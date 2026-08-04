import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import { buildApp } from '../app.js';
import { nacitajPokyny, pokynyPreModel } from '../services/aiInstructionsService.js';
import { createTestDatabase, seedTestUser, testConfig } from '../testHelpers.js';
import { hashPassword } from '../security.js';
import { MemoryObjectStorage } from '../storage.js';

const databases: Awaited<ReturnType<typeof createTestDatabase>>[] = [];
afterEach(async () => Promise.all(databases.splice(0).map((database) => database.close())));

function sessionHeaders(response: { headers: Record<string, unknown>; json(): any }) {
  const cookie = String(response.headers['set-cookie']).split(';')[0];
  return { cookie, 'x-csrf-token': response.json().csrfToken as string };
}

describe('pravidlá pre AI', () => {
  it('globálne pravidlá píše len správca platformy a k firmám sa nedostane', async () => {
    const database = await createTestDatabase();
    databases.push(database);
    const seeded = await seedTestUser(database);
    const app = await buildApp({ database, storage: new MemoryObjectStorage(), config: testConfig(), logger: false });

    // Správca platformy: vlastný tenant, žiadne členstvo v organizácii.
    const platformTenant = randomUUID();
    await database.query('INSERT INTO tenants (id,name) VALUES ($1,$2)', [platformTenant, 'Platforma']);
    await database.query(
      `INSERT INTO users (id,tenant_id,name,email,password_hash,role)
       VALUES ($1,$2,'Správca','platforma@test.sk',$3,'superadmin')`,
      [randomUUID(), platformTenant, await hashPassword(seeded.password)],
    );
    const superLogin = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { email: 'platforma@test.sk', password: seeded.password } });
    const superHeaders = sessionHeaders(superLogin);
    const adminHeaders = sessionHeaders(await app.inject({
      method: 'POST', url: '/api/auth/login', payload: { email: seeded.email, password: seeded.password },
    }));

    const created = await app.inject({
      method: 'POST', url: '/api/global-instructions', headers: superHeaders,
      payload: { nazov: 'Parkovné v EÚ', text: 'Parkovné v zahraničí účtuj na 518, nie 501.' },
    });
    expect(created.statusCode).toBe(200);
    expect(created.json().scope).toBe('global');

    // Bežný admin firmy globálne pravidlá nevidí ani nemení.
    expect((await app.inject({ method: 'GET', url: '/api/global-instructions', headers: adminHeaders })).statusCode).toBe(403);
    expect((await app.inject({
      method: 'POST', url: '/api/global-instructions', headers: adminHeaders,
      payload: { nazov: 'X', text: 'Y' },
    })).statusCode).toBe(403);

    // A správca platformy sa nedostane k pravidlám ani dátam firmy.
    expect((await app.inject({
      method: 'GET', url: `/api/organizations/${seeded.organizationId}/instructions`, headers: superHeaders,
    })).statusCode).toBe(403);

    // Pravidlo firmy patrí len tejto firme — cudzia organizácia ho neuvidí.
    const firemne = await app.inject({
      method: 'POST', url: `/api/organizations/${seeded.organizationId}/instructions`, headers: adminHeaders,
      payload: { nazov: 'Mzdy', text: 'Rekapituláciu miezd rozúčtuj na 521/331 a odvody na 524.', typyDokladov: ['MZDY'] },
    });
    expect(firemne.statusCode).toBe(200);
    const zoznam = await app.inject({
      method: 'GET', url: `/api/organizations/${seeded.organizationId}/instructions`, headers: adminHeaders,
    });
    expect(zoznam.json().pravidla).toHaveLength(1);

    const cudziaOrg = randomUUID();
    expect((await app.inject({
      method: 'DELETE', url: `/api/organizations/${cudziaOrg}/instructions/${firemne.json().id}`, headers: adminHeaders,
    })).statusCode).toBe(404);
    await app.close();
  }, 120_000);

  it('výber pravidiel filtruje podľa typu a slov; firemné idú po globálnych', async () => {
    const database = await createTestDatabase();
    databases.push(database);
    const seeded = await seedTestUser(database);
    await database.query(
      `INSERT INTO ai_instructions (id,scope,nazov,text,faza) VALUES ($1,'global','Globálne','Text globálneho pravidla','both')`,
      [randomUUID()],
    );
    await database.query(
      `INSERT INTO ai_instructions (id,scope,tenant_id,organization_id,nazov,text,faza,typy_dokladov,klucove_slova)
       VALUES ($1,'organization',$2,$3,'Mzdy','Text firemného pravidla','both','["MZDY"]'::jsonb,'["mzdy"]'::jsonb)`,
      [randomUUID(), seeded.tenantId, seeded.organizationId],
    );

    const nesedi = await nacitajPokyny(database, {
      tenantId: seeded.tenantId, organizationId: seeded.organizationId,
      faza: 'accounting', documentType: 'FP', lineText: 'nájom kancelárie',
    });
    expect(nesedi.globalne).toHaveLength(1);
    expect(nesedi.lokalne).toHaveLength(0);

    const sedi = await nacitajPokyny(database, {
      tenantId: seeded.tenantId, organizationId: seeded.organizationId,
      faza: 'accounting', documentType: 'MZDY', lineText: 'mzdy 07/2026',
    });
    expect(sedi.lokalne).toHaveLength(1);
    const blok = pokynyPreModel(sedi) ?? '';
    expect(blok.indexOf('Text globálneho pravidla')).toBeLessThan(blok.indexOf('Text firemného pravidla'));
    expect(blok).toContain('vyhráva pravidlo firmy');

    // Pri extrakcii typ dokladu ešte nepoznáme — pravidlo sa neodfiltruje.
    const extrakcia = await nacitajPokyny(database, {
      tenantId: seeded.tenantId, organizationId: seeded.organizationId, faza: 'extraction',
    });
    expect(extrakcia.lokalne).toHaveLength(1);
    expect(pokynyPreModel(extrakcia)).toContain('platí pre doklady: MZDY');
  }, 120_000);

  it('vylepšenie pravidla pošle AI číselníky firmy a vzorový doklad, nič neukladá', async () => {
    const database = await createTestDatabase();
    databases.push(database);
    const seeded = await seedTestUser(database);
    // Fixný AI parser namiesto OpenAI: zachytí telo požiadavky na kontrolu.
    const volania: any[] = [];
    const app = await buildApp({
      database,
      storage: new MemoryObjectStorage(),
      config: testConfig(),
      logger: false,
      aiRulesParser: {
        parse: async (body: unknown) => {
          volania.push(body);
          return {
            output_parsed: {
              nazov: 'Rekapitulácia miezd',
              text: 'Rekapituláciu miezd zaúčtuj ako interný doklad: hrubé mzdy na 521/331, odvody na 524/336.',
              faza: 'both',
              typyDokladov: ['MZDY'],
              klucoveSlova: ['Mzdy ', 'rekapitulácia', 'mzdy'],
            },
          };
        },
      },
    });
    const headers = sessionHeaders(await app.inject({
      method: 'POST', url: '/api/auth/login', payload: { email: seeded.email, password: seeded.password },
    }));
    await database.query(
      `INSERT INTO code_list_items (id,tenant_id,organization_id,kind,code,name,source)
       VALUES ($1,$2,$3,'predkontacie','518/321','Preprava a služby','manual')`,
      [randomUUID(), seeded.tenantId, seeded.organizationId],
    );

    // Prázdny koncept bez súboru sa odmietne skôr, než sa volá AI.
    expect((await app.inject({
      method: 'POST', url: `/api/organizations/${seeded.organizationId}/instructions/improve`,
      headers, payload: { nazov: '', text: '' },
    })).statusCode).toBe(422);

    // Nepodporovaný súbor (nie PDF/obrázok) sa odmietne podľa bajtov.
    expect((await app.inject({
      method: 'POST', url: `/api/organizations/${seeded.organizationId}/instructions/improve`,
      headers,
      payload: { nazov: '', text: 'x', subory: [{ fileName: 'a.txt', contentBase64: Buffer.from('hello').toString('base64') }] },
    })).statusCode).toBe(422);

    // Doklad + snímka z POHODY naraz: obe idú do AI ako samostatné prílohy.
    const pdf = Buffer.from('%PDF-1.4 vzorova rekapitulacia');
    const png = Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), Buffer.from('pohoda-screenshot')]);
    const improved = await app.inject({
      method: 'POST', url: `/api/organizations/${seeded.organizationId}/instructions/improve`,
      headers,
      payload: {
        nazov: 'Mzdy',
        text: 'ked pride rekapitulacia miezd tak zrazkova dan a odvody',
        subory: [
          { fileName: 'rekapitulacia.pdf', contentBase64: pdf.toString('base64') },
          { fileName: 'pohoda.png', contentBase64: png.toString('base64') },
        ],
      },
    });
    expect(improved.statusCode, improved.body).toBe(200);
    const navrh = improved.json().navrh;
    expect(navrh.text).toContain('521/331');
    expect(navrh.typyDokladov).toEqual(['MZDY']);
    // Kľúčové slová sa normalizujú (malé písmená, bez duplicít).
    expect(navrh.klucoveSlova).toEqual(['mzdy', 'rekapitulácia']);

    // AI dostala číselníky firmy aj oba vzorové súbory v správnom type prílohy.
    const telo = volania[0];
    const obsah = telo.input[0].content;
    expect(obsah[0].text).toContain('Code lists of this company');
    expect(obsah[0].text).toContain('518/321');
    expect(obsah[0].text).toContain('rekapitulacia.pdf, pohoda.png');
    expect(obsah[1].type).toBe('input_file');
    expect(obsah[1].filename).toBe('rekapitulacia.pdf');
    // Snímka ide ako obrázok — input_file by Responses API pri PNG odmietlo.
    expect(obsah[2].type).toBe('input_image');
    expect(obsah[2].image_url.startsWith('data:image/png;base64,')).toBe(true);

    // Nič sa neuložilo — uloženie je samostatný krok účtovníka.
    const zoznam = await app.inject({
      method: 'GET', url: `/api/organizations/${seeded.organizationId}/instructions`, headers,
    });
    expect(zoznam.json().pravidla).toHaveLength(0);
    await app.close();
  }, 120_000);

  it('odmietnutý súbor od AI dá zrozumiteľnú hlášku, nie surovú 500', async () => {
    const database = await createTestDatabase();
    databases.push(database);
    const seeded = await seedTestUser(database);
    const app = await buildApp({
      database,
      storage: new MemoryObjectStorage(),
      config: testConfig(),
      logger: false,
      aiRulesParser: {
        // Presne to, čo vráti OpenAI pri orezanom PNG: HTTP 400.
        parse: async () => { throw Object.assign(new Error('400 invalid image'), { status: 400 }); },
      },
    });
    const headers = sessionHeaders(await app.inject({
      method: 'POST', url: '/api/auth/login', payload: { email: seeded.email, password: seeded.password },
    }));
    const png = Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), Buffer.from('orezane')]);
    const odpoved = await app.inject({
      method: 'POST', url: `/api/organizations/${seeded.organizationId}/instructions/improve`,
      headers,
      payload: { nazov: '', text: 'x', subory: [{ fileName: 'orezane.png', contentBase64: png.toString('base64') }] },
    });
    expect(odpoved.statusCode).toBe(422);
    expect(odpoved.json().message).toContain('odmietla priložený súbor');
    await app.close();
  }, 120_000);
});

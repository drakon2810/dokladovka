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
});

import { randomUUID } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { PGlite } from '@electric-sql/pglite';
import { afterEach, describe, expect, it } from 'vitest';
import { buildApp } from '../app.js';
import { databaseFromPglite, type Database } from '../db/database.js';
import { loadDphProfil } from '../services/dphProfileService.js';
import { polozkaKatalogu } from '../services/profilKatalog.js';
import { MemoryObjectStorage } from '../storage.js';
import { createTestDatabase, seedTestUser, testConfig } from '../testHelpers.js';

const databases: Database[] = [];
afterEach(async () => Promise.all(databases.splice(0).map((database) => database.close())));

function sessionHeaders(response: { headers: Record<string, unknown>; json(): any }) {
  return { cookie: String(response.headers['set-cookie']).split(';')[0], 'x-csrf-token': response.json().csrfToken as string };
}

async function priprav() {
  const database = await createTestDatabase();
  databases.push(database);
  const seeded = await seedTestUser(database);
  const app = await buildApp({ database, storage: new MemoryObjectStorage(), config: testConfig(), logger: false });
  const prihlas = async (email: string) =>
    sessionHeaders(await app.inject({ method: 'POST', url: '/api/auth/login', payload: { email, password: seeded.password } }));
  const pouzivatel = async (rola: 'uctovnik' | 'schvalovatel', meno: string) => {
    const id = randomUUID();
    await database.query(
      `INSERT INTO users (id,tenant_id,name,email,password_hash,role)
       SELECT $1, tenant_id, $2, $3, password_hash, $4 FROM users WHERE id=$5`,
      [id, meno, `${rola}@test.sk`, rola, seeded.userId],
    );
    await database.query('INSERT INTO organization_memberships (user_id,organization_id,tenant_id) VALUES ($1,$2,$3)',
      [id, seeded.organizationId, seeded.tenantId]);
    return prihlas(`${rola}@test.sk`);
  };
  const kod = async (kind: string, code: string) => {
    const id = randomUUID();
    await database.query(
      `INSERT INTO code_list_items (id,tenant_id,organization_id,kind,code,name,source) VALUES ($1,$2,$3,$4,$5,$5,'pohoda')`,
      [id, seeded.tenantId, seeded.organizationId, kind, code],
    );
    return id;
  };
  const url = `/api/organizations/${seeded.organizationId}/profil`;
  return { database, seeded, app, admin: await prihlas(seeded.email), pouzivatel, kod, url };
}

describe('profil klienta — API', () => {
  it('admin aj účtovník smú, schvaľovateľ nie; neznámy fakt 404, zlá hodnota a kód 400', async () => {
    const { app, admin, pouzivatel, kod, url } = await priprav();
    await kod('cleneniaDph', 'PN');

    const prazdny = await app.inject({ method: 'GET', url, headers: admin });
    expect(prazdny.statusCode, prazdny.body).toBe(200);
    expect(prazdny.json()).toEqual({ fakty: [], otazky: [], navrhyDelenia: [] });

    const uctovnik = await pouzivatel('uctovnik', 'Účtovník');
    const ulozene = await app.inject({
      method: 'PUT', url: `${url}/fakty/zasady.drobny_majetok`, headers: uctovnik,
      payload: { stav: 'potvrdene', hodnota: { hranica: 1700 } },
    });
    expect(ulozene.statusCode, ulozene.body).toBe(200);
    expect(ulozene.json().fakty).toEqual([expect.objectContaining({
      kluc: 'zasady.drobny_majetok', stav: 'potvrdene', zdroj: 'uctovnik', hodnota: { hranica: 1700 }, potvrdil: 'Účtovník',
      potvrdeneAt: expect.any(String),
    })]);

    const schvalovatel = await pouzivatel('schvalovatel', 'Schvaľovateľ');
    expect((await app.inject({ method: 'GET', url, headers: schvalovatel })).statusCode).toBe(403);
    expect((await app.inject({
      method: 'PUT', url: `${url}/fakty/zasady.drobny_majetok`, headers: schvalovatel, payload: { stav: 'nepouziva_sa' },
    })).statusCode).toBe(403);

    const put = (kluc: string, hodnota: unknown) =>
      app.inject({ method: 'PUT', url: `${url}/fakty/${kluc}`, headers: admin, payload: { stav: 'potvrdene', hodnota } });
    const neznamy = await put('dph.obdobie', { obdobie: 'mesacne' });
    expect(neznamy.statusCode).toBe(404);
    expect(neznamy.json().code).toBe('profil_fakt_neznamy');
    const zlaHodnota = await put('dph.status', { status: 'mozno' });
    expect(zlaHodnota.statusCode).toBe(400);
    expect(zlaHodnota.json().code).toBe('profil_hodnota_neplatna');
    const zlyKod = await put('samozdanenie.sluzby_eu', { faktura: { clenenieKod: 'PN', kv: 'Z9' }, interny: { ddKod: 'DDsl§69' } });
    expect(zlyKod.statusCode).toBe(400);
    expect(zlyKod.json()).toMatchObject({ code: 'profil_kod_neplatny', details: { kody: ['DDsl§69', 'Z9'] } });
    await app.close();
  }, 120_000);

  it('prepočet vráti payload, potvrdenie faktu zavrie otázku, neskôr odloží a iné vytvorí pokyn', async () => {
    const { database, seeded, app, admin, url } = await priprav();
    const prepocet = await app.inject({ method: 'POST', url: `${url}/prepocitat`, headers: admin });
    expect(prepocet.statusCode, prepocet.body).toBe(200);
    const otazky = prepocet.json().otazky as Array<Record<string, any>>;
    // Blokujúca otázka ide prvá.
    expect(otazky.map((otazka) => otazka.kluc)).toEqual(['fakt:dph.status', 'fakt:zasady.drobny_majetok']);
    expect(prepocet.json()).toMatchObject({ fakty: [], navrhyDelenia: [], prepocitaneAt: expect.any(String) });
    const [status, majetok] = otazky;

    const odpovedz = (id: string, payload: unknown) =>
      app.inject({ method: 'POST', url: `${url}/otazky/${id}`, headers: admin, payload });
    const neskor = await odpovedz(status.id, { akcia: 'neskor' });
    expect(neskor.statusCode, neskor.body).toBe(200);
    expect(neskor.json().otazky).toEqual(expect.arrayContaining([expect.objectContaining({ id: status.id, stav: 'odlozena' })]));
    // Na fakt sa neodpovedá výberom podoby.
    expect((await odpovedz(majetok.id, { akcia: 'variant', index: 0 })).json().code).toBe('profil_akcia_neplatna');

    const potvrdene = await app.inject({
      method: 'PUT', url: `${url}/fakty/zasady.drobny_majetok`, headers: admin, payload: { stav: 'potvrdene', hodnota: { hranica: 1700 } },
    });
    expect(potvrdene.statusCode, potvrdene.body).toBe(200);
    expect(potvrdene.json().otazky.map((otazka: any) => otazka.kluc)).toEqual(['fakt:dph.status']);
    expect(potvrdene.json().fakty).toEqual([expect.objectContaining({ kluc: 'zasady.drobny_majetok', potvrdil: 'Test Admin' })]);
    expect((await database.query<Record<string, any>>('SELECT stav, odpoved, odpovedal FROM profil_otazky WHERE id=$1', [majetok.id])).rows[0])
      .toEqual({ stav: 'zodpovedana', odpoved: { stav: 'potvrdene', hodnota: { hranica: 1700 } }, odpovedal: seeded.userId });
    expect((await database.query("SELECT metadata FROM audit_logs WHERE action='profil.fakt_ulozeny'")).rows)
      .toEqual([{ metadata: { kluc: 'zasady.drobny_majetok', stav: 'potvrdene', hodnota: { hranica: 1700 } } }]);

    const ine = await odpovedz(status.id, { akcia: 'ine', text: 'Firma je platiteľ DPH od roku 2020.' });
    expect(ine.statusCode, ine.body).toBe(200);
    expect(ine.json().otazky).toEqual([]);
    const pokyn = (await database.query<Record<string, any>>(
      'SELECT id, scope, faza, nazov, text FROM ai_instructions WHERE organization_id=$1', [seeded.organizationId],
    )).rows;
    expect(pokyn).toEqual([{
      id: expect.any(String), scope: 'organization', faza: 'accounting', nazov: 'Profil klienta: dph.status',
      text: 'Firma je platiteľ DPH od roku 2020.',
    }]);
    expect((await database.query<Record<string, any>>('SELECT stav, odpoved FROM profil_otazky WHERE id=$1', [status.id])).rows[0])
      .toEqual({ stav: 'zodpovedana', odpoved: { text: 'Firma je platiteľ DPH od roku 2020.', instructionId: pokyn[0].id } });
    const znova = await odpovedz(status.id, { akcia: 'neskor' });
    expect(znova.statusCode).toBe(409);
    expect(znova.json().code).toBe('profil_otazka_zastarana');
    await app.close();
  }, 120_000);

  it('výber podoby pri spore protistrany vytvorí pravidlo; neaktívny kód otázku zastará', async () => {
    const { database, seeded, app, admin, kod, url } = await priprav();
    const ucet = await kod('predkontacie', '518100');
    const pd = await kod('cleneniaDph', 'PD');
    const pn = await kod('cleneniaDph', 'PN');
    const spor = async (protistrana: string, ico: string | null, pdDokladov: number, pnDokladov: number) => database.query(
      `INSERT INTO ucto_pravidla (id,tenant_id,organization_id,agenda,protistrana,protistrana_ico,dokladov,zhoda,varianty,konflikt)
       VALUES ($1,$2,$3,'FP',$4,$5,$6,$7,$8::jsonb,true)`,
      [randomUUID(), seeded.tenantId, seeded.organizationId, protistrana, ico, pdDokladov + pnDokladov, Math.max(pdDokladov, pnDokladov),
        JSON.stringify([
          { predkontaciaKod: '518100', clenenieDphKod: 'PD', clenenieKvKod: 'B2', tvar: [], dokladov: pdDokladov, od: '2026-01-05', do: '2026-04-05' },
          { predkontaciaKod: '518100', clenenieDphKod: 'PN', clenenieKvKod: 'KN', tvar: [], dokladov: pnDokladov, od: '2026-02-05', do: '2026-05-05' },
        ])],
    );
    await spor('rainside s.r.o.', '31386946', 4, 3);
    await spor('druha s.r.o.', null, 2, 5);
    // Staré pravidlo len pre dodávateľa by nový výber prebilo — deaktivuje sa.
    const stare = randomUUID();
    await database.query(
      `INSERT INTO accounting_rules (id,tenant_id,organization_id,supplier_ico,predkontacia_id,origin) VALUES ($1,$2,$3,'31386946',$4,'ai')`,
      [stare, seeded.tenantId, seeded.organizationId, ucet],
    );

    const prepocet = (await app.inject({ method: 'POST', url: `${url}/prepocitat`, headers: admin })).json();
    const otazka = (kluc: string) => prepocet.otazky.find((item: any) => item.kluc === kluc);
    expect(otazka('spor:FP:rainside s.r.o.')).toMatchObject({
      druh: 'spor_protistrany', dokladov: 7,
      data: {
        agenda: 'FP', protistrana: 'rainside s.r.o.', protistranaIco: '31386946',
        varianty: [
          { predkontaciaId: ucet, clenenieDphId: pd, clenenieKvKod: 'B2', dokladov: 4 },
          { predkontaciaId: ucet, clenenieDphId: pn, clenenieKvKod: 'KN', dokladov: 3 },
        ],
      },
    });

    const vyber = await app.inject({
      method: 'POST', url: `${url}/otazky/${otazka('spor:FP:rainside s.r.o.').id}`, headers: admin, payload: { akcia: 'variant', index: 0 },
    });
    expect(vyber.statusCode, vyber.body).toBe(200);
    expect(vyber.json().otazky.map((item: any) => item.kluc)).not.toContain('spor:FP:rainside s.r.o.');
    const pravidla = (await database.query<Record<string, any>>(
      'SELECT id, active, origin, dovod_source, supplier_ico, predkontacia_id, clenenie_dph_id, clenenie_kv_kod FROM accounting_rules WHERE organization_id=$1',
      [seeded.organizationId],
    )).rows;
    expect(pravidla.find((pravidlo) => pravidlo.id === stare)?.active).toBe(false);
    expect(pravidla.find((pravidlo) => pravidlo.id !== stare)).toMatchObject({
      active: true, origin: 'manual', dovod_source: 'human', supplier_ico: '31386946',
      predkontacia_id: ucet, clenenie_dph_id: pd, clenenie_kv_kod: 'B2',
    });
    expect((await database.query("SELECT 1 FROM audit_logs WHERE action='profil.otazka_zodpovedana'")).rowCount).toBe(1);
    // Pravidlo účtovníka o DPH protistrany rozhodlo — ďalší prepočet otázku nezaloží.
    const potom = (await app.inject({ method: 'POST', url: `${url}/prepocitat`, headers: admin })).json();
    expect(potom.otazky.map((item: any) => item.kluc)).toEqual(expect.arrayContaining(['spor:FP:druha s.r.o.']));
    expect(potom.otazky.map((item: any) => item.kluc)).not.toContain('spor:FP:rainside s.r.o.');

    await database.query('UPDATE code_list_items SET active=false WHERE id=$1', [pn]);
    const zastarana = await app.inject({
      method: 'POST', url: `${url}/otazky/${otazka('spor:FP:druha s.r.o.').id}`, headers: admin, payload: { akcia: 'variant', index: 0 },
    });
    expect(zastarana.statusCode, zastarana.body).toBe(409);
    expect(zastarana.json().code).toBe('profil_otazka_zastarana');
    await app.close();
  }, 120_000);

  it('migrácia prenesie platiteľa ako návrh a pravidlá s kódmi namiesto id', async () => {
    // Staré dáta musia vzniknúť pred migráciou 0072 — preto migrácie po jednej.
    const database = databaseFromPglite(new PGlite());
    databases.push(database);
    const adresar = new URL('../db/migrations/', import.meta.url);
    const spusti = async (subor: string) => database.exec(await readFile(new URL(subor, adresar), 'utf8'));
    for (const subor of (await readdir(adresar)).filter((nazov) => nazov.endsWith('.sql') && nazov < '0072').sort()) await spusti(subor);
    const seeded = await seedTestUser(database);
    const kod = async (kind: string, code: string) => {
      const id = randomUUID();
      await database.query(
        `INSERT INTO code_list_items (id,tenant_id,organization_id,kind,code,name,source) VALUES ($1,$2,$3,$4,$5,$5,'pohoda')`,
        [id, seeded.tenantId, seeded.organizationId, kind, code],
      );
      return id;
    };
    const [phm, nadspotreba, telefon, pn, pb] = [
      await kod('predkontacie', 'PHM-501200'), await kod('predkontacie', 'PHM-Nadspotreba'), await kod('predkontacie', '518100'),
      await kod('cleneniaDph', 'PN'), await kod('cleneniaDph', 'PB'),
    ];
    await database.query(
      `INSERT INTO organization_dph_profiles
        (organization_id,tenant_id,platitel_dph,pravidla_aut,pomerne_odpocitanie,clenenie_bez_odpoctu_id,updated_by,updated_at)
       VALUES ($1,$2,'platitel',$3::jsonb,$4::jsonb,$5,$6,'2026-09-01T10:00:00Z')`,
      [seeded.organizationId, seeded.tenantId,
        JSON.stringify([
          { kategoria: 'PHM', percento: 80, percentoDph: 50, klucoveSlova: ['natural 95'], platnostOd: '2026-01-01',
            predkontaciaId: phm, predkontaciaNedanovaId: nadspotreba, clenenieDphNedanoveId: pn },
          // Id, ktoré číselník nepozná, sa na kód nepreloží — pravidlo sa vynechá.
          { kategoria: 'Stará karta', percento: 80, klucoveSlova: ['shell'], predkontaciaId: 'neexistuje', predkontaciaNedanovaId: nadspotreba },
        ]),
        JSON.stringify([{ kategoria: 'Telefón', percento: 70, klucoveSlova: ['telekom'], predkontaciaId: telefon, clenenieDphNedanoveId: pn }]),
        pb, seeded.userId],
    );
    await spusti('0072_profil_fakty.sql');
    // Hneď za prenosom ide 0073 — staré tabuľky zmiznú, prenesené fakty ostanú.
    await spusti('0073_profil_stary_drop.sql');
    expect((await database.query(
      `SELECT 1 FROM information_schema.tables WHERE table_name IN ('organization_dph_profiles','organization_accounting_profiles')`,
    )).rowCount).toBe(0);

    const fakty = new Map((await database.query<Record<string, any>>(
      'SELECT kluc, stav, hodnota, zdroj, potvrdil, potvrdene_at FROM profil_fakty WHERE organization_id=$1', [seeded.organizationId],
    )).rows.map((row) => [row.kluc, row]));
    expect([...fakty.keys()].sort()).toEqual(['dph.clenenie_bez_odpoctu', 'dph.status', 'naklady.pomerne', 'vozidla.pravidla']);
    expect(fakty.get('dph.status')).toMatchObject({ stav: 'navrhnute', zdroj: 'migracia', hodnota: { status: 'platitel' }, potvrdil: null });
    expect(fakty.get('vozidla.pravidla')).toMatchObject({
      stav: 'potvrdene', zdroj: 'migracia', potvrdil: seeded.userId,
      hodnota: [{
        nazov: 'PHM', klucoveSlova: ['natural 95'], percentoZakladu: 80, percentoDph: 50,
        predkontaciaKod: 'PHM-501200', predkontaciaNedanovaKod: 'PHM-Nadspotreba', clenenieDphNedanoveKod: 'PN',
      }],
    });
    expect(new Date(fakty.get('vozidla.pravidla')!.potvrdene_at).toISOString()).toBe('2026-09-01T10:00:00.000Z');
    expect(fakty.get('naklady.pomerne')!.hodnota).toEqual([
      { nazov: 'Telefón', klucoveSlova: ['telekom'], percentoDph: 70, predkontaciaKod: '518100', clenenieDphNedanoveKod: 'PN' },
    ]);
    expect(fakty.get('dph.clenenie_bez_odpoctu')).toMatchObject({ stav: 'potvrdene', hodnota: { clenenieKod: 'PB' } });
    // Prenesené hodnoty musia prejsť schémou faktu — inak by ich účtovník nevedel ani znova uložiť.
    for (const [kluc, fakt] of fakty) expect(polozkaKatalogu(kluc)!.schema.safeParse(fakt.hodnota).success, kluc).toBe(true);
    // Engine ich po migrácii vidí s id; nepotvrdený platiteľ ostáva neznámy.
    expect(await loadDphProfil(database, seeded.tenantId, seeded.organizationId)).toMatchObject({
      platitelDph: 'nezname', clenenieBezOdpoctuId: pb,
      pravidlaAut: [{ percento: 80, percentoDph: 50, predkontaciaId: phm, predkontaciaNedanovaId: nadspotreba, clenenieDphNedanoveId: pn }],
      pomerneOdpocitanie: [{ percento: 70, predkontaciaId: telefon, predkontaciaNedanovaId: telefon, clenenieDphNedanoveId: pn }],
    });
  }, 120_000);
});

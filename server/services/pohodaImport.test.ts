import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import { buildApp } from '../app.js';
import { MemoryObjectStorage } from '../storage.js';
import { createTestDatabase, seedTestUser, testConfig } from '../testHelpers.js';
import { processNextJob } from '../workerService.js';

const databases: Awaited<ReturnType<typeof createTestDatabase>>[] = [];
afterEach(async () => Promise.all(databases.splice(0).map((database) => database.close())));

const DATABAZA = 'StwPh_12345678_2026';

async function priprav() {
  const database = await createTestDatabase();
  databases.push(database);
  const seeded = await seedTestUser(database);
  const app = await buildApp({ database, storage: new MemoryObjectStorage(), config: testConfig(), logger: false });
  const login = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { email: seeded.email, password: seeded.password } });
  const browser = { cookie: String(login.headers['set-cookie']).split(';')[0], 'x-csrf-token': login.json().csrfToken as string };
  await app.inject({ method: 'PUT', url: '/api/mostik/settings', headers: browser, payload: { enabled: true } });
  const pairing = await app.inject({ method: 'POST', url: '/api/mostik/pairing-codes', headers: browser, payload: { organizationId: seeded.organizationId } });
  const paired = await app.inject({
    method: 'POST', url: '/api/agent/pair',
    payload: { pairingCode: pairing.json().code as string, hostname: 'POHODA-SRV', agentVersion: '0.18.0', companyIco: '12345678' },
  });
  const headers = { authorization: `Bearer ${paired.json().agentToken as string}` };
  const agent = (method: 'PUT' | 'POST' | 'GET', cesta: string, payload?: unknown) => app.inject({
    method, url: `/api/agent/organizations/${seeded.organizationId}/${cesta}`, headers, payload: payload as object,
  });
  const publikuj = (importId: string, payload: unknown) => agent('POST', `importy/${importId}/publikuj`, payload);
  const sql = async (query: string) => (await database.query<Record<string, any>>(query, [seeded.organizationId])).rows;
  return { database, seeded, app, browser, headers, agent, publikuj, sql };
}

const manifest = (stav = 'ok', rok?: number) => ({
  databaza: DATABAZA, ...(rok ? { rok } : {}), programVersion: '14301.4 SQL', kluc: 'a36b615a',
  agendy: [{ poziadavka: 'receivedInvoice', agenda: 'FP', stav, dokladov: 2, poloziek: 1, riadkov: 3, preskocene: { hlavickaBezKodu: 1 } }],
});

describe('prenos z Mostíka cez staging a publikáciu', () => {
  it('história: dávky čakajú v stagingu, publikácia vymení korpus len svojej databázy', async () => {
    const { app, headers, seeded, agent, publikuj, sql } = await priprav();
    // Protokol vyjednáva server — Mostík 0.18 podľa neho posiela importId, 0.19 aj hlavičky dokladov.
    const organizacie = await app.inject({ method: 'GET', url: '/api/agent/organizations', headers });
    expect(organizacie.json()).toContainEqual(expect.objectContaining({ organizationId: seeded.organizationId, historiaProtokol: 3 }));
    // Korpus ALPINY má ~22 000 riadkov; strop 20 000 telemetriu úspechu odmietal.
    const telemetria = await app.inject({
      method: 'POST', url: '/api/agent/sync-results', headers,
      payload: { organizationId: seeded.organizationId, kind: 'uctovnyProfil', state: 'ok', itemCount: 25_000, durationMs: 1 },
    });
    expect(telemetria.statusCode, telemetria.body).toBe(202);

    // Živý korpus: starý prenos (bez databázy) a riadok databázy minulého roka.
    const stary = { agenda: 'FP', dokladCislo: 'STARY1', datum: '2026-01-05', lineText: 'Stary', predkontaciaKod: '518/321', riadokIndex: 0 };
    expect((await agent('PUT', 'ucto-history', { reset: true, rows: [stary] })).statusCode).toBe(200);
    await sql(`INSERT INTO ucto_historia (id,tenant_id,organization_id,agenda,doklad_cislo,line_text_normalized,source,riadok_hash,zdroj_databaza)
      SELECT '${randomUUID()}', tenant_id, id, 'FP', 'MINULY1', 'minuly rok', 'mdb', 'minuly', 'StwPh_12345678_2025' FROM organizations WHERE id=$1`);
    const zivy = async () => (await sql(
      'SELECT doklad_cislo, riadok_index, zdroj_databaza FROM ucto_historia WHERE organization_id=$1 ORDER BY doklad_cislo, riadok_index',
    )).map((row) => [row.doklad_cislo, row.riadok_index, row.zdroj_databaza]);
    const predPublikaciou = await zivy();

    const importId = randomUUID();
    const hlavicka = { agenda: 'FP', dokladCislo: 'FP26001', datum: '2026-02-01', lineText: 'Preprava', predkontaciaKod: '518/321', clenenieDphKod: 'PD', riadokIndex: 0, dokladId: 10 };
    const davka0 = {
      importId, davka: 0, reset: true,
      rows: [hlavicka, { ...hlavicka, lineText: 'Clo', riadokIndex: 1, polozkaId: 11 }],
      series: [{ externalId: '79', kod: 'FP26', agenda: 'prijate_faktury', posledneCislo: 'FP26002' }],
    };
    const davka1 = { importId, davka: 1, rows: [{ ...hlavicka, dokladCislo: 'FP26002', datum: '2026-03-01', dokladId: 20 }] };
    expect((await agent('PUT', 'ucto-history', davka0)).json()).toEqual({ importId, davka: 0, prijatych: 2 });
    expect((await agent('PUT', 'ucto-history', davka1)).statusCode).toBe(200);
    // Zopakovaná dávka (timeout agenta) sa prepíše, nezdvojí.
    expect((await agent('PUT', 'ucto-history', davka1)).statusCode).toBe(200);
    // importId bez čísla dávky nie je platná dávka.
    expect((await agent('PUT', 'ucto-history', { importId, rows: [] })).statusCode).toBe(400);

    // Pred publikáciou sa živých dát nič nedotklo — ani reset v dávke.
    expect(await zivy()).toEqual(predPublikaciou);
    expect(await sql(`SELECT 1 FROM code_list_items WHERE organization_id=$1 AND external_id='79'`)).toEqual([]);

    const telo = { druh: 'historia', davok: 2, pocet: 3, manifest: manifest() };
    const prva = await publikuj(importId, telo);
    expect(prva.statusCode, prva.body).toBe(200);
    expect(prva.json()).toMatchObject({ imported: 3, duplicates: 0, bezKodu: 0, preskocene: { hlavickaBezKodu: 1 }, rady: { nove: 1 } });
    expect(await zivy()).toEqual([
      ['FP26001', 0, DATABAZA], ['FP26001', 1, DATABAZA], ['FP26002', 0, DATABAZA],
      // Minulý rok patrí inej databáze a ostal.
      ['MINULY1', null, 'StwPh_12345678_2025'],
    ]);
    expect(await sql(`SELECT accounting_year FROM code_list_items WHERE organization_id=$1 AND external_id='79'`))
      .toEqual([{ accounting_year: '2026' }]);

    // Agent publikáciu po timeoute zopakuje — výsledok je ten istý a nič sa nezdvojí.
    const druha = await publikuj(importId, telo);
    expect([druha.statusCode, druha.json()]).toEqual([200, prva.json()]);
    expect(await zivy()).toHaveLength(4);
    expect((await agent('PUT', 'ucto-history', { ...davka1, davka: 2 })).statusCode).toBe(409);
    expect(await sql(`SELECT stav, published_at IS NOT NULL AS publikovany, manifest->>'databaza' AS databaza,
        (SELECT count(*)::int FROM pohoda_import_davky d WHERE d.import_id=i.id) AS davok
      FROM pohoda_importy i WHERE organization_id=$1`))
      .toEqual([{ stav: 'publikovany', publikovany: true, databaza: DATABAZA, davok: 0 }]);
    expect(await sql(`SELECT kind, state, item_count FROM agent_sync_runs WHERE organization_id=$1 ORDER BY created_at`))
      .toEqual([{ kind: 'uctovnyProfil', state: 'ok', item_count: 25_000 }, { kind: 'uctovnyProfil', state: 'ok', item_count: 3 }]);

    // Meno databázy z mServeru a z nastavenia POHODA CLI sa môže líšiť veľkosťou
    // písmen — je to tá istá databáza a korpus sa nesmie zdvojiť.
    const znova = randomUUID();
    await agent('PUT', 'ucto-history', { ...davka0, importId: znova });
    await agent('PUT', 'ucto-history', { ...davka1, importId: znova });
    const malymi = await publikuj(znova, { ...telo, manifest: { ...manifest(), databaza: DATABAZA.toLowerCase() } });
    expect(malymi.statusCode, malymi.body).toBe(200);
    expect(await zivy()).toHaveLength(4);
  }, 120_000);

  // Po novom prenose ostávali pravidlá aj kategórie zo starej histórie, kým
  // niekto nezaplatil novú analýzu. Prepočet praxe je deterministický a lacný.
  it('publikácia histórie zaradí prepočet praxe a worker ho spraví bez AI', async () => {
    const { database, agent, publikuj, sql } = await priprav();
    await agent('PUT', 'code-lists', { kind: 'predkontacie', items: [{ kod: '518/321', nazov: '518/321' }] });
    // Kategória z minulej analýzy — kódy ešte nemá.
    await sql(`INSERT INTO ucto_kategorie (id,tenant_id,organization_id,nazov,slovnik,kluc)
      SELECT 'kat-preprava', tenant_id, id, 'Preprava', '["preprava"]'::jsonb, 'preprava' FROM organizations WHERE id=$1`);
    const importId = randomUUID();
    const rows = [1, 2, 3].map((n) => ({
      agenda: 'FP', dokladCislo: `FP2600${n}`, datum: `2026-0${n}-01`, lineText: 'Preprava', supplierName: 'Preprava s.r.o.',
      predkontaciaKod: '518/321', clenenieDphKod: 'PD', riadokIndex: 0, dokladId: n,
    }));
    expect((await agent('PUT', 'ucto-history', { importId, davka: 0, reset: true, rows })).statusCode).toBe(200);
    const telo = { druh: 'historia', davok: 1, pocet: 3, manifest: manifest() };
    expect((await publikuj(importId, telo)).statusCode).toBe(200);
    // Zopakovaná publikácia nezaloží druhý čakajúci prepočet.
    expect((await publikuj(importId, telo)).statusCode).toBe(200);
    const joby = () => sql(`SELECT status FROM processing_jobs WHERE organization_id=$1 AND kind='prepocet_praxe'`);
    expect(await joby()).toEqual([{ status: 'queued' }]);
    expect(await sql('SELECT 1 FROM ucto_pravidla WHERE organization_id=$1')).toEqual([]);

    // testConfig nemá kľúč OpenAI — keby prepočet volal model, job by zlyhal.
    expect(await processNextJob(database, testConfig(), 'test-worker')).toBe(true);
    expect(await joby()).toEqual([{ status: 'succeeded' }]);
    expect(await sql('SELECT dokladov, predkontacia_kod, konflikt FROM ucto_pravidla WHERE organization_id=$1'))
      .toEqual([{ dokladov: 3, predkontacia_kod: '518/321', konflikt: false }]);
    expect(await sql('SELECT id, predkontacia_kod, clenenie_dph_kod, pocet FROM ucto_kategorie WHERE organization_id=$1'))
      .toEqual([{ id: 'kat-preprava', predkontacia_kod: '518/321', clenenie_dph_kod: 'PD', pocet: 3 }]);
  }, 120_000);

  it('neúplný alebo nahradený prenos živé dáta nezmení', async () => {
    const { agent, publikuj, sql } = await priprav();
    const riadok = { agenda: 'FP', dokladCislo: 'D1', datum: '2026-01-05', lineText: 'Zivy', predkontaciaKod: '518/321', riadokIndex: 0 };
    await agent('PUT', 'ucto-history', { reset: true, rows: [riadok] });
    const zivy = () => sql('SELECT line_text_normalized FROM ucto_historia WHERE organization_id=$1');

    // Druhá dávka neprišla (sieť, 500 po piatich pokusoch).
    const neuplny = randomUUID();
    await agent('PUT', 'ucto-history', { importId: neuplny, davka: 0, rows: [{ ...riadok, lineText: 'Novy' }] });
    const zamietnuty = await publikuj(neuplny, { druh: 'historia', davok: 2, pocet: 2, manifest: manifest() });
    expect([zamietnuty.statusCode, zamietnuty.json().code]).toEqual([422, 'import_neuplny']);
    expect(zamietnuty.json().message).toContain('1 z 2 dávok');
    expect(await zivy()).toEqual([{ line_text_normalized: 'zivy' }]);
    expect(await sql(`SELECT stav, (SELECT count(*)::int FROM pohoda_import_davky WHERE import_id=id) AS davok
      FROM pohoda_importy WHERE organization_id=$1`)).toEqual([{ stav: 'zamietnuty', davok: 0 }]);
    expect(await sql(`SELECT kind, state, error_code FROM agent_sync_runs WHERE organization_id=$1`))
      .toEqual([{ kind: 'uctovnyProfil', state: 'error', error_code: 'prišlo 1 z 2 dávok' }]);
    expect((await publikuj(neuplny, { druh: 'historia', davok: 2, pocet: 2, manifest: manifest() })).statusCode).toBe(422);

    // POHODA vrátila agendu po častiach — dávky sedia, ale agenda nie je celá.
    const poCastiach = randomUUID();
    await agent('PUT', 'ucto-history', { importId: poCastiach, davka: 0, rows: [{ ...riadok, lineText: 'Novy' }] });
    const parts = await publikuj(poCastiach, { druh: 'historia', davok: 1, pocet: 1, manifest: manifest('parts') });
    expect([parts.statusCode, parts.json().message]).toEqual([422, 'Prenos je neúplný: agenda FP: parts']);
    expect(await zivy()).toEqual([{ line_text_normalized: 'zivy' }]);

    // Nový prenos zruší starší nedokončený — ten sa už publikovať nesmie.
    const starsi = randomUUID();
    const novsi = randomUUID();
    await agent('PUT', 'ucto-history', { importId: starsi, davka: 0, rows: [{ ...riadok, lineText: 'Starsi' }] });
    await agent('PUT', 'ucto-history', { importId: novsi, davka: 0, rows: [{ ...riadok, lineText: 'Novsi' }] });
    expect(await sql(`SELECT count(*)::int AS davok FROM pohoda_import_davky WHERE import_id IN
      (SELECT id FROM pohoda_importy WHERE organization_id=$1 AND stav='prijima')`)).toEqual([{ davok: 1 }]);
    const nahradeny = await publikuj(starsi, { druh: 'historia', davok: 1, pocet: 1, manifest: manifest() });
    expect([nahradeny.statusCode, nahradeny.json().code]).toEqual([409, 'import_nahradeny']);
    expect((await agent('PUT', 'ucto-history', { importId: starsi, davka: 1, rows: [] })).statusCode).toBe(409);
    expect((await publikuj(novsi, { druh: 'historia', davok: 1, pocet: 1, manifest: manifest() })).statusCode).toBe(200);
    expect(await zivy()).toEqual([{ line_text_normalized: 'novsi' }]);
  }, 120_000);

  it('hlavičky a väzby dokladov: publikácia ich vymení za svoju databázu a rok, starší protokol ich nechá', async () => {
    const { agent, publikuj, sql } = await priprav();
    const riadok = { agenda: 'FP', dokladCislo: 'FP26001', datum: '2026-02-01', lineText: 'Preprava', predkontaciaKod: '518/321', riadokIndex: 0, dokladId: 10 };
    const dobropis = {
      agenda: 'FP-D', dokladId: 10, dokladCislo: 'DF26001', datum: '2026-02-03', datumDane: '2026-01-31', datumUplatneniaDph: '2026-02-01',
      externeCislo: 'CN-77', opravovanyDoklad: 'FA-2024-118', varSymbol: '2601', mena: 'CZK', kurz: 25.12, kurzMnozstvo: 1, sumaMena: -1236,
      zakladZakladna: -40, dphZakladna: -9.2, sadzbaZakladna: 23, zaokruhlenie: 0.01,
      vazby: [
        { typ: 'link', druhaAgenda: 'receivedInvoice', druhyDokladId: 7, druhyDokladCislo: 'DF25007' },
        { typ: 'liquidation', druhaAgenda: 'bank', druhyDokladId: 3301, druhyDokladCislo: 'BV26-015', likvidaciaId: 901, datum: '2026-02-20', suma: -49.19, sumaMena: -1236 },
      ],
    };
    // Interný doklad s tým istým natívnym id je iná tabuľka POHODY, teda iný doklad.
    const interny = { agenda: 'INT', dokladId: 10, dokladCislo: 'INT001', datumKvDph: '2026-02-01', vazby: [{ typ: 'manualLink', druhaAgenda: 'receivedInvoice', druhyDokladId: 7 }] };
    const prenos = async (doklady: Array<Record<string, unknown>> | undefined, manifestPrenosu = manifest('ok', 2026)) => {
      const importId = randomUUID();
      expect((await agent('PUT', 'ucto-history', { importId, davka: 0, rows: [riadok], doklady })).statusCode).toBe(200);
      // Doklad zopakovaný v ďalšej dávke sa uloží raz.
      expect((await agent('PUT', 'ucto-history', { importId, davka: 1, rows: [], doklady: doklady?.slice(0, 1) })).statusCode).toBe(200);
      return publikuj(importId, { druh: 'historia', davok: 2, pocet: 1, manifest: manifestPrenosu });
    };
    const hlavicky = () => sql(`SELECT zdroj_databaza, rok, tabulka, pohoda_doklad_id, agenda, datum_dane::text, datum_kv_dph::text, datum_uplatnenia_dph::text,
        externe_cislo, opravovany_doklad, var_symbol, mena, kurz::float8, suma_mena::float8, dph_zakladna::float8, sadzba_zakladna::float8, zaokruhlenie::float8
      FROM ucto_historia_doklady WHERE organization_id=$1 ORDER BY rok, tabulka`);
    const vazby = () => sql(`SELECT rok, tabulka, poradie, typ, druha_agenda, druhy_doklad_id, druhy_doklad_cislo, likvidacia_id, datum::text, suma::float8, suma_mena::float8
      FROM ucto_historia_vazby WHERE organization_id=$1 ORDER BY rok, tabulka, poradie`);

    const prva = await prenos([dobropis, interny]);
    expect(prva.statusCode, prva.body).toBe(200);
    expect(prva.json()).toMatchObject({ imported: 1, doklady: { dokladov: 2, vazieb: 3 } });
    const intDoc2026 = {
      zdroj_databaza: DATABAZA, rok: 2026, tabulka: 'intDoc', pohoda_doklad_id: 10, agenda: 'INT', datum_dane: null, datum_kv_dph: '2026-02-01',
      datum_uplatnenia_dph: null, externe_cislo: null, opravovany_doklad: null, var_symbol: null, mena: null, kurz: null, suma_mena: null,
      dph_zakladna: null, sadzba_zakladna: null, zaokruhlenie: null,
    };
    const faktura2026 = {
      zdroj_databaza: DATABAZA, rok: 2026, tabulka: 'invoice', pohoda_doklad_id: 10, agenda: 'FP-D', datum_dane: '2026-01-31', datum_kv_dph: null,
      datum_uplatnenia_dph: '2026-02-01', externe_cislo: 'CN-77', opravovany_doklad: 'FA-2024-118', var_symbol: '2601', mena: 'CZK', kurz: 25.12,
      suma_mena: -1236, dph_zakladna: -9.2, sadzba_zakladna: 23, zaokruhlenie: 0.01,
    };
    expect(await hlavicky()).toEqual([intDoc2026, faktura2026]);
    expect(await vazby()).toEqual([
      { rok: 2026, tabulka: 'intDoc', poradie: 0, typ: 'manualLink', druha_agenda: 'receivedInvoice', druhy_doklad_id: 7, druhy_doklad_cislo: null, likvidacia_id: null, datum: null, suma: null, suma_mena: null },
      { rok: 2026, tabulka: 'invoice', poradie: 0, typ: 'link', druha_agenda: 'receivedInvoice', druhy_doklad_id: 7, druhy_doklad_cislo: 'DF25007', likvidacia_id: null, datum: null, suma: null, suma_mena: null },
      { rok: 2026, tabulka: 'invoice', poradie: 1, typ: 'liquidation', druha_agenda: 'bank', druhy_doklad_id: 3301, druhy_doklad_cislo: 'BV26-015', likvidacia_id: 901, datum: '2026-02-20', suma: -49.19, suma_mena: -1236 },
    ]);

    // Opakovaný prenos (meno databázy inou veľkosťou písmen) nič nezdvojí a nesie
    // aktuálny stav POHODY: nový kurz, likvidácia zrušená.
    const opakovany = await prenos([{ ...dobropis, kurz: 25.2, vazby: dobropis.vazby.slice(0, 1) }, interny], { ...manifest('ok', 2026), databaza: DATABAZA.toLowerCase() });
    expect(opakovany.statusCode, opakovany.body).toBe(200);
    expect((await hlavicky()).map((row) => [row.tabulka, row.kurz])).toEqual([['intDoc', null], ['invoice', 25.2]]);
    expect((await vazby()).map((row) => row.typ)).toEqual(['manualLink', 'link']);

    // Mostík 0.18 (protokol 2) hlavičky neposiela — ostanú z posledného prenosu, ktorý ich niesol.
    const stary = await prenos(undefined, manifest('ok', 2026));
    expect(stary.statusCode, stary.body).toBe(200);
    expect(stary.json()).not.toHaveProperty('doklady');
    expect(await hlavicky()).toHaveLength(2);

    // Databáza minulého roka s tým istým id je iný doklad; 2026 sa nedotkne.
    const minuly = await prenos([dobropis], { ...manifest('ok', 2025), databaza: 'StwPh_12345678_2025' });
    expect(minuly.statusCode, minuly.body).toBe(200);
    expect((await hlavicky()).map((row) => [row.zdroj_databaza, row.rok, row.tabulka])).toEqual([
      ['StwPh_12345678_2025', 2025, 'invoice'], [DATABAZA.toLowerCase(), 2026, 'intDoc'], [DATABAZA.toLowerCase(), 2026, 'invoice'],
    ]);
    expect(await vazby()).toHaveLength(4);

    // Hlavičky sa kľúčujú rokom — manifest bez neho je neúplný a nič nezmení.
    const bezRoka = await prenos([dobropis], manifest());
    expect([bezRoka.statusCode, bezRoka.json().message]).toEqual([422, 'Prenos je neúplný: hlavičky dokladov bez roka databázy']);
    expect(await hlavicky()).toHaveLength(3);
  }, 120_000);

  it('otvorené faktúry: žiadosť, prenos nahradí celý zoznam a čítanie pre párovanie', async () => {
    const { app, browser, headers, seeded, agent } = await priprav();
    const ziadost = async () => ((await app.inject({ method: 'GET', url: '/api/agent/organizations', headers })).json() as Array<Record<string, unknown>>)
      .find((organizacia) => organizacia.organizationId === seeded.organizationId)?.openInvoicesSyncRequested;
    expect(await ziadost()).toBe(false);
    const poziadaj = await app.inject({ method: 'POST', url: `/api/mostik/organization-links/${seeded.organizationId}/sync-open-invoices`, headers: browser, payload: {} });
    expect(poziadaj.statusCode, poziadaj.body).toBe(202);
    expect(await ziadost()).toBe(true);

    const faktura = (dokladId: number, zostatok: number) => ({
      agenda: 'FP', dokladId, dokladCislo: `DF2600${dokladId}`, partnerIco: '12345678', partnerNazov: 'Dodavatel s.r.o.', varSymbol: `2600${dokladId}`, suma: 123, zostatok,
    });
    const dobropis = { agenda: 'FV-D', dokladId: 3, mena: 'CZK', sumaMena: -1000, zostatok: -40, zostatokMena: -1000 };
    const prvy = await agent('PUT', 'open-invoices', { databaza: DATABAZA, faktury: [faktura(1, 123), faktura(2, 23.5), dobropis, faktura(2, 23.5)] });
    expect([prvy.statusCode, prvy.json()]).toEqual([200, { ulozenych: 3 }]);
    expect(await ziadost()).toBe(false);

    const citaj = async () => (await app.inject({ method: 'GET', url: `/api/organizations/${seeded.organizationId}/otvorene-faktury`, headers: browser })).json();
    const synchronizovane = expect.any(String);
    expect(await citaj()).toEqual([
      { ...faktura(1, 123), dokladId: undefined, pohodaDokladId: 1, mena: null, sumaMena: null, zostatokMena: null, databaza: DATABAZA, synchronizovane },
      { ...faktura(2, 23.5), dokladId: undefined, pohodaDokladId: 2, mena: null, sumaMena: null, zostatokMena: null, databaza: DATABAZA, synchronizovane },
      { ...dobropis, dokladId: undefined, pohodaDokladId: 3, dokladCislo: null, partnerIco: null, partnerNazov: null, varSymbol: null, suma: null, databaza: DATABAZA, synchronizovane },
    ]);

    // Ďalší prenos nahradí celý zoznam — uhradené faktúry zmiznú.
    expect((await agent('PUT', 'open-invoices', { databaza: DATABAZA, faktury: [faktura(2, 10)] })).statusCode).toBe(200);
    expect(await citaj()).toEqual([expect.objectContaining({ pohodaDokladId: 2, zostatok: 10 })]);
    const telemetria = await app.inject({
      method: 'POST', url: '/api/agent/sync-results', headers,
      payload: { organizationId: seeded.organizationId, kind: 'otvoreneFaktury', state: 'ok', itemCount: 1, durationMs: 1 },
    });
    expect(telemetria.statusCode, telemetria.body).toBe(202);
  }, 120_000);

  it('pamäť: publikácia vymení importované rozhodnutia a vylúčenie dodávateľa ostane', async () => {
    const { app, browser, seeded, agent, publikuj, sql } = await priprav();
    for (const [kind, kod] of [['predkontacie', '518/321'], ['cleneniaDph', 'PD']] as const) {
      await agent('PUT', 'code-lists', { kind, items: [{ kod, nazov: kod }] });
    }
    const rozhodnutie = (ico: string, text: string) => ({ supplierIco: ico, supplierName: `Firma ${ico}`, lineText: text, predkontaciaKod: '518/321', clenenieDphKod: 'PD' });
    await agent('PUT', 'training-decisions', { rows: [rozhodnutie('11111111', 'Prenajom'), rozhodnutie('22222222', 'Servis'), rozhodnutie('44444444', 'Schvalene')], done: false });
    // Rozhodnutie schválené v appke — výmena importu sa ho nesmie dotknúť.
    await sql(`UPDATE ucto_decisions SET source='approved' WHERE organization_id=$1 AND supplier_ico='44444444'`);
    const vylucenie = await app.inject({
      method: 'POST', url: `/api/organizations/${seeded.organizationId}/ai-training/exclude`, headers: browser,
      payload: { supplierIco: '11111111', excluded: true },
    });
    expect(vylucenie.statusCode, vylucenie.body).toBe(200);
    await app.inject({ method: 'POST', url: `/api/mostik/organization-links/${seeded.organizationId}/sync-training`, headers: browser, payload: {} });

    const importId = randomUUID();
    // done=true v dávke žiadosť nezmaže — tú zmaže agent až po všetkých troch publikáciách.
    await agent('PUT', 'training-decisions', { importId, davka: 0, done: true, rows: [rozhodnutie('11111111', 'Prenajom novy'), rozhodnutie('33333333', 'Poistenie')] });
    const pamat = () => sql(`SELECT supplier_ico, source, excluded FROM ucto_decisions WHERE organization_id=$1 ORDER BY supplier_ico`);
    expect((await pamat()).map((row) => row.supplier_ico)).toEqual(['11111111', '22222222', '44444444']);

    const publikacia = await publikuj(importId, { druh: 'pamat', davok: 1, pocet: 2, manifest: manifest() });
    expect([publikacia.statusCode, publikacia.json()]).toEqual([200, { imported: 2, duplicates: 0, rejected: 0 }]);
    expect(await pamat()).toEqual([
      { supplier_ico: '11111111', source: 'import', excluded: true },
      { supplier_ico: '33333333', source: 'import', excluded: false },
      { supplier_ico: '44444444', source: 'approved', excluded: false },
    ]);
    expect(await sql('SELECT training_sync_requested_at IS NOT NULL AS ziadost FROM pohoda_company_links WHERE organization_id=$1'))
      .toEqual([{ ziadost: true }]);
    // Prázdne done=true bez importId žiadosť uzavrie, ako doteraz.
    await agent('PUT', 'training-decisions', { rows: [], done: true });
    expect(await sql('SELECT training_sync_requested_at IS NOT NULL AS ziadost FROM pohoda_company_links WHERE organization_id=$1'))
      .toEqual([{ ziadost: false }]);
  }, 120_000);

  it('denník: publikácia vymení len svoj rok a id proviozky nesie databázu', async () => {
    const { agent, publikuj, sql } = await priprav();
    const dennik = (polozky: Array<{ id: string; datum: string; ucty?: boolean }>) => `<?xml version="1.0" encoding="Windows-1250"?>
<rsp:responsePack version="2.0" state="ok" xmlns:rsp="http://www.stormware.cz/schema/version_2/response.xsd"
  xmlns:lst="http://www.stormware.cz/schema/version_2/list.xsd" xmlns:act="http://www.stormware.cz/schema/version_2/accountancy.xsd"
  xmlns:typ="http://www.stormware.cz/schema/version_2/type.xsd">
  <rsp:responsePackItem version="2.0" state="ok"><lst:listAccountancy version="2.0"><lst:accountancy version="2.0">
  ${polozky.map((polozka) => `<act:accountingItem><act:id>${polozka.id}</act:id><act:source>Prijaté faktúry</act:source>
    <act:number><typ:numberRequested>DF${polozka.id}</typ:numberRequested></act:number><act:text>PHM</act:text>
    ${polozka.ucty === false ? '' : '<act:accounting><act:credit>501200</act:credit><act:debit>321100</act:debit></act:accounting>'}
    <act:date>${polozka.datum}</act:date></act:accountingItem>`).join('')}
  </lst:accountancy></lst:listAccountancy></rsp:responsePackItem>
</rsp:responsePack>`;
    // Starý prenos bez databázy: jeden záznam roka 2025 a jeden 2026.
    expect((await agent('PUT', 'ucto-dennik', { xml: dennik([{ id: '7001', datum: '2025-12-31' }, { id: '9001', datum: '2026-07-31' }]) })).statusCode).toBe(200);

    const importId = randomUUID();
    const strana = await agent('PUT', 'ucto-dennik', {
      importId, davka: 0, xml: dennik([{ id: '9002', datum: '2026-08-01' }, { id: '9003', datum: '2026-08-02', ucty: false }]),
    });
    expect(strana.json()).toEqual({ importId, davka: 0, prijatych: 2 });
    expect((await agent('PUT', 'ucto-dennik', { importId, davka: 1, xml: '<nie-je-xml' })).statusCode).toBe(400);
    const zivy = async () => (await sql('SELECT externalny_id FROM ucto_dennik WHERE organization_id=$1 ORDER BY externalny_id')).map((row) => row.externalny_id);
    expect(await zivy()).toEqual(['7001', '9001']);

    const dennikManifest = { ...manifest('ok', 2026), agendy: [{ poziadavka: 'listAccountancy', stav: 'ok', dokladov: 0, poloziek: 0, riadkov: 2, preskocene: {} }] };
    // Bez roka publikácia nevie, čo vymeniť.
    expect((await publikuj(importId, { druh: 'dennik', davok: 1, pocet: 2, manifest: { ...dennikManifest, rok: undefined } })).statusCode).toBe(400);
    const publikacia = await publikuj(importId, { druh: 'dennik', davok: 1, pocet: 2, manifest: dennikManifest });
    expect(publikacia.statusCode, publikacia.body).toBe(200);
    expect(publikacia.json()).toMatchObject({ ulozenych: 1, preskocene: 1 });
    // Rok 2025 ostal, 2026 je presne z prenosu a id nesie databázu.
    expect(await zivy()).toEqual(['7001', `${DATABAZA}:9002`]);

    // Ručné nahratie alebo starší Mostík (id bez databázy) po publikácii
    // proviozku toho istého roka prepíše, nezdvojí.
    const rucne = await agent('PUT', 'ucto-dennik', { xml: dennik([{ id: '9002', datum: '2026-08-01' }, { id: '7001', datum: '2025-12-31' }]) });
    expect(rucne.statusCode, rucne.body).toBe(200);
    expect(await zivy()).toEqual(['7001', `${DATABAZA}:9002`]);
  }, 120_000);
});

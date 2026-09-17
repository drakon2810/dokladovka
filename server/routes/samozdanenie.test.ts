import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import { buildApp } from '../app.js';
import { MemoryObjectStorage } from '../storage.js';
import { createTestDatabase, potvrdFakt, seedTestUser, testConfig } from '../testHelpers.js';

// Samozdanenie na prijatej faktúre: voľba sa ukladá cez blok dokladu, schválenie
// ju zmrazí do snapshotu a export pošle interné doklady s faktúrou.

const databases: Awaited<ReturnType<typeof createTestDatabase>>[] = [];
afterEach(async () => Promise.all(databases.splice(0).map((database) => database.close())));

type Db = Awaited<ReturnType<typeof createTestDatabase>>;
type Seeded = Awaited<ReturnType<typeof seedTestUser>>;

async function pripravApp() {
  const database = await createTestDatabase();
  databases.push(database);
  const seeded = await seedTestUser(database);
  const app = await buildApp({ database, storage: new MemoryObjectStorage(), config: testConfig(), logger: false });
  const login = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { email: seeded.email, password: seeded.password } });
  const headers = { cookie: String(login.headers['set-cookie']).split(';')[0], 'x-csrf-token': login.json().csrfToken as string };
  const kody: Record<string, string> = {};
  for (const [kind, code] of [
    ['predkontacie', '518/Služby'], ['cleneniaDph', 'PN'], ['ciselneRady', '26FP'],
    ['predkontacie', 'aInt'], ['predkontacie', 'bInt'], ['cleneniaDph', 'DDsl§69'], ['cleneniaDph', 'PDsluz'],
  ]) {
    kody[code] = randomUUID();
    await database.query(
      `INSERT INTO code_list_items (id,tenant_id,organization_id,kind,code,name,source) VALUES ($1,$2,$3,$4,$5,$5,'pohoda')`,
      [kody[code], seeded.tenantId, seeded.organizationId, kind, code],
    );
  }
  await potvrdFakt(database, seeded, 'dph.status', { status: 'platitel' });
  return { database, seeded, app, headers, kody };
}

async function vlozFakturu(database: Db, seeded: Seeded, kody: Record<string, string>, dodavatel = { nazov: 'Google Ireland Ltd', icDph: 'IE6388047V', krajina: 'IE' }) {
  const id = randomUUID();
  await database.query(
    `INSERT INTO documents (id,tenant_id,organization_id,document_type,status,processing_status,extracted,accounting,total_amount,currency)
     VALUES ($1,$2,$3,'FP','na_kontrole','ready_for_review',$4::jsonb,$5::jsonb,1000,'EUR')`,
    [id, seeded.tenantId, seeded.organizationId,
      JSON.stringify({
        dodavatel, odberatel: {}, cisloFaktury: `53${id.slice(0, 6)}`,
        datumVystavenia: '2026-06-12', datumDodania: '2026-06-10', datumSplatnosti: '2026-06-26',
        mena: 'EUR', rozpisDph: [{ sadzba: 0, zaklad: 1000, dph: 0 }], sumaSpolu: 1000, polozky: [],
      }),
      JSON.stringify({ predkontaciaId: kody['518/Služby'], clenenieDphId: kody.PN, ciselnyRadId: kody['26FP'] })],
  );
  return id;
}

const KODY_SLUZIEB = { interny: { ddKod: 'DDsl§69', ddPredkontaciaKod: 'aInt', pKod: 'PDsluz', pPredkontaciaKod: 'bInt', kv: 'B1' } };

describe('samozdanenie — schválenie', () => {
  it('bez kódov druhu v profile 409; s kódmi zapíše predvolenú voľbu, zmrazí výpočet a uzamkne blok', async () => {
    const { database, seeded, app, headers, kody } = await pripravApp();
    const id = await vlozFakturu(database, seeded, kody);
    const schval = () => app.inject({ method: 'POST', url: `/api/documents/${id}/approve`, headers, payload: { expectedVersion: 1 } });

    const bezKodov = await schval();
    expect(bezKodov.statusCode, bezKodov.body).toBe(409);
    expect(bezKodov.json()).toMatchObject({ code: 'samozdanenie_neuplne' });
    expect(bezKodov.json().message).toContain('v profile klienta');

    await potvrdFakt(database, seeded, 'samozdanenie.sluzby_eu', KODY_SLUZIEB);
    const blok = await app.inject({ method: 'GET', url: `/api/documents/${id}/samozdanenie`, headers: { cookie: headers.cookie } });
    expect(blok.json().blok).toMatchObject({
      upravitelny: true, dodavatel: 'Google Ireland Ltd', chyby: [],
      hodnota: { volba: 'vytvorit', zdroj: 'predvolene', druh: 'sluzby_eu', zaklad: 1000, dan: 230, odpocet: 230 },
    });

    const schvalene = await schval();
    expect(schvalene.statusCode, schvalene.body).toBe(200);
    const riadok = (await database.query<Record<string, any>>('SELECT samozdanenie, approved_snapshot FROM documents WHERE id=$1', [id])).rows[0];
    expect(riadok.samozdanenie).toMatchObject({ volba: 'vytvorit', datumDanovejPovinnosti: '2026-06-10', dan: 230, interny: KODY_SLUZIEB.interny });
    expect(riadok.approved_snapshot.samozdanenie).toEqual(riadok.samozdanenie);
    const oprava = (await database.query<Record<string, any>>('SELECT zmenene, navrhnute FROM ucto_opravy WHERE document_id=$1', [id])).rows[0];
    expect(oprava.zmenene).not.toContain('samozdanenie');
    expect(oprava.navrhnute.samozdanenie).toBe('vytvorit');

    const zamknuty = await app.inject({ method: 'PUT', url: `/api/documents/${id}/samozdanenie`, headers, payload: { volba: 'v_pohode' } });
    expect(zamknuty.statusCode).toBe(409);
    await app.close();
  }, 120_000);

  it('voľba proti predvolenej je oprava; pamäť dodávateľa a nastavenie firmy sa uložia s voľbou', async () => {
    const { database, seeded, app, headers, kody } = await pripravApp();
    const prva = await vlozFakturu(database, seeded, kody);
    const uloz = (id: string, payload: Record<string, unknown>) => app.inject({ method: 'PUT', url: `/api/documents/${id}/samozdanenie`, headers, payload });

    // Nevzniká povinnosť: bez dôvodu sa schváliť nedá, s dôvodom sa zapamätá dodávateľ.
    expect((await uloz(prva, { volba: 'nevznika', pamatatDodavatela: true })).json().blok.chyby).toEqual(['dovod']);
    const bezDovodu = await app.inject({ method: 'POST', url: `/api/documents/${prva}/approve`, headers, payload: { expectedVersion: 1 } });
    expect(bezDovodu.statusCode).toBe(409);
    const sDovodom = await uloz(prva, { volba: 'nevznika', dovod: 'miesto_dodania', pamatatDodavatela: true });
    expect(sDovodom.statusCode, sDovodom.body).toBe(200);
    expect(sDovodom.json().blok).toMatchObject({ pamatDodavatela: true, hodnota: { volba: 'nevznika', zdroj: 'uctovnik' } });

    const druha = await vlozFakturu(database, seeded, kody);
    const predvolena = await app.inject({ method: 'GET', url: `/api/documents/${druha}/samozdanenie`, headers: { cookie: headers.cookie } });
    expect(predvolena.json().blok.hodnota).toMatchObject({ volba: 'nevznika', zdroj: 'dodavatel', dovod: 'miesto_dodania' });
    const schvalena = await app.inject({ method: 'POST', url: `/api/documents/${druha}/approve`, headers, payload: { expectedVersion: 1 } });
    expect(schvalena.statusCode, schvalena.body).toBe(200);

    // Už zaúčtované v POHODE bez nastavenia firmy: oprava proti predvolenej voľbe.
    const tretia = await vlozFakturu(database, seeded, kody, { nazov: 'Slack Technologies', icDph: '', krajina: 'US' });
    expect((await uloz(tretia, { volba: 'v_pohode', cislaInternych: 'INT0042' })).statusCode).toBe(200);
    expect((await app.inject({ method: 'POST', url: `/api/documents/${tretia}/approve`, headers, payload: { expectedVersion: 1 } })).statusCode).toBe(200);
    const oprava = (await database.query<Record<string, any>>('SELECT zmenene, schvalene FROM ucto_opravy WHERE document_id=$1', [tretia])).rows[0];
    expect(oprava.zmenene).toContain('samozdanenie');
    expect(oprava.schvalene.samozdanenie).toBe('v_pohode');

    // „Takto to robíme pri všetkých faktúrach" → fakt profilu a predvoľba ďalšej faktúry.
    const stvrta = await vlozFakturu(database, seeded, kody, { nazov: 'Slack Technologies', icDph: '', krajina: 'US' });
    expect((await uloz(stvrta, { volba: 'v_pohode', vsetkyFaktury: true })).json().blok.robimeVPohode).toBe(true);
    const fakt = (await database.query<Record<string, any>>(
      `SELECT stav, hodnota FROM profil_fakty WHERE organization_id=$1 AND kluc='samozdanenie.postup'`, [seeded.organizationId],
    )).rows[0];
    expect(fakt).toEqual({ stav: 'potvrdene', hodnota: { postup: 'v_pohode' } });
    const piata = await vlozFakturu(database, seeded, kody, { nazov: 'Atlassian', icDph: '', krajina: 'AU' });
    const blok = await app.inject({ method: 'GET', url: `/api/documents/${piata}/samozdanenie`, headers: { cookie: headers.cookie } });
    expect(blok.json().blok.hodnota).toMatchObject({ volba: 'v_pohode', zdroj: 'firma' });

    // Pamätať vypnuté: dodávateľ sa zabudne.
    await uloz(prva, { volba: 'nevznika', dovod: 'miesto_dodania', pamatatDodavatela: false });
    const pamat = await database.query('SELECT 1 FROM samozdanenie_dodavatelia WHERE organization_id=$1', [seeded.organizationId]);
    expect(pamat.rowCount).toBe(0);
    await app.close();
  }, 120_000);
});

describe('samozdanenie — druh z praxe dodávateľa', () => {
  /** Interné doklady dodávateľa v histórii POHODY — rodinu nesie DD kód. */
  const vlozPrax = async (database: Db, seeded: Seeded, kody: string[], datum = '2026-05-01', meno = 'google ireland ltd') => {
    for (const [poradie, kod] of kody.entries()) {
      await database.query(
        `INSERT INTO ucto_historia
          (id,tenant_id,organization_id,agenda,doklad_cislo,datum,line_text_normalized,clenenie_dph_kod,source,riadok_hash)
         VALUES ($1,$2,$3,'INT',$4,$5::date,'vymeranie dane',$6,'mdb',$1)`,
        [randomUUID(), seeded.tenantId, seeded.organizationId, `INT-${datum}-${poradie}`, datum, kod],
      );
    }
    await database.query(
      `UPDATE ucto_historia SET supplier_name_normalized=$1 WHERE tenant_id=$2 AND organization_id=$3`,
      [meno, seeded.tenantId, seeded.organizationId],
    );
  };

  it('päť jednomyseľných dokladov určí tovar z EÚ; menej ani nejednotná prax nie', async () => {
    const { database, seeded, app, headers, kody } = await pripravApp();
    const id = await vlozFakturu(database, seeded, kody);
    const druh = async () => (await app.inject({
      method: 'GET', url: `/api/documents/${id}/samozdanenie`, headers: { cookie: headers.cookie },
    })).json().blok.hodnota.druh;

    // Bez histórie ostáva územie: dodávateľ z EÚ = služby.
    expect(await druh()).toBe('sluzby_eu');

    // Štyri doklady sú príklad, nie prax.
    await vlozPrax(database, seeded, ['DDnadEU', 'DDnadEU', 'DDnadEU', 'DDnadEU']);
    expect(await druh()).toBe('sluzby_eu');

    // Piaty doklad prax dokončí.
    await vlozPrax(database, seeded, ['DDnadEU'], '2026-05-02');
    expect(await druh()).toBe('tovar_eu');

    // Jediný servisný doklad toho istého dodávateľa prax zneistí — späť na územie.
    await vlozPrax(database, seeded, ['DDsl§69'], '2026-05-03');
    expect(await druh()).toBe('sluzby_eu');
    await app.close();
  }, 120_000);

  it('meno s inou interpunkciou sa spáruje a navrhnuté kódy sa potvrdia z dokladu', async () => {
    const { database, seeded, app, headers, kody } = await pripravApp();
    // POHODA má „ROFA Laboratory & Process Analyzers GmbH", faktúra „ROFA - …, GmbH".
    const id = await vlozFakturu(database, seeded, kody,
      { nazov: 'ROFA - Laboratory & Process Analyzers, GmbH', icDph: 'ATU74777039', krajina: 'AT' });
    await vlozPrax(database, seeded, ['DDnadEU', 'DDnadEU', 'DDnadEU', 'DDnadEU', 'DDnadEU'],
      '2026-05-01', 'rofa laboratory & process analyzers gmbh');
    // Profil druh navrhuje z histórie, ale potvrdený nie je — náhľad ho ukáže našedo.
    await database.query(
      `INSERT INTO profil_fakty (organization_id,tenant_id,kluc,stav,hodnota,zdroj)
       VALUES ($1,$2,'samozdanenie.tovar_eu','navrhnute',$3::jsonb,'historia')`,
      [seeded.organizationId, seeded.tenantId, JSON.stringify({ interny: { ddKod: 'DDsl§69', ddPredkontaciaKod: 'aInt', pKod: 'PDsluz', pPredkontaciaKod: 'bInt', kv: 'B1' } })],
    );
    const prvy = await app.inject({ method: 'GET', url: `/api/documents/${id}/samozdanenie`, headers: { cookie: headers.cookie } });
    expect(prvy.json().blok).toMatchObject({
      chyby: ['kody'], hodnota: { druh: 'tovar_eu' },
      navrhKodov: { ddKod: 'DDsl§69', pKod: 'PDsluz' },
    });

    const potvrdene = await app.inject({ method: 'POST', url: `/api/documents/${id}/samozdanenie/kody`, headers });
    expect(potvrdene.statusCode, potvrdene.body).toBe(200);
    expect(potvrdene.json().blok.navrhKodov).toBeUndefined();
    expect(potvrdene.json().blok).toMatchObject({
      chyby: [],
      hodnota: { druh: 'tovar_eu', interny: { ddKod: 'DDsl§69', ddPredkontaciaKod: 'aInt' } },
    });
    const fakt = (await database.query<Record<string, any>>(
      'SELECT stav FROM profil_fakty WHERE organization_id=$1 AND kluc=$2',
      [seeded.organizationId, 'samozdanenie.tovar_eu'],
    )).rows[0];
    expect(fakt.stav).toBe('potvrdene');
    await app.close();
  }, 120_000);

  it('prax po dátume dodania sa nepočíta', async () => {
    const { database, seeded, app, headers, kody } = await pripravApp();
    const id = await vlozFakturu(database, seeded, kody);
    // Doklad je z 10. 6. 2026; prax vznikla až v júli, takže ju vidieť nemá.
    await vlozPrax(database, seeded, ['DDnadEU', 'DDnadEU', 'DDnadEU', 'DDnadEU', 'DDnadEU'], '2026-07-01');
    const blok = await app.inject({ method: 'GET', url: `/api/documents/${id}/samozdanenie`, headers: { cookie: headers.cookie } });
    expect(blok.json().blok.hodnota.druh).toBe('sluzby_eu');
    await app.close();
  }, 120_000);
});

describe('samozdanenie — prenos cez Mostík', () => {
  it('faktúra a dva interné doklady; opakovaný prenos pošle len nepotvrdený doklad', async () => {
    const { database, seeded, app, headers, kody } = await pripravApp();
    await potvrdFakt(database, seeded, 'samozdanenie.sluzby_eu', KODY_SLUZIEB);
    const id = await vlozFakturu(database, seeded, kody);
    expect((await app.inject({ method: 'POST', url: `/api/documents/${id}/approve`, headers, payload: { expectedVersion: 1 } })).statusCode).toBe(200);

    await app.inject({ method: 'PUT', url: '/api/mostik/settings', headers, payload: { enabled: true } });
    const pairing = await app.inject({ method: 'POST', url: '/api/mostik/pairing-codes', headers, payload: { organizationId: seeded.organizationId } });
    const paired = await app.inject({
      method: 'POST', url: '/api/agent/pair',
      payload: { pairingCode: pairing.json().code as string, hostname: 'POHODA-SRV', agentVersion: '1.0.0', companyIco: '12345678' },
    });
    const agentHeaders = { authorization: `Bearer ${paired.json().agentToken as string}` };
    await database.query('UPDATE pohoda_company_links SET matched_at=now() WHERE organization_id=$1', [seeded.organizationId]);

    const prenos = async (payload: Record<string, unknown>, url = '/api/mostik/export-jobs') => {
      const job = await app.inject({ method: 'POST', url, headers, payload });
      expect(job.statusCode, job.body).toBe(201);
      const fronta = await app.inject({ method: 'GET', url: `/api/agent/export-queue?organizationId=${seeded.organizationId}`, headers: agentHeaders });
      return { jobId: job.json().id as string, xml: fronta.json()[0].dataPackXml as string };
    };
    const vysledok = (exportJobId: string, perDocument: unknown[]) => app.inject({
      method: 'POST', url: '/api/agent/export-results', headers: agentHeaders, payload: { exportJobId, perDocument, rawResponseMeta: {} },
    });
    const polozky = (xml: string) => [...xml.matchAll(/<dat:dataPackItem id="([^"]+)"/g)].map((zhoda) => zhoda[1]);

    const prvy = await prenos({ organizationId: seeded.organizationId, documentIds: [id] });
    expect(polozky(prvy.xml)).toEqual([id, `${id}-sz-dd`, `${id}-sz-p`]);
    // Výsledok musí obsahovať presne položky dataPacku.
    expect((await vysledok(prvy.jobId, [{ documentId: id, state: 'ok' }])).statusCode).toBe(400);
    const prvyVysledok = await vysledok(prvy.jobId, [
      { documentId: id, state: 'ok', pohodaNumber: '26FP0001' },
      { documentId: `${id}-sz-dd`, state: 'ok', pohodaNumber: 'INT0001' },
      { documentId: `${id}-sz-p`, state: 'error', message: 'Členenie DPH neexistuje' },
    ]);
    expect(prvyVysledok.json()).toMatchObject({ accepted: true, status: 'failed' });
    const poPrvom = (await database.query<Record<string, any>>('SELECT status, samozdanenie FROM documents WHERE id=$1', [id])).rows[0];
    expect(poPrvom.status).toBe('chyba');
    expect(poPrvom.samozdanenie.export).toMatchObject({
      faktura: { stav: 'ok', cislo: '26FP0001' }, dd: { stav: 'ok', cislo: 'INT0001' }, p: { stav: 'chyba', sprava: 'Členenie DPH neexistuje' },
    });

    // Doklad s chybou prenosu aj po „Spracovať ručne" má voľbu uzamknutú a
    // opätovné schválenie nezabudne, čo POHODA už prijala.
    const uloz = () => app.inject({ method: 'PUT', url: `/api/documents/${id}/samozdanenie`, headers, payload: { volba: 'v_pohode' } });
    const blok = await app.inject({ method: 'GET', url: `/api/documents/${id}/samozdanenie`, headers: { cookie: headers.cookie } });
    expect(blok.json().blok).toMatchObject({ upravitelny: false, hodnota: { volba: 'vytvorit', export: { faktura: { stav: 'ok' } } } });
    expect((await uloz()).statusCode).toBe(409);
    expect((await app.inject({ method: 'POST', url: `/api/documents/${id}/process-manually`, headers })).statusCode).toBe(200);
    expect((await uloz()).statusCode).toBe(409);
    const verzia = (await database.query<Record<string, any>>('SELECT version FROM documents WHERE id=$1', [id])).rows[0].version;
    const znova = await app.inject({ method: 'POST', url: `/api/documents/${id}/approve`, headers, payload: { expectedVersion: verzia } });
    expect(znova.statusCode, znova.body).toBe(200);

    const druhy = await prenos({}, `/api/mostik/export-jobs/${prvy.jobId}/retry`);
    expect(polozky(druhy.xml)).toEqual([`${id}-sz-p`]);
    const druhyVysledok = await vysledok(druhy.jobId, [{ documentId: `${id}-sz-p`, state: 'ok', pohodaNumber: 'INT0002' }]);
    expect(druhyVysledok.json()).toMatchObject({ accepted: true, status: 'confirmed' });
    const poDruhom = (await database.query<Record<string, any>>('SELECT status, samozdanenie FROM documents WHERE id=$1', [id])).rows[0];
    expect(poDruhom.status).toBe('exportovany');
    expect(poDruhom.samozdanenie.export.p).toMatchObject({ stav: 'ok', cislo: 'INT0002' });
    await app.close();
  }, 120_000);
});

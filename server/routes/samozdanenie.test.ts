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
    // Prepis kódov na doklade a účty, z ktorých sa učí rodina plnenia.
    ['predkontacie', 'cInt'], ['cleneniaDph', 'DDnadEU'], ['cleneniaDph', 'PDnadEU'],
    ['predkontacie', '131100'], ['predkontacie', '501100'],
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

async function vlozFakturu(
  database: Db, seeded: Seeded, kody: Record<string, string>,
  dodavatel = { nazov: 'Google Ireland Ltd', icDph: 'IE6388047V', krajina: 'IE' },
  predkontacia = '518/Služby',
) {
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
      JSON.stringify({ predkontaciaId: kody[predkontacia], clenenieDphId: kody.PN, ciselnyRadId: kody['26FP'] })],
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

describe('samozdanenie — druh z účtu dokladu', () => {
  /**
   * Prax firmy „účet → tovar/služba", naučená z OSTATNÝCH dodávateľov: faktúry
   * na tom istom účte dajú zoznam dodávateľov, ich interné doklady rodinu.
   */
  const vlozPraxUctu = async (database: Db, seeded: Seeded, ucet: string, ddKod: string, dokladov = 5) => {
    for (let poradie = 0; poradie < dokladov; poradie += 1) {
      const partner = `dodavatel ${ucet} ${poradie}`;
      for (const [agenda, pk, dph] of [['FP', ucet, null], ['INT', null, ddKod]] as const) {
        await database.query(
          `INSERT INTO ucto_historia
            (id,tenant_id,organization_id,agenda,doklad_cislo,datum,line_text_normalized,
             predkontacia_kod,clenenie_dph_kod,supplier_name_normalized,source,riadok_hash)
           VALUES ($1,$2,$3,$4,$5,'2026-05-01'::date,'polozka',$6,$7,$8,'mdb',$1)`,
          [randomUUID(), seeded.tenantId, seeded.organizationId, agenda, `${agenda}-${ucet}-${poradie}`, pk, dph, partner],
        );
      }
    }
  };

  it('Green Lab: dodávateľ bez praxe, účet 131 naučený z iných dodávateľov → tovar z EÚ', async () => {
    const { database, seeded, app, headers, kody } = await pripravApp();
    // Faktúra za „Silica Gel" z Maďarska na 124 € bez DPH; v histórii má
    // dodávateľ jediný doklad, takže prax dodávateľa sa nevyjadrí.
    const greenLab = { nazov: 'Green Lab Magyarország Mérnöki Iroda Kft.', icDph: 'HU12345678', krajina: 'HU' };
    const id = await vlozFakturu(database, seeded, kody, greenLab, '131100');
    const druh = async (query = '') => (await app.inject({
      method: 'GET', url: `/api/documents/${id}/samozdanenie${query}`, headers: { cookie: headers.cookie },
    })).json().blok.hodnota.druh;

    // Bez naučeného účtu odpovedá územie — presne to sa stalo vlastníkovi.
    expect(await druh()).toBe('sluzby_eu');
    await vlozPraxUctu(database, seeded, '131100', 'DDnadEU');
    expect(await druh()).toBe('tovar_eu');

    // Štyri doklady na účte sú príklad, nie prax.
    const bezDokladov = await vlozFakturu(database, seeded, kody, greenLab, '501100');
    await vlozPraxUctu(database, seeded, '501100', 'DDnadEU', 4);
    const maly = await app.inject({ method: 'GET', url: `/api/documents/${bezDokladov}/samozdanenie`, headers: { cookie: headers.cookie } });
    expect(maly.json().blok.hodnota.druh).toBe('sluzby_eu');

    // Účet z rozpracovaného editora: doklad ho uložený nemá, ale rodina ho
    // musí sledovať už teraz — inak by sa zmenila až pri schválení.
    const bezUctu = await vlozFakturu(database, seeded, kody, greenLab, 'nic');
    const cerstvy = await app.inject({
      method: 'GET', url: `/api/documents/${bezUctu}/samozdanenie?predkontaciaId=${kody['131100']}`, headers: { cookie: headers.cookie },
    });
    expect(cerstvy.json().blok.hodnota.druh).toBe('tovar_eu');
    // Bez účtu (ani na doklade, ani z editora) rozhoduje územie.
    const sirota = await app.inject({ method: 'GET', url: `/api/documents/${bezUctu}/samozdanenie`, headers: { cookie: headers.cookie } });
    expect(sirota.json().blok.hodnota.druh).toBe('sluzby_eu');
    await app.close();
  }, 120_000);

  it('ten istý účet znamená službu v inej firme; nezhoda s praxou dodávateľa sa nevyjadrí', async () => {
    const { database, seeded, app, headers, kody } = await pripravApp();
    // Účet 501 je tovar v ROFE, ale služba v SLO SERVICES — mapa je vždy na
    // firmu, globálna tabuľka účtov by bola nesprávna.
    const id = await vlozFakturu(database, seeded, kody,
      { nazov: 'Green Lab Kft.', icDph: 'HU12345678', krajina: 'HU' }, '501100');
    await vlozPraxUctu(database, seeded, '501100', 'DDsl§69');
    const blok = await app.inject({ method: 'GET', url: `/api/documents/${id}/samozdanenie`, headers: { cookie: headers.cookie } });
    expect(blok.json().blok.hodnota.druh).toBe('sluzby_eu');

    // Dodávateľ s vlastnou praxou na tovar proti účtu na službu: ani jeden
    // signál nerozhodne a ostane územie (inak by hrozilo zlé členenie a KV).
    const sPraxou = await vlozFakturu(database, seeded, kody,
      { nazov: 'Parr Instrument GmbH', icDph: 'ATU74777039', krajina: 'AT' }, '501100');
    for (let poradie = 0; poradie < 5; poradie += 1) {
      await database.query(
        `INSERT INTO ucto_historia
          (id,tenant_id,organization_id,agenda,doklad_cislo,datum,line_text_normalized,clenenie_dph_kod,supplier_name_normalized,source,riadok_hash)
         VALUES ($1,$2,$3,'INT',$4,'2026-05-01'::date,'vymeranie dane','DDnadEU','parr instrument gmbh','mdb',$1)`,
        [randomUUID(), seeded.tenantId, seeded.organizationId, `INT-parr-${poradie}`],
      );
    }
    const nezhoda = await app.inject({ method: 'GET', url: `/api/documents/${sPraxou}/samozdanenie`, headers: { cookie: headers.cookie } });
    expect(nezhoda.json().blok.hodnota.druh).toBe('sluzby_eu');
    await app.close();
  }, 120_000);
});

describe('samozdanenie — prepis kódov a základu na doklade', () => {
  it('prepis sa uloží, dostane sa do exportu a kód v zlej úlohe server odmietne', async () => {
    const { database, seeded, app, headers, kody } = await pripravApp();
    await potvrdFakt(database, seeded, 'samozdanenie.sluzby_eu', KODY_SLUZIEB);
    const id = await vlozFakturu(database, seeded, kody);
    const uloz = (payload: Record<string, unknown>) =>
      app.inject({ method: 'PUT', url: `/api/documents/${id}/samozdanenie`, headers, payload });

    // Kód odpočtu na riadku vymerania a sekcia KV mimo rodiny samozdanenia.
    const zlyDd = await uloz({ volba: 'vytvorit', rucne: { interny: { ddKod: 'PDsluz' } } });
    expect(zlyDd.statusCode, zlyDd.body).toBe(400);
    expect(zlyDd.json()).toMatchObject({ code: 'samozdanenie_kod_zla_rola' });
    expect(zlyDd.json().message).toContain('nie je daň na výstupe');
    expect((await uloz({ volba: 'vytvorit', rucne: { interny: { pKod: 'DDsl§69' } } })).json().message).toContain('nie je odpočet');
    expect((await uloz({ volba: 'vytvorit', rucne: { interny: { ddKv: 'A1' } } })).json().message).toContain('Sekcia KV A1');
    // Kód, ktorý firma v číselníku aktívny nemá, sa neuloží ani potichu.
    const neznamy = await uloz({ volba: 'vytvorit', rucne: { interny: { ddPredkontaciaKod: 'zzInt' } } });
    expect(neznamy.statusCode).toBe(400);
    expect(neznamy.json().message).toContain('nie sú aktívne v číselníku firmy');

    // Prijatý prepis: iná predkontácia vymerania, iná sekcia KV odpočtu, vlastný základ.
    const ulozeny = await uloz({
      volba: 'vytvorit',
      rucne: { interny: { ddPredkontaciaKod: 'cInt', pKv: 'KN' }, zaklad: 400 },
    });
    expect(ulozeny.statusCode, ulozeny.body).toBe(200);
    expect(ulozeny.json().blok).toMatchObject({
      zakladDokladu: 1000,
      hodnota: { zaklad: 400, dan: 92, interny: { ddPredkontaciaKod: 'cInt', pPredkontaciaKod: 'bInt', kv: 'B1', pKv: 'KN' } },
    });

    // Schválenie prepis zmrazí do snapshotu a export ho pošle do POHODY.
    expect((await app.inject({ method: 'POST', url: `/api/documents/${id}/approve`, headers, payload: { expectedVersion: 1 } })).statusCode).toBe(200);
    const snapshot = (await database.query<Record<string, any>>('SELECT approved_snapshot FROM documents WHERE id=$1', [id])).rows[0];
    expect(snapshot.approved_snapshot.samozdanenie).toMatchObject({ zaklad: 400, interny: { ddPredkontaciaKod: 'cInt', pKv: 'KN' } });

    const export_ = await app.inject({
      method: 'POST', url: '/api/exports/pohoda/xml', headers,
      payload: { organizationId: seeded.organizationId, documentIds: [id] },
    });
    expect(export_.statusCode, export_.body).toBe(201);
    const xml = export_.json().xml as string;
    const interny = (rola: string) => xml.slice(xml.indexOf(`id="${id}-sz-${rola}"`)).split('</dat:dataPackItem>')[0];
    expect(interny('dd')).toContain('<int:accounting><typ:ids>cInt</typ:ids></int:accounting>');
    expect(interny('dd')).toContain('<typ:ids>B1</typ:ids>');
    expect(interny('dd')).toContain('<typ:unitPrice>400.00</typ:unitPrice>');
    // Sekcia KV odpočtu je vlastná — pred prepisom ju oba riadky mali spoločnú.
    expect(interny('p')).toContain('<int:accounting><typ:ids>bInt</typ:ids></int:accounting>');
    expect(interny('p')).toContain('<typ:ids>KN</typ:ids>');
    expect(interny('p')).not.toContain('<typ:ids>B1</typ:ids>');
    await app.close();
  }, 120_000);
});

/**
 * Prax firmy s radom interných dokladov samozdanenia: rad 26SAM z troch
 * dokladov histórie (agenda INT, členenie strany DD) proti predvoľbe interných
 * dokladov, ktorá ukazuje na preúčtovanie DPH.
 *
 * Prvý ostrý import AGS pridelil 26DPH02 a 26DPH03: predvoľba MZDY nebola
 * žiadna, <int:number> sa vynechal a POHODA doklady očíslovala zo svojho
 * predvoleného radu agendy („26DPH — Preúčtovanie DPH"). Samozdanenie pritom
 * AGS vedie v rade 26SAM (158 dokladov).
 */
async function seedRadSamozdanenia(database: Db, seeded: Seeded) {
  const kde = [seeded.tenantId, seeded.organizationId];
  const rad = async (kod: string, nazov: string, ext: string) => {
    const id = randomUUID();
    await database.query(
      `INSERT INTO code_list_items (id,tenant_id,organization_id,kind,code,name,source,agenda,external_id,accounting_year)
       VALUES ($1,$2,$3,'ciselneRady',$4,$5,'pohoda','interni_doklady',$6,'2026')`,
      [id, ...kde, kod, nazov, ext],
    );
    return id;
  };
  const radDph = await rad('26DPH', 'Preúčtovanie DPH', '656');
  await rad('26SAM', 'Samozdanenie', '627');
  await database.query(
    `INSERT INTO organization_series_defaults (organization_id,tenant_id,document_type,ciselny_rad_id)
     VALUES ($2,$1,'MZDY',$3)`,
    [...kde, radDph],
  );
  for (const den of ['07', '08', '09']) {
    await database.query(
      `INSERT INTO ucto_historia
        (id,tenant_id,organization_id,agenda,doklad_cislo,datum,line_text_normalized,clenenie_dph_kod,
         riadok_index,source,riadok_hash,rad_external_id,rad_kod)
       VALUES ($1,$2,$3,'INT',$4,$5::date,'vymeranie dph','DDsl§69',0,'mdb',$6,'627','26SAM')`,
      [randomUUID(), ...kde, `26SAM${den}`, `2026-01-${den}`, randomUUID()],
    );
  }
}

describe('samozdanenie — číselný rad interných dokladov', () => {
  it('rad ide z histórie samozdanenia, nie z predvoľby interných dokladov', async () => {
    const { database, seeded, app, headers, kody } = await pripravApp();
    await potvrdFakt(database, seeded, 'samozdanenie.sluzby_eu', KODY_SLUZIEB);
    await seedRadSamozdanenia(database, seeded);

    const id = await vlozFakturu(database, seeded, kody);
    expect((await app.inject({ method: 'POST', url: `/api/documents/${id}/approve`, headers, payload: { expectedVersion: 1 } })).statusCode).toBe(200);
    const odpoved = await app.inject({
      method: 'POST', url: '/api/exports/pohoda/xml', headers,
      payload: { organizationId: seeded.organizationId, documentIds: [id] },
    });
    expect(odpoved.statusCode, odpoved.body).toBe(201);
    const xml = odpoved.json().xml as string;
    const interny = (rola: string) => xml.slice(xml.indexOf(`id="${id}-sz-${rola}"`)).split('</dat:dataPackItem>')[0];
    for (const rola of ['dd', 'p']) {
      expect(interny(rola)).toContain('<int:number><typ:ids>26SAM</typ:ids></int:number>');
      expect(interny(rola)).not.toContain('26DPH');
    }
    await app.close();
  }, 120_000);
});

describe('samozdanenie — prenos cez Mostík', () => {
  it('faktúra a dva interné doklady; opakovaný prenos pošle len nepotvrdený doklad', async () => {
    const { database, seeded, app, headers, kody } = await pripravApp();
    await potvrdFakt(database, seeded, 'samozdanenie.sluzby_eu', KODY_SLUZIEB);
    await seedRadSamozdanenia(database, seeded);
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
    expect(prvy.xml.match(/<int:number><typ:ids>26SAM<\/typ:ids><\/int:number>/g)).toHaveLength(2);
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
    // Odpočet ide do toho istého radu ako vymeranie, ktoré POHODA už prijala —
    // inak by dva interné doklady jednej faktúry skončili v rôznych radoch.
    expect(druhy.xml).toContain('<int:number><typ:ids>26SAM</typ:ids></int:number>');
    const druhyVysledok = await vysledok(druhy.jobId, [{ documentId: `${id}-sz-p`, state: 'ok', pohodaNumber: 'INT0002' }]);
    expect(druhyVysledok.json()).toMatchObject({ accepted: true, status: 'confirmed' });
    const poDruhom = (await database.query<Record<string, any>>('SELECT status, samozdanenie FROM documents WHERE id=$1', [id])).rows[0];
    expect(poDruhom.status).toBe('exportovany');
    expect(poDruhom.samozdanenie.export.p).toMatchObject({ stav: 'ok', cislo: 'INT0002' });
    await app.close();
  }, 120_000);
});

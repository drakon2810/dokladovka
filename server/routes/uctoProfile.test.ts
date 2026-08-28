import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { maybeAiAccountingSuggestion } from '../services/accountingSuggestionService.js';
import {
  agregujHistoriu,
  analyzujUctovnyProfil,
  deleteUctoKategoria,
  listUctoKategorie,
  updateUctoKategoria,
} from '../services/uctoProfileService.js';
import {
  backfillHistoryFromDecisions,
  historyStats,
  importUctoHistory,
} from '../services/uctoHistoryService.js';
import { aiOdpoved, createTestDatabase, seedTestUser, testConfig } from '../testHelpers.js';

const databases: Awaited<ReturnType<typeof createTestDatabase>>[] = [];
afterEach(async () => Promise.all(databases.splice(0).map((database) => database.close())));

async function seedCodeLists(
  database: Awaited<ReturnType<typeof createTestDatabase>>,
  seeded: { tenantId: string; organizationId: string },
  kody: Array<[string, string]>,
): Promise<Map<string, string>> {
  const ids = new Map<string, string>();
  for (const [kind, code] of kody) {
    const id = randomUUID();
    await database.query(
      `INSERT INTO code_list_items (id,tenant_id,organization_id,kind,code,name,source)
       VALUES ($1,$2,$3,$4,$5,$5,'pohoda')`,
      [id, seeded.tenantId, seeded.organizationId, kind, code],
    );
    ids.set(`${kind}:${code}`, id);
  }
  return ids;
}

describe('účtovný profil firmy', () => {
  it('import histórie je idempotentný, neznámy kód ostane ako text', async () => {
    const database = await createTestDatabase();
    databases.push(database);
    const seeded = await seedTestUser(database);
    await seedCodeLists(database, seeded, [['predkontacie', '518/321'], ['cleneniaDph', 'PD']]);

    const rows = [
      { agenda: 'FP' as const, lineText: 'Preprava tovaru Koper', predkontaciaKod: '518/321', clenenieDphKod: 'PD', clenenieKvKod: 'B2', suma: 120 },
      { agenda: 'PD' as const, lineText: 'Kolok', predkontaciaKod: 'NEEXISTUJE', clenenieDphKod: 'PD' },
      { agenda: 'FP' as const, lineText: 'Riadok bez zaúčtovania' },
    ];
    const prvy = await importUctoHistory(database, { ...seeded, rows, source: 'mdb' });
    expect(prvy).toMatchObject({ imported: 2, duplicates: 0, bezKodu: 1 });

    // Opakovaný import tej istej dávky nezaloží duplicity.
    const druhy = await importUctoHistory(database, { ...seeded, rows, source: 'mdb' });
    expect(druhy).toMatchObject({ imported: 0, duplicates: 2 });

    // Riadok s neznámym kódom sa NEZAHODÍ — kód ostane, id je prázdne.
    const neznamy = await database.query<Record<string, any>>(
      `SELECT predkontacia_kod, predkontacia_id FROM ucto_historia WHERE line_text_normalized='kolok'`,
    );
    expect(neznamy.rows[0]).toMatchObject({ predkontacia_kod: 'NEEXISTUJE', predkontacia_id: null });

    const stats = await historyStats(database, seeded.tenantId, seeded.organizationId);
    expect(stats.spolu).toBe(2);
    expect(stats.podlaAgendy.map((item) => item.agenda).sort()).toEqual(['FP', 'PD']);
  }, 90_000);

  it('backfill preklopí pamäť rozhodnutí do korpusu a agregácia nájde prevažujúce zaúčtovanie', async () => {
    const database = await createTestDatabase();
    databases.push(database);
    const seeded = await seedTestUser(database);
    const ids = await seedCodeLists(database, seeded, [
      ['predkontacie', '518/321'], ['predkontacie', '501/321'], ['cleneniaDph', 'PD'],
    ]);
    for (const [text, predkontacia] of [
      ['preprava tovaru', '518/321'], ['preprava tovaru', '518/321'], ['preprava tovaru', '501/321'],
    ] as const) {
      await database.query(
        `INSERT INTO ucto_decisions (id,tenant_id,organization_id,supplier_name_normalized,
           line_text_normalized,predkontacia_id,clenenie_dph_id,source)
         VALUES ($1,$2,$3,'dodavatel',$4,$5,$6,'import')`,
        [randomUUID(), seeded.tenantId, seeded.organizationId, text,
          ids.get(`predkontacie:${predkontacia}`), ids.get('cleneniaDph:PD')],
      );
    }
    const backfill = await backfillHistoryFromDecisions(database, seeded.tenantId, seeded.organizationId);
    // Každé rozhodnutie je samostatný výskyt — početnosť sa nesmie stratiť.
    expect(backfill.imported).toBe(3);
    // Opakovaný backfill nič nepridá.
    expect((await backfillHistoryFromDecisions(database, seeded.tenantId, seeded.organizationId)).imported).toBe(0);

    const agregat = await agregujHistoriu(database, seeded.tenantId, seeded.organizationId);
    expect(agregat).toHaveLength(1);
    expect(agregat[0].text).toBe('preprava tovaru');
    expect(agregat[0].pocet).toBe(3);
    // Prevažujúce zaúčtovanie je 2× 518, menšinové 1× 501 — konflikt ostáva vidieť.
    expect(agregat[0].kombinacie[0]).toMatchObject({ predkontaciaKod: '518/321', pocet: 2 });
    expect(agregat[0].kombinacie).toHaveLength(2);
  }, 90_000);

  it('backfill berie agendu z dokladu a opakovaním opraví aj riadky preklopené postaru', async () => {
    const database = await createTestDatabase();
    databases.push(database);
    const seeded = await seedTestUser(database);
    const ids = await seedCodeLists(database, seeded, [['predkontacie', '521/331'], ['cleneniaDph', 'UN']]);
    const dokladId = randomUUID();
    const rozhodnutieId = randomUUID();
    await database.query(
      `INSERT INTO documents (id,tenant_id,organization_id,document_type,status,processing_status,source,
         extracted,accounting,confidence,total_amount,currency,version)
       VALUES ($1,$2,$3,'PD','schvaleny','ready_for_review','{}'::jsonb,'{}'::jsonb,
         '{"pokladnaTyp":"expense"}'::jsonb,1,10,'EUR',1)`,
      [dokladId, seeded.tenantId, seeded.organizationId],
    );
    await database.query(
      `INSERT INTO ucto_decisions (id,tenant_id,organization_id,document_id,supplier_name_normalized,
         line_text_normalized,predkontacia_id,clenenie_dph_id,source)
       VALUES ($1,$2,$3,$4,'dodavatel','nakup phm',$5,$6,'approved')`,
      [rozhodnutieId, seeded.tenantId, seeded.organizationId, dokladId,
        ids.get('predkontacie:521/331'), ids.get('cleneniaDph:UN')],
    );

    // Výdajový pokladničný doklad — smer je v zaúčtovaní, nie v type dokladu.
    expect((await backfillHistoryFromDecisions(database, seeded.tenantId, seeded.organizationId)).imported).toBe(1);
    const agendaVKorpuse = async () => (await database.query<{ agenda: string } & Record<string, unknown>>(
      'SELECT agenda FROM ucto_historia WHERE organization_id=$1', [seeded.organizationId],
    )).rows[0].agenda;
    expect(await agendaVKorpuse()).toBe('VPD');

    // Riadok preklopený starším kódom (natvrdo 'FP') sa musí dať opraviť
    // opakovaným preklopením — s DO NOTHING v ňom ostala zlá agenda navždy.
    await database.query('UPDATE ucto_historia SET agenda=$1 WHERE organization_id=$2',
      ['FP', seeded.organizationId]);
    expect((await backfillHistoryFromDecisions(database, seeded.tenantId, seeded.organizationId)).imported).toBe(1);
    expect(await agendaVKorpuse()).toBe('VPD');
    // Keď už agenda sedí, riadok sa ako preklopený nepočíta.
    expect((await backfillHistoryFromDecisions(database, seeded.tenantId, seeded.organizationId)).imported).toBe(0);
  }, 90_000);

  it('analýza uloží kategórie a zahodí účet, ktorý model vymyslel', async () => {
    const database = await createTestDatabase();
    databases.push(database);
    const seeded = await seedTestUser(database);
    const ids = await seedCodeLists(database, seeded, [['predkontacie', '518/321'], ['cleneniaDph', 'PD']]);
    for (let index = 0; index < 6; index += 1) {
      await importUctoHistory(database, {
        ...seeded,
        rows: [{ agenda: 'FP', lineText: `Preprava tovaru ${index}`, predkontaciaKod: '518/321', clenenieDphKod: 'PD' }],
        source: 'mdb',
      });
    }
    const parser = {
      parse: vi.fn().mockResolvedValue({
        output_parsed: {
          kategorie: [
            {
              nazov: 'Preprava a špedícia', popis: 'Doprava tovaru', slovnik: ['preprava', 'doprava'],
              predkontaciaKod: '518/321', clenenieDphKod: 'PD', clenenieKvKod: 'B2',
              vynimky: [], konflikt: null,
            },
            {
              nazov: 'Vymyslená', popis: 'Účet mimo podkladu', slovnik: ['nic'],
              predkontaciaKod: '999/999', clenenieDphKod: null, clenenieKvKod: null,
              vynimky: [{ podmienka: 'nikdy', predkontaciaKod: '888/888' }], konflikt: null,
            },
          ],
        },
      }),
    };
    // Vektory sa počítajú JEDNÝM volaním po poslednej dávke — uloz() prepisuje
    // celú mapu po každej dávke, takže embedovanie vnútri by tú istú kategóriu
    // zaplatilo raz za dávku.
    const embedder = { create: vi.fn().mockResolvedValue({ data: [{ embedding: [1, 0] }, { embedding: [0, 1] }] }) };
    const vysledok = await analyzujUctovnyProfil(database, testConfig(), seeded, parser, embedder);
    expect(vysledok.kategorii).toBe(2);
    expect(embedder.create).toHaveBeenCalledTimes(1);
    const ulozene = (await database.query<Record<string, any>>(
      'SELECT nazov, vektor, vektor_model FROM ucto_kategorie WHERE organization_id=$1 ORDER BY nazov',
      [seeded.organizationId],
    )).rows;
    expect(ulozene.map((row) => row.vektor_model)).toEqual(['text-embedding-3-small', 'text-embedding-3-small']);
    expect(ulozene.every((row) => Array.isArray(row.vektor) && row.vektor.length === 2)).toBe(true);
    expect((parser.parse.mock.calls[0][0] as any).model).toBe('gpt-5.6-sol');

    const kategorie = await listUctoKategorie(database, seeded.tenantId, seeded.organizationId);
    const preprava = kategorie.find((item) => item.nazov === 'Preprava a špedícia');
    expect(preprava?.predkontaciaId).toBe(ids.get('predkontacie:518/321'));
    expect(preprava?.clenenieKvKod).toBe('B2');
    // Početnosť sa počíta zo slovníka nad podkladom, nie odhadom: „preprava"
    // sedí na všetkých 6 riadkov, „nic" na žiadny.
    expect(preprava?.pocet).toBe(6);
    expect(kategorie.find((item) => item.nazov === 'Vymyslená')?.pocet).toBe(0);
    // Účet, ktorý v podklade nebol, sa do profilu nedostane ani ako výnimka.
    const vymyslena = kategorie.find((item) => item.nazov === 'Vymyslená');
    expect(vymyslena?.predkontaciaKod).toBeUndefined();
    expect(vymyslena?.vynimky).toHaveLength(0);
  }, 90_000);

  it('kategória sa dostane do návrhu aj pri neznámom dodávateľovi a zdvihne istotu na predvyplnenie', async () => {
    const database = await createTestDatabase();
    databases.push(database);
    const seeded = await seedTestUser(database);
    const ids = await seedCodeLists(database, seeded, [
      ['predkontacie', '518/321'], ['cleneniaDph', 'PD'], ['ciselneRady', 'PF'],
    ]);
    const documentId = randomUUID();
    await database.query(
      `INSERT INTO documents (id,tenant_id,organization_id,document_type,status,processing_status,extracted,accounting,total_amount,currency)
       VALUES ($1,$2,$3,'FP','na_kontrole','ready_for_review','{}'::jsonb,'{}'::jsonb,100,'EUR')`,
      [documentId, seeded.tenantId, seeded.organizationId],
    );
    await database.query(
      `INSERT INTO ucto_kategorie (id,tenant_id,organization_id,nazov,popis,slovnik,predkontacia_kod,
         predkontacia_id,clenenie_dph_kod,clenenie_dph_id,clenenie_kv_kod,agendy,pocet)
       VALUES ($1,$2,$3,'Preprava a špedícia','Doprava tovaru','["preprava","freight"]'::jsonb,'518/321',$4,
         'PD',$5,'B2','["FP"]'::jsonb,120)`,
      [randomUUID(), seeded.tenantId, seeded.organizationId,
        ids.get('predkontacie:518/321'), ids.get('cleneniaDph:PD')],
    );

    const parser = {
      create: vi.fn().mockResolvedValue(aiOdpoved({
          clenenieKvKod: null,
          predkontaciaId: ids.get('predkontacie:518/321'), clenenieDphId: ids.get('cleneniaDph:PD'),
          ciselnyRadId: null, confidence: 0.95, reason: 'Ide o prepravu tovaru',
        })),
    };
    // Dodávateľ, ktorého firma nikdy nemala — pamäť ani história nepomôžu.
    const input = { tenantId: seeded.tenantId, organizationId: seeded.organizationId, documentId, supplierName: 'Nová špedícia s.r.o.' };
    const context = { documentType: 'FP', supplierName: 'Nová špedícia s.r.o.', totalAmount: 100, currency: 'EUR', lineDescriptions: ['Freight Shanghai - Koper', 'THC'] };
    expect(await maybeAiAccountingSuggestion(database, testConfig(), input, context, parser)).toBe(true);

    const payload = JSON.parse((parser.create.mock.calls[0][0] as any).input[0].content[0].text);
    expect(payload.kategorie).toHaveLength(1);
    expect(payload.kategorie[0]).toMatchObject({ nazov: 'Preprava a špedícia', pouziteKrat: 120 });

    const suggestion = (await database.query<Record<string, any>>(
      'SELECT * FROM accounting_suggestions WHERE document_id=$1', [documentId],
    )).rows[0];
    // Nad 0.9 = doklad sa predvyplní sám, účtovník nemusí klikať „Použiť návrh".
    expect(Number(suggestion.confidence)).toBeGreaterThanOrEqual(0.9);
    expect(suggestion.reason).toContain('Preprava a špedícia');
    expect(suggestion.predkontacia_id).toBe(ids.get('predkontacie:518/321'));
    // KV berie z kategórie: členenia DPH z POHODY nemajú vyplnenú kv_section,
    // takže bez tohto by členenie KV ostalo prázdne na každom doklade.
    expect(suggestion.clenenie_kv_kod).toBe('B2');
  }, 90_000);

  // Reálny prípad: talianska faktúra „Intervento del 13/03/2026 | Bollo virtuale".
  // Slovník kategórie „Asistenčné služby" ju netrafil ani jedným znakom, model
  // dostal PRÁZDNY zoznam kategórií a predkontáciu volil podľa názvu z rozvrhu.
  it('cudzojazyčný text dostane kategóriu podľa významu, ale istotu nedvíha', async () => {
    const database = await createTestDatabase();
    databases.push(database);
    const seeded = await seedTestUser(database);
    const ids = await seedCodeLists(database, seeded, [
      ['predkontacie', '518/321'], ['cleneniaDph', 'PD'], ['ciselneRady', 'PF'],
    ]);
    const documentId = randomUUID();
    await database.query(
      `INSERT INTO documents (id,tenant_id,organization_id,document_type,status,processing_status,extracted,accounting,total_amount,currency)
       VALUES ($1,$2,$3,'FP','na_kontrole','ready_for_review','{}'::jsonb,'{}'::jsonb,480,'EUR')`,
      [documentId, seeded.tenantId, seeded.organizationId],
    );
    // Slovník je čisto slovenský a text faktúry je taliansky — lexikálna zhoda 0.
    // pocet 120 je nad prahom predvyplnenia, takže test zároveň stráži, že
    // sémantický kandidát istotu NEDVÍHA.
    await database.query(
      `INSERT INTO ucto_kategorie (id,tenant_id,organization_id,nazov,popis,slovnik,predkontacia_kod,
         predkontacia_id,clenenie_dph_kod,clenenie_dph_id,clenenie_kv_kod,agendy,pocet,vektor,vektor_model)
       VALUES ($1,$2,$3,'Asistenčné služby a odťah vozidiel','Pomoc na ceste',
         '["asistenčné služby","odťah vozidla"]'::jsonb,'518/321',$4,'PD',$5,'B2','["FP"]'::jsonb,120,
         '[1,0,0]'::jsonb,'text-embedding-3-small')`,
      [randomUUID(), seeded.tenantId, seeded.organizationId,
        ids.get('predkontacie:518/321'), ids.get('cleneniaDph:PD')],
    );

    const parser = {
      create: vi.fn().mockResolvedValue(aiOdpoved({
        clenenieKvKod: null,
        predkontaciaId: ids.get('predkontacie:518/321'), clenenieDphId: ids.get('cleneniaDph:PD'),
        ciselnyRadId: null, confidence: 0.95, reason: 'Asistencia na ceste',
      })),
    };
    // Vektor dokladu mieri tam, kam vektor kategórie — kosínus 1.
    const embedder = { create: vi.fn().mockResolvedValue({ data: [{ embedding: [1, 0, 0] }] }) };
    const input = { tenantId: seeded.tenantId, organizationId: seeded.organizationId, documentId, supplierName: 'AUTOSERVICE ALPINA S.r.l.' };
    const context = { documentType: 'FP', supplierName: 'AUTOSERVICE ALPINA S.r.l.', totalAmount: 480, currency: 'EUR',
      lineDescriptions: ['Intervento del 13/03/2026', 'Bollo virtuale'] };
    expect(await maybeAiAccountingSuggestion(database, testConfig(), input, context, parser, embedder)).toBe(true);

    // 1. Kategória sa k modelu DOSTALA, hoci slovník netrafil ani jedno slovo.
    const payload = JSON.parse((parser.create.mock.calls[0][0] as any).input[0].content[0].text);
    expect(payload.kategorie).toHaveLength(1);
    expect(payload.kategorie[0]).toMatchObject({
      nazov: 'Asistenčné služby a odťah vozidiel', zhodaSlov: 0, podobnostVyznamu: 1,
    });

    const suggestion = (await database.query<Record<string, any>>(
      'SELECT * FROM accounting_suggestions WHERE document_id=$1', [documentId],
    )).rows[0];
    expect(suggestion.predkontacia_id).toBe(ids.get('predkontacie:518/321'));
    // 2. Ale istota ostáva pod prahom predvyplnenia (0.9): zaradenie podľa
    // významu je hypotéza, nie doložená prax firmy.
    expect(Number(suggestion.confidence)).toBeLessThan(0.9);
    expect(suggestion.reason).toContain('Významovo zaradené');
    // 3. A hlavne: sekciu KV od seba NEDÁ. Sémantického kandidáta viaže na
    // doklad len rovnosť predkontácie — tú istú nesie viac kategórií, takže by
    // do kontrolného výkazu doniesla sekciu kategória bez spoločného slova.
    expect(suggestion.clenenie_kv_kod).not.toBe('B2');
  }, 90_000);

  // Model má 120 s strop a nula opakovaní. Kým sa kategórie ukladali až po
  // poslednej dávke, jedna pomalá dávka z deviatich zahodila všetkých osem
  // zaplatených pred ňou — firma s 1 217 textami sa nikdy nedopočítala.
  it('dávka, ktorú model nestihol, nezahodí kategórie z dávok pred ňou', async () => {
    const database = await createTestDatabase();
    databases.push(database);
    const seeded = await seedTestUser(database);
    await seedCodeLists(database, seeded, [['predkontacie', '518/321'], ['cleneniaDph', 'PD']]);
    // Dosť rôznych textov na dve dávky (DAVKA = 150).
    for (let index = 0; index < 160; index += 1) {
      await importUctoHistory(database, {
        ...seeded,
        rows: [{ agenda: 'FP', lineText: `Preprava tovaru ${index}`, predkontaciaKod: '518/321', clenenieDphKod: 'PD' }],
        source: 'mdb',
      });
    }
    const parser = {
      parse: vi.fn()
        .mockResolvedValueOnce({
          output_parsed: {
            kategorie: [{
              nazov: 'Preprava a špedícia', popis: 'Doprava tovaru', slovnik: ['preprava'],
              predkontaciaKod: '518/321', clenenieDphKod: 'PD', clenenieKvKod: 'B2',
              vynimky: [], konflikt: null,
            }],
          },
        })
        .mockRejectedValueOnce(new Error('Request timed out.')),
    };

    const vysledok = await analyzujUctovnyProfil(database, testConfig(), seeded, parser);
    expect(vysledok.davok).toBe(2);
    expect(vysledok.zlyhanychDavok).toBe(1);
    expect(vysledok.kategorii).toBe(1);
    // A hlavne: to, čo prvá dávka priniesla, je naozaj v databáze.
    const kategorie = await listUctoKategorie(database, seeded.tenantId, seeded.organizationId);
    expect(kategorie.map((item) => item.nazov)).toEqual(['Preprava a špedícia']);
  }, 120_000);

  it('ručná úprava kategórie previaže známy kód na číselník, neznámy nechá ako text', async () => {
    const database = await createTestDatabase();
    databases.push(database);
    const seeded = await seedTestUser(database);
    const ids = await seedCodeLists(database, seeded, [['predkontacie', '518/321'], ['cleneniaDph', 'PD']]);
    const kategoriaId = randomUUID();
    await database.query(
      `INSERT INTO ucto_kategorie (id,tenant_id,organization_id,nazov,slovnik,agendy,pocet,vektor,vektor_model)
       VALUES ($1,$2,$3,'Preprava','["preprava"]'::jsonb,'["FP"]'::jsonb,10,'[1,0]'::jsonb,'text-embedding-3-small')`,
      [kategoriaId, seeded.tenantId, seeded.organizationId],
    );

    const upravena = await updateUctoKategoria(database, seeded.tenantId, seeded.organizationId, kategoriaId, {
      nazov: 'Preprava a špedícia',
      popis: 'Doprava tovaru',
      slovnik: ['preprava', 'freight'],
      predkontaciaKod: '518/321',
      clenenieDphKod: 'NEEXISTUJE',
      clenenieKvKod: 'B2',
    });
    // Vektor vznikol z názvu/popisu/slovníka — po ich zmene ukazuje na pôvodný
    // význam. NULL = vyberaj lexikálne, teda presne to, čo účtovník upravil.
    const poUprave = (await database.query<Record<string, any>>(
      'SELECT vektor, vektor_model FROM ucto_kategorie WHERE id=$1', [kategoriaId],
    )).rows[0];
    expect(poUprave.vektor).toBeNull();
    expect(poUprave.vektor_model).toBeNull();
    expect(upravena).toMatchObject({
      nazov: 'Preprava a špedícia',
      slovnik: ['preprava', 'freight'],
      predkontaciaKod: '518/321',
      predkontaciaId: ids.get('predkontacie:518/321'),
      clenenieDphKod: 'NEEXISTUJE',
      clenenieKvKod: 'B2',
    });
    // Neznámy kód ostáva ako text s prázdnym id — rovnako ako pri importe histórie.
    expect(upravena.clenenieDphId).toBeUndefined();

    // Vymazanie kódu zruší aj väzbu na číselník.
    const bezUctu = await updateUctoKategoria(
      database, seeded.tenantId, seeded.organizationId, kategoriaId, { predkontaciaKod: null },
    );
    expect(bezUctu.predkontaciaKod).toBeUndefined();
    expect(bezUctu.predkontaciaId).toBeUndefined();

    // Neplatná sekcia KV sa odmietne.
    await expect(updateUctoKategoria(
      database, seeded.tenantId, seeded.organizationId, kategoriaId, { clenenieKvKod: 'X9' },
    )).rejects.toMatchObject({ statusCode: 400 });

    // „BEZ…" predkontácia sa do kategórie nedostane ani ručnou úpravou.
    await expect(updateUctoKategoria(
      database, seeded.tenantId, seeded.organizationId, kategoriaId, { predkontaciaKod: 'BEZ321100' },
    )).rejects.toMatchObject({ statusCode: 400, code: 'bez_predkontacia' });

    // Mäkké zmazanie: kategória zmizne zo zoznamu, ďalšia úprava je 404.
    await deleteUctoKategoria(database, seeded.tenantId, seeded.organizationId, kategoriaId);
    expect(await listUctoKategorie(database, seeded.tenantId, seeded.organizationId)).toHaveLength(0);
    await expect(updateUctoKategoria(
      database, seeded.tenantId, seeded.organizationId, kategoriaId, { nazov: 'X' },
    )).rejects.toMatchObject({ statusCode: 404 });
  }, 90_000);

  it('predkontácie „BEZ…" sa neučia ani nenavrhujú', async () => {
    const database = await createTestDatabase();
    databases.push(database);
    const seeded = await seedTestUser(database);
    const ids = await seedCodeLists(database, seeded, [
      ['predkontacie', 'BEZ321100'], ['predkontacie', '518/321'], ['cleneniaDph', 'PD'],
    ]);

    // 1) Do korpusu sa BEZ kód nedostane ani ako text.
    await importUctoHistory(database, {
      ...seeded,
      rows: [{ agenda: 'FP', lineText: 'Údajová uzávierka', predkontaciaKod: 'BEZ321100', clenenieDphKod: 'PD' }],
      source: 'mdb',
    });
    const historia = await database.query<Record<string, any>>(
      'SELECT predkontacia_kod, predkontacia_id FROM ucto_historia',
    );
    expect(historia.rows[0]).toMatchObject({ predkontacia_kod: null, predkontacia_id: null });

    // 2) Model taký účet ani neuvidí v ponuke, a keby ho aj vrátil, zahodí sa.
    const documentId = randomUUID();
    await database.query(
      `INSERT INTO documents (id,tenant_id,organization_id,document_type,status,processing_status,extracted,accounting,total_amount,currency)
       VALUES ($1,$2,$3,'FP','na_kontrole','ready_for_review','{}'::jsonb,'{}'::jsonb,100,'EUR')`,
      [documentId, seeded.tenantId, seeded.organizationId],
    );
    const parser = {
      create: vi.fn().mockResolvedValue(aiOdpoved({
          clenenieKvKod: null,
          predkontaciaId: ids.get('predkontacie:BEZ321100'), clenenieDphId: null,
          ciselnyRadId: null, confidence: 0.9, reason: 'Uzávierka',
        })),
    };
    const context = { documentType: 'FP', supplierName: 'Dodávateľ', totalAmount: 100, currency: 'EUR', lineDescriptions: ['Údajová uzávierka'] };
    expect(await maybeAiAccountingSuggestion(
      database, testConfig(),
      { tenantId: seeded.tenantId, organizationId: seeded.organizationId, documentId, supplierName: 'Dodávateľ' },
      context, parser,
    )).toBe(false);
    const ponuka = JSON.parse((parser.create.mock.calls[0][0] as any).input[0].content[0].text);
    expect(ponuka.ciselniky.predkontacie.map((item: any) => item.kod)).toEqual(['518/321']);
  }, 90_000);
});

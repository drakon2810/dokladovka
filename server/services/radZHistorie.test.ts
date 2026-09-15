import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { aiOdpoved, createTestDatabase, seedTestUser, testConfig } from '../testHelpers.js';
import { maybeAiAccountingSuggestion, rebuildAccountingSuggestion, resolveSeriesDefault } from './accountingSuggestionService.js';
import { zmerajRady } from './uctoPresnostService.js';

// Rad sa doteraz hádal z predpony čísla dokladu a z najvyššieho čísla radu —
// a chybil naprieč firmami (AGS marec v ťarchopisoch, ROFA „FP20" z roku 2025).
// Tu sa počíta z histórie: každý doklad nesie identifikátor radu z POHODY.

const databases: Awaited<ReturnType<typeof createTestDatabase>>[] = [];
afterEach(async () => Promise.all(databases.splice(0).map((database) => database.close())));

async function firma() {
  const database = await createTestDatabase();
  databases.push(database);
  const seeded = await seedTestUser(database);
  const kde = { tenantId: seeded.tenantId, organizationId: seeded.organizationId };
  const externe = new Map<string, { ext: string; kod: string }>();

  const rad = async (kod: string, nazov: string, agenda: string, rok: string | null = null, posledne: string | null = null) => {
    const id = randomUUID();
    const ext = String(externe.size + 100);
    externe.set(id, { ext, kod });
    await database.query(
      `INSERT INTO code_list_items (id,tenant_id,organization_id,kind,code,name,source,agenda,external_id,accounting_year,last_number)
       VALUES ($1,$2,$3,'ciselneRady',$4,$5,'pohoda',$6,$7,$8,$9)`,
      [id, kde.tenantId, kde.organizationId, kod, nazov, agenda, ext, rok, posledne],
    );
    return id;
  };

  let poradie = 0;
  const doklad = async (agenda: string, radId: string, datum: string, protistrana = 'dodavatel', krajina: string | null = null) => {
    poradie += 1;
    const { ext, kod } = externe.get(radId)!;
    // Hlavička aj položka nesú rad — doklad sa musí rátať raz, nie dvakrát.
    for (const index of [0, 1]) {
      await database.query(
        `INSERT INTO ucto_historia
          (id,tenant_id,organization_id,agenda,doklad_cislo,datum,supplier_name_normalized,line_text_normalized,
           predkontacia_kod,riadok_index,source,riadok_hash,rad_external_id,rad_kod,krajina)
         VALUES ($1,$2,$3,$4,$5,$6::date,$7,'sluzba','518/321',$8,'mdb',$9,$10,$11,$12)`,
        [randomUUID(), kde.tenantId, kde.organizationId, agenda, `${kod}${1000 + poradie}`, datum, protistrana,
          index, randomUUID(), ext, kod, krajina],
      );
    }
  };
  return { database, kde, rad, doklad };
}

describe('číselný rad z histórie firmy', () => {
  it('rad minulého roka nevyhrá a nový rok prevezme rad podľa názvu', async () => {
    const { database, kde, rad, doklad } = await firma();
    // ROFA: pseudo-rad FP20 z decembrových dokladov 2025 má vyššie posledné
    // číslo než skutočný FP202 — staré odhady ho preto vyberali.
    const fp20 = await rad('FP20', 'FP20', 'prijate_faktury', '2025', 'FP2025764');
    const fp202 = await rad('FP202', 'Prijaté faktúry', 'prijate_faktury', '2026', 'FP2026012');
    const fp270 = await rad('FP270', 'Prijaté faktúry', 'prijate_faktury', '2027');
    // Rady dobropisov v tej istej agende, s vyšším počítadlom a bez dokladov.
    await rad('2026', 'Prijaté dopropisy', 'prijate_faktury', '2026', '202602271');
    await rad('2027', 'Prijaté dopropisy', 'prijate_faktury', '2027', '202700009');
    for (const den of ['01', '02', '03', '04', '05']) await doklad('FP', fp20, `2025-12-${den}`);
    for (const mesiac of ['01', '02', '03']) await doklad('FP', fp202, `2026-${mesiac}-10`);

    expect(await resolveSeriesDefault(database, kde, 'FP', '2026-07-27', 'bezna', { nazov: 'ECH Scientific Ltd' }))
      .toBe(fp202);
    // Január 2027 ešte nemá doklady: vyberie sa z roku 2026 a prenesie na rad
    // nového roka s rovnakým názvom.
    expect(await resolveSeriesDefault(database, kde, 'FP', '2027-01-05', 'bezna', { nazov: 'ECH Scientific Ltd' }))
      .toBe(fp270);
  }, 90_000);

  it('dobropis dostane rad dobropisov, nastavenie ani pamäť výber neprebijú', async () => {
    const { database, kde, rad, doklad } = await firma();
    const faktury = await rad('F26', 'Prijaté faktúry', 'prijate_faktury', '2026', 'F26900');
    const dobropisy = await rad('D26', 'Prijaté dopropisy', 'prijate_faktury', '2026', 'D26002');
    const iny = await rad('X26', 'Prijaté faktúry iné', 'prijate_faktury', '2026');
    for (const den of ['10', '11', '12', '13', '14']) await doklad('FP', faktury, `2026-03-${den}`);
    for (const den of ['15', '16', '17']) await doklad('FP-D', dobropisy, `2026-03-${den}`);

    expect(await resolveSeriesDefault(database, kde, 'FP', '2026-04-01', 'dobropis', {})).toBe(dobropisy);
    expect(await resolveSeriesDefault(database, kde, 'FP', '2026-04-01', 'bezna', {})).toBe(faktury);

    // Pamäť dodávateľa nesie rad zo svojho dokladu (pamäť podtyp nerozlišuje)
    // — nesmie prebiť rad z histórie.
    const pred = randomUUID();
    await database.query(
      `INSERT INTO code_list_items (id,tenant_id,organization_id,kind,code,name,source)
       VALUES ($1,$2,$3,'predkontacie','518/321','Služby','pohoda')`,
      [pred, kde.tenantId, kde.organizationId],
    );
    await database.query(
      `INSERT INTO ucto_decisions
        (id,tenant_id,organization_id,supplier_name_normalized,line_text_normalized,predkontacia_id,ciselny_rad_id,source)
       VALUES ($1,$2,$3,'stary dodavatel','sluzba',$4,$5,'import')`,
      [randomUUID(), kde.tenantId, kde.organizationId, pred, iny],
    );
    const documentId = randomUUID();
    await database.query(
      `INSERT INTO documents (id,tenant_id,organization_id,document_type,status,processing_status,extracted,accounting,total_amount,currency)
       VALUES ($1,$2,$3,'FP','na_kontrole','ready_for_review',$4::jsonb,'{}'::jsonb,10,'EUR')`,
      [documentId, kde.tenantId, kde.organizationId,
        JSON.stringify({ dodavatel: { nazov: 'Stary dodavatel' }, datumVystavenia: '2026-04-02', polozky: [{ popis: 'sluzba' }] })],
    );
    await rebuildAccountingSuggestion(database, { ...kde, documentId, supplierName: 'Stary dodavatel' });
    expect((await database.query<Record<string, any>>(
      'SELECT source, ciselny_rad_id FROM accounting_suggestions WHERE document_id=$1', [documentId],
    )).rows[0]).toMatchObject({ source: 'decision_memory', ciselny_rad_id: faktury });

    // Nastavenie účtovníka pre FP platí bežnej faktúre, dobropisu nie.
    await database.query(
      `INSERT INTO organization_series_defaults (organization_id,tenant_id,document_type,ciselny_rad_id)
       VALUES ($1,$2,'FP',$3)`,
      [kde.organizationId, kde.tenantId, iny],
    );
    expect(await resolveSeriesDefault(database, kde, 'FP', '2026-04-01', 'bezna', {})).toBe(iny);
    expect(await resolveSeriesDefault(database, kde, 'FP', '2026-04-01', 'dobropis', {})).toBe(dobropisy);
  }, 90_000);

  it('mesačná firma: rad mesiaca, nový mesiac len podľa názvu, inak prázdne', async () => {
    const { database, kde, rad, doklad } = await firma();
    // AGS: rad na každý mesiac. Najvyššie posledné číslo má apríl.
    const februar = await rad('26020', 'Vydané faktúry február', 'vydane_faktury', '2026', '26020001');
    const marec = await rad('26030', 'Vydané faktúry marec', 'vydane_faktury', '2026', '26030001');
    const april = await rad('26040', 'Vydané faktúry apríl', 'vydane_faktury', '2026', '26040999');
    for (const [radId, mesiac] of [[februar, '02'], [marec, '03'], [april, '04']] as const) {
      for (const den of ['10', '11', '12']) await doklad('FV', radId, `2026-${mesiac}-${den}`, `zakaznik ${mesiac}${den}`);
    }
    // Stály zákazník bol vo februári dvakrát — jeho „100 %" je rad februára.
    await doklad('FV', februar, '2026-02-20', 'stala s.r.o.');
    await doklad('FV', februar, '2026-02-21', 'stala s.r.o.');

    expect(await resolveSeriesDefault(database, kde, 'FV', '2026-03-20', 'bezna', { nazov: 'Nový zákazník' })).toBe(marec);
    expect(await resolveSeriesDefault(database, kde, 'FV', '2026-03-20', 'bezna', { nazov: 'Stala s.r.o.' })).toBe(marec);

    // Máj ešte nemá doklad a rad „máj" neexistuje: rad sa nechá na účtovníka —
    // ani model, ani iný mesiac ho nezaplní.
    expect(await resolveSeriesDefault(database, kde, 'FV', '2026-05-12', 'bezna', { nazov: 'Nový zákazník' })).toBeNull();
    const pred = randomUUID();
    await database.query(
      `INSERT INTO code_list_items (id,tenant_id,organization_id,kind,code,name,source)
       VALUES ($1,$2,$3,'predkontacie','602/311','Tržby','pohoda')`,
      [pred, kde.tenantId, kde.organizationId],
    );
    const documentId = randomUUID();
    await database.query(
      `INSERT INTO documents (id,tenant_id,organization_id,document_type,status,processing_status,extracted,accounting,total_amount,currency)
       VALUES ($1,$2,$3,'FV','na_kontrole','ready_for_review','{}'::jsonb,'{}'::jsonb,100,'EUR')`,
      [documentId, kde.tenantId, kde.organizationId],
    );
    const parser = {
      create: vi.fn().mockResolvedValue(aiOdpoved({
        clenenieKvKod: null, predkontaciaId: pred, clenenieDphId: null, ciselnyRadId: april, confidence: 0.7, reason: 'Sťahovanie',
      })),
    };
    const context = {
      documentType: 'FV', datumVystavenia: '2026-05-12', odberatel: { nazov: 'Nový zákazník' },
      totalAmount: 100, currency: 'EUR', lineDescriptions: ['sťahovanie'],
    };
    expect(await maybeAiAccountingSuggestion(database, testConfig(), { ...kde, documentId }, context, parser)).toBe(true);
    expect((await database.query<Record<string, any>>(
      'SELECT ciselny_rad_id FROM accounting_suggestions WHERE document_id=$1', [documentId],
    )).rows[0].ciselny_rad_id).toBeNull();

    const maj = await rad('26050', 'Vydané faktúry máj', 'vydane_faktury', '2026');
    expect(await resolveSeriesDefault(database, kde, 'FV', '2026-05-12', 'bezna', { nazov: 'Nový zákazník' })).toBe(maj);
  }, 90_000);

  it('tuzemský a zahraničný rad podľa krajiny, stála protistrana podľa seba', async () => {
    const { database, kde, rad, doklad } = await firma();
    // SLO: rady bez „zahraničné" v názve, zahraničný má viac dokladov aj vyššie číslo.
    const df = await rad('DF260', 'DF260', 'prijate_faktury', '2026', 'DF260100');
    const zf = await rad('ZF260', 'ZF260', 'prijate_faktury', '2026', 'ZF260900');
    for (let index = 1; index <= 8; index += 1) await doklad('FP', df, '2026-02-10', `sk dodavatel ${index}`, 'SK');
    for (let index = 1; index <= 9; index += 1) await doklad('FP', zf, '2026-02-11', `foreign supplier ${index}`, index % 2 ? 'IT' : 'DE');
    // Slovenský dodávateľ, ktorého firma vedie v zahraničnom rade.
    await doklad('FP', zf, '2026-02-12', 'vip s.r.o.', 'SK');
    await doklad('FP', zf, '2026-02-13', 'vip s.r.o.', 'SK');

    expect(await resolveSeriesDefault(database, kde, 'FP', '2026-03-01', 'bezna', { nazov: 'Nový SK', krajina: 'SK' })).toBe(df);
    expect(await resolveSeriesDefault(database, kde, 'FP', '2026-03-01', 'bezna', { nazov: 'Nuovo', krajina: 'IT' })).toBe(zf);
    expect(await resolveSeriesDefault(database, kde, 'FP', '2026-03-01', 'bezna', { nazov: 'VIP s.r.o.', krajina: 'SK' })).toBe(zf);
  }, 90_000);

  it('zmerajRady počíta každý doklad len z toho, čo firma vedela pred ním', async () => {
    const { database, kde, rad, doklad } = await firma();
    const f25 = await rad('F25', 'Prijaté faktúry', 'prijate_faktury', '2025');
    const f26 = await rad('F26', 'Prijaté faktúry', 'prijate_faktury', '2026');
    const d26 = await rad('D26', 'Prijaté dobropisy', 'prijate_faktury', '2026');
    await doklad('FP', f25, '2025-12-10');
    for (const mesiac of ['01', '02', '03']) await doklad('FP', f26, `2026-${mesiac}-10`);
    for (const mesiac of ['02', '03']) await doklad('FP-D', d26, `2026-${mesiac}-15`);

    const vysledok = await zmerajRady(database, kde);
    expect(vysledok.od).toBe('2026-01-01');
    // Januárová faktúra prevezme rad z roku 2025 podľa názvu; prvý dobropis
    // roka nemá z čoho počítať a ostane prázdny.
    expect(vysledok.podlaAgendy).toEqual({
      FP: { dokladov: 3, spravne: 3, prazdne: 0 },
      'FP-D': { dokladov: 2, spravne: 1, prazdne: 1 },
    });
    expect(vysledok.rozdiely).toEqual([
      expect.objectContaining({ agenda: 'FP-D', datum: '2026-02-15', skutocne: 'D26', navrh: null }),
    ]);
  }, 90_000);
});

import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Database } from '../db/database.js';
import { aiOdpoved, createTestDatabase, seedTestUser, testConfig } from '../testHelpers.js';
import {
  intervalSpolahlivosti, jeRozpisany, ohodnot, scitajPoAgendach, vyberVzorku, zmerajPresnost,
  type Skutocnost, type VysledokDokladu,
} from './uctoPresnostService.js';
import { prepocitajPravidla } from './uctoPravidlaService.js';

// Meranie stojí a padá na jednej veci: meraný doklad NESMIE vidieť seba ani
// nič, čo vzniklo po ňom. Korpus je zrkadlo toho, čo účtovník urobil, takže
// bez delenia časom by model dostal do promptu vlastnú odpoveď.

const databases: Database[] = [];
afterEach(async () => Promise.all(databases.splice(0).map((database) => database.close())));

async function firma() {
  const database = await createTestDatabase();
  databases.push(database);
  const seeded = await seedTestUser(database);
  const kde = { tenantId: seeded.tenantId, organizationId: seeded.organizationId };
  const vloz = async (tabulka: string, hodnoty: Record<string, unknown>) => {
    const stlpce = { id: randomUUID(), tenant_id: kde.tenantId, organization_id: kde.organizationId, ...hodnoty };
    const nazvy = Object.keys(stlpce);
    await database.query(
      `INSERT INTO ${tabulka} (${nazvy.join(',')}) VALUES (${nazvy.map((_, index) => `$${index + 1}`).join(',')})`,
      Object.values(stlpce),
    );
    return stlpce.id;
  };
  const kod = (kind: string, code: string, dalsie: Record<string, unknown> = {}) =>
    vloz('code_list_items', { kind, code, name: code, source: 'pohoda', ...dalsie });
  const riadok = (hodnoty: Record<string, unknown>) => vloz('ucto_historia', {
    agenda: 'FP', riadok_index: 0, supplier_name_normalized: 'preprava s.r.o.', line_text_normalized: 'preprava tovaru',
    suma: 100, source: 'mdb', riadok_hash: randomUUID(), ...hodnoty,
  });
  return { database, kde, vloz, kod, riadok };
}

const prompt = (parser: { create: ReturnType<typeof vi.fn> }, index = 0) =>
  JSON.parse((parser.create.mock.calls[index][0] as any).input[0].content[0].text);

describe('meranie presnosti zaúčtovania', () => {
  it('drží históriu k dátumu dokladu a neznámu skutočnosť nepočíta', async () => {
    const { database, kde, kod, riadok } = await firma();
    const spravna = await kod('predkontacie', '518/321');
    const ina = await kod('predkontacie', '501/321');
    // Minulosť: firma tomuto dodávateľovi dávala 518/321.
    for (const [index, cislo] of ['26FP001', '26FP002', '26FP003'].entries()) {
      await riadok({ doklad_cislo: cislo, datum: `2026-0${index + 1}-15`, predkontacia_id: spravna });
    }
    // Meraný doklad dostal INÚ predkontáciu — ak sa v prompte objaví, doklad si
    // odpoveď odpísal sám od seba.
    await riadok({ doklad_cislo: '26FP090', datum: '2026-08-20', predkontacia_id: ina });

    const parser = {
      create: vi.fn().mockResolvedValue(aiOdpoved({
        predkontaciaId: spravna, clenenieDphId: null, clenenieKvKod: null,
        ciselnyRadId: null, confidence: 0.8, reason: 'Preprava',
      })),
    };
    const vysledok = await zmerajPresnost(database, testConfig(), kde,
      { rezim: 'ai', deliciDatum: '2026-08-01', vzorka: 10 }, parser);

    expect(vysledok).toMatchObject({ vzorka: 1, metodika: 2, rezim: 'ai', id: null });
    // Model odpovedal podľa histórie (518/321), účtovník dal 501/321 — nezhoda.
    expect(vysledok.vysledok.FP.predkontacia).toEqual({ spravne: 0, znamych: 1, navrhnutych: 1 });
    // Hlavička nemá členenie DPH ani KV: nie je proti čomu merať, takže sa to
    // nesmie rátať ako zhoda — kedysi tu stálo 1 z 1.
    expect(vysledok.vysledok.FP.clenenieDph).toEqual({ spravne: 0, znamych: 0, navrhnutych: 0 });
    expect(vysledok.vysledok.FP.kv).toEqual({ spravne: 0, znamych: 0, navrhnutych: 0 });
    expect(vysledok.rozdiely).toEqual([expect.objectContaining({ doklad: '26FP090' })]);

    const vPrompte = (prompt(parser).dennik ?? []).map((riadokDennika: any) => riadokDennika.predkontaciaId);
    expect(vPrompte).not.toContain(ina);
    expect(vPrompte).toContain(spravna);
  }, 90_000);

  // Na vydanej faktúre je protistranou ODBERATEĽ a návrh ho číta z iného poľa.
  it('vydaná faktúra nesie odberateľa, inak sa meria naslepo', async () => {
    const { database, kde, kod, riadok } = await firma();
    const predkontacia = await kod('predkontacie', '602200');
    for (const [index, cislo] of ['26FV001', '26FV002', '26FV003', '26FV090'].entries()) {
      await riadok({
        agenda: 'FV', doklad_cislo: cislo, datum: index === 3 ? '2026-08-20' : `2026-0${index + 1}-15`,
        supplier_name_normalized: 'milena pribis', line_text_normalized: 'skladovanie',
        predkontacia_id: predkontacia, predkontacia_kod: '602200', clenenie_dph_kod: 'UD', clenenie_kv_kod: 'D2',
      });
    }
    await prepocitajPravidla(database, kde);

    const parser = {
      create: vi.fn().mockResolvedValue(aiOdpoved({
        predkontaciaId: predkontacia, clenenieDphId: null, clenenieKvKod: null,
        ciselnyRadId: null, confidence: 0.8, reason: 'Skladovanie',
      })),
    };
    await zmerajPresnost(database, testConfig(), kde, { rezim: 'ai', deliciDatum: '2026-08-01' }, parser);

    expect(prompt(parser).dokument.odberatel).toMatchObject({ nazov: 'milena pribis' });
    expect(prompt(parser).pravidlo).toMatchObject({ dokladov: 3, zhoda: 3, predkontaciaKod: '602200' });
  }, 90_000);

  it('rad sa porovná s radom, do ktorého doklad v POHODE naozaj padol', async () => {
    const { database, kde, kod, riadok } = await firma();
    const predkontacia = await kod('predkontacie', '518/321');
    for (const [code, ext] of [['DF260', '11'], ['ZF260', '12']]) {
      await kod('ciselneRady', code, { agenda: 'prijate_faktury', external_id: ext, accounting_year: '2026' });
    }
    const doklad = (cislo: string, datum: string, rad: string, krajina: string) => riadok({
      doklad_cislo: cislo, datum, predkontacia_id: predkontacia, krajina,
      rad_external_id: rad === 'DF260' ? '11' : '12', rad_kod: rad,
    });
    for (const [index, cislo] of ['DF260001', 'DF260002', 'DF260003'].entries()) {
      await doklad(cislo, `2026-0${index + 1}-15`, 'DF260', 'SK');
    }
    // Merané: jeden trafený, druhý v zahraničnom rade, ktorý história nepozná.
    await doklad('DF260090', '2026-08-20', 'DF260', 'SK');
    await doklad('ZF260091', '2026-08-21', 'ZF260', 'IT');

    const parser = {
      create: vi.fn().mockResolvedValue(aiOdpoved({
        predkontaciaId: predkontacia, clenenieDphId: null, clenenieKvKod: null,
        ciselnyRadId: null, confidence: 0.8, reason: 'Preprava',
      })),
    };
    const vysledok = await zmerajPresnost(database, testConfig(), kde,
      { rezim: 'ai', deliciDatum: '2026-08-01' }, parser);
    expect(vysledok.vysledok.FP).toMatchObject({
      dokladov: 2, rad: { spravne: 1, znamych: 2, navrhnutych: 2 }, predkontacia: { spravne: 2, znamych: 2, navrhnutych: 2 },
    });
    expect(vysledok.rozdiely).toEqual([expect.objectContaining({
      doklad: 'ZF260091', skutocne: expect.objectContaining({ rad: 'ZF260' }), navrh: expect.objectContaining({ rad: 'DF260' }),
    })]);
  }, 90_000);

  it('bez dokladov v meranom okne to povie, nie spadne', async () => {
    const { database, kde, riadok } = await firma();
    await riadok({ doklad_cislo: '26FP001', datum: '2026-01-10', predkontacia_kod: '518/321' });
    await expect(zmerajPresnost(database, testConfig(), kde, { deliciDatum: '2026-06-01' }))
      .rejects.toThrow(/doklady/);
  }, 60_000);

  // Model, ktorý nič nespoznal, sa zdržal — to nie je chyba, ale ani zhoda.
  it('zdržanie sa počíta zvlášť, nie ako navrhnuté', async () => {
    const { database, kde, kod, riadok } = await firma();
    const predkontacia = await kod('predkontacie', '518/321');
    await riadok({ doklad_cislo: '26FP001', datum: '2026-08-20', predkontacia_id: predkontacia });
    const parser = {
      create: vi.fn().mockResolvedValue(aiOdpoved({
        predkontaciaId: null, clenenieDphId: null, clenenieKvKod: null, ciselnyRadId: null, confidence: 0, reason: 'Neviem',
      })),
    };
    const vysledok = await zmerajPresnost(database, testConfig(), kde, { rezim: 'ai', deliciDatum: '2026-08-01' }, parser);
    expect(vysledok.vysledok.FP).toMatchObject({
      dokladov: 1, zdrzanie: 1, chyb: 0, predkontacia: { spravne: 0, znamych: 1, navrhnutych: 0 },
    });
    expect(vysledok.doklady[0]).toMatchObject({ zdrzanie: 'bez_zauctovania', navrh: null });
    expect(vysledok.rozdiely).toEqual([]);
  }, 60_000);
});

// Neskorší doklad ani nič, čo vzniklo po dátume dokladu, nesmie zmeniť to, čo
// o skoršom doklade model dostane — ani to, čo z odpovede spraví dospracovanie.
describe('bez úniku budúcnosti', () => {
  it('neskorší doklad, pravidlá, príklady, pokyny ani kategórie nezmenia prompt ani výsledok', async () => {
    const { database, kde, vloz, kod, riadok } = await firma();
    const p518 = await kod('predkontacie', '518/321');
    const p501 = await kod('predkontacie', '501/321');
    const pd = await kod('cleneniaDph', 'PD');
    const pn = await kod('cleneniaDph', 'PN');
    const r1 = await kod('ciselneRady', 'R1', { agenda: 'prijate_faktury', accounting_year: '2026' });
    await kod('ciselneRady', 'R2', { agenda: 'prijate_faktury', accounting_year: '2026' });
    const kody = { predkontacia_id: p518, predkontacia_kod: '518/321', clenenie_dph_id: pd, clenenie_dph_kod: 'PD', clenenie_kv_kod: 'B2' };
    for (const [index, cislo] of ['26FP001', '26FP002', '26FP003'].entries()) {
      await riadok({ doklad_cislo: cislo, datum: `2026-0${index + 1}-15`, ...kody });
    }
    await riadok({ doklad_cislo: '26FP010', datum: '2026-04-10', ...kody });
    // Pokyn spred dokladu v prompte byť MÁ — filter nesmie vyhodiť všetko.
    await database.query(
      `INSERT INTO ai_instructions (id,scope,nazov,text,faza,created_at)
       VALUES ($1,'global','Staré pravidlo','platí','accounting','2026-01-01')`, [randomUUID()],
    );

    const parser = {
      create: vi.fn().mockResolvedValue(aiOdpoved({
        predkontaciaId: p518, clenenieDphId: pd, clenenieKvKod: 'B2', ciselnyRadId: null, confidence: 0.8, reason: 'Preprava',
      })),
    };
    const zmeraj = async () => {
      parser.create.mockClear();
      const vysledok = await zmerajPresnost(database, testConfig(), kde, { rezim: 'ai', deliciDatum: '2026-04-10' }, parser);
      const index = parser.create.mock.calls.findIndex((_, poradie) => prompt(parser, poradie).dokument.datumVystavenia === '2026-04-10');
      return { prompt: prompt(parser, index), doklad: vysledok.doklady.find((doklad) => doklad.doklad === '26FP010') };
    };
    const predtym = await zmeraj();

    // Budúcnosť: iný doklad tej istej protistrany s inou praxou a všetko, čo
    // mohlo vzniknúť až po dátume meraného dokladu.
    await riadok({
      doklad_cislo: '26FP020', datum: '2026-05-10', predkontacia_id: p501, predkontacia_kod: '501/321',
      clenenie_dph_id: pn, clenenie_dph_kod: 'PN', clenenie_kv_kod: 'KN',
    });
    await vloz('ucto_decisions', {
      supplier_name_normalized: 'preprava s.r.o.', line_text_normalized: 'preprava tovaru', predkontacia_id: p501,
      clenenie_dph_id: pn, clenenie_kv_kod: 'KN', ciselny_rad_id: r1, document_type: 'FP', source: 'import',
      created_at: '2026-06-01',
    });
    await vloz('accounting_rules', {
      supplier_name_normalized: 'preprava s.r.o.', predkontacia_id: p501, priority: 1, created_at: '2026-06-01',
    });
    await database.query(
      `INSERT INTO ai_instructions (id,scope,nazov,text,faza,created_at)
       VALUES ($1,'global','Nové pravidlo','platí','accounting','2026-06-01')`, [randomUUID()],
    );
    await vloz('ucto_kategorie', {
      nazov: 'Preprava', slovnik: JSON.stringify(['preprava']), predkontacia_id: p501, agendy: JSON.stringify(['FP']), pocet: 30,
    });
    const potom = await zmeraj();

    expect(potom.prompt).toEqual(predtym.prompt);
    expect(potom.doklad).toEqual(predtym.doklad);
    expect(predtym.prompt.kategorie).toEqual([]);
    expect(predtym.prompt.pravidla).toContain('Staré pravidlo');
    expect(predtym.prompt.pravidla).not.toContain('Nové pravidlo');
  }, 120_000);
});

describe('meranie bez zápisov', () => {
  it('v oboch režimoch nezapíše nič; uloz=true zapíše práve jeden beh', async () => {
    const { database, kde, kod, riadok } = await firma();
    const predkontacia = await kod('predkontacie', '518/321');
    for (const [index, cislo] of ['26FP001', '26FP002', '26FP003', '26FP090'].entries()) {
      await riadok({
        doklad_cislo: cislo, datum: index === 3 ? '2026-08-20' : `2026-0${index + 1}-15`,
        predkontacia_id: predkontacia, predkontacia_kod: '518/321',
      });
    }
    const parser = {
      create: vi.fn().mockResolvedValue(aiOdpoved({
        predkontaciaId: predkontacia, clenenieDphId: null, clenenieKvKod: null, ciselnyRadId: null, confidence: 0.8, reason: 'x',
      })),
    };

    const povodny = database.query.bind(database);
    database.query = (async (sql: string, params?: unknown[]) => {
      if (/\b(insert\s+into|update\s+\w+\s+set|delete\s+from)\b/i.test(sql)) throw new Error(`zápis počas merania: ${sql}`);
      return povodny(sql, params);
    }) as Database['query'];
    // Bez API kľúča (testConfig) — režim bez AI ho nepotrebuje.
    const bezAi = await zmerajPresnost(database, testConfig(), kde, { deliciDatum: '2026-08-01' });
    const znova = await zmerajPresnost(database, testConfig(), kde, { deliciDatum: '2026-08-01' });
    const sAi = await zmerajPresnost(database, testConfig(), kde, { rezim: 'ai', deliciDatum: '2026-08-01' }, parser);
    database.query = povodny;

    // Chyba zápisu by sa v behu schovala do „chyba" dokladu — preto sa overuje aj tá.
    for (const beh of [bezAi, sAi]) {
      expect(beh.id).toBeNull();
      expect(beh.doklady.map((doklad) => doklad.chyba)).toEqual([undefined]);
    }
    // Lokálny výber odpovedá z pravidla protistrany, ktoré je v prompte.
    expect(bezAi).toMatchObject({ rezim: 'bez_ai', vysledok: { FP: { predkontacia: { spravne: 1, znamych: 1, navrhnutych: 1 } } } });
    expect(znova.doklady).toEqual(bezAi.doklady);
    for (const tabulka of ['documents', 'accounting_suggestions', 'ucto_presnost']) {
      expect((await database.query(`SELECT 1 FROM ${tabulka} WHERE organization_id=$1`, [kde.organizationId])).rowCount).toBe(0);
    }

    await zmerajPresnost(database, testConfig(), kde, { deliciDatum: '2026-08-01', uloz: true });
    const behy = await database.query<Record<string, any>>(
      'SELECT metodika, rezim, manifest, doklady FROM ucto_presnost WHERE organization_id=$1', [kde.organizationId],
    );
    expect(behy.rows).toEqual([expect.objectContaining({ metodika: 2, rezim: 'bez_ai' })]);
    expect(behy.rows[0].doklady).toHaveLength(1);
    expect(behy.rows[0].manifest).toMatchObject({ asOf: 'datum_dokladu', kategorie: 'vylucene', korpus: { zmeneny: false } });
  }, 120_000);

  it('režim AI: bez web searchu, strop volaní, sčítané tokeny a uložená odpoveď modelu', async () => {
    const { database, kde, kod, riadok } = await firma();
    const predkontacia = await kod('predkontacie', '518/321');
    for (let index = 1; index <= 5; index += 1) {
      await riadok({ doklad_cislo: `26FP10${index}`, datum: `2026-08-1${index}`, predkontacia_id: predkontacia });
    }
    const parser = {
      create: vi.fn().mockResolvedValue({
        ...aiOdpoved({
          predkontaciaId: predkontacia, clenenieDphId: null, clenenieKvKod: null, ciselnyRadId: null, confidence: 0.8, reason: 'x',
        }),
        usage: { input_tokens: 100, output_tokens: 20, total_tokens: 120 },
      }),
    };
    const vysledok = await zmerajPresnost(database, testConfig(), kde,
      { rezim: 'ai', deliciDatum: '2026-08-01', vzorka: 5, maxAiVolani: 2 }, parser);

    expect(parser.create).toHaveBeenCalledTimes(2);
    expect((parser.create.mock.calls[0][0] as any).tools).toBeUndefined();
    expect(vysledok.manifest).toMatchObject({ webSearch: false, tokeny: { vstup: 200, vystup: 40, spolu: 240 }, maxAiVolani: 2 });
    expect(vysledok.doklady[0].odpovedModelu).toMatchObject({ predkontaciaId: predkontacia });
  }, 90_000);

  it('doklad s dátumom v budúcnosti sa nemeria a okná sa neprekrývajú', async () => {
    const { database, kde, kod, riadok } = await firma();
    const predkontacia = await kod('predkontacie', '518/321');
    for (let index = 1; index <= 10; index += 1) {
      await riadok({ doklad_cislo: `26FP0${index}`, datum: `2026-0${Math.ceil(index / 2)}-1${index % 10}`, predkontacia_id: predkontacia });
    }
    const zajtra = new Date(Date.now() + 30 * 86_400_000).toISOString().slice(0, 10);
    await riadok({ doklad_cislo: '26FP999', datum: zajtra, predkontacia_id: predkontacia });

    const test = await zmerajPresnost(database, testConfig(), kde);
    const validacia = await zmerajPresnost(database, testConfig(), kde, { okno: 'validacia' });
    const okna = test.manifest.okna as { validacia: { od: string; doVylucne: string }; test: { od: string } };
    expect(okna.validacia.doVylucne).toBe(okna.test.od);
    expect(test.doklady.map((doklad) => doklad.doklad)).not.toContain('26FP999');
    expect(test.doklady.every((doklad) => doklad.datum >= okna.test.od)).toBe(true);
    expect(validacia.doklady.length).toBeGreaterThan(0);
    expect(validacia.doklady.every((doklad) => doklad.datum >= okna.validacia.od && doklad.datum < okna.test.od)).toBe(true);
  }, 90_000);
});

// Prvé ostré meranie ALPINY malo vzorku bez jedinej prijatej faktúry: pár
// leasingových splátok a rezerv je zaúčtovaných dopredu (31. 12.), takže
// „max mínus tri mesiace" dalo delítko 30. 9. Percentil sa o výbežky neopiera.
describe('deliaci dátum', () => {
  it('nenechá sa strhnúť dokladmi zaúčtovanými dopredu', async () => {
    const { database, kde, kod, riadok } = await firma();
    const predkontacia = await kod('predkontacie', '518/321');
    for (let index = 1; index <= 20; index += 1) {
      await riadok({ doklad_cislo: `26FP${index}`, datum: `2026-0${Math.ceil(index / 3)}-10`, predkontacia_id: predkontacia });
    }
    await riadok({ agenda: 'OZ', doklad_cislo: '26OZ001', datum: '2026-12-31', predkontacia_id: predkontacia });
    await riadok({ agenda: 'OZ', doklad_cislo: '26OZ002', datum: '2026-12-30', predkontacia_id: predkontacia });

    const vysledok = await zmerajPresnost(database, testConfig(), kde);
    expect(vysledok.deliciDatum < '2026-09-01').toBe(true);
    expect(Object.keys(vysledok.vysledok)).toContain('FP');
  }, 90_000);
});

// Druhé ostré meranie ALPINY malo rozpísaných dokladov nula: staršie importy
// niesli len hlavičku bez indexu a pri NULLS LAST prepísala položky.
describe('skladanie dokladu z korpusu', () => {
  it('stará hlavička bez indexu neprepíše položky', async () => {
    const { database, kde, kod, riadok } = await firma();
    const hlavna = await kod('predkontacie', '518/321');
    const iny = await kod('predkontacie', '501/321');
    const polozka = (index: number | null, text: string, predkontacia: string) => riadok({
      doklad_cislo: '26FP500', datum: '2026-08-10', supplier_name_normalized: 'dodavatel',
      line_text_normalized: text, predkontacia_id: predkontacia, riadok_index: index, suma: 50,
    });
    await polozka(0, 'nová hlavička', hlavna);
    await polozka(1, 'tovar', hlavna);
    await polozka(2, 'rozúčtovaná časť', iny);
    await polozka(null, 'stará hlavička', hlavna);

    const parser = {
      create: vi.fn().mockResolvedValue(aiOdpoved({
        predkontaciaId: hlavna, clenenieDphId: null, clenenieKvKod: null, ciselnyRadId: null, confidence: 0.8, reason: 'Tovar',
      })),
    };
    const vysledok = await zmerajPresnost(database, testConfig(), kde,
      { rezim: 'ai', deliciDatum: '2026-08-01', vzorka: 5 }, parser);

    expect(vysledok.vysledok.FP).toMatchObject({ dokladov: 1, rozpisanych: 1, chybajuciRozpis: 1 });
    expect(prompt(parser).dokument.polozky.map((item: any) => item.popis)).toEqual(['tovar', 'rozúčtovaná časť']);
  }, 90_000);
});

describe('hodnotenie tvaru', () => {
  const doklad = (polozky: Skutocnost['polozky']): Skutocnost => ({
    agenda: 'FP', dokladCislo: '1', datum: '2026-01-01',
    predkontaciaId: 'P', clenenieDphId: 'D', clenenieKvKod: 'B2', polozky,
  });
  const navrh = (riadky: Array<{ index: number; predkontaciaId: string; clenenieDphId?: string; clenenieKvKod?: string }> | null) => ({
    predkontacia_id: 'P', clenenie_dph_id: 'D', clenenie_kv_kod: 'B2', confidence: 0.8, reason: '',
    riadky: riadky?.map((riadok) => ({ popis: '', ...riadok })) ?? null,
  });

  it('položka s tým istým účtom, ale inou DPH je rozpis', () => {
    const skutocnost = doklad([{ popis: 'tovar' }, { popis: 'repre', predkontaciaId: 'P', clenenieDphId: 'N', clenenieKvKod: 'KN' }]);
    expect(jeRozpisany(skutocnost)).toBe(true);
    expect(jeRozpisany(doklad([{ popis: 'tovar' }, { popis: 'iny', predkontaciaId: 'P' }]))).toBe(false);
    expect(ohodnot(skutocnost, navrh([{ index: 1, predkontaciaId: 'P', clenenieDphId: 'N', clenenieKvKod: 'KN' }]), new Map()).tvar)
      .toEqual({ navrhnute: true, spravne: true });
  });

  it('zlý účet na rozpísanej položke je zlý tvar, rozpis nerozpísaného je falošný', () => {
    const rozpisany = doklad([{ popis: 'tovar' }, { popis: 'repre', predkontaciaId: 'X' }]);
    expect(ohodnot(rozpisany, navrh([{ index: 1, predkontaciaId: 'Y' }]), new Map()).tvar)
      .toEqual({ navrhnute: true, spravne: false });

    const obycajny = doklad([{ popis: 'tovar' }, { popis: 'tovar 2' }]);
    const hodnotenie = ohodnot(obycajny, navrh([{ index: 1, predkontaciaId: 'X' }]), new Map());
    expect(hodnotenie.tvar).toEqual({ navrhnute: true, spravne: false });
    const vysledok: VysledokDokladu = {
      agenda: 'FP', doklad: '1', datum: '2026-01-01', protistrana: null, rozpisany: false, navrhRozpisany: true,
      hodnotenie, skutocne: { predkontacia: 'P', clenenieDph: null, kv: null, rad: null },
      navrh: { predkontacia: 'P', clenenieDph: null, kv: null, rad: null },
    };
    expect(scitajPoAgendach([vysledok]).FP).toMatchObject({ falosnyRozpis: 1, chybajuciRozpis: 0, tvar: { spravne: 0, znamych: 1 } });
  });

  it('neznáma skutočnosť poľa sa nehodnotí', () => {
    const bezDph = { ...doklad([{ popis: 'tovar' }]), clenenieDphId: undefined };
    expect(ohodnot(bezDph, navrh(null), new Map()).clenenieDph).toBeNull();
    expect(ohodnot(bezDph, navrh(null), new Map()).rad).toBeNull();
  });
});

describe('vzorka a interval', () => {
  it('vzorka drží každú agendu a je stabilná', () => {
    const doklady = [
      ...Array.from({ length: 50 }, (_, index) => ({ agenda: 'FP', dokladCislo: `FP${index}` })),
      ...Array.from({ length: 5 }, (_, index) => ({ agenda: 'FV-D', dokladCislo: `D${index}` })),
      { agenda: 'PPD', dokladCislo: 'P1' },
    ];
    const vzorka = vyberVzorku(doklady, 10);
    expect(vzorka.length).toBeLessThanOrEqual(10);
    expect(new Set(vzorka.map((doklad) => doklad.agenda))).toEqual(new Set(['FP', 'FV-D', 'PPD']));
    // Poradie vstupu (napr. iný import) výber nemení.
    expect(new Set(vyberVzorku([...doklady].reverse(), 10))).toEqual(new Set(vzorka));
  });

  it('interval spoľahlivosti obopína podiel a je opakovateľný', () => {
    const doklady = Array.from({ length: 20 }, (_, index) => ({
      hodnotenie: {
        predkontacia: { navrhnute: true, spravne: index < 16 }, clenenieDph: null, kv: null, rad: null, tvar: null,
      },
    }));
    const interval = intervalSpolahlivosti(doklady, 'predkontacia');
    expect(interval![0]).toBeLessThan(0.8);
    expect(interval![1]).toBeGreaterThan(0.8);
    expect(intervalSpolahlivosti(doklady, 'predkontacia')).toEqual(interval);
    expect(intervalSpolahlivosti(doklady, 'kv')).toBeNull();
  });
});

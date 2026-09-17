import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Database } from '../db/database.js';
import { aiOdpoved, createTestDatabase, potvrdFakt, seedTestUser, testConfig } from '../testHelpers.js';
import {
  castostOtazok, intervalSpolahlivosti, jeRozpisany, ohodnot, porovnajBehy, presnostNadPrahom, scitajPoAgendach, vyberVzorku, zmerajPresnost,
  type Skutocnost, type VysledokDokladu,
} from './uctoPresnostService.js';
import { prepocitajPravidla, sporPraxe } from './uctoPravidlaService.js';

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
    // Celé doklady tiež len spred dátumu: tri rovnaké doklady protistrany sa
    // zlúčia do najnovšieho — meraný by bol najnovší, keby unikol.
    expect(prompt(parser).doklady).toEqual([expect.objectContaining({ ref: 'FP|26FP003|2026-03-15', rovnakych: 3 })]);
    expect(JSON.stringify(prompt(parser).doklady)).not.toContain(ina);
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

  // Samotné členenie DPH bez účtu nie je zaúčtovanie — tvar ani rozpis sa za návrh rátať nesmú.
  it('návrh bez predkontácie je zdržanie, nie zlý tvar', async () => {
    const { database, kde, kod, riadok } = await firma();
    const predkontacia = await kod('predkontacie', '518/321');
    const pd = await kod('cleneniaDph', 'PD');
    const iny = await kod('predkontacie', '501/321');
    const doklad = { doklad_cislo: '26FP001', datum: '2026-08-20', suma_dph: 20, sadzba_dph: 20 };
    await riadok({ ...doklad, predkontacia_id: predkontacia, clenenie_dph_id: pd });
    await riadok({ ...doklad, riadok_index: 1, predkontacia_id: predkontacia, clenenie_dph_id: pd });
    await riadok({ ...doklad, riadok_index: 2, line_text_normalized: 'ine', predkontacia_id: iny, clenenie_dph_id: pd });
    const parser = {
      create: vi.fn().mockResolvedValue(aiOdpoved({
        predkontaciaId: null, clenenieDphId: pd, clenenieKvKod: null, ciselnyRadId: null, confidence: 0.5, reason: 'Len DPH',
      })),
    };
    const vysledok = await zmerajPresnost(database, testConfig(), kde, { rezim: 'ai', deliciDatum: '2026-08-01' }, parser);
    expect(vysledok.doklady[0]).toMatchObject({ zdrzanie: 'bez_predkontacie', navrh: null });
    expect(vysledok.vysledok.FP).toMatchObject({
      zdrzanie: 1, chybajuciRozpis: 0, rozpisanych: 1, tvar: { spravne: 0, znamych: 1, navrhnutych: 0 },
    });
  }, 60_000);

  // Zmluva s promptom: režim bez AI číta dennik[].tejProtistrany. Keď sa kľúč
  // premenuje, každý doklad bez pravidla ticho skončí ako „bez dôkazu".
  it('bez AI odpovie z denníka protistrany, keď pravidlo ešte nie je', async () => {
    const { database, kde, kod, riadok } = await firma();
    const predkontacia = await kod('predkontacie', '518/321');
    await riadok({ doklad_cislo: '26FP001', datum: '2026-02-15', predkontacia_id: predkontacia, predkontacia_kod: '518/321' });
    await riadok({ doklad_cislo: '26FP090', datum: '2026-08-20', predkontacia_id: predkontacia, predkontacia_kod: '518/321' });
    const vysledok = await zmerajPresnost(database, testConfig(), kde, { deliciDatum: '2026-08-01' });
    expect(vysledok.vysledok.FP.predkontacia).toEqual({ spravne: 1, znamych: 1, navrhnutych: 1 });
    // Istota sa ukladá k dokladu — bez nej sa prah predvyplnenia nedá overiť.
    expect(vysledok.doklady[0].istota).toBe(0.8);
  }, 60_000);

  // Nová protistrana: pravidlo ani denník protistrany nepomôžu, rozhoduje druh
  // plnenia. V celkovom čísle by sa stratila medzi známymi dodávateľmi.
  it('doklady novej protistrany sa počítajú aj zvlášť', async () => {
    const { database, kde, kod, riadok } = await firma();
    const predkontacia = await kod('predkontacie', '518/321');
    await riadok({ doklad_cislo: '26FP001', datum: '2026-02-15', predkontacia_id: predkontacia, predkontacia_kod: '518/321' });
    await riadok({ doklad_cislo: '26FP090', datum: '2026-08-20', predkontacia_id: predkontacia, predkontacia_kod: '518/321' });
    await riadok({
      doklad_cislo: '26FP091', datum: '2026-08-21', predkontacia_id: predkontacia, predkontacia_kod: '518/321',
      supplier_name_normalized: 'nova preprava s.r.o.',
    });

    const vysledok = await zmerajPresnost(database, testConfig(), kde, { deliciDatum: '2026-08-01' });
    expect(vysledok.doklady.map((doklad) => [doklad.doklad, doklad.novaProtistrana ?? false])).toEqual([
      ['26FP090', false], ['26FP091', true],
    ]);
    expect(vysledok.vysledokNovaProtistrana.FP).toMatchObject({ dokladov: 1, zdrzanie: 1 });
  }, 60_000);

  // Rovnaké meno s iným IČO je iná firma — spoločné meno ju nesmie zaradiť medzi
  // známe. Riadok histórie bez IČO sa však ešte smie spárovať menom (staré
  // importy IČO nemali). Doklad bez IČO aj mena nie je „známy", ale neznámy.
  it('nová protistrana sa pozná podľa IČO a doklad bez identity je neznámy', async () => {
    const { database, kde, kod, riadok } = await firma();
    const predkontacia = await kod('predkontacie', '518/321');
    await riadok({
      doklad_cislo: '26FP001', datum: '2026-02-15', predkontacia_id: predkontacia, predkontacia_kod: '518/321',
      supplier_ico: '11111111', supplier_name_normalized: 'preprava s.r.o.',
    });
    await riadok({
      doklad_cislo: '26FP002', datum: '2026-02-16', predkontacia_id: predkontacia, predkontacia_kod: '518/321',
      supplier_name_normalized: 'stary import s.r.o.',
    });
    const meranie = { predkontacia_id: predkontacia, predkontacia_kod: '518/321' };
    await riadok({ ...meranie, doklad_cislo: '26FP090', datum: '2026-08-20', supplier_ico: '22222222', supplier_name_normalized: 'preprava s.r.o.' });
    await riadok({ ...meranie, doklad_cislo: '26FP091', datum: '2026-08-21', supplier_ico: '33333333', supplier_name_normalized: 'stary import s.r.o.' });
    await riadok({ ...meranie, doklad_cislo: '26FP092', datum: '2026-08-22', supplier_name_normalized: null });

    const vysledok = await zmerajPresnost(database, testConfig(), kde, { deliciDatum: '2026-08-01' });
    const podlaCisla = Object.fromEntries(vysledok.doklady.map((doklad) =>
      [doklad.doklad, [doklad.novaProtistrana ?? false, doklad.neznamaProtistrana ?? false]]));
    expect(podlaCisla).toEqual({
      '26FP090': [true, false],
      '26FP091': [false, false],
      '26FP092': [false, true],
    });
  }, 60_000);

  // Spor praxí: protistrana má dve ustálené zaúčtovania a ani jedno neprevažuje,
  // takže pravidlo príde bez účtu. Základná čiara to nesmie brať ako odpoveď —
  // inak by spor vyzeral ako zdržanie, hoci denník tej istej protistrany odpoveď má.
  it('bez AI pri spore praxí siahne po denníku, nie po prázdnom pravidle', async () => {
    const { database, kde, kod, riadok } = await firma();
    const p518 = await kod('predkontacie', '518/321');
    const p501 = await kod('predkontacie', '501/321');
    // Striedavo po mesiacoch, aby nešlo o zmenu praxe (tá by víťaza mala).
    const prax = [
      ['26FP001', '2026-01-15', p518, '518/321'], ['26FP002', '2026-02-15', p501, '501/321'],
      ['26FP003', '2026-03-15', p518, '518/321'], ['26FP004', '2026-04-15', p501, '501/321'],
      ['26FP005', '2026-05-15', p518, '518/321'], ['26FP006', '2026-06-15', p501, '501/321'],
      ['26FP007', '2026-07-15', p518, '518/321'],
    ] as const;
    for (const [cislo, datum, id, kodPredkontacie] of prax) {
      await riadok({ doklad_cislo: cislo, datum, predkontacia_id: id, predkontacia_kod: kodPredkontacie });
    }
    // 4 zo 7 je pod hranicou 60 %, takže pravidlo skončí v spore bez kódov.
    await riadok({ doklad_cislo: '26FP090', datum: '2026-08-20', predkontacia_id: p518, predkontacia_kod: '518/321' });

    const vysledok = await zmerajPresnost(database, testConfig(), kde, { deliciDatum: '2026-08-01' });
    expect(vysledok.doklady[0].zdrzanie ?? null).toBeNull();
    expect(vysledok.vysledok.FP.predkontacia).toEqual({ spravne: 1, znamych: 1, navrhnutych: 1 });
  }, 60_000);

  // Druh operácie pred praxou protistrany: zamestnanec so zúčtovaním stravného aj
  // pokutami. Pokút je viac, takže pravidlo protistrany dalo stravnému účet pokuty.
  it('bez AI vyberie druh podľa textu dokladu aj s rozpisom; nová protistrana ostáva bez návrhu', async () => {
    const { database, kde, kod, riadok } = await firma();
    const stravne = await kod('predkontacie', '333100-stravné');
    const cestovne = await kod('predkontacie', 'cestovné381');
    const zaloha = await kod('predkontacie', 'zúčt.zálohy');
    const pokuty = await kod('predkontacie', '325100-pokuty');
    const zpc = async (cislo: string, datum: string, zamestnanec = 'mrkva jozef') => {
      const spolocne = { agenda: 'OZ', doklad_cislo: cislo, datum, supplier_name_normalized: zamestnanec };
      await riadok({ ...spolocne, line_text_normalized: 'zpc týždeň', suma: null, predkontacia_id: stravne, predkontacia_kod: '333100-stravné' });
      for (const [index, text, suma, id, kodPredkontacie] of [
        [1, 'stravné', 1000, stravne, '333100-stravné'], [2, 'cestovné', 180, cestovne, 'cestovné381'],
        [3, 'zúčtovanie zálohy', -300, zaloha, 'zúčt.zálohy'],
      ] as const) {
        await riadok({ ...spolocne, riadok_index: index, line_text_normalized: text, suma, predkontacia_id: id, predkontacia_kod: kodPredkontacie });
      }
    };
    const pokuta = (cislo: string, datum: string) => riadok({
      agenda: 'OZ', doklad_cislo: cislo, datum, supplier_name_normalized: 'mrkva jozef',
      line_text_normalized: `pokuta č. ${cislo}; mrkva jozef`, predkontacia_id: pokuty, predkontacia_kod: '325100-pokuty',
    });
    for (const [index, cislo] of ['26ZC001', '26ZC002', '26ZC003'].entries()) await zpc(cislo, `2026-0${index * 2 + 2}-10`);
    // Šesť pokút z deviatich dokladov je prevažujúca podoba protistrany.
    for (let mesiac = 1; mesiac <= 6; mesiac += 1) await pokuta(`26OZ00${mesiac}`, `2026-0${mesiac}-05`);
    await zpc('26ZC090', '2026-08-20');
    await pokuta('26OZ091', '2026-08-21');
    await zpc('26ZC092', '2026-08-22', 'novák peter');

    const vysledok = await zmerajPresnost(database, testConfig(), kde, { deliciDatum: '2026-08-01' });
    const doklad = (cislo: string) => vysledok.doklady.find((item) => item.doklad === cislo)!;
    expect(doklad('26ZC090')).toMatchObject({
      navrh: { predkontacia: '333100-stravné' }, rozpisany: true, navrhRozpisany: true,
      hodnotenie: { predkontacia: { spravne: true }, tvar: { spravne: true } },
    });
    expect(doklad('26OZ091')).toMatchObject({ navrh: { predkontacia: '325100-pokuty' }, hodnotenie: { predkontacia: { spravne: true } } });
    // Nová protistrana nemá pravidlo ani druhy — ako doteraz sa zdrží.
    expect(doklad('26ZC092')).toMatchObject({ novaProtistrana: true, navrh: null, zdrzanie: expect.any(String) });
  }, 90_000);

  // Interný doklad samozdanenia nesie DPH, ktorú si firma vypočítala sama.
  // Faktúra zahraničného dodávateľa za ním je bez dane — kým meranie tú daň
  // podstrčilo ako daň dodávateľa, kontrola DPH ju brala za cudziu daň
  // a každé samozdanenie zablokovala.
  it('daň interného dokladu nie je daň, ktorú účtoval dodávateľ', async () => {
    const { database, kde, kod, riadok } = await firma();
    const aInt = await kod('predkontacie', 'aInt');
    const pdSluz = await kod('cleneniaDph', 'PDsluz');
    const samozdanenie = {
      agenda: 'INT', supplier_name_normalized: 'geschwandtner gmbh', krajina: 'DE', suma_dph: 23, sadzba_dph: 23,
      predkontacia_id: aInt, predkontacia_kod: 'aInt', clenenie_dph_id: pdSluz,
    };
    await riadok({ ...samozdanenie, doklad_cislo: '26SAM001', datum: '2026-02-15' });
    await riadok({ ...samozdanenie, doklad_cislo: '26SAM090', datum: '2026-08-20' });

    const vysledok = await zmerajPresnost(database, testConfig(), kde, { deliciDatum: '2026-08-01' });
    expect(vysledok.doklady[0].zdrzanie ?? null).toBeNull();
    expect(vysledok.vysledok.INT.predkontacia).toEqual({ spravne: 1, znamych: 1, navrhnutych: 1 });
  }, 60_000);
});

// Neskorší doklad ani nič, čo vzniklo po dátume dokladu, nesmie zmeniť to, čo
// o skoršom doklade model dostane — ani to, čo z odpovede spraví dospracovanie.
describe('bez úniku budúcnosti', () => {
  it('neskorší doklad, pravidlá, príklady, pokyny, kategórie ani fakty profilu nezmenia prompt ani výsledok', async () => {
    const { database, kde, vloz, kod, riadok } = await firma();
    const p518 = await kod('predkontacie', '518/321');
    const p501 = await kod('predkontacie', '501/321');
    const pd = await kod('cleneniaDph', 'PD');
    const pn = await kod('cleneniaDph', 'PN');
    await kod('ciselneRady', 'R1', { agenda: 'prijate_faktury', accounting_year: '2026' });
    // R2 pri rovnosti použití prehráva s R1 poradím kódu — budúce použitie ho musí prevážiť, ak unikne.
    const r2 = await kod('ciselneRady', 'R2', { agenda: 'prijate_faktury', accounting_year: '2026' });
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
    // Fakt profilu potvrdený pred dokladom v prompte byť MÁ.
    await potvrdFakt(database, kde, 'zasady.tovar_na_ceste', { pouziva: false }, '2026-01-01T00:00:00Z');

    // Sekciu KV model nedá: doplní ju prax firmy (kvPreClenenie), ktorá tiež musí stáť k dátumu.
    const parser = {
      create: vi.fn().mockResolvedValue(aiOdpoved({
        predkontaciaId: p518, clenenieDphId: pd, clenenieKvKod: null, ciselnyRadId: null, confidence: 0.8, reason: 'Preprava',
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
    // Tá istá DPH s inou sekciou: bez delenia časom by prax PD prestala byť jednoznačná.
    await riadok({ doklad_cislo: '26FP021', datum: '2026-05-11', ...kody, clenenie_kv_kod: 'B3' });
    await vloz('ucto_decisions', {
      supplier_name_normalized: 'preprava s.r.o.', line_text_normalized: 'preprava tovaru', predkontacia_id: p501,
      clenenie_dph_id: pn, clenenie_kv_kod: 'KN', ciselny_rad_id: r2, document_type: 'FP', source: 'import',
      created_at: '2026-06-01',
    });
    await vloz('accounting_rules', {
      supplier_name_normalized: 'preprava s.r.o.', predkontacia_id: p501, priority: 1, created_at: '2026-06-01',
    });
    await database.query(
      `INSERT INTO ai_instructions (id,scope,nazov,text,faza,created_at)
       VALUES ($1,'global','Nové pravidlo','platí','accounting','2026-06-01')`, [randomUUID()],
    );
    // Odpoveď účtovníka až po dátume dokladu: neplatiteľ by zmenil pokyny aj ponuku členení.
    await potvrdFakt(database, kde, 'dph.status', { status: 'neplatitel' }, '2026-06-01T00:00:00Z');
    await potvrdFakt(database, kde, 'dph.clenenie_bez_odpoctu', { clenenieKod: 'PN' }, '2026-06-01T00:00:00Z');
    await vloz('ucto_kategorie', {
      nazov: 'Preprava', slovnik: JSON.stringify(['preprava']), predkontacia_id: p501, agendy: JSON.stringify(['FP']), pocet: 30,
    });
    const potom = await zmeraj();

    expect(potom.prompt).toEqual(predtym.prompt);
    expect(potom.doklad).toEqual(predtym.doklad);
    // Sekcia prišla z praxe firmy a rad z počtu použití — oba zdroje sa teda naozaj pýtali.
    expect(predtym.doklad?.navrh).toMatchObject({ kv: 'B2', rad: 'R1' });
    // Doklady v prompte naozaj sú — rovnosť promptov vyššie teda stráži aj ich.
    expect(predtym.prompt.doklady).toEqual([expect.objectContaining({ ref: 'FP|26FP003|2026-03-15', rovnakych: 3 })]);
    expect(predtym.prompt.kategorie).toEqual([]);
    expect(predtym.prompt.pravidla).toContain('Staré pravidlo');
    expect(predtym.prompt.pravidla).not.toContain('Nové pravidlo');
    expect(predtym.prompt.profilKlienta).toEqual({ platitelDph: 'nezname', pokyny: ['Firma tovar na ceste (účet 139) neúčtuje.'] });
  }, 120_000);
});

// Účinok profilu klienta (analýza 2.4): tá istá vzorka s profilom k dátumu,
// dnešným potvrdeným a vypnutým. Voľba smie meniť LEN profil v prompte a manifest
// musí retrospektívne použitie dnešnej politiky pomenovať.
describe('meranie účinku profilu', () => {
  it('k_datumu, potvrdeny a vypnuty menia len profil a manifest ich označí', async () => {
    const { database, kde, kod, riadok } = await firma();
    const p518 = await kod('predkontacie', '518/321');
    for (const [index, cislo] of ['26FP001', '26FP002', '26FP003', '26FP090'].entries()) {
      await riadok({
        doklad_cislo: cislo, datum: index === 3 ? '2026-08-20' : `2026-0${index + 1}-15`,
        predkontacia_id: p518, predkontacia_kod: '518/321',
      });
    }
    // Fakt spred dokladu vidí aj replay k dátumu; status potvrdený dnes len profil potvrdeny.
    await potvrdFakt(database, kde, 'zasady.tovar_na_ceste', { pouziva: false }, '2026-01-01T00:00:00Z');
    await potvrdFakt(database, kde, 'dph.status', { status: 'platitel' });
    const parser = {
      create: vi.fn().mockResolvedValue(aiOdpoved({
        predkontaciaId: p518, clenenieDphId: null, clenenieKvKod: null, ciselnyRadId: null, confidence: 0.8, reason: 'Preprava',
      })),
    };
    const zmeraj = async (profil?: 'k_datumu' | 'potvrdeny' | 'vypnuty') => {
      parser.create.mockClear();
      const vysledok = await zmerajPresnost(database, testConfig(), kde, { rezim: 'ai', deliciDatum: '2026-08-01', profil }, parser);
      return { vysledok, prompt: prompt(parser) };
    };
    const predvolene = await zmeraj();
    const kDatumu = await zmeraj('k_datumu');
    const potvrdeny = await zmeraj('potvrdeny');
    const vypnuty = await zmeraj('vypnuty');

    expect(kDatumu.prompt).toEqual(predvolene.prompt);
    expect(kDatumu.prompt.profilKlienta).toEqual({ platitelDph: 'nezname', pokyny: ['Firma tovar na ceste (účet 139) neúčtuje.'] });
    expect(potvrdeny.prompt.profilKlienta).toMatchObject({ platitelDph: 'platitel' });
    expect(vypnuty.prompt.profilKlienta).toBeUndefined();
    for (const beh of [potvrdeny, vypnuty]) {
      expect({ ...beh.prompt, profilKlienta: undefined }).toEqual({ ...kDatumu.prompt, profilKlienta: undefined });
      expect(beh.vysledok.doklady.map((doklad) => doklad.doklad)).toEqual(kDatumu.vysledok.doklady.map((doklad) => doklad.doklad));
    }

    expect(predvolene.vysledok.manifest).toMatchObject({ profil: 'k_datumu', vylucene: ['ucto_kategorie'] });
    expect(predvolene.vysledok.manifest.profilUpozornenie).toBeUndefined();
    expect(potvrdeny.vysledok.manifest).toMatchObject({
      profil: 'potvrdeny', profilUpozornenie: expect.stringContaining('retrospektívne'),
      aktualnyStav: expect.arrayContaining(['profil_fakty']),
    });
    expect(vypnuty.vysledok.manifest).toMatchObject({ profil: 'vypnuty', vylucene: ['ucto_kategorie', 'profil_fakty'] });
  }, 120_000);

  it('párové porovnanie počíta zmenené doklady a po poliach zlepšenia, zhoršenia aj doklady bez páru', () => {
    const doklad = (cislo: string, predkontacia: boolean | null, dph: boolean | null): VysledokDokladu => ({
      agenda: 'FP', doklad: cislo, datum: '2026-08-20', protistrana: null, rozpisany: false, navrhRozpisany: false,
      hodnotenie: {
        predkontacia: predkontacia === null ? null : { navrhnute: true, spravne: predkontacia },
        clenenieDph: dph === null ? null : { navrhnute: true, spravne: dph },
        kv: null, rad: null, tvar: null,
      },
      skutocne: { predkontacia: 'A', clenenieDph: 'PD', kv: null, rad: null },
      navrh: { predkontacia: predkontacia ? 'A' : 'B', clenenieDph: dph ? 'PD' : 'PN', kv: null, rad: null },
    });
    const rozdiel = porovnajBehy(
      [doklad('1', false, true), doklad('2', true, true), doklad('3', true, null), doklad('len-pred', true, true)],
      [doklad('1', true, false), doklad('2', true, true), doklad('3', true, null), doklad('len-po', false, false)],
    );
    expect(rozdiel).toMatchObject({
      parov: 3, bezParu: 2, zmenenych: 1,
      polia: { predkontacia: { lepsie: 1, horsie: 0 }, clenenieDph: { lepsie: 0, horsie: 1 }, tvar: { lepsie: 0, horsie: 0 } },
    });
  });
});

// Firma bez histórie (R18): tie isté doklady, ale engine nesmie vidieť nič
// z toho, čo firma robila — len číselníky. Každý zdroj histórie sa overuje
// najprv v bežnom behu, inak by prázdny prompt nič nedokazoval.
describe('firma bez histórie', () => {
  it('prompt nemá denník, doklady, pravidlá, príklady, rozdelenie, pokyny ani kategórie a rad ide cestou novej firmy', async () => {
    const { database, kde, vloz, kod, riadok } = await firma();
    const p518 = await kod('predkontacie', '518/321', { ucet_md: '518100' });
    const p501 = await kod('predkontacie', '501/321', { ucet_md: '501100' });
    const pd = await kod('cleneniaDph', 'PD');
    await kod('ciselneRady', 'R1', { agenda: 'prijate_faktury', external_id: '11', accounting_year: '2026', last_number: 'R1005' });
    // Nová firma nemá z čoho počítať rad — dostane ho z posledného čísla v číselníku.
    await kod('ciselneRady', 'R2', { agenda: 'prijate_faktury', external_id: '12', accounting_year: '2026', last_number: 'R2099' });
    const kody = { predkontacia_id: p518, predkontacia_kod: '518/321', clenenie_dph_id: pd, clenenie_dph_kod: 'PD', clenenie_kv_kod: 'B2', rad_external_id: '11', rad_kod: 'R1' };
    for (const [index, cislo] of ['26FP001', '26FP002', '26FP003', '26FP090'].entries()) {
      await riadok({ doklad_cislo: cislo, datum: index === 3 ? '2026-08-20' : `2026-0${index + 1}-15`, ...kody });
      if (index === 3) continue;
      for (const ucet of ['518100', '501100']) {
        await vloz('ucto_dennik', {
          externalny_id: `${cislo}-${ucet}`, agenda: 'Prijaté faktúry', doklad_cislo: cislo, datum: `2026-0${index + 1}-15`,
          ucet_md: ucet, ucet_dal: '321000', partner_nazov: 'preprava s.r.o.',
        });
      }
    }
    await vloz('ucto_decisions', {
      supplier_name_normalized: 'preprava s.r.o.', line_text_normalized: 'preprava tovaru', predkontacia_id: p518,
      document_type: 'FP', source: 'import', created_at: '2026-01-01',
    });
    // Pravidlo účtovníka prebije odpoveď modelu — v bežnom behu je predkontácia 501/321.
    await vloz('accounting_rules', { supplier_name_normalized: 'preprava s.r.o.', predkontacia_id: p501, priority: 1, created_at: '2026-01-01' });
    await database.query(
      `INSERT INTO ai_instructions (id,scope,nazov,text,faza,created_at)
       VALUES ($1,'global','Staré pravidlo','platí','accounting','2026-01-01')`, [randomUUID()],
    );
    await vloz('ucto_kategorie', {
      nazov: 'Preprava', slovnik: JSON.stringify(['preprava']), predkontacia_id: p518, agendy: JSON.stringify(['FP']), pocet: 30,
    });

    const parser = {
      create: vi.fn().mockResolvedValue(aiOdpoved({
        predkontaciaId: p518, clenenieDphId: pd, clenenieKvKod: null, ciselnyRadId: null, confidence: 0.8, reason: 'Preprava',
      })),
    };
    const zmeraj = async (bezHistorie: boolean) => {
      parser.create.mockClear();
      const vysledok = await zmerajPresnost(database, testConfig(), kde,
        { rezim: 'ai', deliciDatum: '2026-08-01', kategorie: true, bezHistorie }, parser);
      return { vysledok, prompt: prompt(parser) };
    };

    const bezne = await zmeraj(false);
    expect(bezne.prompt.dennik).not.toEqual([]);
    expect(bezne.prompt.doklady).toBeDefined();
    expect(bezne.prompt.pravidlo).toBeDefined();
    expect(bezne.prompt.rozdelenie).toBeDefined();
    expect(bezne.prompt.priklady).not.toEqual([]);
    expect(bezne.prompt.kategorie).not.toEqual([]);
    expect(bezne.prompt.pravidla).toContain('Staré pravidlo');
    expect(bezne.prompt.ciselniky.cleneniaDph).toEqual([expect.objectContaining({ pouziteNaTomtoTypeDokladu: 3 })]);
    expect(bezne.vysledok.doklady[0]).toMatchObject({ navrh: { predkontacia: '501/321', rad: 'R1' } });
    expect(bezne.vysledok.doklady[0].novaProtistrana).toBeUndefined();

    const nova = await zmeraj(true);
    expect(nova.prompt.dennik).toEqual([]);
    expect(nova.prompt.doklady).toBeUndefined();
    expect(nova.prompt.pravidlo).toBeUndefined();
    expect(nova.prompt.rozdelenie).toBeUndefined();
    expect(nova.prompt.priklady).toEqual([]);
    expect(nova.prompt.kategorie).toEqual([]);
    expect(JSON.stringify(nova.prompt.pravidla ?? null)).not.toContain('Staré pravidlo');
    expect(nova.prompt.ciselniky.cleneniaDph).toEqual([{ id: pd, kod: 'PD', nazov: 'PD' }]);
    expect(nova.vysledok.doklady[0]).toMatchObject({ novaProtistrana: true, navrh: { predkontacia: '518/321', rad: 'R2' } });
    expect(nova.vysledok.manifest).toMatchObject({ asOf: 'bez_historie', kategorie: 'vylucene', embeddingy: null });
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
    for (const tabulka of ['documents', 'accounting_suggestions', 'ucto_navrh_stopa', 'extraction_runs', 'ucto_presnost']) {
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

// Kedy by sa systém pýtal účtovníka namiesto hádania (R09). Pred zapnutím
// otázok treba vedieť, na koľkých dokladoch by sa pýtal — cieľ je najviac
// 10–15 %. Spor praxí protistrany, ktorý mení DPH alebo sekciu KV, je otázka;
// spor len v účte je ponuka bez predvyplnenia; nová protistrana je otázka.
describe('častosť otázok', () => {
  it('spor praxí rozlíši DPH od účtu', () => {
    const variant = (predkontaciaKod: string, clenenieDphKod: string, clenenieKvKod: string) => ({
      predkontaciaKod, clenenieDphKod, clenenieKvKod, tvar: [], dokladov: 3, od: '2026-01-01', do: '2026-06-01',
    });
    expect(sporPraxe(undefined)).toBeUndefined();
    expect(sporPraxe({ konflikt: false, varianty: [variant('501', 'PD', 'B2'), variant('518', 'PN', 'KN')] })).toBeUndefined();
    expect(sporPraxe({ konflikt: true, varianty: [variant('501', 'PD', 'B2'), variant('518', 'PD', 'B2')] })).toBe('ucet');
    expect(sporPraxe({ konflikt: true, varianty: [variant('513', 'PN', 'KN'), variant('513', 'PN', 'B2')] })).toBe('dph');
  });

  it('spor nie je šum: strany samozdanenia, prázdne KV pri PN ani okrajový doklad', () => {
    const variant = (predkontaciaKod: string, clenenieDphKod: string, clenenieKvKod: string, okrajovy?: boolean) => ({
      predkontaciaKod, clenenieDphKod, clenenieKvKod, tvar: [], dokladov: 5, od: '2026-01-01', do: '2026-06-01',
      ...(okrajovy ? { okrajovy } : {}),
    });
    // Samozdanenie: jeden interný doklad daň priznáva (DD…), druhý ju odpočítava
    // (PD…). Sú to dva doklady jednej praxe, nie dve praxe.
    expect(sporPraxe({ konflikt: true, varianty: [variant('343', 'DDsl§69', 'B1'), variant('343', 'PDsluz', 'B1')] })).toBeUndefined();
    // Prázdna sekcia a KN pri členení bez odpočtu — rovnaká daň, spor len v účte.
    expect(sporPraxe({ konflikt: true, varianty: [variant('518', 'PN', ''), variant('548', 'PN', 'KN')] })).toBe('ucet');
    // Okrajový doklad sporom nie je.
    expect(sporPraxe({ konflikt: true, varianty: [variant('518', 'PD', 'B2'), variant('1', 'PN', 'KN', true)] })).toBeUndefined();
    // Vlastný kód firmy či chýbajúce členenie sa od PD neoddeľujú — len strana DD.
    expect(sporPraxe({ konflikt: true, varianty: [variant('518', 'PD', 'B2'), variant('518', '', '')] })).toBe('dph');
    expect(sporPraxe({ konflikt: true, varianty: [variant('518', 'PD', 'B2'), variant('518', 'PDvlastny', 'KN')] })).toBe('dph');
    // Skutočný spor v rámci jednej strany ostáva.
    expect(sporPraxe({ konflikt: true, varianty: [variant('518', 'PD', 'B2'), variant('518', 'PN', 'KN'), variant('343', 'DDsl§69', 'B1')] })).toBe('dph');
  });

  it('spočíta otázky a ponuky bez predvyplnenia na doklad, nie na dôvod', () => {
    const doklady = [
      { spor: 'dph' as const }, { spor: 'dph' as const, novaProtistrana: true },
      { spor: 'ucet' as const }, { novaProtistrana: true }, {}, {}, {}, {}, {}, {},
    ];
    expect(castostOtazok(doklady)).toEqual({ dokladov: 10, otazky: 3, sporDph: 2, novaProtistrana: 2, ponukyBezPredvyplnenia: 1 });
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

  // Vzorka je strop platených volaní: kvóta „aspoň jeden na agendu" ju nesmie prekročiť.
  it('vzorka nikdy neprekročí rozpočet, ani keď je agend viac než miest', () => {
    const agendy = (velkosti: Record<string, number>) => Object.entries(velkosti)
      .flatMap(([agenda, pocet]) => Array.from({ length: pocet }, (_, index) => ({ agenda, dokladCislo: `${agenda}${index}` })));
    const trojica = vyberVzorku(agendy({ FP: 90, FV: 5, OZ: 5 }), 10);
    expect(trojica).toHaveLength(10);
    expect(new Set(trojica.map((doklad) => doklad.agenda))).toEqual(new Set(['FP', 'FV', 'OZ']));
    expect(vyberVzorku(agendy({ FP: 10, FV: 10, OZ: 10, INT: 10 }), 2)).toHaveLength(2);
    // Viac agend než miest: rozpočet vyhrá a vypadnú najmenšie.
    expect(new Set(vyberVzorku(agendy({ FP: 10, FV: 5, OZ: 3 }), 2).map((doklad) => doklad.agenda)))
      .toEqual(new Set(['FP', 'FV']));
  });

  // Bootstrap na samých správnych dokladoch vracal [1, 1] — sľuboval istotu,
  // ktorú 20 dokladov nedá. Wilsonov interval pri 20 z 20 začína okolo 84 %.
  it('20 z 20 správnych nedá interval sto percent', () => {
    const doklady = Array.from({ length: 20 }, () => ({
      hodnotenie: { predkontacia: { navrhnute: true, spravne: true }, clenenieDph: null, kv: null, rad: null, tvar: null },
    }));
    const [dolna, horna] = intervalSpolahlivosti(doklady, 'predkontacia')!;
    expect(dolna).toBeGreaterThan(0.83);
    expect(dolna).toBeLessThan(0.85);
    expect(horna).toBe(1);
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

  // Predvypĺňa sa od istoty 0,9. Presnosť tam je presnosť dokladov, ktoré
  // účtovník neotvorí — doklady pod prahom ju nesmú ani zlepšiť, ani zhoršiť.
  it('presnosť nad prahom počíta len doklady, ktoré by sa predvyplnili', () => {
    const doklad = (istota: number, spravne: boolean) => ({
      istota,
      hodnotenie: { predkontacia: { navrhnute: true, spravne }, clenenieDph: null, kv: null, rad: null, tvar: null },
    });
    const doklady = [
      ...Array.from({ length: 30 }, (_, index) => doklad(0.95, index < 27)),
      ...Array.from({ length: 30 }, () => doklad(0.8, false)),
    ];
    const vysledok = presnostNadPrahom(doklady, 'predkontacia');
    expect(vysledok).toMatchObject({ navrhnutych: 30, spravnych: 27, pokrytie: 0.5 });
    expect(vysledok.interval![0]).toBeLessThan(0.9);
    expect(vysledok.interval![1]).toBeGreaterThan(0.9);
    // Päť dokladov nad prahom: interval by klamal presnosťou, ktorú nemá.
    expect(presnostNadPrahom(doklady.slice(25, 35), 'predkontacia').interval).toBeNull();
  });
});

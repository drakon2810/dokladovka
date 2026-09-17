import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import { createTestDatabase, seedTestUser } from '../testHelpers.js';
import {
  najdiPravidlo, odvodNavrhyDelenia, odvodPrax, odvodRozpis, odvodRozpisVarianty, pravidloPodlaTextu, prepocitajPravidla, sporPraxe,
  variantyRozpisu, type DokladDelenia, type DokladPraxe, type UctoPravidlo,
} from './uctoPravidlaService.js';
import { doplnRozpisKategorii } from './uctoKategoriaRozpis.js';
import { ocistiSlovnik } from './uctoProfileService.js';

// Pravidlo je zhrnutie toho, čo v korpuse naozaj stojí — počíta sa bez modelu.
// Prípady sú z ALPINY: leasing sa delí na istinu a úrok, PHM na daňovú
// a nedaňovú časť v pomere 80/20, a bežný dodávateľ sa nedelí vôbec.

const databases: Awaited<ReturnType<typeof createTestDatabase>>[] = [];
afterEach(async () => Promise.all(databases.splice(0).map((database) => database.close())));

describe('pravidlá odvodené z histórie', () => {
  it('nájde ustálenú hlavičku aj tvar položiek', async () => {
    const database = await createTestDatabase();
    databases.push(database);
    const seeded = await seedTestUser(database);
    const kde = [seeded.tenantId, seeded.organizationId];

    const riadok = async (
      agenda: string, dodavatel: string, cislo: string, index: number,
      text: string, suma: number | null, predkontacia: string | null, dph: string | null,
    ) => database.query(
      `INSERT INTO ucto_historia
        (id,tenant_id,organization_id,agenda,doklad_cislo,datum,supplier_name_normalized,
         line_text_normalized,suma,predkontacia_kod,clenenie_dph_kod,riadok_index,source,riadok_hash)
       VALUES ($1,$2,$3,$4,$5,'2026-05-10',$6,$7,$8,$9,$10,$11,'mdb',$12)`,
      [randomUUID(), ...kde, agenda, cislo, dodavatel, text, suma, predkontacia, dph, index, randomUUID()],
    );

    // Leasing: hlavička istina, položky istina + úrok. Sumy sa menia, takže
    // podiel ustálený NIE JE a do rozpisu nepatrí. Úrok ostáva v tom istom
    // pásme 20 % — inak by to boli rôzne podoby praxe (podiel je v jej kľúči).
    for (const [cislo, istina, urok] of [['L1', 820, 180], ['L2', 820, 180], ['L3', 776, 224]] as const) {
      await riadok('OZ', 'čsob leasing', cislo, 0, 'splátka', null, 'leas.istina', 'PD');
      await riadok('OZ', 'čsob leasing', cislo, 1, 'istina', istina, 'leas.istina', 'PD');
      await riadok('OZ', 'čsob leasing', cislo, 2, 'úrok', urok, 'Úroky-leas', 'PD');
    }
    // PHM: pomer 80/20 je v každom doklade rovnaký, takže sa zapíše.
    for (const [cislo, celok] of [['F1', 100], ['F2', 200], ['F3', 50]] as const) {
      await riadok('FP', 'up déjeuner', cislo, 0, 'phm', null, 'PHM-501200', 'PD');
      await riadok('FP', 'up déjeuner', cislo, 1, 'daňová časť', celok * 0.8, 'PHM-501200', 'PD');
      await riadok('FP', 'up déjeuner', cislo, 2, 'nedaňová časť', celok * 0.2, 'PHM-Nadspotreba', 'PN');
    }
    // Bežný dodávateľ: jedna položka, žiadny rozpis.
    for (const cislo of ['T1', 'T2', 'T3', 'T4']) {
      await riadok('FP', 'telekom', cislo, 0, 'telefón', null, '518/321', 'PD');
      await riadok('FP', 'telekom', cislo, 1, 'telefón', 50, '518/321', 'PD');
    }
    // Dvojdokladová protistrana je náhoda, nie prax — pravidlo nevznikne.
    for (const cislo of ['X1', 'X2']) {
      await riadok('FP', 'jednorazovka', cislo, 0, 'čosi', null, '518/321', 'PD');
    }

    const vysledok = await prepocitajPravidla(database, {
      tenantId: seeded.tenantId, organizationId: seeded.organizationId,
    });
    expect(vysledok).toEqual({ pravidiel: 3, sRozpisom: 2, konfliktov: 0, zmienRezimu: 0 });

    const leasing = await najdiPravidlo(database, {
      tenantId: seeded.tenantId, organizationId: seeded.organizationId,
    }, ['OZ'], { nazov: 'ČSOB Leasing' });
    expect(leasing).toMatchObject({
      dokladov: 3, zhoda: 3, predkontaciaKod: 'leas.istina', clenenieDphKod: 'PD',
    });
    expect(leasing?.rozpis.map((r) => [r.text, r.predkontaciaKod, r.podiel])).toEqual([
      ['istina', 'leas.istina', undefined],
      ['úrok', 'Úroky-leas', undefined],
    ]);

    // PHM: pomer je v každom doklade rovnaký, takže sa do pravidla zapíše.
    const phm = await najdiPravidlo(database, {
      tenantId: seeded.tenantId, organizationId: seeded.organizationId,
    }, ['FP'], { nazov: 'Up Déjeuner' });
    expect(phm?.rozpis.map((r) => [r.predkontaciaKod, r.clenenieDphKod, r.podiel])).toEqual([
      ['PHM-501200', 'PD', 0.8],
      ['PHM-Nadspotreba', 'PN', 0.2],
    ]);

    // Dodávateľ, ktorý sa nedelí, rozpis nedostane — inak by pravidlo tvrdilo
    // rozdelenie tam, kde žiadne nie je.
    const telekom = await najdiPravidlo(database, {
      tenantId: seeded.tenantId, organizationId: seeded.organizationId,
    }, ['FP'], { nazov: 'Telekom' });
    expect(telekom?.rozpis).toEqual([]);

    // Dva doklady na prax nestačia.
    expect(await najdiPravidlo(database, {
      tenantId: seeded.tenantId, organizationId: seeded.organizationId,
    }, ['FP'], { nazov: 'Jednorazovka' })).toBeUndefined();
  }, 90_000);

  it('prepočet nahrádza celú sadu, nepridáva k nej', async () => {
    const database = await createTestDatabase();
    databases.push(database);
    const seeded = await seedTestUser(database);
    for (const cislo of ['A1', 'A2', 'A3']) {
      await database.query(
        `INSERT INTO ucto_historia
          (id,tenant_id,organization_id,agenda,doklad_cislo,datum,supplier_name_normalized,
           line_text_normalized,predkontacia_kod,riadok_index,source,riadok_hash)
         VALUES ($1,$2,$3,'FP',$4,'2026-05-10','dodavatel','sluzba','518/321',0,'mdb',$5)`,
        [randomUUID(), seeded.tenantId, seeded.organizationId, cislo, randomUUID()],
      );
    }
    const kde = { tenantId: seeded.tenantId, organizationId: seeded.organizationId };
    await prepocitajPravidla(database, kde);
    await prepocitajPravidla(database, kde);
    const pocet = await database.query('SELECT count(*) AS n FROM ucto_pravidla WHERE organization_id=$1',
      [seeded.organizationId]);
    expect(Number((pocet.rows[0] as { n: string }).n)).toBe(1);
  }, 60_000);
});

// F18: účet a DPH pravidla pochádzali z rôznych skupín dokladov. A má 60
// dokladov (30 VATx, 30 VATz), B 40 dokladov VATy — nezávislé väčšiny dali
// A + VATy, kombináciu, ktorú firma nikdy nepoužila.
describe('spoločná prax protistrany', () => {
  it('uložené pravidlo nezmieša účet a DPH z rôznych dokladov a meranie k dátumu dá to isté', async () => {
    const database = await createTestDatabase();
    databases.push(database);
    const seeded = await seedTestUser(database);
    const kde = { tenantId: seeded.tenantId, organizationId: seeded.organizationId };
    // Dátumy sa prekrývajú (7n mod 100) — nejde o zmenu režimu, ale o dve praxe naraz.
    await database.query(
      `INSERT INTO ucto_historia (id,tenant_id,organization_id,agenda,doklad_cislo,datum,supplier_name_normalized,
         line_text_normalized,predkontacia_kod,clenenie_dph_kod,clenenie_kv_kod,riadok_index,source,riadok_hash)
       SELECT 'r' || n, $1, $2, 'FP', 'D' || n, date '2026-01-01' + (n * 7 % 100), 'zmiesana s.r.o.', 'sluzba',
              CASE WHEN n <= 60 THEN 'A' ELSE 'B' END,
              CASE WHEN n <= 30 THEN 'VATx' WHEN n <= 60 THEN 'VATz' ELSE 'VATy' END, 'B2', 0, 'mdb', 'h' || n
         FROM generate_series(1, 100) AS n`,
      [kde.tenantId, kde.organizationId],
    );
    await prepocitajPravidla(database, kde);
    const pravidlo = await najdiPravidlo(database, kde, ['FP'], { nazov: 'Zmiesana s.r.o.' });
    expect(pravidlo).toMatchObject({ dokladov: 100, zhoda: 40, konflikt: true });
    expect([pravidlo?.predkontaciaKod, pravidlo?.clenenieDphKod]).not.toEqual(['A', 'VATy']);
    expect(pravidlo?.predkontaciaKod).toBeUndefined();
    // Pri rovnakom počte rozhoduje novší posledný doklad (VATz 10. apríla, VATx 9.).
    expect(pravidlo?.varianty.map((v) => [v.predkontaciaKod, v.clenenieDphKod, v.dokladov]))
      .toEqual([['B', 'VATy', 40], ['A', 'VATz', 30], ['A', 'VATx', 30]]);
    // Meranie počíta to isté pravidlo, aké používa produkcia.
    const kDatumu = await najdiPravidlo(database, kde, ['FP'], { nazov: 'zmiesana s.r.o.' }, '2027-01-01');
    expect({ ...kDatumu, id: '' }).toEqual({ ...pravidlo, id: '' });
  }, 90_000);
});

// Druh operácie pred praxou protistrany. Zamestnanec má zúčtovanie stravného
// (hlavička stravné, rozpis stravné / cestovné / záloha) aj pokuty; pokút je
// viac, takže pravidlo protistrany by stravnému dalo účet pokuty.
describe('druh operácie podľa textu dokladu', () => {
  it('text vyberie druh s hlavičkou aj rozpisom; nejednoznačný text a nová protistrana ostávajú, ako boli', async () => {
    const database = await createTestDatabase();
    databases.push(database);
    const seeded = await seedTestUser(database);
    const kde = { tenantId: seeded.tenantId, organizationId: seeded.organizationId };
    const riadok = (cislo: string, datum: string, index: number, text: string, predkontacia: string | null, suma: number | null) =>
      database.query(
        `INSERT INTO ucto_historia
          (id,tenant_id,organization_id,agenda,doklad_cislo,datum,supplier_name_normalized,
           line_text_normalized,suma,predkontacia_kod,riadok_index,source,riadok_hash)
         VALUES ($1,$2,$3,'OZ',$4,$5,'mrkva jozef',$6,$7,$8,$9,'mdb',$10)`,
        [randomUUID(), kde.tenantId, kde.organizationId, cislo, datum, text, suma, predkontacia, index, randomUUID()],
      );
    for (const [poradie, cislo] of ['ZC1', 'ZC2', 'ZC3'].entries()) {
      const datum = `2026-0${poradie * 2 + 2}-10`;
      await riadok(cislo, datum, 0, `zpc ${poradie + 5}.týždeň`, '333100-stravné', null);
      await riadok(cislo, datum, 1, 'stravné', '333100-stravné', 1000);
      await riadok(cislo, datum, 2, 'cestovné', 'cestovné381', 180);
      await riadok(cislo, datum, 3, 'zúčtovanie zálohy', 'zúčt.zálohy', -300);
    }
    for (let mesiac = 1; mesiac <= 6; mesiac += 1) {
      await riadok(`OZ${mesiac}`, `2026-0${mesiac}-05`, 0, `pokuta č. 38${mesiac}; mrkva jozef`, '325100-pokuty', null);
    }
    // Mzda bez účtu v hlavičke druhom nie je, ale jej slová druhy odlišovať nesmú.
    for (let mesiac = 1; mesiac <= 3; mesiac += 1) {
      await riadok(`MZ${mesiac}`, `2026-0${mesiac}-28`, 0, 'wage payments, zúčtovanie zálohy', null, null);
    }
    await prepocitajPravidla(database, kde);
    const pravidlo = await najdiPravidlo(database, kde, ['OZ'], { nazov: 'Mrkva Jozef' });
    // Samo pravidlo protistrany je spor bez účtu — stravné by dostalo prvý riadok denníka.
    expect(pravidlo).toMatchObject({ konflikt: true, predkontaciaKod: undefined });
    expect(pravidlo?.druhy.map((druh) => [druh.predkontaciaKod, druh.dokladov, druh.slova])).toEqual([
      // Meno zamestnanca je v texte pokút, no identita protistrany druh neurčuje.
      ['325100-pokuty', 6, ['pokuta']],
      ['333100-stravné', 3, ['cestovne', 'stravne', 'tyzden', 'zpc']],
    ]);
    // Meranie k dátumu dostane tie isté druhy ako uložené pravidlo.
    const kDatumu = await najdiPravidlo(database, kde, ['OZ'], { nazov: 'mrkva jozef' }, '2027-01-01');
    expect(kDatumu?.druhy).toEqual(pravidlo?.druhy);

    const stravne = pravidloPodlaTextu(pravidlo, 'stravné cestovné zúčtovanie zálohy');
    expect(stravne).toMatchObject({
      predkontaciaKod: '333100-stravné', dokladov: 3, zhoda: 3, konflikt: false, podlaTextu: ['cestovne', 'stravne'],
    });
    expect(stravne?.rozpis.map((item) => [item.text, item.predkontaciaKod])).toEqual([
      ['stravné', '333100-stravné'], ['cestovné', 'cestovné381'], ['zúčtovanie zálohy', 'zúčt.zálohy'],
    ]);
    expect(pravidloPodlaTextu(pravidlo, 'Pokuta č. 999')).toMatchObject({
      predkontaciaKod: '325100-pokuty', dokladov: 6, rozpis: [], konflikt: false,
    });
    // Slová dvoch druhov naraz alebo žiadneho: pravidlo protistrany bez zmeny.
    expect(pravidloPodlaTextu(pravidlo, 'pokuta a stravné')).toBe(pravidlo);
    expect(pravidloPodlaTextu(pravidlo, 'zúčtovanie zálohy')).toBe(pravidlo);
    // Doklad nového druhu nesie len meno zamestnanca — účet pokút nedostane.
    expect(pravidloPodlaTextu(pravidlo, 'Cestovný príkaz; Mrkva Jozef')).toBe(pravidlo);
    // Nová protistrana pravidlo nemá — text jej cudzí druh nepriradí.
    expect(pravidloPodlaTextu(undefined, 'stravné cestovné')).toBeUndefined();
  }, 90_000);

  it('jedna hlavička druhy nemá — spor v tvare text nerozhodne', () => {
    const doklady: DokladPraxe[] = Array.from({ length: 8 }, (_, i) => ({
      kluc: `D${i}`, datum: `2025-0${i + 1}-01`,
      hlavicka: { riadokIndex: 0, text: i % 2 ? 'phm karta' : 'phm hotovost', predkontaciaKod: 'PHM', clenenieDphKod: 'PD' },
      polozky: i % 2
        ? [{ riadokIndex: 1, text: 'phm', suma: 80, predkontaciaKod: 'PHM', clenenieDphKod: 'PD' },
          { riadokIndex: 2, text: 'phm', suma: 20, predkontaciaKod: 'NAD', clenenieDphKod: 'PN' }]
        : [],
    }));
    const prax = odvodPrax(doklady);
    expect(prax.konflikt).toBe(true);
    expect(prax.druhy).toEqual([]);
  });

  // S druhou hlavičkou (diaľničná známka) druhy vzniknú. Druh je prax nad
  // dokladmi druhu — zmenu režimu ani spor v podieloch text neskryje.
  const nafta = (i: number, datum: string, rez?: number): DokladPraxe => ({
    kluc: `N${i}`, datum,
    hlavicka: { riadokIndex: 0, text: 'nafta', predkontaciaKod: 'PHM', clenenieDphKod: 'PD' },
    polozky: rez === undefined
      ? [{ riadokIndex: 1, text: 'nafta', suma: 100, predkontaciaKod: 'PHM', clenenieDphKod: 'PD' }]
      : [{ riadokIndex: 1, text: 'nafta', suma: rez, predkontaciaKod: 'PHM', clenenieDphKod: 'PD' },
        { riadokIndex: 2, text: 'nafta', suma: 100 - rez, predkontaciaKod: 'NAD', clenenieDphKod: 'PN' }],
  });
  const znamka = (i: number, datum: string): DokladPraxe => ({
    kluc: `Z${i}`, datum,
    hlavicka: { riadokIndex: 0, text: 'dialnicna znamka', predkontaciaKod: 'ZNAM', clenenieDphKod: 'PD' },
    polozky: [],
  });
  // Ako z tabuľky: druhy prešli cez jsonb, kľúče s undefined v nich nie sú.
  const pravidloZ = (doklady: DokladPraxe[]): UctoPravidlo => {
    const prax = odvodPrax(doklady, undefined, 'slovnaft');
    return {
      id: 'p', agenda: 'FP', protistrana: 'slovnaft', dokladov: prax.dokladov, zhoda: prax.vitaz?.dokladov ?? 0,
      predkontaciaKod: prax.vitaz?.predkontaciaKod, clenenieDphKod: prax.vitaz?.clenenieDphKod, rozpis: prax.rozpis,
      konflikt: prax.konflikt, varianty: prax.varianty, zmenaRezimu: prax.zmenaRezimu?.od,
      druhy: JSON.parse(JSON.stringify(prax.druhy)),
    };
  };

  it('druh nesie zmenu režimu a rozpis víťaza, iný druh ju nezdedí', () => {
    const pravidlo = pravidloZ([
      ...Array.from({ length: 5 }, (_, i) => nafta(i, `2024-0${i + 1}-10`)),
      ...Array.from({ length: 3 }, (_, i) => znamka(i, `2024-0${i + 6}-10`)),
      ...Array.from({ length: 5 }, (_, i) => nafta(i + 5, `2025-0${i + 1}-10`, 80)),
    ]);
    expect(pravidlo).toMatchObject({ konflikt: false, zmenaRezimu: '2025-01-10', predkontaciaKod: 'PHM' });
    const phm = pravidloPodlaTextu(pravidlo, 'Nafta motorová');
    expect(phm).toMatchObject({
      predkontaciaKod: 'PHM', dokladov: 10, zhoda: 5, konflikt: false, zmenaRezimu: '2025-01-10', podlaTextu: ['nafta'],
    });
    expect(phm?.rozpis.map((riadok) => [riadok.predkontaciaKod, riadok.podiel])).toEqual([['PHM', 0.8], ['NAD', 0.2]]);
    const dialnicna = pravidloPodlaTextu(pravidlo, 'Diaľničná známka');
    expect(dialnicna).toMatchObject({ predkontaciaKod: 'ZNAM', dokladov: 3, zhoda: 3, konflikt: false });
    expect(dialnicna?.zmenaRezimu).toBeUndefined();
  });

  it('spor v podieloch druhu ostáva sporom aj vedľa inej hlavičky', () => {
    const pravidlo = pravidloZ([
      ...Array.from({ length: 8 }, (_, i) => nafta(i, `2025-0${i + 1}-10`, i % 2 ? 80 : 60)),
      ...Array.from({ length: 3 }, (_, i) => znamka(i, `2025-0${i + 2}-20`)),
    ]);
    const phm = pravidloPodlaTextu(pravidlo, 'nafta');
    expect(phm).toMatchObject({ dokladov: 8, konflikt: true, rozpis: [], podlaTextu: ['nafta'] });
    expect(phm?.predkontaciaKod).toBeUndefined();
    expect(phm?.varianty.map((variant) => variant.predkontaciaKod)).toEqual(['PHM', 'PHM']);
    expect(sporPraxe(phm)).toBe('ucet');
  });
});

// Prax ako spoločné podoby dokladov — čistá funkcia, bez databázy.
describe('prax protistrany z celých dokladov', () => {
  type Polozka = [predkontacia: string, dph: string, suma: number, sumaDph?: number, kv?: string];
  const doklad = (cislo: string, datum: string, hlavicka: [string, string], polozky: Polozka[] = []): DokladPraxe => ({
    kluc: `FP|${cislo}|${datum}`,
    datum,
    hlavicka: { riadokIndex: 0, text: 'doklad', predkontaciaKod: hlavicka[0], clenenieDphKod: hlavicka[1], clenenieKvKod: 'B2' },
    polozky: polozky.map(([predkontaciaKod, clenenieDphKod, suma, sumaDph, kv], index) => ({
      riadokIndex: index + 1, text: predkontaciaKod, suma, sumaDph, predkontaciaKod, clenenieDphKod, clenenieKvKod: kv ?? 'B2',
    })),
  });
  const den = (poradie: number) => new Date(Date.UTC(2025, 0, 1 + poradie)).toISOString().slice(0, 10);

  it('A 60 (VATx/VATz) a B 40 (VATy) je konflikt a každá podoba je z dokladov', () => {
    const doklady = [
      ...Array.from({ length: 30 }, (_, i) => doklad(`X${i}`, den(i * 3), ['A', 'VATx'])),
      ...Array.from({ length: 30 }, (_, i) => doklad(`Z${i}`, den(i * 3 + 1), ['A', 'VATz'])),
      ...Array.from({ length: 40 }, (_, i) => doklad(`Y${i}`, den(i * 2 + 2), ['B', 'VATy'])),
    ];
    const prax = odvodPrax(doklady);
    expect(prax.vitaz).toBeUndefined();
    expect(prax.konflikt).toBe(true);
    const videne = new Set(doklady.map((item) => `${item.hlavicka!.predkontaciaKod}|${item.hlavicka!.clenenieDphKod}`));
    expect(prax.varianty).toHaveLength(3);
    for (const variant of prax.varianty) expect(videne.has(`${variant.predkontaciaKod}|${variant.clenenieDphKod}`)).toBe(true);
    expect(prax.varianty.map((v) => [v.predkontaciaKod, v.clenenieDphKod])).not.toContainEqual(['A', 'VATy']);
  });

  it('pozícia rozpisu je celá trojica — X/PD/KN, ktorý nebol v žiadnom doklade, nevznikne', () => {
    const riadok = (trojica: [string, string, string], riadokIndex: number) => ({
      riadokIndex, text: trojica[0], suma: 50, predkontaciaKod: trojica[0], clenenieDphKod: trojica[1], clenenieKvKod: trojica[2],
    });
    const doklady = (pocet: number, prva: [string, string, string]) =>
      Array.from({ length: pocet }, () => [riadok(prva, 1), riadok(['Z', 'PD', 'B2'], 2)]);
    const trojice = (riadky: Array<{ predkontaciaKod?: string; clenenieDphKod?: string; clenenieKvKod?: string }>) =>
      riadky.map((item) => `${item.predkontaciaKod}/${item.clenenieDphKod}/${item.clenenieKvKod}`);
    // Účet X má 65 %, PD 75 %, KN 60 % — každé zvlášť prejde, spolu nikdy.
    const vstup = [...doklady(40, ['X', 'PD', 'B2']), ...doklady(25, ['X', 'PN', 'KN']), ...doklady(35, ['Y', 'PD', 'KN'])];
    const rozpis = odvodRozpis(vstup);
    expect(trojice(rozpis)).not.toContain('X/PD/KN');
    const videne = new Set(trojice(vstup.flat()));
    for (const trojica of trojice(rozpis)) expect(videne.has(trojica)).toBe(true);
    // Prevažujúca trojica sa na pozíciu dostane celá.
    expect(trojice(odvodRozpis([...doklady(7, ['X', 'PN', 'KN']), ...doklady(3, ['X', 'PD', 'B2'])])))
      .toEqual(['X/PN/KN', 'Z/PD/B2']);
  });

  it('podoba rozpisu kategórie sa delí aj podľa DPH, nie len podľa účtov', () => {
    const riadok = (predkontaciaKod: string, clenenieDphKod: string, clenenieKvKod: string, riadokIndex: number) =>
      ({ riadokIndex, text: predkontaciaKod, suma: riadokIndex === 1 ? 80 : 20, predkontaciaKod, clenenieDphKod, clenenieKvKod });
    const varianty = odvodRozpisVarianty([
      ...Array.from({ length: 3 }, () => [riadok('PHM', 'PD', 'B2', 1), riadok('DPH', 'PN', 'KN', 2)]),
      ...Array.from({ length: 3 }, () => [riadok('PHM', 'PN', 'KN', 1), riadok('DPH', 'PD', 'B2', 2)]),
    ]);
    expect(varianty.map((v) => v.riadky.map((r) => `${r.predkontaciaKod}/${r.clenenieDphKod}/${r.clenenieKvKod}`)))
      .toEqual([['PHM/PD/B2', 'DPH/PN/KN'], ['PHM/PN/KN', 'DPH/PD/B2']]);
  });

  // Šum, ktorý robil z jednej praxe dve (R09): pri členení bez odpočtu je prázdna
  // sekcia KV to isté ako KN — obe do výkazu nejdú.
  it('prázdna sekcia KV a KN pri členení bez odpočtu sú jedna prax', () => {
    const sKv = (item: DokladPraxe, kv: string): DokladPraxe => ({ ...item, hlavicka: { ...item.hlavicka!, clenenieKvKod: kv } });
    const prax = odvodPrax([
      ...Array.from({ length: 4 }, (_, i) => sKv(doklad(`P${i}`, den(i), ['A', 'PN']), '')),
      ...Array.from({ length: 3 }, (_, i) => sKv(doklad(`K${i}`, den(i + 10), ['A', 'PN']), 'KN')),
    ]);
    expect(prax).toMatchObject({ konflikt: false, vitaz: { predkontaciaKod: 'A', dokladov: 7 } });
    expect(prax.varianty).toHaveLength(1);
  });

  // Jeden odchýlený doklad (PACCAR: 46 × prenájom s odpočtom, 1 × bez) nesmie
  // zhodiť väčšinu do konfliktu. Ostáva medzi podobami, ale označený.
  it('osamotený doklad väčšine neprekáža a je označený ako okrajový', () => {
    const prax = odvodPrax([
      ...Array.from({ length: 6 }, (_, i) => doklad(`A${i}`, den(i * 5), ['A', 'PD'])),
      ...Array.from({ length: 4 }, (_, i) => doklad(`B${i}`, den(i * 5 + 2), ['A2', 'PD'])),
      doklad('C0', den(12), ['C', 'PN']),
    ]);
    expect(prax).toMatchObject({ konflikt: false, vitaz: { predkontaciaKod: 'A', dokladov: 6 } });
    expect(prax.varianty.find((variant) => variant.predkontaciaKod === 'C')).toMatchObject({ okrajovy: true });
    expect(prax.varianty.find((variant) => variant.predkontaciaKod === 'A2')?.okrajovy).toBeUndefined();
  });

  // Okrajovosť sa posudzuje na hlavičke a účtoch rezu, nie na podieloch. Prax,
  // ktorej rez sa mení doklad od dokladu, má inak samé podoby po jednom
  // doklade — tie by vyšli ako okrajové a polovica histórie by vyhrala.
  it('prax s meniacim sa podielom rezu nie je okrajová — spor ostáva', () => {
    const bezRezu = Array.from({ length: 20 }, (_, i) => doklad(`N${i}`, den(i * 2), ['518', 'PD']));
    const sRezom = Array.from({ length: 20 }, (_, i) => {
      const nedanove = 5 + i * 4.5;
      return doklad(`R${i}`, den(i * 2 + 1), ['518', 'PD'],
        [['518', 'PD', 100 - nedanove, 23, 'B2'], ['513', 'PN', nedanove, 0, 'KN']]);
    });
    const prax = odvodPrax([...bezRezu, ...sRezom]);
    expect(prax.konflikt).toBe(true);
    expect(prax.varianty.some((variant) => variant.okrajovy)).toBe(false);
  });

  it('nová prax po konci starej vyhrá so zmenou režimu, prekrývajúca sa nie', () => {
    const stare = Array.from({ length: 20 }, (_, i) =>
      doklad(`S${i}`, `2025-${String((i % 12) + 1).padStart(2, '0')}-10`, ['A', 'PD']));
    const nove = Array.from({ length: 5 }, (_, i) => doklad(`N${i}`, `2026-0${i + 2}-01`, ['A', 'PN']));
    expect(odvodPrax([...stare, ...nove])).toMatchObject({
      konflikt: false, zmenaRezimu: { od: '2026-02-01' }, vitaz: { predkontaciaKod: 'A', clenenieDphKod: 'PN', dokladov: 5 },
    });
    // Tých istých päť dokladov uprostred roka 2025 nie je nový režim, len menšina.
    const zmiesane = odvodPrax([...stare, ...nove.map((item, i) => ({ ...item, datum: `2025-0${i + 3}-15` }))]);
    expect(zmiesane).toMatchObject({ konflikt: false, vitaz: { clenenieDphKod: 'PD', dokladov: 20 } });
    expect(zmiesane.zmenaRezimu).toBeUndefined();
  });

  it('poradie vstupu výsledok nemení a doklad od dátumu merania ho nezmení', () => {
    const doklady = [
      ...Array.from({ length: 6 }, (_, i) => doklad(`P${i}`, `2025-0${i + 1}-05`, ['PHM', 'PD'],
        [['PHM', 'PD', 80, 10], ['NAD', 'PN', 20, 10, 'KN']])),
      ...Array.from({ length: 3 }, (_, i) => doklad(`Q${i}`, `2025-0${i + 2}-20`, ['PHM', 'PD'],
        [['PHM', 'PD', 80, 16], ['NAD', 'PN', 20, 4, 'KN']])),
      ...Array.from({ length: 2 }, (_, i) => doklad(`R${i}`, `2025-0${i + 3}-11`, ['518', 'PD'])),
    ];
    const zamiesane = [...doklady.slice(4), ...doklady.slice(0, 4)].reverse();
    expect(JSON.stringify(odvodPrax(zamiesane))).toBe(JSON.stringify(odvodPrax(doklady)));
    // Doklad presne v deň merania aj neskorší sú budúcnosť — výsledok k dátumu sa nepohne.
    const neskorsie = [doklad('L1', '2025-07-01', ['518', 'PD']), doklad('L2', '2026-01-01', ['PHM', 'PN'])];
    expect(odvodPrax([...neskorsie, ...doklady], '2025-07-01')).toEqual(odvodPrax(doklady, '2025-07-01'));
  });

  it('80/20 s daňou 50/50 a 80/20 s daňou 80/20 sú dve praxe; zdedená položka podobu nedelí', () => {
    const kratena = Array.from({ length: 3 }, (_, i) => doklad(`K${i}`, `2025-0${i + 1}-05`, ['PHM', 'PD'], [
      ['PHM', 'PD', 80, 10], ['NAD', 'PN', 20, 10, 'KN'],
      // Umytie auta na účte hlavičky — len dedí, tvar nemení.
      ...(i === 0 ? [['PHM', 'PD', 10, 0] as Polozka] : []),
    ]));
    const pomerna = Array.from({ length: 3 }, (_, i) => doklad(`M${i}`, `2025-0${i + 1}-06`, ['PHM', 'PD'],
      [['PHM', 'PD', 80, 16], ['NAD', 'PN', 20, 4, 'KN']]));
    const prax = odvodPrax([...kratena, ...pomerna]);
    const nedanova = { predkontaciaKod: 'NAD', clenenieDphKod: 'PN', clenenieKvKod: 'KN', podiel: 0.2 };
    expect(prax.varianty.map((v) => [v.dokladov, v.tvar])).toEqual(expect.arrayContaining([
      [3, [{ ...nedanova, podielDph: 0.5 }]],
      [3, [{ ...nedanova, podielDph: 0.2 }]],
    ]));
    expect(prax.varianty).toHaveLength(2);
  });
});

// Rozpis kategórie. Pravidlo protistrany platí len pre dodávateľa, ktorého
// firma už mala; kategória hovorí o DRUHU plnenia, takže platí aj pre celkom
// nového. Kategória „Leasing - splátka (istina a úrok)" mala doteraz v názve
// dve veci a v poli jednu.
describe('rozpis kategórie plnenia', () => {
  it('odvodí tvar z dokladov, ktoré do kategórie spadli', async () => {
    const database = await createTestDatabase();
    databases.push(database);
    const seeded = await seedTestUser(database);
    const kde = [seeded.tenantId, seeded.organizationId];

    await database.query(
      `INSERT INTO ucto_kategorie (id,tenant_id,organization_id,nazov,popis,slovnik,pocet)
       VALUES ($1,$2,$3,'Leasing','Splátky leasingu','["leasing","splátka"]'::jsonb,10)`,
      [randomUUID(), ...kde],
    );
    // Kategória, do ktorej nespadne nič — rozpis dostať nesmie.
    await database.query(
      `INSERT INTO ucto_kategorie (id,tenant_id,organization_id,nazov,popis,slovnik,pocet)
       VALUES ($1,$2,$3,'Kancelária','Kancelárske potreby','["toner","papier"]'::jsonb,4)`,
      [randomUUID(), ...kde],
    );

    const riadok = async (cislo: string, index: number, text: string, predkontacia: string) =>
      database.query(
        `INSERT INTO ucto_historia
          (id,tenant_id,organization_id,agenda,doklad_cislo,datum,supplier_name_normalized,
           line_text_normalized,suma,predkontacia_kod,riadok_index,source,riadok_hash)
         VALUES ($1,$2,$3,'OZ',$4,'2026-05-10','ktokoľvek',$5,100,$6,$7,'mdb',$8)`,
        [randomUUID(), ...kde, cislo, text, predkontacia, index, randomUUID()],
      );
    // Tri doklady rôznych dodávateľov — kategória ich spája podľa slovníka.
    for (const cislo of ['L1', 'L2', 'L3']) {
      await riadok(cislo, 0, 'leasing splátka vozidla', 'leas.istina');
      await riadok(cislo, 1, 'istina', 'leas.istina');
      await riadok(cislo, 2, 'úrok', 'Úroky-leas');
    }

    // Doklady účtované na JEDEN účet sú v korpuse kvôli textom položiek, ale
    // o delení nehovoria nič. Keby tvar učili aj ony, prevážili by — odvodRozpis
    // by videl prevažne rovnaké riadky a kategórii by neostalo nič.
    for (const cislo of ['J1', 'J2', 'J3', 'J4', 'J5']) {
      await riadok(cislo, 0, 'leasing splátka vozidla', 'leas.istina');
      await riadok(cislo, 1, 'splátka', 'leas.istina');
      await riadok(cislo, 2, 'splátka', 'leas.istina');
    }

    const vysledok = await doplnRozpisKategorii(database, {
      tenantId: seeded.tenantId, organizationId: seeded.organizationId,
    });
    expect(vysledok).toEqual({ kategoriiSRozpisom: 1 });

    const kategorie = await database.query<Record<string, any>>(
      'SELECT nazov, rozpis FROM ucto_kategorie WHERE organization_id=$1 ORDER BY nazov', [seeded.organizationId],
    );
    expect(kategorie.rows[0].nazov).toBe('Kancelária');
    expect(kategorie.rows[0].rozpis).toEqual([]);
    const varianty = kategorie.rows[1].rozpis as Array<{ pocet: number; riadky: Array<Record<string, unknown>> }>;
    expect(varianty).toHaveLength(1);
    expect(varianty[0].pocet).toBe(3);
    expect(varianty[0].riadky.map((r) => r.predkontaciaKod)).toEqual(['leas.istina', 'Úroky-leas']);
  }, 90_000);
});

// Kategória je širšia než pravidlo protistrany: hovorí o DRUHU plnenia, a ten
// istý druh sa kupuje v rôznych režimoch. ALPINA má pod „PHM" 156 dokladov —
// tuzemskú kartu Shell (PHM-501200 80 % + PHM-Nadspotreba 20 %) a zahraničné
// tankovanie kamiónov (PHM + DPH tej krajiny). Jeden tvar z toho odvodiť nešlo,
// na druhej pozícii mal najsilnejší účet 27 % namiesto potrebných 60 %, takže
// kategória ostala bez rozpisu a tvrdila PN na celé palivo — nový dodávateľ PHM
// by nedostal odpočet vôbec.
describe('viac podôb rozpisu v jednej kategórii', () => {
  const doklad = (ucty: string[], sumy: number[]) => ucty.map((ucet, index) => ({
    riadokIndex: index + 1, text: ucet, suma: sumy[index], predkontaciaKod: ucet,
    clenenieDphKod: ucet === 'PHM-Nadspotreba' ? 'PN' : 'PD', clenenieKvKod: undefined,
  }));

  it('oddelí tuzemský a zahraničný tvar namiesto toho, aby ich zmiešala', () => {
    const doklady = [
      // Zahraničné tankovanie — väčšina, ale o tuzemskej karte nehovorí nič.
      ...Array.from({ length: 5 }, () => doklad(['PHM', 'DPH Taliansko'], [800, 200])),
      ...Array.from({ length: 4 }, () => doklad(['PHM', 'DPH Francúzsko'], [700, 300])),
      // Tuzemská karta — menšina, a práve ona nesie pomer 80/20.
      ...Array.from({ length: 3 }, () => doklad(['PHM-501200', 'PHM-Nadspotreba'], [80, 20])),
    ];
    const varianty = odvodRozpisVarianty(doklady);
    expect(varianty.map((v) => v.riadky.map((r) => r.predkontaciaKod))).toEqual([
      ['PHM', 'DPH Taliansko'],
      ['PHM', 'DPH Francúzsko'],
      ['PHM-501200', 'PHM-Nadspotreba'],
    ]);
    // Pomer sa drží podoby, nie kategórie — 80/20 patrí tuzemskej karte.
    expect(varianty[2].riadky.map((r) => r.podiel)).toEqual([0.8, 0.2]);
    expect(varianty[2].pocet).toBe(3);
  });

  it('podobu pod tromi dokladmi nevydá a doklad bez účtu do tvaru nepustí', () => {
    const doklady = [
      ...Array.from({ length: 3 }, () => doklad(['PHM', 'DPH Taliansko'], [800, 200])),
      // Dve je málo — náhoda, nie prax.
      ...Array.from({ length: 2 }, () => doklad(['PHM', 'diaľ.popl.'], [900, 100])),
      // Riadok bez účtu: podpis by bol dierou, nie tvarom.
      [{ riadokIndex: 1, text: 'x', suma: 10, predkontaciaKod: undefined },
        { riadokIndex: 2, text: 'y', suma: 90, predkontaciaKod: 'PHM' }],
    ];
    expect(odvodRozpisVarianty(doklady).map((v) => v.riadky.map((r) => r.predkontaciaKod)))
      .toEqual([['PHM', 'DPH Taliansko']]);
  });

  it('starý uložený profil s jedným tvarom sa číta ako jedna podoba', () => {
    expect(variantyRozpisu([{ text: 'istina', predkontaciaKod: 'leas.istina' }]))
      .toEqual([{ pocet: 0, riadky: [{ text: 'istina', predkontaciaKod: 'leas.istina' }] }]);
    expect(variantyRozpisu([])).toEqual([]);
    expect(variantyRozpisu(null)).toEqual([]);
  });
});

// Pravidlo auta z DPH profilu reže položku, ktorej text kľúčové slovo LEN
// OBSAHUJE. Slovo spoločné pre rez, ale prítomné aj inde, by rezalo cudzie položky.
describe('návrhy pravidiel delenia — kľúčové slová', () => {
  const rez = (n: number): DokladDelenia => ({
    kluc: `D${n}`, cislo: `D${n}`, datum: `2026-0${n}-01`, polozky: [
      { text: 'phm cast danova', suma: 80, sumaDph: 10, predkontaciaId: 'A' },
      { text: 'phm cast nedanova', suma: 20, sumaDph: 10, predkontaciaId: 'B', clenenieDphId: 'pn',
        clenenieDphKod: 'PN', clenenieDphNazov: 'Bez nároku na odpočet' },
    ],
  });
  const olej: DokladDelenia = {
    kluc: 'O1', cislo: 'O1', datum: '2026-05-01', polozky: [{ text: 'Castrol olej', suma: 30, predkontaciaId: 'C' }],
  };

  it('slovo, ktoré sa vyskytne aj mimo rezu (aj ako časť iného slova), do návrhu nepatrí', () => {
    expect(odvodNavrhyDelenia([rez(1), rez(2), rez(3), olej])).toEqual([expect.objectContaining({
      klucoveSlova: ['phm'], percento: 80, percentoDph: 50, predkontaciaId: 'A', predkontaciaNedanovaId: 'B', dokladov: 3,
    })]);
  });

  it('rez bez rozlišujúceho slova sa nenavrhne — pravidlo bez slova by sa nepoužilo', () => {
    const nerozdelene: DokladDelenia = {
      kluc: 'P1', cislo: 'P1', datum: '2026-06-01', polozky: [{ text: 'PHM kamión', suma: 100, predkontaciaId: 'A' }],
    };
    expect(odvodNavrhyDelenia([rez(1), rez(2), rez(3), olej, nerozdelene])).toEqual([]);
  });
});

// Slovník má strop 30 hesiel a zlučovanie berie prvých tridsať, takže plný
// slovník sa sám nikdy neuvoľní. V PHM kategórii ALPINY bolo trinásť z tridsiatich
// hesiel cenou z jedného dokladu a „natural" ani „nafta" sa doň už nezmestili.
describe('slovník kategórie', () => {
  it('zahodí cenu z jedného dokladu a ostatné heslá nechá', () => {
    expect(ocistiSlovnik([
      'phm', 'phm 1,43€/l', 'tankovanie', 'phm -ad blue cena 1,37/liter',
      'phm-50%', 'diesel', 'phm 2€/l', 'natural 95',
    ])).toEqual(['phm', 'tankovanie', 'phm-50%', 'diesel', 'natural 95']);
  });

  it('radšej zašumený slovník než prázdny', () => {
    // Kategória bez hesiel sa na doklad nenaviaže a jej účet sa stratí.
    expect(ocistiSlovnik(['phm 1,43€/l'])).toEqual(['phm 1,43€/l']);
  });
});

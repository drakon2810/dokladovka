import { describe, expect, it } from 'vitest';
import { zoradDokladyPrikladov, zoskupDokladyHistorie, type DokladHistorie } from './accountingSuggestionService.js';

// Výber celých dokladov histórie pre prompt, bez databázy. Meria sa, či medzi
// prvými tromi je doklad s rovnakým druhom plnenia — aj pre dodávateľa, ktorého
// firma nikdy nemala — a že rozpočet nikdy neoreže doklad.

/** Deterministická náhoda (mulberry32): korpus je pri každom behu rovnaký. */
function nahoda(seed: number) {
  let stav = seed;
  return () => {
    stav = (stav + 0x6d2b79f5) | 0;
    let t = Math.imul(stav ^ (stav >>> 15), 1 | stav);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
  };
}

const DRUHY = [
  { slova: ['nafta', 'diesel', 'palivo', 'phm', 'tankovanie'], suma: 80 },
  { slova: ['oprava', 'servis', 'vozidla', 'pneumatiky', 'udrzba'], suma: 400 },
  { slova: ['najom', 'kancelarie', 'priestorov', 'prenajom', 'nebytovych'], suma: 900 },
  { slova: ['elektrina', 'energia', 'odber', 'elektrickej', 'distribucia'], suma: 250 },
  { slova: ['telefon', 'mobilne', 'volania', 'data', 'pausal'], suma: 40 },
  { slova: ['papier', 'toner', 'kancelarske', 'potreby', 'pisacie'], suma: 60 },
  { slova: ['obed', 'restauracia', 'pohostenie', 'napoje', 'jedlo'], suma: 70 },
  { slova: ['licencia', 'software', 'predplatne', 'cloud', 'hosting'], suma: 120 },
  { slova: ['preprava', 'dopravne', 'kamionova', 'zasielka', 'nakladu'], suma: 1500 },
  { slova: ['poistenie', 'poistne', 'havarijne', 'zmluvy', 'poistky'], suma: 300 },
  { slova: ['skolenie', 'kurz', 'seminar', 'vzdelavanie', 'certifikat'], suma: 200 },
  { slova: ['material', 'stavebny', 'cement', 'tehly', 'hutny'], suma: 700 },
];
const MESIACE = ['januar', 'februar', 'marec', 'april', 'maj', 'jun', 'jul', 'august', 'september', 'oktober', 'november', 'december'];
const VYPLN = ['sluzby', 'poplatok', 'fakturacia'];

function korpus(seed: number) {
  const rnd = nahoda(seed);
  const vyber = <T>(zoznam: T[]) => zoznam[Math.floor(rnd() * zoznam.length)];
  const text = (druh: number) => {
    const slova = [...DRUHY[druh].slova].sort(() => rnd() - 0.5).slice(0, 2 + Math.floor(rnd() * 2));
    if (rnd() < 0.5) slova.push(vyber(MESIACE));
    if (rnd() < 0.3) slova.push(vyber(VYPLN));
    if (rnd() < 0.3) slova.push(`c. ${Math.floor(rnd() * 90_000) + 10_000}`);
    return slova.join(' ');
  };
  let poradie = 0;
  const doklad = (druh: number, dodavatel: number): DokladHistorie => {
    poradie += 1;
    const texty = Array.from({ length: 1 + Math.floor(rnd() * 4) }, () => text(druh));
    const spolu = DRUHY[druh].suma * (0.5 + rnd() * 1.5);
    const kody = { predkontaciaKod: `P${druh}`, clenenieDphKod: 'PD', clenenieKvKod: 'B2' };
    return {
      agenda: 'FP',
      cislo: `25FP${String(poradie).padStart(5, '0')}`,
      datum: `2025-${String(1 + Math.floor(rnd() * 12)).padStart(2, '0')}-${String(1 + Math.floor(rnd() * 28)).padStart(2, '0')}`,
      ico: `3000000${dodavatel}`,
      nazov: `dodavatel ${dodavatel} s.r.o.`,
      hlavicka: { text: texty[0], ...kody, hash: `h${poradie}` },
      polozky: texty.map((polozka, index) => ({
        riadok: index + 1, text: polozka, suma: Number((spolu / texty.length).toFixed(2)), ...kody, hash: `h${poradie}-${index}`,
      })),
    };
  };
  const dopyt = (druh: number, dodavatel: number) => {
    const vzor = doklad(druh, dodavatel);
    return {
      polozky: vzor.polozky.map((polozka) => polozka.text),
      suma: vzor.polozky.reduce((spolu, polozka) => spolu + (polozka.suma ?? 0), 0),
      ico: vzor.ico,
      nazov: vzor.nazov,
    };
  };
  const doklady = DRUHY.flatMap((_, druh) => Array.from({ length: 6 }, (__, dodavatel) =>
    Array.from({ length: 10 }, () => doklad(druh, dodavatel))).flat());
  return { doklady, dopyt };
}

describe('výber celých dokladov histórie', () => {
  it('recall@3 na syntetickom korpuse: 12 druhov × 6 dodávateľov × 10 dokladov', () => {
    const { doklady, dopyt } = korpus(20_260_915);
    expect(doklady).toHaveLength(720);
    const trafi = (vysledok: ReturnType<typeof zoradDokladyPrikladov>, druh: number) =>
      vysledok.slice(0, 3).some(({ priklad }) => priklad.hlavicka?.predkontaciaKod === `P${druh}`);

    let znami = 0;
    let neznami = 0;
    for (let druh = 0; druh < DRUHY.length; druh += 1) {
      for (let dodavatel = 0; dodavatel < 6; dodavatel += 1) {
        const vysledok = zoradDokladyPrikladov(doklady, dopyt(druh, dodavatel));
        if (trafi(vysledok, druh)) znami += 1;
        // Doklady tej istej protistrany idú pred všetkými ostatnými.
        const protistrany = vysledok.map(({ priklad }) => priklad.tejProtistrany);
        expect(protistrany[0]).toBe(true);
        expect(protistrany.indexOf(false) === -1 || !protistrany.slice(protistrany.indexOf(false)).includes(true)).toBe(true);
      }
      for (const dodavatel of [7, 8]) {
        const vysledok = zoradDokladyPrikladov(doklady, dopyt(druh, dodavatel));
        expect(vysledok.every(({ priklad }) => !priklad.tejProtistrany)).toBe(true);
        if (trafi(vysledok, druh)) neznami += 1;
      }
    }
    const spolu = (znami + neznami) / (DRUHY.length * 8);
    expect(spolu).toBeGreaterThanOrEqual(0.9);
    expect(neznami / (DRUHY.length * 2)).toBeGreaterThanOrEqual(0.8);
  });

  const doklad = (cislo: string, datum: string, ico: string, polozky: Array<[string, string]>, text = 'oprava vozidla'): DokladHistorie => ({
    agenda: 'FP', cislo, datum, ico, nazov: `firma ${ico}`,
    hlavicka: { text, predkontaciaKod: polozky[0]?.[0] ?? '518', hash: `${cislo}-0` },
    polozky: polozky.map(([predkontaciaKod, popis], index) => ({
      riadok: index + 1, text: popis, suma: 10, predkontaciaKod, hash: `${cislo}-${index + 1}`,
    })),
  });

  it('rozpočet nikdy neprekročí a doklad neoreže: príliš veľký prvý sa preskočí, druhý príde celý', () => {
    const velky = doklad('26FP001', '2026-03-01', '11111111',
      Array.from({ length: 100 }, (_, index) => [index % 2 ? '518' : '501', `oprava vozidla ${'x'.repeat(100)}`] as [string, string]));
    const maly = doklad('26FP002', '2026-02-01', '11111111', [['518', 'oprava vozidla'], ['518', 'umytie vozidla']]);
    const cudzi = doklad('26FP003', '2026-01-01', '22222222', [['518', 'oprava vozidla']]);
    const dopyt = { polozky: ['oprava vozidla'], ico: '11111111' };

    const poradie = zoradDokladyPrikladov([velky, maly, cudzi], dopyt, 1_000_000).map(({ priklad }) => priklad.ref);
    expect(poradie).toEqual(['FP|26FP001|2026-03-01', 'FP|26FP002|2026-02-01', 'FP|26FP003|2026-01-01']);

    const vysledok = zoradDokladyPrikladov([velky, maly, cudzi], dopyt, 2_000);
    expect(vysledok.map(({ priklad }) => priklad.ref)).toEqual(['FP|26FP002|2026-02-01', 'FP|26FP003|2026-01-01']);
    for (const strop of [150, 400, 700, 2_000, 20_000]) {
      const vybrane = zoradDokladyPrikladov([velky, maly, cudzi], dopyt, strop);
      expect(JSON.stringify(vybrane.map(({ priklad }) => priklad)).length).toBeLessThanOrEqual(strop);
      for (const { priklad, doklad: zdroj } of vybrane) expect(priklad.polozky).toHaveLength(zdroj.polozky.length);
    }
  });

  it('rovnaký tvar jednej protistrany sa zlúči do najnovšieho, iný tvar a iná protistrana nie', () => {
    const vysledok = zoradDokladyPrikladov([
      doklad('26FP001', '2026-01-10', '11111111', [['518', 'oprava vozidla']]),
      doklad('26FP002', '2026-03-10', '11111111', [['518', 'oprava vozidla']]),
      doklad('26FP003', '2026-02-10', '11111111', [['518', 'oprava vozidla']]),
      doklad('26FP004', '2026-02-20', '11111111', [['518', 'oprava vozidla'], ['513', 'obed']]),
      doklad('26FP005', '2026-01-05', '22222222', [['518', 'oprava vozidla']]),
    ], { polozky: ['oprava vozidla'], ico: '11111111' });

    expect(vysledok.map(({ priklad }) => [priklad.ref, priklad.rovnakych, priklad.tejProtistrany])).toEqual([
      ['FP|26FP002|2026-03-10', 3, true],
      ['FP|26FP004|2026-02-20', undefined, true],
      ['FP|26FP005|2026-01-05', undefined, false],
    ]);
    // Meno ani IČO inej protistrany do promptu nejde — ani vlastnej.
    const json = JSON.stringify(vysledok.map(({ priklad }) => priklad));
    expect(json).not.toContain('22222222');
    expect(json).not.toContain('firma');
  });

  it('položka s kódmi hlavičky je zdedená a podiely sa sčítajú na celok', () => {
    const [{ priklad }] = zoradDokladyPrikladov([{
      agenda: 'FP', cislo: '26FP001', datum: '2026-01-10', ico: '11111111',
      hlavicka: { text: 'phm', predkontaciaKod: 'PHM', clenenieDphKod: 'PD', hash: 'h0' },
      polozky: [
        { riadok: 1, text: 'natural 95', suma: 52.68, sumaDph: 7.58, predkontaciaKod: 'PHM', clenenieDphKod: 'PD', hash: 'h1' },
        { riadok: 2, text: 'natural 95 nedanova cast', suma: 13.17, sumaDph: 7.57, predkontaciaKod: 'PHM-Nadspotreba', clenenieDphKod: 'PN', hash: 'h2' },
      ],
    }], { polozky: ['natural 95'], ico: '11111111' });

    expect(priklad).toMatchObject({ suma: 65.85, hlavicka: { text: 'phm', predkontaciaKod: 'PHM' } });
    expect(priklad.polozky).toEqual([
      expect.objectContaining({ riadok: 1, podiel: 0.8, podielDph: 0.5003, zdedene: true }),
      expect.not.objectContaining({ zdedene: true }),
    ]);
    expect(priklad.polozky![1]).toMatchObject({ podiel: 0.2, podielDph: 0.4997 });
  });

  it('bez čísla samotného: iný dátum aj iná agenda sú iný doklad, a doklad sám seba nevidí', () => {
    const riadok = (hodnoty: Record<string, unknown>) => ({
      line_text_normalized: 'oprava', predkontacia_kod: '518', supplier_ico: '11111111', riadok_hash: String(Math.random()), ...hodnoty,
    });
    const doklady = zoskupDokladyHistorie([
      // Iný tvar než doklad o rok neskôr — inak by ho zlúčenie skrylo aj bez vylúčenia.
      riadok({ agenda: 'FP', doklad_cislo: '001', datum: '2026-01-10', riadok_index: 1, line_text_normalized: 'polozka', predkontacia_kod: '501' }),
      riadok({ agenda: 'FP', doklad_cislo: '001', datum: '2026-01-10', riadok_index: 0 }),
      riadok({ agenda: 'FP', doklad_cislo: '001', datum: '2027-01-10', riadok_index: 0 }),
      riadok({ agenda: 'VPD', doklad_cislo: 'P01', datum: '2026-02-01', riadok_index: 0 }),
      riadok({ agenda: 'PPD', doklad_cislo: 'P01', datum: '2026-02-01', riadok_index: 0 }),
      // Natívne id: novšia hlavička s indexom 0 prebije starú bez indexu, nech prišla v akomkoľvek poradí.
      riadok({ agenda: 'FP', doklad_cislo: '009', datum: '2026-03-01', riadok_index: 0, pohoda_doklad_id: '7', zdroj_databaza: 'db', line_text_normalized: 'nova' }),
      riadok({ agenda: 'FP', doklad_cislo: '009', datum: '2026-03-01', riadok_index: null, pohoda_doklad_id: '7', zdroj_databaza: 'db', line_text_normalized: 'stara' }),
    ]);
    expect(doklady.map((doklad) => `${doklad.agenda}|${doklad.cislo}|${doklad.datum}|${doklad.polozky.length}`).sort()).toEqual([
      'FP|001|2026-01-10|1', 'FP|001|2027-01-10|0', 'FP|009|2026-03-01|0', 'PPD|P01|2026-02-01|0', 'VPD|P01|2026-02-01|0',
    ]);
    expect(doklady.find((doklad) => doklad.cislo === '009')?.hlavicka?.text).toBe('nova');

    const refy = zoradDokladyPrikladov(doklady, { polozky: ['oprava'], ico: '11111111', cislo: '001', datum: '2026-01-10' })
      .map(({ priklad }) => priklad.ref);
    expect(refy).not.toContain('FP|001|2026-01-10');
    expect(refy).toContain('FP|001|2027-01-10');
  });
});

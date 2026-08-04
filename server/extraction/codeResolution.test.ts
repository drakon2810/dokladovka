// Preklad kódov z pravidla na id číselníka. Chyba tu znamená doklad zaúčtovaný
// na cudzí účet, preto sú tu aj prípady, ktoré účtovník nikdy neuvidí.
import { describe, expect, it } from 'vitest';
import { najdiKod, polozkySKodmi, zauctovanieZKodov, type CodeIndex } from './codeResolution.js';

function index(riadky: Array<[string, string, string]>): CodeIndex {
  const presne = new Map<any, Map<string, string>>();
  const prefixy = new Map<any, Map<string, string | null>>();
  for (const [kind, code, id] of riadky) {
    const kod = code.toLowerCase().replace(/\s+/g, '');
    if (!presne.has(kind)) presne.set(kind, new Map());
    if (!prefixy.has(kind)) prefixy.set(kind, new Map());
    presne.get(kind)!.set(kod, id);
    const prefix = prefixy.get(kind)!;
    prefix.set(kod, prefix.has(kod) ? null : id);
  }
  return { presne, prefixy } as CodeIndex;
}

const CISELNIK = index([
  ['predkontacie', '521100/331100 HM', 'p-hm'],
  ['predkontacie', '524100/331100', 'p-pn'],
  ['predkontacie', '331 / 335200', 'p-strava'],
  ['predkontacie', 'SF', 'p-sf'],
  ['predkontacie', '518100/321100', 'p-sluzby'],
  ['predkontacie', '518100/321200', 'p-sluzby2'],
  ['cleneniaDph', 'UN', 'd-un'],
  ['ciselneRady', '26MZD', 'r-mzd'],
]);

describe('najdiKod', () => {
  it('nájde presný kód bez ohľadu na medzery a veľkosť písmen', () => {
    expect(najdiKod(CISELNIK, 'predkontacie', '521100/331100 HM')).toBe('p-hm');
    expect(najdiKod(CISELNIK, 'predkontacie', '521100/331100 hm')).toBe('p-hm');
    // Pravidlo píše kód bez medzier, číselník ich má — musí sedieť.
    expect(najdiKod(CISELNIK, 'predkontacie', '331/335200')).toBe('p-strava');
    expect(najdiKod(CISELNIK, 'ciselneRady', '26mzd')).toBe('r-mzd');
  });

  it('doplní jednoznačný chvost kódu', () => {
    // „521100/331100" existuje len ako „…HM" — doplnenie je bezpečné.
    expect(najdiKod(CISELNIK, 'predkontacie', '521100/331100')).toBe('p-hm');
  });

  it('pri viacznačnom prefixe radšej nevráti nič', () => {
    // „518100/321" sedí na dva rôzne účty — hádať by znamenalo zlé zaúčtovanie.
    expect(najdiKod(CISELNIK, 'predkontacie', '518100/321')).toBeUndefined();
  });

  it('neznámy alebo prázdny kód nevráti nič', () => {
    expect(najdiKod(CISELNIK, 'predkontacie', 'NEEXISTUJE')).toBeUndefined();
    expect(najdiKod(CISELNIK, 'predkontacie', '')).toBeUndefined();
    expect(najdiKod(CISELNIK, 'predkontacie', undefined)).toBeUndefined();
    // Kód z iného druhu číselníka sa nesmie použiť.
    expect(najdiKod(CISELNIK, 'cleneniaDph', '26MZD')).toBeUndefined();
  });
});

describe('zauctovanieZKodov', () => {
  it('preloží predkontáciu, členenie aj rad a prevezme sekciu KV', () => {
    expect(zauctovanieZKodov(CISELNIK, {
      accountCode: 'SF', vatClassificationCode: 'UN', numberSeriesCode: '26MZD',
    })).toEqual({ predkontaciaId: 'p-sf', clenenieDphId: 'd-un', ciselnyRadId: 'r-mzd' });
  });

  it('sekciu kontrolného výkazu berie priamo, nie z číselníka', () => {
    // KN nie je členenie DPH firmy — je to štatutárna sekcia KV.
    expect(zauctovanieZKodov(CISELNIK, {
      accountCode: undefined, vatClassificationCode: 'kn', numberSeriesCode: undefined,
    })).toEqual({ clenenieKvKod: 'KN' });
  });

  it('neznáme kódy vynechá, nie nahradí', () => {
    expect(zauctovanieZKodov(CISELNIK, {
      accountCode: '999/999', vatClassificationCode: undefined, numberSeriesCode: 'XX',
    })).toEqual({});
  });
});

describe('polozkySKodmi', () => {
  const extracted = { polozky: [{ id: 'a', popis: 'hrubá mzda' }, { id: 'b', popis: 'náhrada za PN' }] };

  it('doplní predkontáciu na položky podľa poradia', () => {
    const vysledok = polozkySKodmi(CISELNIK, extracted, [
      { accountCode: '521100/331100 HM' },
      { accountCode: '524100/331100', vatClassificationCode: 'UN' },
    ]) as any;
    expect(vysledok.polozky[0].ucto).toEqual({ predkontaciaId: 'p-hm' });
    expect(vysledok.polozky[1].ucto).toEqual({ predkontaciaId: 'p-pn', clenenieDphId: 'd-un' });
    // Pôvodný objekt ostáva nedotknutý.
    expect((extracted.polozky[0] as any).ucto).toBeUndefined();
  });

  it('položku bez kódu ani s neznámym kódom nechá tak', () => {
    const vysledok = polozkySKodmi(CISELNIK, extracted, [{}, { accountCode: 'NIC' }]) as any;
    expect(vysledok.polozky[0].ucto).toBeUndefined();
    expect(vysledok.polozky[1].ucto).toBeUndefined();
  });

  it('doklad bez položiek prejde bez zmeny', () => {
    const prazdny = { polozky: [] };
    expect(polozkySKodmi(CISELNIK, prazdny, [])).toBe(prazdny);
  });
});

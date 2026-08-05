import { describe, expect, it } from 'vitest';
import { extractPohodaDecisions, extractPohodaHistory, type MdbLike } from './pohodaMdbImport';

// Falošný mdb-reader: dáta zodpovedajú reálnej štruktúre POHODA (FA + väzby na
// pPK/sDPH/sKVDPH). sKVDPH.ID=7→B2, ID=1→KN, ID=16→C2B1 (rozšírený kód).
function fakeReader(
  fa: Array<Record<string, unknown>>,
  dalsie: Record<string, Array<Record<string, unknown>>> = {},
): MdbLike {
  const tables: Record<string, Array<Record<string, unknown>>> = {
    FA: fa,
    pPK: [{ ID: 100, IDS: 'BEZ321100' }, { ID: 200, IDS: '501100 PHM' }],
    sDPH: [{ ID: 10, IDS: 'PD' }, { ID: 20, IDS: 'PN' }, { ID: 30, IDS: 'UD' }],
    sKVDPH: [{ ID: 7, IDS: 'B2' }, { ID: 1, IDS: 'KN' }, { ID: 16, IDS: 'C2B1' }],
    ...dalsie,
  };
  return {
    getTableNames: () => Object.keys(tables),
    getTable: (name) => ({
      getColumnNames: () => Object.keys(tables[name]?.[0] ?? {}),
      getData: () => tables[name] ?? [],
    }),
  };
}

describe('extractPohodaDecisions', () => {
  it('číta prijaté faktúry, rozvíja väzby, vydané preskočí a rozšírený KV kód zredukuje na sekciu', () => {
    const { rows, summary } = extractPohodaDecisions(fakeReader([
      { RelTpFak: 11, Firma: 'SPEDUS SK s. r. o.', ICO: '52394051', SText: 'preprava', RelPk: 100, RelTpDPH: 10, RelTpKVDPH: 7 },
      { RelTpFak: 11, Firma: 'SPEDUS SK s. r. o.', ICO: '52394051', SText: 'preprava', RelPk: 100, RelTpDPH: 10, RelTpKVDPH: 7 }, // duplicita
      { RelTpFak: 11, Firma: 'Geschwandtner GmbH', ICO: null, SText: 'parkovanie', RelPk: 100, RelTpDPH: 20, RelTpKVDPH: 1 },
      { RelTpFak: 12, Firma: 'Dobropis s.r.o.', ICO: '11112222', SText: 'oprava', RelPk: 200, RelTpDPH: 10, RelTpKVDPH: 16 }, // C2B1 → C2
      { RelTpFak: 1, Firma: 'Odberateľ a.s.', ICO: '99998888', SText: 'predaj', RelPk: 100, RelTpDPH: 30, RelTpKVDPH: 1 }, // vydaná → skip
      { RelTpFak: 11, Firma: '', ICO: null, SText: 'bez dodávateľa', RelPk: 100, RelTpDPH: 10, RelTpKVDPH: 7 }, // bez dodávateľa → skip
    ]));

    expect(summary).toMatchObject({ spolu: 6, prijate: 5, vydane: 1, bezUctovania: 1, unikatne: 3 });
    expect(rows).toHaveLength(3);
    expect(rows[0]).toEqual({
      supplierIco: '52394051', supplierName: 'SPEDUS SK s. r. o.', lineText: 'preprava',
      predkontaciaKod: 'BEZ321100', clenenieDphKod: 'PD', clenenieKvKod: 'B2',
    });
    // Zahraničný dodávateľ bez IČO — matchuje sa podľa názvu; KV = KN.
    expect(rows[1]).toMatchObject({ supplierIco: undefined, supplierName: 'Geschwandtner GmbH', clenenieKvKod: 'KN' });
    // Rozšírený kód C2B1 sa zredukoval na zákonnú sekciu C2.
    expect(rows[2].clenenieKvKod).toBe('C2');
  });

  it('história berie všetky dokladové agendy okrem banky a vydané nechá ako FV', () => {
    const { rows, summary } = extractPohodaHistory(fakeReader(
      [
        // mdb-reader vracia UTC polnoc — test to musí napodobniť, inak by skryl
        // posun dátumu o deň na strojoch západne od UTC.
        { RelTpFak: 11, Cislo: 'FP2500001', Datum: new Date(Date.UTC(2025, 2, 5)), Firma: 'SPEDUS SK s. r. o.', ICO: '52394051', SText: 'preprava', RelPk: 200, RelTpDPH: 10, RelTpKVDPH: 7 },
        { RelTpFak: 1, Cislo: 'FV2500001', Datum: new Date(Date.UTC(2025, 2, 6)), Firma: 'Odberateľ a.s.', ICO: '99998888', SText: 'predaj tovaru', RelPk: 200, RelTpDPH: 30, RelTpKVDPH: 1 },
        { RelTpFak: 16, Cislo: 'OZ2500001', Firma: 'Poisťovňa', ICO: null, SText: 'poistné', RelPk: 200, RelTpDPH: 20, RelTpKVDPH: 1 },
        { RelTpFak: 11, Cislo: 'FP2500002', Firma: 'X', ICO: '1', SText: 'bez zaúčtovania', RelPk: null, RelTpDPH: null, RelTpKVDPH: null },
      ],
      {
        HO: [{ Cislo: 'PD2500001', Datum: new Date(Date.UTC(2025, 0, 31)), Firma: 'Slovnaft', ICO: '31322832', SText: 'PHM', RelPk: 200, RelTpDPH: 10, RelTpKVDPH: 7 }],
        pINT: [{ Cislo: 'INT2500001', SText: 'mzdy 01/2025', RelPk: 200, RelTpDPH: 20, RelTpKVDPH: 1, Firma: '', ICO: null }],
        BV: [{ Cislo: 'BV1', SText: 'úhrada', RelPk: 200, RelTpDPH: 10, Firma: '', ICO: null }],
      },
    ));

    // Banka (BV) sa neučí; FA riadok bez predkontácie aj členenia sa vynechá.
    expect(summary).toMatchObject({ spolu: 6, bezZauctovania: 1 });
    expect(summary.poAgende).toEqual({ FP: 1, FV: 1, INE: 2, PD: 1 });
    expect(rows).toHaveLength(5);
    expect(rows[0]).toEqual({
      agenda: 'FP', riadokIndex: 0, dokladCislo: 'FP2500001', datum: '2025-03-05',
      supplierIco: '52394051', supplierName: 'SPEDUS SK s. r. o.', lineText: 'preprava',
      predkontaciaKod: '501100 PHM', clenenieDphKod: 'PD', clenenieKvKod: 'B2',
    });
    // Vydaná faktúra do histórie patrí (na rozdiel od pamäte dodávateľov).
    expect(rows[1]).toMatchObject({ agenda: 'FV', lineText: 'predaj tovaru', clenenieDphKod: 'UD' });
    // Neznámy typ FA (ostatné pohľadávky/záväzky) neprepadne — skončí ako INE.
    expect(rows[2]).toMatchObject({ agenda: 'INE', dokladCislo: 'OZ2500001', datum: undefined });
    expect(rows[3]).toMatchObject({ agenda: 'PD', lineText: 'PHM', dokladCislo: 'PD2500001' });
    expect(rows[4]).toMatchObject({ agenda: 'INE', lineText: 'mzdy 01/2025', supplierName: undefined });
  });

  it('história prežije databázu bez pokladne a interných dokladov', () => {
    const { rows, summary } = extractPohodaHistory(fakeReader([
      { RelTpFak: 11, Cislo: 'FP1', Firma: 'X', ICO: '1', SText: 'preprava', RelPk: 200, RelTpDPH: 10, RelTpKVDPH: 7 },
    ]));
    expect(rows).toHaveLength(1);
    expect(summary.poAgende).toEqual({ FP: 1 });
  });

  it('nespadne, keď v databáze chýba tabuľka číselníka', () => {
    const reader: MdbLike = {
      getTableNames: () => ['FA'],
      getTable: () => ({ getColumnNames: () => [], getData: () => [
        { RelTpFak: 11, Firma: 'X', ICO: '1', SText: 't', RelPk: 1, RelTpDPH: 1, RelTpKVDPH: 1 },
      ] }),
    };
    const { rows } = extractPohodaDecisions(reader);
    // Bez číselníkov ostanú kódy prázdne → riadok bez predkontácie aj členenia sa vynechá.
    expect(rows).toHaveLength(0);
  });
});

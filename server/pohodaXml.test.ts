import { describe, expect, it } from 'vitest';
import { buildServerDataPack, splitPostalAddress, vatCountryIds, type PohodaCodeLookup } from './pohodaXml.js';

const codeLists: PohodaCodeLookup = {
  predkontacie: new Map([['p1', '518/321']]),
  cleneniaDph: new Map([['c1', 'PD']]),
  ciselneRady: new Map([['r1', '26FP']]),
  strediska: new Map(),
};

function invoiceDocument(extra: Record<string, unknown>) {
  return {
    id: 'doc-1',
    snapshot: {
      version: 2,
      typ: 'FP',
      extracted: {
        dodavatel: { nazov: 'RAINSIDE s.r.o.', ico: '31386946', dic: '2020309247' },
        cisloFaktury: 'FA-202610845',
        datumVystavenia: '2026-06-30',
        datumDodania: '2026-06-30',
        datumSplatnosti: '2026-07-14',
        mena: 'EUR',
        rozpisDph: [{ sadzba: 23, zaklad: 70, dph: 16.1 }],
        sumaSpolu: 86.1,
        ...extra,
      },
      ucto: { predkontaciaId: 'p1', clenenieDphId: 'c1', ciselnyRadId: 'r1' },
    },
  };
}

describe('buildServerDataPack — variabilný symbol', () => {
  it('prázdny VS z AI extrakcie sa nahradí číslicami z čísla faktúry', () => {
    const xml = buildServerDataPack({
      id: 'pack-1',
      ico: '35761571',
      documents: [invoiceDocument({ variabilnySymbol: '' })],
      codeLists,
    });
    expect(xml).toContain('<inv:symVar>202610845</inv:symVar>');
  });

  it('vyplnený VS má prednosť pred číslom faktúry', () => {
    const xml = buildServerDataPack({
      id: 'pack-2',
      ico: '35761571',
      documents: [invoiceDocument({ variabilnySymbol: '9990001' })],
      codeLists,
    });
    expect(xml).toContain('<inv:symVar>9990001</inv:symVar>');
  });
});

describe('buildServerDataPack — partner a hlavička pre POHODU', () => {
  it('zahraničný dodávateľ dostane IČ DPH, adresu a krajinu z prefixu IČ DPH', () => {
    const xml = buildServerDataPack({
      id: 'pack-3',
      ico: '35761571',
      documents: [invoiceDocument({
        dodavatel: {
          nazov: 'MUNDUS Spedition Gesellschaft m. b. H.',
          icDph: 'ATU42597604',
          adresa: '1020 Wien – Seitenhafenstrasse 15/202',
        },
      })],
      codeLists,
    });
    expect(xml).toContain('<typ:icDph>ATU42597604</typ:icDph>');
    expect(xml).toContain('<typ:city>Wien</typ:city>');
    expect(xml).toContain('<typ:street>Seitenhafenstrasse 15/202</typ:street>');
    expect(xml).toContain('<typ:zip>1020</typ:zip>');
    expect(xml).toContain('<typ:country><typ:ids>AT</typ:ids></typ:country>');
    // Prázdne IČO/DIČ sa nevypisujú ako prázdne prvky.
    expect(xml).not.toContain('<typ:ico></typ:ico>');
    expect(xml).not.toContain('<typ:dic></typ:dic>');
  });

  it('FP dostane originalDocument (pole Doklad) a dateDelivery (Dátum dodania)', () => {
    const xml = buildServerDataPack({
      id: 'pack-4',
      ico: '35761571',
      documents: [invoiceDocument({})],
      codeLists,
    });
    expect(xml).toContain('<inv:originalDocument>FA-202610845</inv:originalDocument>');
    expect(xml).toContain('<inv:dateDelivery>2026-06-30</inv:dateDelivery>');
  });

  it('FV pole Doklad nemá; slovenský dodávateľ má krajinu SK z prefixu IČ DPH', () => {
    const doc = invoiceDocument({ dodavatel: { nazov: 'RAINSIDE s.r.o.', ico: '31386946', dic: '2020309247', icDph: 'SK2020309247' } });
    doc.snapshot.typ = 'FV';
    const xml = buildServerDataPack({ id: 'pack-5', ico: '35761571', documents: [doc], codeLists });
    expect(xml).not.toContain('<inv:originalDocument>');
    expect(xml).toContain('<typ:icDph>SK2020309247</typ:icDph>');
    expect(xml).toContain('<typ:country><typ:ids>SK</typ:ids></typ:country>');
  });
});

describe('buildServerDataPack — rozpis na položky (invoiceDetail)', () => {
  const detailCodeLists: PohodaCodeLookup = {
    predkontacie: new Map([['p1', '518/321'], ['p2', '501/321']]),
    cleneniaDph: new Map([['c1', 'PD'], ['c2', 'PN']]),
    ciselneRady: new Map([['r1', '26FP']]),
    strediska: new Map([['s1', 'CENTRALA']]),
  };

  it('doklad bez položiek importuje iba súhrn (žiadny invoiceDetail)', () => {
    const xml = buildServerDataPack({ id: 'pack-6', ico: '35761571', documents: [invoiceDocument({})], codeLists: detailCodeLists });
    expect(xml).not.toContain('<inv:invoiceDetail>');
    expect(xml).toContain('<inv:invoiceSummary>');
  });

  it('položky sa importujú s DPH, jednotkou, počtom a pozičným zaúčtovaním', () => {
    const doc = invoiceDocument({
      polozky: [
        {
          id: 'li-1', popis: 'Baliaci material', mnozstvo: 2, jednotka: 'ks', sadzbaDph: 23,
          jednotkovaCenaBezDph: 35, sumaBezDph: 70, sumaDph: 16.1, sumaSpolu: 86.1,
          ucto: { predkontaciaId: 'p2', clenenieDphId: 'c2', strediskoId: 's1' },
        },
      ],
    });
    doc.snapshot.ucto = { ...doc.snapshot.ucto, clenenieKvKod: 'B2' };
    const xml = buildServerDataPack({ id: 'pack-7', ico: '35761571', documents: [doc], codeLists: detailCodeLists });
    expect(xml).toContain('<inv:invoiceDetail>');
    expect(xml).toContain('<inv:text>Baliaci material</inv:text>');
    expect(xml).toContain('<inv:quantity>2</inv:quantity>');
    expect(xml).toContain('<inv:unit>ks</inv:unit>');
    expect(xml).toContain('<inv:rateVAT>high</inv:rateVAT>');
    expect(xml).toContain('<typ:unitPrice>35.00</typ:unitPrice>');
    expect(xml).toContain('<typ:price>70.00</typ:price>');
    expect(xml).toContain('<typ:priceVAT>16.10</typ:priceVAT>');
    expect(xml).toContain('<typ:priceSum>86.10</typ:priceSum>');
    // Pozičné zaúčtovanie položky prebíja hlavičku; KV DPH sa dedí z hlavičky.
    expect(xml).toContain('<inv:accounting><typ:ids>501/321</typ:ids></inv:accounting>');
    expect(xml).toContain('<inv:classificationVAT><typ:ids>PN</typ:ids></inv:classificationVAT>');
    expect(xml).toContain('<inv:classificationKVDPH><typ:ids>B2</typ:ids></inv:classificationKVDPH>');
    expect(xml).toContain('<inv:centre><typ:ids>CENTRALA</typ:ids></inv:centre>');
  });

  it('položka bez vlastného zaúčtovania sa vráti na predkontáciu/členenie hlavičky', () => {
    const doc = invoiceDocument({
      polozky: [{ id: 'li-1', popis: 'Služba', mnozstvo: 1, sadzbaDph: 19, sumaBezDph: 100, sumaDph: 19, sumaSpolu: 119 }],
    });
    const xml = buildServerDataPack({ id: 'pack-8', ico: '35761571', documents: [doc], codeLists: detailCodeLists });
    expect(xml).toContain('<inv:rateVAT>low</inv:rateVAT>');
    expect(xml).toContain('<inv:accounting><typ:ids>518/321</typ:ids></inv:accounting>');
    expect(xml).toContain('<inv:classificationVAT><typ:ids>PD</typ:ids></inv:classificationVAT>');
    expect(xml).not.toContain('<inv:centre>');
  });
});

describe('splitPostalAddress a vatCountryIds', () => {
  it('rozloží jednoriadkovú adresu s pomlčkou aj viacriadkovú adresu', () => {
    expect(splitPostalAddress('1020 Wien – Seitenhafenstrasse 15/202'))
      .toEqual({ street: 'Seitenhafenstrasse 15/202', city: 'Wien', zip: '1020' });
    expect(splitPostalAddress('Prístavná 776/10\n821 09 Bratislava\nSlovakei'))
      .toEqual({ street: 'Prístavná 776/10', city: 'Bratislava', zip: '821 09' });
    expect(splitPostalAddress('Hlavná 1')).toEqual({ street: 'Hlavná 1' });
    expect(splitPostalAddress(undefined)).toEqual({});
  });

  it('krajina sa mapuje z prefixu IČ DPH vrátane EL a XI', () => {
    expect(vatCountryIds('ATU42597604')).toBe('AT');
    expect(vatCountryIds('EL123456789')).toBe('GR');
    expect(vatCountryIds('XI123456789')).toBe('GB');
    expect(vatCountryIds(undefined)).toBeUndefined();
    expect(vatCountryIds('12345')).toBeUndefined();
  });
});

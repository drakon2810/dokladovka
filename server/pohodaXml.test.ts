import { describe, expect, it } from 'vitest';
import { buildServerDataPack, splitPostalAddress, vatCountryIds, type PohodaCodeLookup } from './pohodaXml.js';

const codeLists: PohodaCodeLookup = {
  predkontacie: new Map([['p1', '518/321']]),
  cleneniaDph: new Map([['c1', 'PD']]),
  ciselneRady: new Map([['r1', '26FP']]),
  strediska: new Map(),
  // Bez diakritiky — escapeXml ju kóduje na číselné entity (Windows-1250),
  // čo testujú vlastné testy escapeXml; tu ide o samotný obsah <inv:text>.
  predkontacieNazvy: new Map([['p1', 'Preprava zahranicna 69']]),
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

describe('buildServerDataPack — krajina a text hlavičky', () => {
  // Extrakcia zahraničný daňový identifikátor často uloží do DIČ (icDph zostane
  // prázdne) — POHODA potom importovala dodávateľa bez krajiny.
  it('krajina sa odvodí z DIČ, keď je IČ DPH prázdne', () => {
    const xml = buildServerDataPack({
      id: 'pack-country',
      ico: '35761571',
      documents: [invoiceDocument({
        dodavatel: {
          nazov: 'Hapag-Lloyd AG',
          dic: 'DE813960018',
          adresa: 'Ballindamm 25, 20095 Hamburg, Germany',
        },
      })],
      codeLists,
    });
    expect(xml).toContain('<typ:country><typ:ids>DE</typ:ids></typ:country>');
  });

  it('slovenské číselné DIČ nevyrobí falošnú krajinu', () => {
    const xml = buildServerDataPack({
      id: 'pack-country-sk',
      ico: '35761571',
      documents: [invoiceDocument({})],
      codeLists,
    });
    expect(xml).not.toContain('<typ:country>');
  });

  it('text dokladu je názov vybranej predkontácie', () => {
    const xml = buildServerDataPack({
      id: 'pack-text',
      ico: '35761571',
      documents: [invoiceDocument({})],
      codeLists,
    });
    expect(xml).toContain('<inv:text>Preprava zahranicna 69</inv:text>');
  });

  it('bez názvu predkontácie sa použije číslo faktúry', () => {
    const xml = buildServerDataPack({
      id: 'pack-text-fallback',
      ico: '35761571',
      documents: [invoiceDocument({})],
      codeLists: { ...codeLists, predkontacieNazvy: undefined },
    });
    expect(xml).toContain('<inv:text>FA-202610845</inv:text>');
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

describe('buildServerDataPack — položkový rozpis PD a MZDY', () => {
  const detailCodeLists: PohodaCodeLookup = {
    predkontacie: new Map([['p1', '501/211'], ['p2', '513/211']]),
    cleneniaDph: new Map([['c1', 'PD'], ['c2', 'PN']]),
    ciselneRady: new Map([['r1', '26PD']]),
    strediska: new Map([['s1', 'CENTRALA']]),
  };
  const polozky = [
    {
      id: 'li-1', popis: 'Nafta', mnozstvo: 1, sadzbaDph: 23,
      sumaBezDph: 42.28, sumaDph: 9.72, sumaSpolu: 52,
      ucto: { predkontaciaId: 'p2', clenenieDphId: 'c2', strediskoId: 's1' },
    },
  ];

  it('PD (vch:voucher) exportuje voucherDetail s pozičným zaúčtovaním', () => {
    const doc = invoiceDocument({ polozky });
    doc.snapshot.typ = 'PD';
    doc.snapshot.ucto = { ...doc.snapshot.ucto, pokladnaKod: 'PKR', pokladnaTyp: 'expense', clenenieKvKod: 'B3' };
    const xml = buildServerDataPack({ id: 'pack-pd', ico: '35761571', documents: [doc], codeLists: detailCodeLists });
    expect(xml).toContain('<vch:voucherDetail>');
    expect(xml).toContain('<vch:text>Nafta</vch:text>');
    expect(xml).toContain('<vch:rateVAT>high</vch:rateVAT>');
    // Per-riadkové zaúčtovanie sa pri PD predtým mlčky zahadzovalo.
    expect(xml).toContain('<vch:accounting><typ:ids>513/211</typ:ids></vch:accounting>');
    expect(xml).toContain('<vch:classificationVAT><typ:ids>PN</typ:ids></vch:classificationVAT>');
    expect(xml).toContain('<vch:classificationKVDPH><typ:ids>B3</typ:ids></vch:classificationKVDPH>');
    expect(xml).toContain('<vch:centre><typ:ids>CENTRALA</typ:ids></vch:centre>');
  });

  it('PD bez položiek zostáva len súhrn (žiadny voucherDetail)', () => {
    const doc = invoiceDocument({});
    doc.snapshot.typ = 'PD';
    doc.snapshot.ucto = { ...doc.snapshot.ucto, pokladnaKod: 'PKR', pokladnaTyp: 'expense' };
    const xml = buildServerDataPack({ id: 'pack-pd-2', ico: '35761571', documents: [doc], codeLists: detailCodeLists });
    expect(xml).not.toContain('<vch:voucherDetail>');
    expect(xml).toContain('<vch:voucherSummary>');
  });

  it('MZDY (int:intDoc) exportuje intDocDetail', () => {
    const doc = invoiceDocument({ polozky });
    doc.snapshot.typ = 'MZDY';
    const xml = buildServerDataPack({ id: 'pack-mzdy', ico: '35761571', documents: [doc], codeLists: detailCodeLists });
    expect(xml).toContain('<int:intDocDetail>');
    expect(xml).toContain('<int:text>Nafta</int:text>');
    expect(xml).toContain('<int:accounting><typ:ids>513/211</typ:ids></int:accounting>');
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

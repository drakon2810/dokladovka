import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { buildServerDataPack, splitPostalAddress, supplierAddressParts, vatCountryIds, type PohodaCodeLookup } from './pohodaXml.js';

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

// Rakúska faktúra ASFINAG: 89,00 + 20 % = 106,80 €. Slovenská POHODA pozná len
// sadzby 23/19/5/0, takže riadok nepadol do žiadneho koša a do POHODY by prišiel
// doklad na 0,00 €. Cudzia daň sa neodpočítava — ide celá do priceNone.
describe('buildServerDataPack — cudzia sadzba DPH', () => {
  const rakuska = invoiceDocument({
    rozpisDph: [{ sadzba: 20, zaklad: 89, dph: 17.8 }],
    sumaSpolu: 106.8,
    polozky: [{
      id: 'li-0', popis: 'Annual vignette Car 2026', mnozstvo: 1, jednotkovaCenaBezDph: 89,
      sadzbaDph: 20, sumaBezDph: 89, sumaDph: 17.8, sumaSpolu: 106.8,
    }],
  });

  it('celá suma ide do priceNone, nie do nuly', () => {
    const xml = buildServerDataPack({ id: 'pack-at', ico: '35761571', documents: [rakuska], codeLists });
    expect(xml).toContain('<typ:priceNone>106.80</typ:priceNone>');
    expect(xml).toContain('<typ:priceHigh>0.00</typ:priceHigh>');
  });

  it('položka nesie celú sumu bez DPH, aby sa daň nestratila', () => {
    const xml = buildServerDataPack({ id: 'pack-at2', ico: '35761571', documents: [rakuska], codeLists });
    expect(xml).toContain('<inv:rateVAT>none</inv:rateVAT>');
    expect(xml).toContain('<typ:price>106.80</typ:price>');
    expect(xml).toContain('<typ:priceVAT>0.00</typ:priceVAT>');
    expect(xml).toContain('<typ:unitPrice>106.80</typ:unitPrice>');
  });

  it('slovenská sadzba ostáva rozdelená na základ a daň', () => {
    const xml = buildServerDataPack({ id: 'pack-sk', ico: '35761571', documents: [invoiceDocument({})], codeLists });
    expect(xml).toContain('<typ:priceHigh>70.00</typ:priceHigh>');
    expect(xml).toContain('<typ:priceHighVAT>16.10</typ:priceHighVAT>');
    expect(xml).toContain('<typ:priceNone>0.00</typ:priceNone>');
  });
});

describe('buildServerDataPack — dodržanie limitov XSD schémy', () => {
  // Reálny prípad: francúzsky dodávateľ mal v poli IČO SIRET „340 256 791 00054"
  // (17 znakov) — typ:icoType má maxLength 15, takže XSD validácia u agenta
  // zhodila CELÝ dataPack vrátane bezchybných dokladov v tej istej dávke.
  it('zahraničné identifikátory sa zbavia medzier a orežú na limit schémy', () => {
    const xml = buildServerDataPack({
      id: 'pack-limits',
      ico: '35761571',
      documents: [invoiceDocument({
        dodavatel: { nazov: 'A'.repeat(300), ico: '340 256 791 00054', dic: 'FR 12 345 678 901 234 567 890', adresa: `${'Ulica '.repeat(20)} – 851 01 ${'Mesto'.repeat(20)}` },
        cisloFaktury: 'F'.repeat(60),
        cisloObjednavky: 'O'.repeat(60),
        variabilnySymbol: '1'.repeat(40),
      })],
      codeLists,
    });
    expect(xml).toContain('<typ:ico>34025679100054</typ:ico>');
    expect(xml).not.toContain('340 256 791');
    for (const [element, maxLength] of [
      ['typ:ico', 15], ['typ:dic', 18], ['typ:company', 255], ['typ:city', 45], ['typ:street', 64], ['typ:zip', 15],
      ['inv:symVar', 20], ['inv:originalDocument', 32], ['inv:numberOrder', 32], ['inv:text', 240],
    ] as const) {
      const value = new RegExp(`<${element}>([^<]*)</${element}>`).exec(xml)?.[1];
      expect(value, `${element} chýba v dataPacku`).toBeDefined();
      expect(value!.length, `${element} presahuje limit ${maxLength}`).toBeLessThanOrEqual(maxLength);
    }
  });

  // Dátumy sú xsd:date — chýbajúca splatnosť je pri schvaľovaní len upozornenie,
  // takže sa doklad dá schváliť a doteraz zhodil celý prenos až u agenta.
  it('neplatný alebo chýbajúci dátum sa nahradí dátumom vystavenia', () => {
    const xml = buildServerDataPack({
      id: 'pack-dates',
      ico: '35761571',
      documents: [invoiceDocument({ datumSplatnosti: '', datumDodania: '30.06.2026' })],
      codeLists,
    });
    expect(xml).toContain('<inv:date>2026-06-30</inv:date>');
    expect(xml).toContain('<inv:dateDue>2026-06-30</inv:dateDue>');
    expect(xml).toContain('<inv:dateTax>2026-06-30</inv:dateTax>');
    expect(xml).not.toContain('30.06.2026');
    expect(xml).not.toContain('<inv:dateDelivery>');
  });

  it('doklad bez dátumu vystavenia sa odmietne s menom dokladu', () => {
    expect(() => buildServerDataPack({
      id: 'pack-nodate',
      ico: '35761571',
      documents: [invoiceDocument({ datumVystavenia: '' })],
      codeLists,
    })).toThrow(/doc-1.*dátum vystavenia/);
  });

  // typ:ids = prefix rady (POHODA pridelí ďalšie voľné číslo). Keď tam išiel
  // typ:numberRequested, každý doklad žiadal to isté číslo a druhý export
  // skončil hláškou „Doklad so zadaným číslom už existuje".
  it('číselný rad ide do typ:ids, nie ako konkrétne číslo dokladu', () => {
    const xml = buildServerDataPack({
      id: 'pack-series',
      ico: '35761571',
      documents: [invoiceDocument({})],
      codeLists,
    });
    expect(xml).toContain('<inv:number><typ:ids>26FP</typ:ids></inv:number>');
    expect(xml).not.toContain('numberRequested');
  });

  it('nečíselné množstvo položky nezhodí dataPack', () => {
    const xml = buildServerDataPack({
      id: 'pack-qty',
      ico: '35761571',
      documents: [invoiceDocument({ polozky: [{ popis: 'Preprava', mnozstvo: '2 ks', sadzbaDph: 23, cenaBezDph: 70, dph: 16.1 }] })],
      codeLists,
    });
    expect(xml).toContain('<inv:quantity>1</inv:quantity>');
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

  it('FP: partnerom je dodávateľ; krajina SK sa odvodí z prefixu IČ DPH', () => {
    const doc = invoiceDocument({ dodavatel: { nazov: 'RAINSIDE s.r.o.', ico: '31386946', dic: '2020309247', icDph: 'SK2020309247' } });
    const xml = buildServerDataPack({ id: 'pack-5', ico: '35761571', documents: [doc], codeLists });
    expect(xml).toContain('<typ:icDph>SK2020309247</typ:icDph>');
    expect(xml).toContain('<typ:country><typ:ids>SK</typ:ids></typ:country>');
  });

  it('FV: partnerom je ODBERATEĽ, nie vlastná firma; pole Doklad sa neposiela', () => {
    const doc = invoiceDocument({
      // Dodávateľom vydanej faktúry je vlastná firma — do POHODY ísť nesmie.
      dodavatel: { nazov: 'AGS Bratislava s.r.o.', ico: '35761571', icDph: 'SK2020254170', iban: 'SK3131000000004040272818' },
      odberatel: { nazov: 'International Atomic Energy Agency', icDph: 'ATU37890000', adresa: 'Wagramer Str. 5, 1220 Vienna' },
    });
    doc.snapshot.typ = 'FV';
    const xml = buildServerDataPack({ id: 'pack-5', ico: '35761571', documents: [doc], codeLists });
    expect(xml).not.toContain('<inv:originalDocument>');
    expect(xml).toContain('<typ:company>International Atomic Energy Agency</typ:company>');
    expect(xml).toContain('<typ:icDph>ATU37890000</typ:icDph>');
    expect(xml).toContain('<typ:country><typ:ids>AT</typ:ids></typ:country>');
    // Vlastná firma sa ako partner neobjaví ani cez IČO, ani cez IČ DPH.
    expect(xml).not.toContain('AGS Bratislava');
    expect(xml).not.toContain('SK2020254170');
    // paymentAccount je pole záväzku — pohľadávka ho nemá.
    expect(xml).not.toContain('<inv:paymentAccount>');
    // Dátum dodania a špecifický symbol sú polia záväzkov (invoice.xsd).
    expect(xml).not.toContain('<inv:dateDelivery>');
    expect(xml).not.toContain('<inv:symSpec>');
  });

  it('FV: forma úhrady a vlastný účet idú do POHODY ako paymentType a account', () => {
    const doc = invoiceDocument({
      dodavatel: { nazov: 'AGS Bratislava s.r.o.', ico: '35761571' },
      odberatel: { nazov: 'Alfa Trade s.r.o.', ico: '36528221' },
      specifickySymbol: '55',
    });
    doc.snapshot.typ = 'FV';
    doc.snapshot.ucto = { ...doc.snapshot.ucto, bankUcetKod: 'PB', formaUhrady: 'draft' };
    const xml = buildServerDataPack({ id: 'pack-5b', ico: '35761571', documents: [doc], codeLists });
    expect(xml).toContain('<inv:paymentType><typ:paymentType>draft</typ:paymentType></inv:paymentType>');
    expect(xml).toContain('<inv:account><typ:ids>PB</typ:ids></inv:account>');
    assertOrder(emittedChildren(xml, 'inv', 'invoiceHeader'), xsdSequence('invoice.xsd', 'invoiceHeaderType'));
  });

  it('číslo dokladu: prázdne nechá číslovanie POHODE, vyplnené sa pošle ako numberRequested', () => {
    const doc = invoiceDocument({ dodavatel: { nazov: 'Dodávateľ', ico: '11112222' } });
    // Bez prepísania ide do POHODY len prefix radu — číslo pridelí ona.
    const bezCisla = buildServerDataPack({ id: 'pack-6a', ico: '35761571', documents: [doc], codeLists });
    expect(bezCisla).toContain('<inv:number><typ:ids>26FP</typ:ids></inv:number>');
    expect(bezCisla).not.toContain('numberRequested');

    // Účtovníkom prepísané číslo ide SAMO, bez rady: rada má v POHODE vyššiu
    // prioritu a číslo by prebila („Hodnota prvku musela byť upravená").
    doc.snapshot.ucto = { ...doc.snapshot.ucto, cisloVPohode: '260704300120' };
    const sCislom = buildServerDataPack({ id: 'pack-6b', ico: '35761571', documents: [doc], codeLists });
    expect(sCislom).toContain(
      '<inv:number><typ:numberRequested>260704300120</typ:numberRequested></inv:number>',
    );
    expect(sCislom).not.toContain('<typ:ids>26FP</typ:ids>');
    // S vlastným číslom vieme dokladu určiť aj podzložku pre záložku Dokumenty —
    // bez nej POHODA hlási „Priečinok nie je definovaný" a sken nemá kam ísť.
    expect(sCislom).toContain(
      // Diakritika ide do XML ako číselné entity (Windows-1250), preto sa
      // porovnáva escapovaný tvar cesty.
      '<inv:attachments><typ:files><typ:subFolder>Faktur&#225;cia\\Prijat&#233; fakt&#250;ry\\26FP\\260704300120</typ:subFolder></typ:files></inv:attachments>',
    );
    // Bez vlastného čísla podzložku POHODA nepridelí sama — meno nesie začiatok
    // id dokladu, inak by prijaté faktúry ostali bez priloženého PDF.
    expect(bezCisla).toContain(
      '<inv:attachments><typ:files><typ:subFolder>Faktur&#225;cia\\Prijat&#233; fakt&#250;ry\\26FP\\doc-1</typ:subFolder></typ:files></inv:attachments>',
    );
    assertOrder(emittedChildren(sCislom, 'inv', 'invoiceHeader'), xsdSequence('invoice.xsd', 'invoiceHeaderType'));
  });
});

// Sken sa do POHODY dostane len cez podzložku uloženú na doklade. Kým ju vedela
// zložiť iba vydaná faktúra (jediná s vlastným číslom), ostatné agendy hlásili
// „Priečinok nie je definovaný" a PDF ostalo v cloude.
describe('buildServerDataPack — priečinok dokumentov každej agendy', () => {
  const agendaCodeLists: PohodaCodeLookup = {
    ...codeLists,
    ciselneRady: new Map([['r1', '26FP'], ['rp', '26HP'], ['ri', '26INT'], ['ro', '26OZ']]),
  };

  /** Podzložka späť v čitateľnej podobe — escapeXml diakritiku kóduje na entity. */
  function subFolder(xml: string): string {
    const raw = /<typ:subFolder>([^<]*)<\/typ:subFolder>/.exec(xml)?.[1];
    expect(raw, 'doklad nedostal podzložku pre záložku Dokumenty').toBeDefined();
    return raw!.replace(/&#(\d+);/g, (_, code) => String.fromCodePoint(Number(code)));
  }

  it('pokladničný doklad dostane podzložku agendy Pokladňa', () => {
    const doc = invoiceDocument({});
    doc.snapshot.typ = 'PD';
    doc.snapshot.ucto = { ...doc.snapshot.ucto, ciselnyRadId: 'rp', pokladnaKod: '26HP', pokladnaTyp: 'expense' };
    const xml = buildServerDataPack({ id: 'pack-pd', ico: '35761571', documents: [doc], codeLists: agendaCodeLists });
    expect(subFolder(xml)).toBe('Podvojné účtovníctvo\\Pokladňa\\26HP\\doc-1');
    // attachments patrí do TELA dokladu až za súhrn (voucher.xsd), nie do hlavičky.
    expect(xml).toContain('</vch:voucherSummary>\n      <vch:attachments>');
  });

  it('mzdová páska dostane podzložku agendy Interné doklady', () => {
    const doc = invoiceDocument({});
    doc.snapshot.typ = 'MZDY';
    doc.snapshot.ucto = { ...doc.snapshot.ucto, ciselnyRadId: 'ri' };
    const xml = buildServerDataPack({ id: 'pack-int', ico: '35761571', documents: [doc], codeLists: agendaCodeLists });
    expect(subFolder(xml)).toBe('Podvojné účtovníctvo\\Interné doklady\\26INT\\doc-1');
    expect(xml).toContain('</int:intDocSummary>\n      <int:attachments>');
  });

  it('ostatný záväzok ide do svojej agendy, nie medzi prijaté faktúry', () => {
    const doc = invoiceDocument({});
    doc.snapshot.typ = 'OZ';
    doc.snapshot.ucto = { ...doc.snapshot.ucto, ciselnyRadId: 'ro' };
    const xml = buildServerDataPack({ id: 'pack-oz', ico: '35761571', documents: [doc], codeLists: agendaCodeLists });
    expect(subFolder(xml)).toBe('Fakturácia\\Ostatné záväzky\\26OZ\\doc-1');
  });

  it('nepriateľské číslo dokladu nesmie pridať úroveň cesty ani vyjsť zo stromu', () => {
    // cisloVPohode je nakoniec text z PDF: „/" by pridalo priečinok a „.." by
    // sken zapísalo mimo Dokumentov (agent podzložku dostane späť od POHODY).
    const doc = invoiceDocument({});
    doc.snapshot.ucto = { ...doc.snapshot.ucto, cisloVPohode: '..\\..\\Windows/2026' };
    const xml = buildServerDataPack({ id: 'pack-zly', ico: '35761571', documents: [doc], codeLists: agendaCodeLists });
    const cesta = subFolder(xml);
    expect(cesta.split('\\').at(-1)).toBe('Windows-2026');
    expect(cesta).not.toContain('..');
  });

  it('dva doklady s rovnakým číslom od dodávateľa nesmú zdieľať priečinok', () => {
    // Číslo faktúry jedinečné nie je (dvaja dodávatelia pošlú „1"), preto meno
    // priečinka nesie id dokladu — inak by druhý sken prepadol ako duplicita.
    const a = invoiceDocument({ cisloFaktury: '1' });
    const b = { ...invoiceDocument({ cisloFaktury: '1' }), id: 'doc-2' };
    const xml = buildServerDataPack({ id: 'pack-dup', ico: '35761571', documents: [a, b], codeLists: agendaCodeLists });
    const cesty = [...xml.matchAll(/<typ:subFolder>([^<]*)<\/typ:subFolder>/g)].map((match) => match[1]);
    expect(cesty).toHaveLength(2);
    expect(cesty[0]).not.toBe(cesty[1]);
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
      .toEqual({ street: 'Prístavná 776/10', city: 'Bratislava', zip: '821 09', country: 'SK' });
    expect(splitPostalAddress('Hlavná 1')).toEqual({ street: 'Hlavná 1' });
    expect(splitPostalAddress(undefined)).toEqual({});
  });

  it('PSČ ako samostatná časť adresy dá mesto aj krajinu', () => {
    // Reálna adresa súkromnej osoby z vydanej faktúry: mesto a PSČ sú vlastné
    // časti a krajina je na konci — predtým z toho ostala len „46A".
    expect(splitPostalAddress('46A, MÝTNA, BRATISLAVA, 811 07, Slovakia'))
      .toEqual({ street: '46A, MÝTNA', city: 'BRATISLAVA', zip: '811 07', country: 'SK' });
    expect(splitPostalAddress('Ballindamm 25, 20095 Hamburg, Germany'))
      .toEqual({ street: 'Ballindamm 25', city: 'Hamburg', zip: '20095', country: 'DE' });
    // Tá istá adresa, tri behy extrakcie — názov krajiny so zátvorkou, kraj
    // navyše aj zopakované mesto. Zo všetkých musí vyjsť to isté.
    for (const adresa of [
      '46A, MÝTNA, BRATISLAVA, 811 07, Slovakia (Slovak Republic)',
      '46A, MÝTNA, BRATISLAVA, BRATISLAVA, 811 07, SLOVAKIA (SLOVAK REPUBLIC)',
      '46A, MÝTNA, BRATISLAVA, BRATISLAVSKÝ KRAJ, 811 07, SLOVAKIA (SLOVAK REPUBLIC)',
    ]) {
      expect(splitPostalAddress(adresa)).toMatchObject({ zip: '811 07', country: 'SK' });
      expect(splitPostalAddress(adresa).city?.toUpperCase()).toBe('BRATISLAVA');
      expect(splitPostalAddress(adresa).street?.toUpperCase()).toBe('46A, MÝTNA');
    }
    // Bez IČ DPH je názov krajiny v adrese jediný zdroj krajiny partnera.
    expect(supplierAddressParts({ adresa: '46A, MÝTNA, BRATISLAVA, 811 07, Slovakia' }))
      .toEqual({ ulica: '46A, MÝTNA', psc: '811 07', obec: 'BRATISLAVA', krajina: 'SK' });
  });

  it('krajina sa mapuje z prefixu IČ DPH vrátane EL a XI', () => {
    expect(vatCountryIds('ATU42597604')).toBe('AT');
    expect(vatCountryIds('EL123456789')).toBe('GR');
    expect(vatCountryIds('XI123456789')).toBe('GB');
    expect(vatCountryIds(undefined)).toBeUndefined();
    expect(vatCountryIds('12345')).toBeUndefined();
  });
});

describe('buildServerDataPack — dlhy text polozky', () => {
  // Reálny prípad: text položky mal 106 znakov a zlom riadka uprostred. Orezanie
  // na presných 90 nestačilo — zlom riadka XSD ráta ako znak a validácia zhodila
  // celý prenos (POHODA odmieta CELÝ dataPack, nie len chybný doklad).
  it('viacriadkovy text sa zlúči do jedného riadka a oreže na 90 znakov', () => {
    const doc = invoiceDocument({
      polozky: [{
        id: 'li-1',
        popis: ['Na základe vzájomnej dohody Vám fakturujeme služby za rok 2025',
          'spracovanie účt.závierky a DPPO za rok 2025'].join(String.fromCharCode(10)),
        mnozstvo: 1, sadzbaDph: 23, sumaBezDph: 350, sumaDph: 80.5, sumaSpolu: 430.5,
      }],
    });
    const xml = buildServerDataPack({ id: 'pack-dlhy-text', ico: '35761571', documents: [doc], codeLists });
    const detail = xml.slice(xml.indexOf('<inv:invoiceItem>'));
    const text = new RegExp('<inv:text>([^<]*)</inv:text>').exec(detail)?.[1] ?? '';
    // escapeXml kóduje diakritiku na číselné entity, dĺžku meriame po dekódovaní.
    const dekodovany = text.replace(new RegExp('&#([0-9]+);', 'g'), (_, code) => String.fromCharCode(Number(code)));
    expect(dekodovany.length).toBeLessThanOrEqual(90);
    expect(dekodovany.includes(String.fromCharCode(10))).toBe(false);
    expect(dekodovany.startsWith('Na z')).toBe(true);
  });
});

describe('supplierAddressParts', () => {
  it('bez ručných polí sa odvodí z voľnej adresy a IČ DPH', () => {
    expect(supplierAddressParts({ adresa: 'Riazanská 62\n811 01 Bratislava', icDph: 'SK2020309247' }))
      .toEqual({ ulica: 'Riazanská 62', psc: '811 01', obec: 'Bratislava', krajina: 'SK' });
  });

  it('ručné polia majú prednosť a prázdna hodnota sa nedoplní z adresy', () => {
    expect(supplierAddressParts({
      adresa: 'Riazanská 62, 811 01 Bratislava',
      icDph: 'SK2020309247',
      ulica: '',
      psc: '900 27',
      obec: 'Bernolákovo',
      krajina: 'CZ',
    })).toEqual({ ulica: '', psc: '900 27', obec: 'Bernolákovo', krajina: 'CZ' });
  });

  it('vymazaná ulica sa nedostane do XML', () => {
    const doc = invoiceDocument({});
    doc.snapshot.extracted.dodavatel = {
      ...doc.snapshot.extracted.dodavatel,
      adresa: 'Riazanská 62, 811 01 Bratislava',
      ulica: '',
      psc: '811 01',
      obec: 'Bratislava',
      krajina: 'SK',
    } as typeof doc.snapshot.extracted.dodavatel;
    const xml = buildServerDataPack({ id: 'pack-adr', ico: '35761571', documents: [doc], codeLists });
    expect(xml).not.toContain('<typ:street>');
    expect(xml).toContain('<typ:city>Bratislava</typ:city>');
    expect(xml).toContain('<typ:zip>811 01</typ:zip>');
    expect(xml).toContain('<typ:country><typ:ids>SK</typ:ids></typ:country>');
  });
});

// ---------------------------------------------------------------------------
// Poradie elementov musí sedieť so sekvenciou v oficiálnej XSD schéme. POHODA
// (aj validátor agenta) odmietne celý dataPack, keď je jediný element mimo
// poradia — a taká chyba sa inak prejaví až pri reálnom importe u klienta.
// Sekvencia sa číta priamo z priloženej schémy, nie z ručne prepísaného zoznamu.
function xsdSequence(file: string, complexType: string): string[] {
  const schema = readFileSync(join(process.cwd(), 'agent/vendor/pohoda-xsd', file), 'latin1');
  const start = schema.indexOf(`<xsd:complexType name="${complexType}"`);
  if (start < 0) throw new Error(`XSD typ ${complexType} sa nenašiel v ${file}`);
  const names: string[] = [];
  let depth = 0;
  for (const token of schema.slice(start).matchAll(/<(\/?)xsd:(complexType|element)([^>]*?)(\/?)>/g)) {
    const [, closing, , attributes, selfClosing] = token;
    if (closing) {
      depth -= 1;
      if (depth === 0) break;
      continue;
    }
    depth += 1;
    if (depth === 2) {
      const name = /name="([A-Za-z0-9_]+)"/.exec(attributes)?.[1];
      if (name) names.push(name);
    }
    if (selfClosing) depth -= 1;
  }
  return names;
}

/** Priame deti jedného elementu v poradí, v akom ich generátor vypísal. */
function emittedChildren(xml: string, prefix: string, wrapper: string): string[] {
  // Obal má atribúty (`<vch:voucher version="2.0">`), preto sa hľadá cez regulár
  // — hľadanie presného `<vch:voucher>` by nenašlo nič a kontrola by prešla naprázdno.
  const open = new RegExp(`<${prefix}:${wrapper}[\\s>]`).exec(xml);
  if (!open) throw new Error(`element ${prefix}:${wrapper} sa v XML nenašiel`);
  const start = open.index + open[0].length;
  const end = xml.indexOf(`</${prefix}:${wrapper}>`, start);
  const body = xml.slice(start, end);
  // Trieda musí byť `[\\s>]`: v šablónovom reťazci sa `\s` zmenilo na obyčajné
  // „s" a elementy s atribútom sa do zoznamu nikdy nedostali.
  return [...body.matchAll(new RegExp(`<${prefix}:([A-Za-z0-9]+)[\\s>]`, 'g'))].map((match) => match[1]);
}

function assertOrder(emitted: string[], sequence: string[]): void {
  const unknown = emitted.filter((name) => !sequence.includes(name));
  expect(unknown, `elementy mimo schémy: ${unknown.join(', ')}`).toEqual([]);
  const positions = emitted.map((name) => sequence.indexOf(name));
  const sorted = [...positions].sort((left, right) => left - right);
  expect(positions, `poradie ${emitted.join(' → ')}`).toEqual(sorted);
}

describe('buildServerDataPack — poradie elementov podľa XSD', () => {
  const fullCodeLists: PohodaCodeLookup = {
    ...codeLists,
    strediska: new Map([['s1', '501998']]),
    cinnosti: new Map([['a1', '211200']]),
    zakazky: new Map([['z1', 'ZK-2026/014']]),
  };
  const analytics = { strediskoId: 's1', cinnostId: 'a1', zakazkaId: 'z1', clenenieKvKod: 'B2', poznamka: 'Poznámka' };
  const polozka = {
    id: 'i1', popis: 'Nákup PHM', mnozstvo: 2, jednotka: 'l', sadzbaDph: 23,
    sumaBezDph: 70, sumaDph: 16.1, sumaSpolu: 86.1,
    ucto: { predkontaciaId: 'p1', clenenieDphId: 'c1', strediskoId: 's1', clenenieKvKod: 'A1', cinnostId: 'a1', zakazkaId: 'z1' },
  };

  it('prijatá faktúra so všetkými poľami editora sedí so schémou', () => {
    const document = invoiceDocument({
      cisloObjednavky: 'OBJ-1', konstantnySymbol: '0308', specifickySymbol: '55',
      textPolozky: 'Nákup PHM benzín EVO 95', polozky: [polozka],
    });
    document.snapshot.ucto = { ...document.snapshot.ucto, ...analytics };
    const xml = buildServerDataPack({ id: 'pack-order-1', ico: '35761571', documents: [document], codeLists: fullCodeLists });
    assertOrder(emittedChildren(xml, 'inv', 'invoiceHeader'), xsdSequence('invoice.xsd', 'invoiceHeaderType'));
    assertOrder(emittedChildren(xml, 'inv', 'invoiceItem'), xsdSequence('invoice.xsd', 'invoiceItemType'));
    // Text zápisu si píše účtovník; názov predkontácie je až náhrada.
    expect(xml).toContain('<inv:text>N&#225;kup PHM benz&#237;n EVO 95</inv:text>');
    expect(xml).toContain('<inv:centre><typ:ids>501998</typ:ids></inv:centre>');
    expect(xml).toContain('<inv:activity><typ:ids>211200</typ:ids></inv:activity>');
    expect(xml).toContain('<inv:contract><typ:ids>ZK-2026/014</typ:ids></inv:contract>');
    // Členenie KV z položky prebíja hlavičku.
    expect(xml).toContain('<inv:classificationKVDPH><typ:ids>A1</typ:ids></inv:classificationKVDPH>');
  });

  it('pokladničný doklad a interný doklad sedia so schémou', () => {
    const voucher = invoiceDocument({ textPolozky: 'Nákup PHM', polozky: [polozka] });
    voucher.snapshot.typ = 'PD';
    voucher.snapshot.extracted.variabilnySymbol = '13507';
    voucher.snapshot.ucto = { ...voucher.snapshot.ucto, ...analytics, pokladnaKod: 'HP1', pokladnaTyp: 'expense' };
    const voucherXml = buildServerDataPack({ id: 'pack-order-2', ico: '35761571', documents: [voucher], codeLists: fullCodeLists });
    assertOrder(emittedChildren(voucherXml, 'vch', 'voucherHeader'), xsdSequence('voucher.xsd', 'voucherHeaderType'));
    assertOrder(emittedChildren(voucherXml, 'vch', 'voucherItem'), xsdSequence('voucher.xsd', 'voucherItemType'));
    expect(voucherXml).toContain('<vch:symPar>13507</vch:symPar>');

    const intDoc = invoiceDocument({ textPolozky: 'Mzdy 06/2026', polozky: [polozka] });
    intDoc.snapshot.typ = 'MZDY';
    intDoc.snapshot.ucto = { ...intDoc.snapshot.ucto, ...analytics };
    const intXml = buildServerDataPack({ id: 'pack-order-3', ico: '35761571', documents: [intDoc], codeLists: fullCodeLists });
    assertOrder(emittedChildren(intXml, 'int', 'intDocHeader'), xsdSequence('intDoc.xsd', 'intDocHeaderType'));
    assertOrder(emittedChildren(intXml, 'int', 'intDocItem'), xsdSequence('intDoc.xsd', 'intDocItemType'));
  });
});

describe('buildServerDataPack — bankový výpis (bnk:bank)', () => {
  const bankCodeLists: PohodaCodeLookup = {
    ...codeLists,
    predkontacie: new Map([['p1', '518/321'], ['p2', 'Uhrada FP-tuz.']]),
  };

  function bankDocument(extra: Record<string, unknown> = {}, ucto: Record<string, string | undefined> = {}) {
    return {
      id: 'doc-bv',
      snapshot: {
        version: 2,
        typ: 'BV',
        extracted: {
          dodavatel: { nazov: 'UniCredit Bank', iban: 'SK0911110000001522620009' },
          cisloFaktury: 'SK09...-101-260528',
          cisloVypisu: '101',
          datumVystavenia: '2026-05-28',
          mena: 'EUR',
          rozpisDph: [],
          sumaSpolu: 22486.43,
          polozky: [
            {
              id: 'm1', popis: 'Dan z financnych transakcii', sumaSpolu: -0.2,
              datumPlatby: '2026-05-26', ucto: { predkontaciaId: 'p1' },
            },
            {
              id: 'm2', popis: 'Uhrada FV c. 260504300086, stahovanie', sumaSpolu: 9177.5,
              datumPlatby: '2026-05-26', vs: '260504300086', ks: '0308',
              protistrana: 'SAMSUNG Electronics Slovakia s.r.o.',
              protiucetIban: 'SK0581300000002004860007',
              ucto: { predkontaciaId: 'p2' },
            },
          ],
          ...extra,
        },
        ucto: { bankUcetKod: 'PB', ...ucto },
      },
    };
  }

  it('jeden pohyb = jeden bnk:bank so smerom podľa znamienka a poradie sedí s bank.xsd', () => {
    const xml = buildServerDataPack({ id: 'pack-bv', ico: '35761571', documents: [bankDocument()], codeLists: bankCodeLists });
    expect(xml.match(/<bnk:bank version="2.0">/g)).toHaveLength(2);
    expect(xml).toContain('<dat:dataPackItem id="doc-bv-p1" version="2.0">');
    expect(xml).toContain('<dat:dataPackItem id="doc-bv-p2" version="2.0">');
    // Výdaj zo záporného pohybu, príjem z kladného; suma vždy kladná.
    expect(xml).toContain('<bnk:bankType>expense</bnk:bankType>');
    expect(xml).toContain('<bnk:bankType>receipt</bnk:bankType>');
    expect(xml).toContain('<typ:priceNone>0.20</typ:priceNone>');
    expect(xml).toContain('<typ:priceNone>9177.50</typ:priceNone>');
    expect(xml).toContain('<bnk:account><typ:ids>PB</typ:ids></bnk:account>');
    expect(xml).toContain('<bnk:statementNumber><bnk:statementNumber>101</bnk:statementNumber><bnk:numberMovement>2</bnk:numberMovement></bnk:statementNumber>');
    expect(xml).toContain('<bnk:symVar>260504300086</bnk:symVar>');
    expect(xml).toContain('<bnk:symConst>0308</bnk:symConst>');
    expect(xml).toContain('<bnk:accounting><typ:ids>Uhrada FP-tuz.</typ:ids></bnk:accounting>');
    expect(xml).toContain('<bnk:paymentAccount><typ:accountNo>2004860007</typ:accountNo><typ:bankCode>8130</typ:bankCode></bnk:paymentAccount>');
    expect(xml).toContain('xmlns:bnk="http://www.stormware.cz/schema/version_2/bank.xsd"');
    // emittedChildren vidí aj vnorené bnk:* elementy zloženého statementNumber —
    // vnútorné (numberMovement + duplicitný statementNumber) sa z poradia vynechajú.
    const emitted = [...new Set(emittedChildren(xml, 'bnk', 'bankHeader').filter((name) => name !== 'numberMovement'))];
    assertOrder(emitted, xsdSequence('bank.xsd', 'bankHeaderType'));
  });

  it('pohyb bez vlastnej predkontácie dedí hlavičkovú; bez akejkoľvek export padá', () => {
    const zdedene = bankDocument({
      polozky: [{ id: 'm1', popis: 'Poplatok', sumaSpolu: -1 }],
    }, { predkontaciaId: 'p1' });
    const xml = buildServerDataPack({ id: 'pack-bv-2', ico: '35761571', documents: [zdedene], codeLists: bankCodeLists });
    expect(xml).toContain('<bnk:accounting><typ:ids>518/321</typ:ids></bnk:accounting>');

    const bezPredkontacie = bankDocument({ polozky: [{ id: 'm1', popis: 'Poplatok', sumaSpolu: -1 }] });
    expect(() => buildServerDataPack({ id: 'pack-bv-3', ico: '35761571', documents: [bezPredkontacie], codeLists: bankCodeLists }))
      .toThrow(/nemá predkontáciu/);
  });

  it('bez účtu POHODY alebo pri devízovej mene export padá s jasnou chybou', () => {
    expect(() => buildServerDataPack({ id: 'pack-bv-4', ico: '35761571', documents: [bankDocument({}, { bankUcetKod: undefined })], codeLists: bankCodeLists }))
      .toThrow(/nemá nastavený účet POHODY/);
    expect(() => buildServerDataPack({ id: 'pack-bv-5', ico: '35761571', documents: [bankDocument({ mena: 'USD' })], codeLists: bankCodeLists }))
      .toThrow(/devízových výpisov/);
  });

  it('pohyb bez sumy alebo s nerozpoznanou predkontáciou export zastaví', () => {
    // Pohyb bez sumy nesmie prekĺznuť ako príjem 0,00.
    const bezSumy = bankDocument({
      polozky: [{ id: 'm1', popis: 'Bez sumy', ucto: { predkontaciaId: 'p1' } }],
    });
    expect(() => buildServerDataPack({ id: 'pack-bv-6', ico: '35761571', documents: [bezSumy], codeLists: bankCodeLists }))
      .toThrow(/nemá platnú sumu/);
    // Predkontácia pohybu mimo aktívneho číselníka nesmie potichu spadnúť
    // na hlavičkovú — zaúčtovalo by sa inam, než účtovník schválil.
    const nerozpoznana = bankDocument({
      polozky: [{ id: 'm1', popis: 'Poplatok', sumaSpolu: -1, ucto: { predkontaciaId: 'zmazana-predkontacia' } }],
    }, { predkontaciaId: 'p1' });
    expect(() => buildServerDataPack({ id: 'pack-bv-7', ico: '35761571', documents: [nerozpoznana], codeLists: bankCodeLists }))
      .toThrow(/mimo aktívneho číselníka/);
  });
});

// Testy XML POHODA dataPack — SPEC §7.
import { describe, expect, it } from 'vitest';
import {
  buildDataPack,
  buildExportFileName,
  escapeXml,
  formatXmlAmount,
  mapInvoiceType,
  summarizeVat,
} from './pohodaDataPack';
import type { CodeListItem, DocumentItem, Organization } from '../types';

const ORG: Organization = {
  id: 'org-1',
  tenantId: 'tenant-demo',
  nazov: 'Alfa Trade s.r.o.',
  ico: '36123456',
  dic: '2021234567',
  icDph: 'SK2021234567',
  emailAlias: 'alfa-trade-k7m4q2@doklady.dokladorpro.sk',
  farba: '#0E7A5F',
};

const CODE_LISTS = {
  predkontacie: [{ id: 'pk-1', tenantId: 'tenant-demo', kod: '518/321', nazov: 'Služby', orgId: 'org-1', source: 'manual', active: true }] as CodeListItem[],
  cleneniaDph: [{ id: 'cd-1', tenantId: 'tenant-demo', kod: 'PD', nazov: 'Tuzemské plnenie', orgId: 'org-1', source: 'manual', active: true }] as CodeListItem[],
  ciselneRady: [{ id: 'cr-1', tenantId: 'tenant-demo', kod: '26FP', nazov: 'Faktúry prijaté', orgId: 'org-1', source: 'manual', active: true }] as CodeListItem[],
};

function mkDoc(overrides: Partial<DocumentItem> = {}): DocumentItem {
  return {
    id: 'doc-1',
    tenantId: 'tenant-demo',
    orgId: 'org-1',
    typ: 'FP',
    status: 'schvaleny',
    processingStatus: 'ready_for_review',
    pdfUrl: '/samples/a.pdf',
    prijateDna: '2026-07-01T10:00:00.000Z',
    zdroj: { typ: 'email' },
    confidence: 0.95,
    extracted: {
      dodavatel: {
        nazov: 'Slovak Telekom, a.s.',
        ico: '35763469',
        dic: '2020273893',
        iban: 'SK6511000000002628004523',
      },
      cisloFaktury: '8412345601',
      variabilnySymbol: '8412345601',
      datumVystavenia: '2026-06-28',
      datumSplatnosti: '2026-07-12',
      datumDodania: '2026-06-28',
      mena: 'EUR',
      rozpisDph: [{ sadzba: 23, zaklad: 100, dph: 23 }],
      sumaSpolu: 123,
    },
    ucto: { predkontaciaId: 'pk-1', clenenieDphId: 'cd-1', ciselnyRadId: 'cr-1' },
    history: [],
    comments: [],
    version: 1,
    ...overrides,
  } as DocumentItem;
}

// Zhoda so serverom (server/pohodaXml.test.ts, „položka len s celkovou sumou").
// Pokuta nemá ani sadzbu, ani základ — položka nesie len popis a sumaSpolu.
// Základ sa bral ako `eff.bezDph ?? 0`, takže do XML odišlo price 0,00
// a doklad sa v POHODE zaúčtoval nulový (POHODA berie cenu z price + priceVAT,
// priceSum je len kontrolný súčet).
describe('buildDataPack — položka len s celkovou sumou', () => {
  it('celá suma ide do ceny, nie do nuly', () => {
    const doc = mkDoc({
      typ: 'OZ',
      extracted: {
        ...mkDoc().extracted,
        rozpisDph: [{ sadzba: 0, zaklad: 62.65, dph: 0 }],
        sumaSpolu: 62.65,
        polozky: [{ id: 'li-0', popis: 'Verb 4E00009718 Nedelcu (Tir europa) a.e.', sumaSpolu: 62.65 }],
      },
    } as Partial<DocumentItem>);
    const xml = buildDataPack(ORG, [doc], CODE_LISTS);
    expect(xml).toContain('<typ:price>62.65</typ:price>');
    expect(xml).toContain('<typ:priceSum>62.65</typ:priceSum>');
    expect(xml).not.toContain('<typ:price>0.00</typ:price>');
  });
});

describe('escapeXml', () => {
  it('escapuje XML špeciálne znaky', () => {
    expect(escapeXml('<a & "b" \'c\'>')).toBe('&lt;a &amp; &quot;b&quot; &apos;c&apos;&gt;');
  });

  it('kóduje ne-ASCII znaky ako numerické entity (bezpečné pre Windows-1250)', () => {
    const out = escapeXml('Kancelária š');
    expect(out).not.toMatch(/[áš]/);
    expect(out).toContain('&#xE1;'); // á
    expect(out).toContain('&#x161;'); // š
  });

  it('kóduje Unicode mimo BMP ako jednu platnú numeric entity', () => {
    expect(escapeXml('Doklad 😀')).toBe('Doklad &#x1F600;');
  });

  it('necháva bežné ASCII bez zmeny', () => {
    expect(escapeXml('Faktura 123-ABC')).toBe('Faktura 123-ABC');
  });
});

describe('formatXmlAmount', () => {
  it('formátuje s bodkou a 2 desatinnými miestami (SPEC §7)', () => {
    expect(formatXmlAmount(1234.5)).toBe('1234.50');
    expect(formatXmlAmount(0)).toBe('0.00');
    expect(formatXmlAmount(10.005)).toBe('10.01');
  });
});

describe('mapInvoiceType', () => {
  it('FP → receivedInvoice, FV → issuedInvoice', () => {
    expect(mapInvoiceType('FP')).toBe('receivedInvoice');
    expect(mapInvoiceType('FV')).toBe('issuedInvoice');
  });

  it('OZ mapuje na ostatný záväzok; PD používa samostatnú voucher agendu', () => {
    expect(mapInvoiceType('OZ')).toBe('commitment');
    expect(() => mapInvoiceType('PD')).toThrow();
  });

  it('BV a MZDY vyhodia chybu — neexportujú sa (SPEC §7)', () => {
    expect(() => mapInvoiceType('BV')).toThrow();
    expect(() => mapInvoiceType('MZDY')).toThrow();
  });
});

describe('summarizeVat', () => {
  it('zoskupí riadky podľa sadzieb', () => {
    const t = summarizeVat([
      { sadzba: 23, zaklad: 100, dph: 23 },
      { sadzba: 23, zaklad: 50, dph: 11.5 },
      { sadzba: 19, zaklad: 200, dph: 38 },
      { sadzba: 5, zaklad: 40, dph: 2 },
      { sadzba: 0, zaklad: 10, dph: 0 },
    ]);
    expect(t.zakladHigh).toBe(150);
    expect(t.dphHigh).toBe(34.5);
    expect(t.zakladLow).toBe(200);
    expect(t.dphLow).toBe(38);
    expect(t.zakladThird).toBe(40);
    expect(t.dphThird).toBe(2);
    expect(t.zakladNone).toBe(10);
  });

  // Rakúska faktúra (20 %) nepatrí do žiadneho slovenského koša. Daň sa
  // predtým zahodila a doklad odchádzal do POHODY nižší o ňu.
  it('cudzia sadzba ide celá do nezdaniteľnej sumy', () => {
    const t = summarizeVat([{ sadzba: 20, zaklad: 89, dph: 17.8 }]);
    expect(t.zakladNone).toBe(106.8);
    expect(t.zakladHigh).toBe(0);
  });

  // Zhoda so serverom (server/pohodaXml.test.ts, R2): kôš určuje dátum plnenia.
  it('v roku 2024 je 20 % základná a 10 % znížená sadzba; 23 % vtedy neexistovalo', () => {
    const t = summarizeVat([
      { sadzba: 20, zaklad: 100, dph: 20 },
      { sadzba: 10, zaklad: 50, dph: 5 },
      { sadzba: 23, zaklad: 10, dph: 2.3 },
    ], '2024-12-01');
    expect(t.zakladHigh).toBe(100);
    expect(t.dphHigh).toBe(20);
    expect(t.zakladLow).toBe(50);
    expect(t.dphLow).toBe(5);
    expect(t.zakladNone).toBe(12.3);
  });
});

describe('buildDataPack — slovenská sadzba DPH podľa dátumu plnenia', () => {
  const doklad2024 = (dodavatel = mkDoc().extracted.dodavatel) => mkDoc({
    extracted: {
      ...mkDoc().extracted, dodavatel, datumVystavenia: '2024-12-01', datumDodania: '2024-12-01',
      rozpisDph: [{ sadzba: 20, zaklad: 100, dph: 20 }], sumaSpolu: 120,
      polozky: [{ id: 'li-1', popis: 'Služba', mnozstvo: 1, sadzbaDph: 20, sumaBezDph: 100, sumaDph: 20, sumaSpolu: 120 }],
    },
  } as Partial<DocumentItem>);

  it('20 % v roku 2024 ide do základnej sadzby, nie do nezdaniteľnej sumy', () => {
    const xml = buildDataPack(ORG, [doklad2024()], CODE_LISTS);
    expect(xml).toContain('<inv:rateVAT>high</inv:rateVAT>');
    expect(xml).toContain('<typ:priceVAT>20.00</typ:priceVAT>');
    expect(xml).toContain('<typ:priceHigh>100.00</typ:priceHigh>');
    expect(xml).toContain('<typ:priceHighVAT>20.00</typ:priceHighVAT>');
    expect(xml).toContain('<typ:priceNone>0.00</typ:priceNone>');
  });

  it('zahraničný dodávateľ s 20 % ostáva cudzia daň', () => {
    const xml = buildDataPack(ORG, [doklad2024({ nazov: 'ASFINAG', icDph: 'ATU12345678', krajina: 'AT' })], CODE_LISTS);
    expect(xml).toContain('<inv:rateVAT>none</inv:rateVAT>');
    expect(xml).toContain('<typ:priceNone>120.00</typ:priceNone>');
  });

  // Zhoda so serverom (server/pohodaPodtyp.test.ts): dobropis z roku 2025
  // s 20 % opravuje staršie obdobie — nesmie potichu skončiť v priceNone.
  it('dobropis so sadzbou zo staršieho obdobia export zastaví', () => {
    const dobropis = mkDoc({
      podtyp: 'dobropis',
      extracted: { ...doklad2024().extracted, datumVystavenia: '2025-02-10', datumDodania: '2025-02-10' },
    } as Partial<DocumentItem>);
    expect(() => buildDataPack(ORG, [dobropis], CODE_LISTS)).toThrow(/predchádzajúceho obdobia DPH/);
    // Rakúske IČ DPH bez krajiny: 20 % je daň dodávateľa, nie stará slovenská sadzba.
    const bezKrajiny = mkDoc({
      podtyp: 'dobropis',
      extracted: { ...doklad2024({ nazov: 'ASFINAG', icDph: 'ATU12345678' }).extracted, datumVystavenia: '2026-03-10', datumDodania: '2026-03-10' },
    } as Partial<DocumentItem>);
    expect(buildDataPack(ORG, [bezKrajiny], CODE_LISTS)).toContain('<typ:priceNone>120.00</typ:priceNone>');
  });
});

describe('buildDataPack — číselník položky mimo exportu', () => {
  // Zhoda so serverom (R3): neznáme ID položky nesmie potichu zdediť hlavičku.
  it('neznáma predkontácia položky export zastaví', () => {
    const doc = mkDoc();
    doc.extracted.polozky = [{
      id: 'li-1', popis: 'Služba', mnozstvo: 1, sadzbaDph: 23, sumaBezDph: 100, sumaDph: 23, sumaSpolu: 123,
      ucto: { predkontaciaId: 'zmazana' },
    }];
    expect(() => buildDataPack(ORG, [doc], CODE_LISTS)).toThrow(/Položka 1 dokladu doc-1 .*mimo aktívneho číselníka/);
  });
});

describe('buildDataPack', () => {
  it('obsahuje deklaráciu, dataPack atribúty a namespace-y (SPEC §7)', () => {
    const xml = buildDataPack(ORG, [mkDoc()], CODE_LISTS, 'Export001');
    expect(xml.startsWith('<?xml version="1.0" encoding="Windows-1250"?>')).toBe(true);
    expect(xml).toContain('ico="36123456"');
    expect(xml).toContain('id="Export001"');
    expect(xml).toContain('application="Dokladovka"');
    expect(xml).toContain('xmlns:dat="http://www.stormware.cz/schema/version_2/data.xsd"');
    expect(xml).toContain('xmlns:inv="http://www.stormware.cz/schema/version_2/invoice.xsd"');
    expect(xml).toContain('xmlns:typ="http://www.stormware.cz/schema/version_2/type.xsd"');
  });

  it('mapuje hlavičku dokladu: typ, symVar, dátumy, predkontáciu, členenie', () => {
    const xml = buildDataPack(ORG, [mkDoc()], CODE_LISTS);
    expect(xml).toContain('<inv:invoiceType>receivedInvoice</inv:invoiceType>');
    expect(xml).toContain('<inv:symVar>8412345601</inv:symVar>');
    expect(xml).toContain('<inv:date>2026-06-28</inv:date>');
    expect(xml).toContain('<inv:dateTax>2026-06-28</inv:dateTax>');
    expect(xml).toContain('<inv:dateDue>2026-07-12</inv:dateDue>');
    expect(xml).toContain('<inv:accounting><typ:ids>518/321</typ:ids></inv:accounting>');
    expect(xml).toContain('<inv:classificationVAT><typ:ids>PD</typ:ids></inv:classificationVAT>');
    expect(xml).toContain('<typ:ico>35763469</typ:ico>');
  });

  it('dateTax padá na dátum vystavenia, ak DUZP chýba', () => {
    const doc = mkDoc();
    doc.extracted.datumDodania = undefined;
    const xml = buildDataPack(ORG, [doc], CODE_LISTS);
    expect(xml).toContain('<inv:dateTax>2026-06-28</inv:dateTax>');
  });

  it('sumarizuje DPH do priceHigh/priceLow/priceNone s bodkou a 2 miestami', () => {
    const doc = mkDoc();
    doc.extracted.rozpisDph = [
      { sadzba: 23, zaklad: 100, dph: 23 },
      { sadzba: 19, zaklad: 200, dph: 38 },
      { sadzba: 0, zaklad: 10, dph: 0 },
    ];
    const xml = buildDataPack(ORG, [doc], CODE_LISTS);
    expect(xml).toContain('<typ:priceHigh>100.00</typ:priceHigh>');
    expect(xml).toContain('<typ:priceHighVAT>23.00</typ:priceHighVAT>');
    expect(xml).toContain('<typ:priceLow>200.00</typ:priceLow>');
    expect(xml).toContain('<typ:priceLowVAT>38.00</typ:priceLowVAT>');
    expect(xml).toContain('<typ:priceNone>10.00</typ:priceNone>');
  });

  it('tretiu sadzbu 5 % emituje cez oficiálne price3 polia', () => {
    const withFive = mkDoc();
    withFive.extracted.rozpisDph = [{ sadzba: 5, zaklad: 40, dph: 2 }];
    const xml5 = buildDataPack(ORG, [withFive], CODE_LISTS);
    expect(xml5).toContain('<typ:price3>40.00</typ:price3>');
    expect(xml5).toContain('<typ:price3VAT>2.00</typ:price3VAT>');

    const without = buildDataPack(ORG, [mkDoc()], CODE_LISTS);
    expect(without).toContain('<typ:price3>0.00</typ:price3>');
  });

  it('escapuje názov dodávateľa so špeciálnymi znakmi a diakritikou', () => {
    const doc = mkDoc();
    doc.extracted.dodavatel.nazov = 'METRO Cash & Carry <SR> š';
    const xml = buildDataPack(ORG, [doc], CODE_LISTS);
    expect(xml).toContain('METRO Cash &amp; Carry &lt;SR&gt; &#x161;');
    expect(xml).not.toContain('& Carry <SR>');
  });

  it('výsledok je čisté ASCII (žiadna surová diakritika)', () => {
    const doc = mkDoc();
    doc.extracted.dodavatel.nazov = 'Kancelárske potreby, š.p.';
    const xml = buildDataPack(ORG, [doc], CODE_LISTS);
    // eslint-disable-next-line no-control-regex
    expect(/^[\x00-\x7F]*$/.test(xml)).toBe(true);
  });

  it('FV sa exportuje ako issuedInvoice', () => {
    const xml = buildDataPack(ORG, [mkDoc({ typ: 'FV' })], CODE_LISTS);
    expect(xml).toContain('<inv:invoiceType>issuedInvoice</inv:invoiceType>');
  });

  it('OZ exportuje ako commitment a rozloží slovenský IBAN na účet a kód banky', () => {
    const xml = buildDataPack(ORG, [mkDoc({ typ: 'OZ' })], CODE_LISTS);
    expect(xml).toContain('<inv:invoiceType>commitment</inv:invoiceType>');
    expect(xml).toContain('<typ:accountNo>2628004523</typ:accountNo>');
    expect(xml).toContain('<typ:bankCode>1100</typ:bankCode>');
  });

  it('PD exportuje ako voucher až po ľudskom výbere pokladne a smeru', () => {
    const xml = buildDataPack(ORG, [mkDoc({ typ: 'PD', ucto: { predkontaciaId: 'pk-1', clenenieDphId: 'cd-1', ciselnyRadId: 'cr-1', pokladnaKod: 'EUR', pokladnaTyp: 'expense' } })], CODE_LISTS);
    expect(xml).toContain('<vch:voucher version="2.0">');
    expect(xml).toContain('<vch:voucherType>expense</vch:voucherType>');
    expect(xml).toContain('<vch:cashAccount><typ:ids>EUR</typ:ids></vch:cashAccount>');
    expect(() => buildDataPack(ORG, [mkDoc({ typ: 'PD' })], CODE_LISTS)).toThrow(/kód a typ/);
  });

  it('vyhodí chybu pre BV/MZDY v exporte', () => {
    expect(() => buildDataPack(ORG, [mkDoc({ typ: 'BV' })], CODE_LISTS)).toThrow(/camt\.053/);
    expect(() => buildDataPack(ORG, [mkDoc({ typ: 'MZDY' })], CODE_LISTS)).toThrow();
  });

  it('vyhodí chybu pri miešaní organizácií (SPEC §11.24)', () => {
    expect(() => buildDataPack(ORG, [mkDoc({ orgId: 'org-2' })], CODE_LISTS)).toThrow(/organizáci/);
  });

  it('nepoužije tichý fallback, ak číselný rad chýba alebo nie je aktívny', () => {
    expect(() =>
      buildDataPack(
        ORG,
        [mkDoc({ ucto: { predkontaciaId: 'pk-1', clenenieDphId: 'cd-1' } })],
        CODE_LISTS,
      ),
    ).toThrow(/aktívny číselný rad/);

    const inactiveLists = {
      ...CODE_LISTS,
      ciselneRady: CODE_LISTS.ciselneRady.map((item) => ({ ...item, active: false })),
    };
    expect(() => buildDataPack(ORG, [mkDoc()], inactiveLists)).toThrow(
      /aktívny číselný rad/,
    );
  });

  it('vytvorí dataPackItem pre každý doklad', () => {
    const xml = buildDataPack(ORG, [mkDoc(), mkDoc({ id: 'doc-2' })], CODE_LISTS);
    expect(xml.match(/<dat:dataPackItem /g)).toHaveLength(2);
    expect(xml.match(/<\/dat:dataPackItem>/g)).toHaveLength(2);
  });

  it('má vyvážené otváracie/zatváracie tagy (well-formed sanity check)', () => {
    const xml = buildDataPack(ORG, [mkDoc()], CODE_LISTS);
    for (const tag of ['dat:dataPack', 'dat:dataPackItem', 'inv:invoice', 'inv:invoiceHeader', 'inv:invoiceSummary', 'inv:homeCurrency', 'typ:address']) {
      const open = xml.match(new RegExp(`<${tag}[ >]`, 'g'))?.length ?? 0;
      const close = xml.match(new RegExp(`</${tag}>`, 'g'))?.length ?? 0;
      expect(open, tag).toBe(close);
    }
  });
});

describe('buildDataPack — krajina a rozpis na položky', () => {
  const STREDISKA = [{ id: 'st-1', tenantId: 'tenant-demo', kod: 'CENTRALA', nazov: 'Centrála', orgId: 'org-1', source: 'manual', active: true }] as CodeListItem[];
  const CODE_LISTS_S = { ...CODE_LISTS, strediska: STREDISKA };

  it('slovenský dodávateľ dostane krajinu SK z prefixu IČ DPH', () => {
    const doc = mkDoc();
    doc.extracted.dodavatel.icDph = 'SK2020273893';
    const xml = buildDataPack(ORG, [doc], CODE_LISTS);
    expect(xml).toContain('<typ:country><typ:ids>SK</typ:ids></typ:country>');
  });

  it('ručne upravené časti adresy prebijú voľnú adresu aj odvodenú krajinu', () => {
    const doc = mkDoc();
    doc.extracted.dodavatel.icDph = 'SK2020273893';
    doc.extracted.dodavatel.adresa = 'Riazanská 62, 811 01 Bratislava';
    // Vymazaná ulica (prázdny reťazec) sa nesmie doplniť späť z voľnej adresy.
    Object.assign(doc.extracted.dodavatel, { ulica: '', psc: '900 27', obec: 'Bernolakovo', krajina: 'CZ' });
    const xml = buildDataPack(ORG, [doc], CODE_LISTS);
    expect(xml).not.toContain('<typ:street>');
    expect(xml).toContain('<typ:zip>900 27</typ:zip>');
    expect(xml).toContain('<typ:city>Bernolakovo</typ:city>');
    expect(xml).toContain('<typ:country><typ:ids>CZ</typ:ids></typ:country>');
  });

  it('doklad bez položiek nemá invoiceDetail', () => {
    const xml = buildDataPack(ORG, [mkDoc()], CODE_LISTS_S);
    expect(xml).not.toContain('<inv:invoiceDetail>');
  });

  it('položky sa importujú s DPH, jednotkou, počtom a pozičným zaúčtovaním', () => {
    const doc = mkDoc();
    doc.ucto.clenenieKvKod = 'B2';
    doc.extracted.polozky = [
      {
        id: 'li-1', popis: 'Baliaci material', mnozstvo: 2, jednotka: 'ks', sadzbaDph: 23,
        jednotkovaCenaBezDph: 35, sumaBezDph: 70, sumaDph: 16.1, sumaSpolu: 86.1,
        ucto: { strediskoId: 'st-1' },
      },
    ];
    const xml = buildDataPack(ORG, [doc], CODE_LISTS_S);
    expect(xml).toContain('<inv:invoiceDetail>');
    expect(xml).toContain('<inv:text>Baliaci material</inv:text>');
    expect(xml).toContain('<inv:quantity>2</inv:quantity>');
    expect(xml).toContain('<inv:unit>ks</inv:unit>');
    expect(xml).toContain('<inv:rateVAT>high</inv:rateVAT>');
    expect(xml).toContain('<typ:unitPrice>35.00</typ:unitPrice>');
    expect(xml).toContain('<typ:price>70.00</typ:price>');
    expect(xml).toContain('<typ:priceVAT>16.10</typ:priceVAT>');
    expect(xml).toContain('<typ:priceSum>86.10</typ:priceSum>');
    // Bez vlastnej predkontácie/členenia sa dedia z hlavičky; KV DPH z hlavičky; stredisko z položky.
    expect(xml).toContain('<inv:accounting><typ:ids>518/321</typ:ids></inv:accounting>');
    expect(xml).toContain('<inv:classificationVAT><typ:ids>PD</typ:ids></inv:classificationVAT>');
    expect(xml).toContain('<inv:classificationKVDPH><typ:ids>B2</typ:ids></inv:classificationKVDPH>');
    expect(xml).toContain('<inv:centre><typ:ids>CENTRALA</typ:ids></inv:centre>');
  });

  it('položky zachovajú vyvážené tagy (well-formed)', () => {
    const doc = mkDoc();
    doc.extracted.polozky = [{ id: 'li-1', popis: 'Služba', mnozstvo: 1, sadzbaDph: 19, sumaBezDph: 100, sumaDph: 19, sumaSpolu: 119 }];
    const xml = buildDataPack(ORG, [doc], CODE_LISTS_S);
    for (const tag of ['inv:invoiceDetail', 'inv:invoiceItem', 'inv:homeCurrency']) {
      const open = xml.match(new RegExp(`<${tag}[ >]`, 'g'))?.length ?? 0;
      const close = xml.match(new RegExp(`</${tag}>`, 'g'))?.length ?? 0;
      expect(open, tag).toBe(close);
    }
    expect(xml).toContain('<inv:rateVAT>low</inv:rateVAT>');
  });
});

describe('buildExportFileName', () => {
  it('generuje pohoda-{orgKod}-{YYYYMMDD-HHmm}.xml (SPEC §6.5)', () => {
    const name = buildExportFileName(ORG, new Date(2026, 6, 10, 14, 5));
    expect(name).toBe('pohoda-alfa-trade-20260710-1405.xml');
  });

  it('odstráni diakritiku a právnu formu z kódu organizácie', () => {
    const org = { ...ORG, nazov: 'Účtovná kancelária, a.s.' };
    const name = buildExportFileName(org, new Date(2026, 0, 1, 0, 0));
    expect(name).toBe('pohoda-uctovna-kancelaria-20260101-0000.xml');
  });
});

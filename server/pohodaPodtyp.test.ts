import { describe, expect, it } from 'vitest';
import { buildServerDataPack, type PohodaCodeLookup } from './pohodaXml.js';

// POHODA nemá pre dobropis vlastnú agendu — má vlastnú hodnotu invoiceType
// (XSD: issuedCreditNotice = Dobropis, issuedDebitNote = Vrubopis/ťarchopis,
// issuedAdvanceInvoice = Zálohová faktúra). Bez dvojice (typ, podtyp) by
// dobropis odišiel ako bežná faktúra: zlý číselný rad aj zlá sekcia KV.
const codeLists: PohodaCodeLookup = {
  predkontacie: new Map([['p1', '518/321']]),
  cleneniaDph: new Map([['c1', 'PD']]),
  ciselneRady: new Map([['r1', '26FP']]),
  strediska: new Map(),
};

const doklad = (typ: string, podtyp?: string) => ({
  id: 'doc-1',
  snapshot: {
    version: 1,
    typ,
    ...(podtyp ? { podtyp } : {}),
    extracted: {
      dodavatel: { nazov: 'Test s.r.o.', ico: '31386946' },
      cisloFaktury: 'FA-1', datumVystavenia: '2026-06-30', datumSplatnosti: '2026-07-14',
      mena: 'EUR', rozpisDph: [{ sadzba: 23, zaklad: 100, dph: 23 }], sumaSpolu: 123,
    },
    ucto: { predkontaciaId: 'p1', clenenieDphId: 'c1', ciselnyRadId: 'r1' },
  },
});

const OCAKAVANE: Array<[string, string | undefined, string]> = [
  ['FP', 'bezna', 'receivedInvoice'],
  ['FP', undefined, 'receivedInvoice'],
  ['FP', 'dobropis', 'receivedCreditNotice'],
  ['FP', 'tarchopis', 'receivedDebitNote'],
  ['FP', 'zalohova', 'receivedAdvanceInvoice'],
  ['FV', 'bezna', 'issuedInvoice'],
  ['FV', 'dobropis', 'issuedCreditNotice'],
  ['FV', 'tarchopis', 'issuedDebitNote'],
  ['FV', 'zalohova', 'issuedAdvanceInvoice'],
];

describe('invoiceType podľa druhu dokladu', () => {
  for (const [typ, podtyp, ocakavany] of OCAKAVANE) {
    it(`${typ} / ${podtyp ?? 'bez podtypu'} → ${ocakavany}`, () => {
      const xml = buildServerDataPack({
        id: 'pack', ico: '35761571', documents: [doklad(typ, podtyp)], codeLists,
      });
      expect(xml).toContain(`<inv:invoiceType>${ocakavany}</inv:invoiceType>`);
    });
  }
});

// Audit R4: zálohová faktúra sa neúčtuje a do DPH nevstupuje — invoice.xsd pri
// classificationVAT výslovne píše, že sa pri zálohovej nepoužíva. Export ju bez
// predkontácie a členenia DPH napriek tomu odmietol, takže prejsť mohla len
// s vymysleným zaúčtovaním.
describe('zálohová faktúra bez zaúčtovania (R4)', () => {
  const sUcto = (typ: string, podtyp: string, ucto: Record<string, string>) => {
    const zaklad = doklad(typ, podtyp);
    return { ...zaklad, snapshot: { ...zaklad.snapshot, ucto } };
  };
  const build = (document: ReturnType<typeof sUcto>) =>
    buildServerDataPack({ id: 'pack', ico: '35761571', documents: [document], codeLists });

  it('prejde bez predkontácie a členenia DPH, číselný rad ostáva', () => {
    const xml = build(sUcto('FP', 'zalohova', { ciselnyRadId: 'r1' }));
    expect(xml).toContain('<inv:invoiceType>receivedAdvanceInvoice</inv:invoiceType>');
    expect(xml).toContain('<inv:number><typ:ids>26FP</typ:ids></inv:number>');
    expect(xml).not.toContain('<inv:accounting>');
    expect(xml).not.toContain('<inv:classificationVAT>');
  });

  it('bez číselného radu padá aj zálohová', () => {
    expect(() => build(sUcto('FV', 'zalohova', {}))).toThrow(/nemá platné aktívne číselníky/);
  });

  it('nastavená, no neplatná predkontácia zálohovej je chyba, nie „bez zaúčtovania"', () => {
    expect(() => build(sUcto('FP', 'zalohova', { ciselnyRadId: 'r1', predkontaciaId: 'zmazana' })))
      .toThrow(/nemá platné aktívne číselníky/);
  });

  it('bežná faktúra bez predkontácie a členenia padá ako doteraz', () => {
    expect(() => build(sUcto('FP', 'bezna', { ciselnyRadId: 'r1' }))).toThrow(/nemá platné aktívne číselníky/);
  });
});

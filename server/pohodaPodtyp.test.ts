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

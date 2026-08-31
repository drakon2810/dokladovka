import { describe, expect, it } from 'vitest';
import { checkApprovable } from './api';
import type { DocumentItem } from './types';
import type { AppDataState } from './store';

// Zálohová faktúra členenie DPH nemá — POHODA ju vedie s predkontáciou „Bez"
// a daňový moment nastane až pri úhrade. Bez výnimky sa nedala schváliť vôbec:
// „Na schválenie ešte treba: vybrať členenie DPH" pri doklade, kde ho niet.
const codeLists = {
  predkontacie: [{ id: 'p1', orgId: 'o1', tenantId: 't1', kod: '314', nazov: 'Preddavky', active: true }],
  cleneniaDph: [{ id: 'c1', orgId: 'o1', tenantId: 't1', kod: 'PN', nazov: 'PN', active: true }],
  ciselneRady: [{ id: 'r1', orgId: 'o1', tenantId: 't1', kod: '2618', nazov: 'Zálohové', active: true }],
  strediska: [], zakazky: [], cinnosti: [], projekty: [], bankoveUcty: [],
} as unknown as AppDataState['codeLists'];

const doklad = (podtyp: string | undefined, clenenieDphId?: string) => ({
  id: 'd1', tenantId: 't1', orgId: 'o1', typ: 'FP', podtyp,
  status: 'na_kontrole', processingStatus: 'ready_for_review',
  ucto: { predkontaciaId: 'p1', ciselnyRadId: 'r1', clenenieDphId },
  extracted: {
    dodavatel: { nazov: 'Dodávateľ s.r.o.' }, odberatel: { nazov: 'ALPINA EST' },
    cisloFaktury: 'ZAL-1', datumVystavenia: '2026-08-01', datumSplatnosti: '2026-08-15',
    rozpisDph: [], sumaSpolu: 100, mena: 'EUR', polozky: [],
  },
  zdroj: {}, confidence: 0.9, fieldConfidence: {},
} as unknown as DocumentItem);

describe('schválenie a členenie DPH', () => {
  it('bežná faktúra bez členenia DPH sa schváliť nedá', () => {
    expect(checkApprovable(doklad('bezna'), codeLists).chybajuceUcto).toContain('clenenieDph');
  });

  it('zálohová faktúra ho nepotrebuje', () => {
    expect(checkApprovable(doklad('zalohova'), codeLists).chybajuceUcto).not.toContain('clenenieDph');
  });

  it('dobropis ho potrebuje — oprava základu dane do výkazu vstupuje', () => {
    expect(checkApprovable(doklad('dobropis'), codeLists).chybajuceUcto).toContain('clenenieDph');
  });

  it('doklad bez podtypu sa správa ako bežný', () => {
    expect(checkApprovable(doklad(undefined), codeLists).chybajuceUcto).toContain('clenenieDph');
  });

  it('vyplnené členenie prejde vždy', () => {
    expect(checkApprovable(doklad('bezna', 'c1'), codeLists).chybajuceUcto).not.toContain('clenenieDph');
  });
});

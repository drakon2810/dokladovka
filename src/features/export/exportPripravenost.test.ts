import { describe, expect, it } from 'vitest';
import { exportUnavailableReason } from './ExportPage';

// Zálohovú faktúru schválenie pustí len s radom. Export ju s tým istým
// zaúčtovaním hlásil ako nekompletnú, takže sa z UI nedala odoslať.
const codeLists = {
  predkontacie: [], cleneniaDph: [],
  ciselneRady: [{ id: 'r1', tenantId: 't1', orgId: 'o1', active: true, kod: '2618', nazov: 'Zálohové' }],
} as never;
const doklad = (podtyp: string) =>
  ({ typ: 'FP', podtyp, tenantId: 't1', orgId: 'o1', ucto: { ciselnyRadId: 'r1' }, extracted: {} }) as never;

describe('pripravenosť na export', () => {
  it('zálohová faktúra s radom je pripravená, bežná bez účtovania nie', () => {
    expect(exportUnavailableReason(doklad('zalohova'), codeLists)).toBeUndefined();
    expect(exportUnavailableReason(doklad('bezna'), codeLists)).toBe('ucto-nekompletne');
  });
});

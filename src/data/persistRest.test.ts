import { describe, expect, it } from 'vitest';
import { persistovanyStavRest, useAppStore } from './store';

// Do localStorage sa ukladal CELÝ snapshot tenanta. Pri účte so siedmimi
// firmami to sú megabajty a Safari na iPhone má na doménu asi 5 MB: zápis
// spadol na „The quota has been exceeded" priamo pri načítaní dát a telefón
// ostal bez firiem. Na počítači je limit väčší, takže sa to tam neprejavilo.
describe('čo sa v serverovom režime ukladá do prehliadača', () => {
  it('len filter firmy a rola — nikdy nie dáta', () => {
    const stav = useAppStore.getState();
    const ulozene = persistovanyStavRest({ ...stav, currentOrgId: 'org-1', role: 'uctovnik' });

    expect(Object.keys(ulozene).sort()).toEqual(['currentOrgId', 'role']);
    expect(ulozene.currentOrgId).toBe('org-1');
    expect(ulozene.role).toBe('uctovnik');
  });

  it('veľkosť uloženého nerastie s množstvom dokladov', () => {
    const stav = useAppStore.getState();
    const sDokladmi = {
      ...stav,
      // Tisíc dokladov je bežná firma za rok; práve na tomto to padalo.
      documents: Array.from({ length: 1000 }, (_, index) => ({
        id: `d${index}`, popis: 'x'.repeat(200),
      })) as never,
    };
    expect(JSON.stringify(persistovanyStavRest(sDokladmi)).length).toBeLessThan(200);
  });
});

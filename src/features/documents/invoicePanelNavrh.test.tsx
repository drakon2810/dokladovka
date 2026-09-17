// @vitest-environment happy-dom
// Tlačidlo „Automatické účtovanie" pri návrhu BEZ účtu v hlavičke. O2 SLOVAKIA
// má u ROFY 9 dokladov a dve rovnaké, takže jeden účet v hlavičke právom nemá —
// tlačidlo sa viazalo na predkontáciu návrhu a pre tohto dodávateľa tak bolo
// vypnuté navždy, hoci členenie DPH aj účty položiek návrh vedel. A keď sa už
// zapne, nesmie zmazať účet, ktorý si účtovník dovtedy vypísal.
import { act } from 'react-dom/test-utils';
import { createRoot } from 'react-dom/client';
import { describe, expect, it, vi } from 'vitest';
import type { AccountingSuggestion } from '../../data/types';

(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock('../../data/api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../data/api')>()),
  getCachedSnapshot: () => ({ organizations: [{ id: 'org-1', ico: '12345678', icDph: 'SK2020123456' }] }),
}));

const { InvoicePanel } = await import('./InvoicePanel');

const BEZ_CISELNIKOV = { predkontacie: [], cleneniaDph: [], strediska: [], cinnosti: [], zakazky: [], ciselneRady: [] };

const navrh = (cast: Partial<AccountingSuggestion>): AccountingSuggestion => ({
  tenantId: 't1', organizationId: 'org-1', documentId: 'd1',
  source: 'decision_memory', confidence: 0.88, reason: 'Návrh z pamäte.', createdAt: '2026-09-01T00:00:00.000Z',
  ...cast,
});

async function panel(suggestion?: AccountingSuggestion) {
  const updateUcto = vi.fn();
  const updateExtracted = vi.fn();
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  const draft = {
    id: 'd1', tenantId: 't1', orgId: 'org-1', queueId: 'q1', typ: 'OZ', status: 'na_kontrole',
    processingStatus: 'ready_for_review', pdfUrl: '', prijateDna: '2026-09-01', zdroj: {}, confidence: 1,
    // Účet si účtovník vypísal sám — tlačidlo mu ho nesmie zmazať.
    ucto: { predkontaciaId: 'vlastny-ucet' }, history: [], comments: [], version: 1,
    extracted: {
      dodavatel: { nazov: 'O2 Slovakia', ico: '35848863' }, odberatel: { nazov: '' }, cisloFaktury: '1',
      datumVystavenia: '2026-09-01', mena: 'EUR', rozpisDph: [], sumaSpolu: 10,
      polozky: [{ id: 'p1', popis: 'Poistka' }],
    },
  } as never;
  await act(async () => {
    root.render(
      <InvoicePanel
        draft={draft} readOnly={false} codeLists={BEZ_CISELNIKOV} autoFilled={false} suggestion={suggestion}
        setTyp={() => undefined} updateUcto={updateUcto} updateExtracted={updateExtracted}
        updateParty={() => undefined} updatePartyAddress={() => undefined}
      />,
    );
  });
  const tlacidlo = container.querySelector('.dk-btn-ai') as HTMLButtonElement;
  const klikni = async () => act(async () => { tlacidlo.click(); });
  return { tlacidlo, klikni, updateUcto, updateExtracted, zavri: () => { act(() => root.unmount()); container.remove(); } };
}

describe('InvoicePanel — automatické účtovanie bez účtu v hlavičke', () => {
  it('rozpis po položkách tlačidlo zapne, vyplní položky a účet účtovníka nezmaže', async () => {
    const { tlacidlo, klikni, updateUcto, updateExtracted, zavri } = await panel(navrh({
      clenenieDphId: 'pd', clenenieKvKod: 'B2',
      riadky: [{ index: 0, popis: 'Poistka', predkontaciaId: 'cv', clenenieDphId: 'pn', clenenieKvKod: 'KN' }],
    }));
    expect(tlacidlo.disabled).toBe(false);
    await klikni();
    // Pole, ktoré návrh nemá, sa nemaže — inak by účet z hlavičky zmizol.
    expect(updateUcto).toHaveBeenCalledWith({ clenenieDphId: 'pd', clenenieKvKod: 'B2' });
    expect(updateExtracted).toHaveBeenCalledWith('polozky', [
      { id: 'p1', popis: 'Poistka', ucto: { predkontaciaId: 'cv', clenenieDphId: 'pn', clenenieKvKod: 'KN' } },
    ]);
    zavri();
  });

  it('návrh, ktorý nemá čo vyplniť, tlačidlo nezapne', async () => {
    const prazdny = await panel(navrh({ source: 'none', confidence: 0 }));
    expect(prazdny.tlacidlo.disabled).toBe(true);
    prazdny.zavri();
    const bezNavrhu = await panel();
    expect(bezNavrhu.tlacidlo.disabled).toBe(true);
    bezNavrhu.zavri();
  });
});

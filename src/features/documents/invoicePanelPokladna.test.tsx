// @vitest-environment happy-dom
// Smer pokladne, kým ho doklad nemá: editor ho uloží rovnakým pravidlom ako
// server pri vzniku dokladu — doklad vystavený samotnou firmou je príjem.
// Doteraz doplnil vždy „výdaj", aj pri príjmovom doklade firmy.
import { act } from 'react-dom/test-utils';
import { createRoot } from 'react-dom/client';
import { describe, expect, it, vi } from 'vitest';

(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock('../../data/api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../data/api')>()),
  getCachedSnapshot: () => ({ organizations: [{ id: 'org-1', ico: '12345678', icDph: 'SK2020123456' }] }),
}));

const { InvoicePanel } = await import('./InvoicePanel');

const BEZ_CISELNIKOV = { predkontacie: [], cleneniaDph: [], strediska: [], cinnosti: [], zakazky: [], ciselneRady: [] };

async function ulozenySmer(dodavatel: { ico?: string; icDph?: string }) {
  const updateUcto = vi.fn();
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  const draft = {
    id: 'd1', tenantId: 't1', orgId: 'org-1', queueId: 'q1', typ: 'PD', status: 'na_kontrole', processingStatus: 'ready_for_review',
    pdfUrl: '', prijateDna: '2026-04-30', zdroj: {}, confidence: 1, ucto: {}, history: [], comments: [], version: 1,
    extracted: {
      dodavatel: { nazov: 'Predajca', ...dodavatel }, odberatel: { nazov: '' }, cisloFaktury: '1',
      datumVystavenia: '2026-04-30', mena: 'EUR', rozpisDph: [], sumaSpolu: 10, polozky: [],
    },
  } as never;
  await act(async () => {
    root.render(
      <InvoicePanel
        draft={draft} readOnly={false} codeLists={BEZ_CISELNIKOV} autoFilled={false}
        setTyp={() => undefined} updateUcto={updateUcto} updateExtracted={() => undefined}
        updateParty={() => undefined} updatePartyAddress={() => undefined}
      />,
    );
  });
  act(() => root.unmount());
  container.remove();
  return updateUcto.mock.calls.map(([patch]) => patch.pokladnaTyp).find(Boolean);
}

describe('InvoicePanel — smer pokladničného dokladu', () => {
  it('doklad vystavený firmou je príjem, cudzí výdaj', async () => {
    expect(await ulozenySmer({ ico: '12 345 678' })).toBe('receipt');
    expect(await ulozenySmer({ icDph: 'SK2020123456' })).toBe('receipt');
    expect(await ulozenySmer({ ico: '87654321' })).toBe('expense');
  });
});

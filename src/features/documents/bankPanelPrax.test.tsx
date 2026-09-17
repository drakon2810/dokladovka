// @vitest-environment happy-dom
// Predkontácia pohybu z praxe banky je návrh, nie schválenie: editor ju odlíši
// a ručný výber zdroj praxe zahodí.
import { act } from 'react-dom/test-utils';
import { createRoot } from 'react-dom/client';
import { describe, expect, it, vi } from 'vitest';
import { BankPanel } from './BankPanel';

(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;

const predkontacia = (id: string, kod: string) =>
  ({ id, tenantId: 't1', kod, nazov: kod, orgId: 'org-1', source: 'pohoda' as const, active: true, agenda: 'bankIssued' });

describe('BankPanel — návrh z praxe banky', () => {
  it('pohyb z praxe má prerušovaný okraj a ručná zmena zdroj zahodí', async () => {
    const updateExtracted = vi.fn();
    const container = document.createElement('div');
    document.body.append(container);
    const root = createRoot(container);
    const draft = {
      id: 'd1', tenantId: 't1', orgId: 'org-1', queueId: 'q1', typ: 'BV', status: 'na_kontrole', processingStatus: 'ready_for_review',
      pdfUrl: '', prijateDna: '2026-08-31', zdroj: {}, confidence: 1, ucto: { bankUcetKod: 'TB' }, history: [], comments: [], version: 1,
      extracted: {
        dodavatel: { nazov: 'Banka' }, odberatel: { nazov: '' }, cisloFaktury: 'V-8', datumVystavenia: '2026-08-31', mena: 'EUR',
        rozpisDph: [], sumaSpolu: 0,
        polozky: [
          { id: 'm0', popis: 'Poplatok', sumaSpolu: -3, ucto: { predkontaciaId: 'p1', zdroj: 'banka_prax' } },
          { id: 'm1', popis: 'Nájom', sumaSpolu: -300, ucto: { predkontaciaId: 'p1' } },
        ],
      },
    } as never;
    await act(async () => {
      root.render(
        <BankPanel
          draft={draft} readOnly={false} setTyp={() => undefined} updateUcto={() => undefined} updateExtracted={updateExtracted}
          codeLists={{ predkontacie: [predkontacia('p1', 'Poplatky'), predkontacia('p2', 'Poplatky karta')], bankoveUcty: [] }}
        />,
      );
    });
    const bunky = [...container.querySelectorAll('.dk-bank-row.dk-row-item .dk-pick-btn')];
    expect(bunky.map((bunka) => bunka.classList.contains('dk-cell-navrh'))).toEqual([true, false]);
    expect(bunky[0].getAttribute('title')).toBe('Návrh z praxe banky z denníka — skontrolujte pred schválením');

    await act(async () => { (bunky[0] as HTMLElement).click(); });
    const volba = [...document.querySelectorAll('.dk-pick-opt')].find((option) => option.textContent?.includes('Poplatky karta')) as HTMLElement;
    await act(async () => { volba.click(); });
    expect(updateExtracted).toHaveBeenLastCalledWith('polozky', [
      { id: 'm0', popis: 'Poplatok', sumaSpolu: -3, ucto: { predkontaciaId: 'p2' } },
      { id: 'm1', popis: 'Nájom', sumaSpolu: -300, ucto: { predkontaciaId: 'p1' } },
    ]);
    act(() => root.unmount());
    container.remove();
  });
});

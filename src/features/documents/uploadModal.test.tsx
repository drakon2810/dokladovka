// @vitest-environment happy-dom
// Regresia: súbor pustený na zoznam dokladov ostal navždy na 0 %.
// React v StrictMode komponent v deve mountne dvakrát a medzitým spustí
// cleanup — ten zrušil časovač falošného priebehu, kým strážny ref už bránil
// druhému spusteniu. Upload potom nikto nedokončil.
import { StrictMode } from 'react';
import { act } from 'react-dom/test-utils';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { t } from '../../i18n/sk';

(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;

const uploadDocumentFile = vi.fn();
vi.mock('../../data/api', () => ({ uploadDocumentFile: (...args: unknown[]) => uploadDocumentFile(...args) }));

const { UploadModal } = await import('./UploadModal');

const ORG = [{
  id: 'org-1', nazov: 'Test s.r.o.', tenantId: 't1', ico: '12345678', dic: '',
  farba: '#0E7A5F', emailAlias: 'a@b.sk', archived: false,
}] as never;

let root: Root | undefined;
let container: HTMLElement | undefined;

afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
  vi.clearAllMocks();
});

async function renderDropped(file: File) {
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
  await act(async () => {
    root!.render(
      <StrictMode>
        <UploadModal organizations={ORG} currentOrgId="org-1" initialFiles={[file]} onClose={() => undefined} />
      </StrictMode>,
    );
  });
  // Necháme dobehnúť reťaz promisov uploadu.
  await act(async () => { await Promise.resolve(); await Promise.resolve(); });
}

describe('UploadModal — súbory pustené na zoznam', () => {
  it('dotiahne upload do konca aj v StrictMode (nezostane visieť)', async () => {
    uploadDocumentFile.mockResolvedValue({ status: 'queued' });
    await renderDropped(new File(['x'], 'rozhodnutie.pdf', { type: 'application/pdf' }));

    // Napriek dvojitému mountnutiu sa súbor nahrá práve raz…
    expect(uploadDocumentFile).toHaveBeenCalledTimes(1);
    expect(uploadDocumentFile).toHaveBeenCalledWith('org-1', expect.any(File));
    // …a riadok sa dostane do koncového stavu, nie visí na začiatku.
    expect(container!.textContent).toContain(t('doklady.nahrat.stavSpracuvaAi'));
    expect(container!.textContent).toContain('rozhodnutie.pdf');
  });

  it('zlyhanie ukáže chybu na riadku, nie nekonečné nahrávanie', async () => {
    uploadDocumentFile.mockRejectedValue(new Error('unsupported_file_type'));
    await renderDropped(new File(['x'], 'sken.pdf', { type: 'application/pdf' }));

    expect(container!.textContent).toContain(t('doklady.nahrat.chyba'));
    expect(container!.textContent).not.toContain(t('doklady.nahrat.stavSpracuvaAi'));
  });
});

// @vitest-environment happy-dom
// Okno „Nahrať zo SharePointu". Súbor ostáva v „nespracované", kým jeho doklad
// neprejde do POHODY — teda dni po nahratí. Okno ho preto nesmie ponúknuť na
// výber znova, inak by účtovník nahral ten istý doklad dvakrát.
import { act } from 'react-dom/test-utils';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';

(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;

const nacitajSharePointSubory = vi.fn();
const nahrajZoSharePointu = vi.fn();
vi.mock('../../data/api', () => ({
  nacitajSharePointSubory: (...args: unknown[]) => nacitajSharePointSubory(...args),
  nahrajZoSharePointu: (...args: unknown[]) => nahrajZoSharePointu(...args),
}));
vi.mock('../../components/toast', () => ({ showToast: vi.fn() }));

const { SharePointPickerModal } = await import('./SharePointPickerModal');

const ORG = {
  id: 'org-1', nazov: 'SLO SERVICES, s. r. o.', tenantId: 't1', ico: '12345678', dic: '',
  farba: '#0E7A5F', emailAlias: 'a@b.sk', archived: false,
} as never;

const SUBORY = [
  { id: 'novy-1', nazov: 'faktura-1.pdf', velkost: 120_000, upravene: '2026-09-15T08:00:00Z', stav: 'nove' },
  { id: 'novy-2', nazov: 'faktura-2.pdf', velkost: 90_000, upravene: '2026-09-14T08:00:00Z', stav: 'nove' },
  { id: 'nahraty', nazov: 'uz-v-dokladovke.pdf', velkost: 80_000, upravene: '2026-09-10T08:00:00Z', stav: 'nahrate' },
];

let root: Root | undefined;
let container: HTMLElement | undefined;

afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
  vi.clearAllMocks();
});

async function otvor(onClose = vi.fn()) {
  nacitajSharePointSubory.mockResolvedValue({ nastavene: true, subory: SUBORY });
  nahrajZoSharePointu.mockResolvedValue({ zaradene: 2, preskocene: 0 });
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
  await act(async () => {
    root!.render(<SharePointPickerModal organization={ORG} onClose={onClose} />);
  });
  await act(async () => { await Promise.resolve(); await Promise.resolve(); });
  return onClose;
}

function checkbox(nazov: string): HTMLInputElement {
  const riadok = [...document.querySelectorAll('li')].find((li) => li.textContent?.includes(nazov));
  return riadok!.querySelector('input[type="checkbox"]') as HTMLInputElement;
}

function tlacidlo(text: string): HTMLButtonElement {
  return [...document.querySelectorAll('button')].find((button) => button.textContent?.startsWith(text)) as HTMLButtonElement;
}

describe('SharePointPickerModal', () => {
  it('načíta priečinok firmy a už nahratý súbor nedá vybrať', async () => {
    await otvor();
    expect(nacitajSharePointSubory).toHaveBeenCalledWith('org-1', 'nespracovane');
    expect(checkbox('faktura-1.pdf').disabled).toBe(false);
    expect(checkbox('uz-v-dokladovke.pdf').disabled).toBe(true);
    expect(document.body.textContent).toContain('už nahraté');
  });

  it('„Označiť všetky" vyberie len nové a nahrá presne ich', async () => {
    const onClose = await otvor();
    // Bez výberu sa nedá nahrať nič.
    expect(tlacidlo('Nahrať').disabled).toBe(true);

    await act(async () => { tlacidlo('Označiť všetky').click(); });
    expect(tlacidlo('Nahrať').textContent).toBe('Nahrať (2)');

    await act(async () => { tlacidlo('Nahrať').click(); });
    await act(async () => { await Promise.resolve(); });
    expect(nahrajZoSharePointu).toHaveBeenCalledWith('org-1', 'nespracovane', ['novy-1', 'novy-2']);
    expect(onClose).toHaveBeenCalled();
  });

  it('prepnutie na „Chybné" načíta iný priečinok a výber zruší', async () => {
    await otvor();
    await act(async () => { checkbox('faktura-1.pdf').click(); });
    expect(tlacidlo('Nahrať').textContent).toBe('Nahrať (1)');

    nacitajSharePointSubory.mockResolvedValue({ nastavene: true, subory: [] });
    const karta = [...document.querySelectorAll('[role="tab"]')].find((tab) => tab.textContent === 'Chybné') as HTMLButtonElement;
    await act(async () => { karta.click(); });
    await act(async () => { await Promise.resolve(); });
    expect(nacitajSharePointSubory).toHaveBeenLastCalledWith('org-1', 'chybne');
    expect(tlacidlo('Nahrať').textContent).toBe('Nahrať');
  });
});

import { afterEach, describe, expect, it, vi } from 'vitest';

// Pravidlo protistrany zruší otázku na všetkých otvorených dokladoch tej
// protistrany. Bez obnovenia snapshotu ju ostatné doklady ukazovali ďalej.

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.resetModules();
});

describe('ulozPravidloProtistrany v serverovom režime', () => {
  it('po uložení obnoví snapshot', async () => {
    vi.stubEnv('VITE_DATA_MODE', 'rest');
    vi.resetModules();
    const { storeApi } = await import('./store');
    const { ulozPravidloProtistrany } = await import('./api');
    storeApi.set({ role: 'uctovnik' });

    const volania: string[] = [];
    vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
      volania.push(`${init?.method ?? 'GET'} ${url}`);
      const body = url === '/api/data/snapshot' ? storeApi.get()
        : url.endsWith('/pravidlo-protistrany') ? { ruleId: 'r1' } : { csrfToken: 't' };
      return { ok: true, status: 200, json: async () => body };
    }));

    expect(await ulozPravidloProtistrany('d1', { predkontaciaId: 'p1', clenenieDphId: 'c1' })).toBe('r1');
    const zapis = volania.indexOf('POST /api/documents/d1/pravidlo-protistrany');
    expect(zapis).toBeGreaterThanOrEqual(0);
    expect(volania.slice(zapis + 1)).toContain('GET /api/data/snapshot');
  });
});

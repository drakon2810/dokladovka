import { afterEach, describe, expect, it, vi } from 'vitest';

// Serverový režim: po uložení sa koncept nahradí snapshotom zo servera. Keď
// PATCH podtyp neposlal, zmena na dobropis sa po uložení potichu vrátila.

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.resetModules();
});

describe('saveDocument v serverovom režime', () => {
  it('pošle podtyp dokladu', async () => {
    vi.stubEnv('VITE_DATA_MODE', 'rest');
    vi.resetModules();
    const { storeApi } = await import('./store');
    const { saveDocument } = await import('./api');
    storeApi.set({ role: 'uctovnik' });
    const doklad = storeApi.get().documents[0];

    const telaPatch: unknown[] = [];
    vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
      if (init?.method === 'PATCH') telaPatch.push(JSON.parse(String(init.body)));
      const body = url === '/api/data/snapshot' ? storeApi.get() : { csrfToken: 't' };
      return { ok: true, status: 200, json: async () => body };
    }));

    await saveDocument(doklad.id, { typ: 'FP', podtyp: 'dobropis' }, doklad.version);
    expect(telaPatch).toEqual([expect.objectContaining({ documentType: 'FP', podtyp: 'dobropis' })]);
  });
});

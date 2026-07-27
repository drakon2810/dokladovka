// DIČ/IČ DPH z informačných zoznamov FS SR — dva rôzne zoznamy, jedna odpoveď.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { buildApp } from '../app.js';
import { MemoryObjectStorage } from '../storage.js';
import { createTestDatabase, seedTestUser, testConfig } from '../testHelpers.js';

const sessionCookie = (response: { headers: Record<string, unknown> }) =>
  String(response.headers['set-cookie']).split(';')[0];

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('GET /api/company-registry/sk-tax-ids', () => {
  it('spojí DIČ zo zoznamu dane z príjmov a IČ DPH zo zoznamu platiteľov', async () => {
    const database = await createTestDatabase();
    const seeded = await seedTestUser(database);
    const app = await buildApp({
      database,
      storage: new MemoryObjectStorage(),
      config: testConfig({ fsOpenDataApiKey: 'test-key' }),
      logger: false,
    });
    vi.stubGlobal('fetch', vi.fn(async (url: string) => ({
      ok: true,
      json: async () => ({
        data: String(url).includes('ds_dsrdp')
          ? [{ dic: '2020372640', ico: '31322832', nazov_ds: 'SLOVNAFT, a.s.' }]
          : [{ ic_dph: 'SK7120001713', ico: '31322832' }],
      }),
    })));

    const login = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { email: seeded.email, password: seeded.password } });
    const cookie = sessionCookie(login);
    const response = await app.inject({
      method: 'GET', url: '/api/company-registry/sk-tax-ids?ico=31322832', headers: { cookie },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ dic: '2020372640', icDph: 'SK7120001713', configured: true });

    // Neplatiteľ DPH: zoznam vráti 404 → IČ DPH ostane prázdne, DIČ nie.
    vi.stubGlobal('fetch', vi.fn(async (url: string) => (
      String(url).includes('ds_dsrdp')
        ? { ok: true, json: async () => ({ data: [{ dic: '2120000001' }] }) }
        : { ok: false, json: async () => ({}) }
    )));
    const partial = await app.inject({
      method: 'GET', url: '/api/company-registry/sk-tax-ids?ico=47358782', headers: { cookie },
    });
    expect(partial.json()).toMatchObject({ dic: '2120000001', icDph: null });
    await app.close();
  }, 60_000);

  it('bez nakonfigurovaného kľúča nevolá externé API', async () => {
    const database = await createTestDatabase();
    const seeded = await seedTestUser(database);
    const app = await buildApp({
      database, storage: new MemoryObjectStorage(), config: testConfig(), logger: false,
    });
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const login = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { email: seeded.email, password: seeded.password } });
    const response = await app.inject({
      method: 'GET', url: '/api/company-registry/sk-tax-ids?ico=31322832',
      headers: { cookie: sessionCookie(login) },
    });
    expect(response.json()).toMatchObject({ configured: false, dic: null, icDph: null });
    expect(fetchMock).not.toHaveBeenCalled();
    await app.close();
  }, 60_000);
});

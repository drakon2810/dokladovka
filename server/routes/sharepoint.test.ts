import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { buildApp } from '../app.js';
import { encryptSecret } from '../security.js';
import { MemoryObjectStorage } from '../storage.js';
import { createTestDatabase, seedTestUser, testConfig } from '../testHelpers.js';
import type { SharePointClient, SharePointFolderRef } from '../services/sharepointService.js';

const config = testConfig({
  sharepoint: { clientId: 'app-id', clientSecret: 'app-secret', pollIntervalSeconds: 180 },
  appBaseUrl: 'https://dokladovka.test',
});

/** Priečinky podľa adresy: rovnaký disk, ak nie je povedané inak. */
function fakeClient(mapa: Record<string, SharePointFolderRef>): SharePointClient {
  return {
    list: async () => [],
    download: async () => Buffer.alloc(0),
    move: async () => {},
    resolveFolderUrl: async (url) => {
      const ref = mapa[url];
      if (!ref) throw new Error('Položka neexistuje');
      return ref;
    },
  };
}

const REFS: Record<string, SharePointFolderRef> = {
  'https://firma.sharepoint.com/x/nespracovane': { driveId: 'drive-1', itemId: 'n1', name: 'nespracovane' },
  'https://firma.sharepoint.com/x/spracovane': { driveId: 'drive-1', itemId: 's1', name: 'spracovane' },
  'https://firma.sharepoint.com/x/chybne': { driveId: 'drive-1', itemId: 'c1', name: 'chybne' },
  'https://firma.sharepoint.com/ina/kniznica': { driveId: 'drive-INY', itemId: 'x1', name: 'ina' },
};

function sessionHeaders(response: { headers: Record<string, unknown>; json(): any }) {
  return { cookie: String(response.headers['set-cookie']).split(';')[0], 'x-csrf-token': response.json().csrfToken };
}

async function prostredie(client: SharePointClient = fakeClient(REFS)) {
  const database = await createTestDatabase();
  const seeded = await seedTestUser(database);
  const app = await buildApp({
    database, storage: new MemoryObjectStorage(), config, logger: false,
    sharePointClient: () => client,
  });
  const login = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { email: seeded.email, password: seeded.password } });
  return { database, app, seeded, headers: sessionHeaders(login) };
}

async function pripoj(database: any, tenantId: string) {
  await database.query(
    `INSERT INTO sharepoint_connections (id,tenant_id,ms_tenant_id,account_email,refresh_token_encrypted)
     VALUES ($1,$2,'ms-tenant','ucto@firma.sk',$3)`,
    [randomUUID(), tenantId, encryptSecret('rt', config.secretEncryptionKey)],
  );
}

describe('SharePoint — pripojenie a priečinky', { timeout: 60_000 }, () => {
  it('bez pripojenia povie, že nie je pripojené, ale registráciu má', async () => {
    const { app, headers } = await prostredie();
    const odpoved = (await app.inject({ method: 'GET', url: '/api/sharepoint/connection', headers })).json();
    expect(odpoved).toMatchObject({ configured: true, connection: null, folders: [] });
  });

  it('odkaz na prihlásenie nesie podpísaný state a mieri na /common', async () => {
    const { app, headers } = await prostredie();
    const { url } = (await app.inject({ method: 'POST', url: '/api/sharepoint/authorize', headers })).json();
    const adresa = new URL(url);
    expect(adresa.origin + adresa.pathname).toBe('https://login.microsoftonline.com/common/oauth2/v2.0/authorize');
    expect(adresa.searchParams.get('scope')).toContain('offline_access');
    expect(adresa.searchParams.get('redirect_uri')).toBe('https://dokladovka.test/api/sharepoint/callback');
    // Bez podpisu by si ktokoľvek mohol pripojiť SharePoint k cudzej kancelárii.
    expect(adresa.searchParams.get('state')?.split('.')).toHaveLength(2);
  });

  it('podvrhnutý state návrat odmietne', async () => {
    const { app } = await prostredie();
    const telo = Buffer.from(JSON.stringify({ tenantId: 'cudzi', userId: 'x', exp: Date.now() + 60_000 })).toString('base64url');
    const odpoved = await app.inject({
      method: 'GET', url: `/api/sharepoint/callback?code=abc&state=${telo}.zlypodpis`,
    });
    expect(odpoved.statusCode).toBe(400);
  });

  it('priečinky sa uložia z odkazov a vrátia svoje názvy', async () => {
    const { app, database, seeded, headers } = await prostredie();
    await pripoj(database, seeded.tenantId);
    const odpoved = await app.inject({
      method: 'PUT', url: '/api/sharepoint/folders', headers,
      payload: {
        organizationId: seeded.organizationId,
        nespracovaneUrl: 'https://firma.sharepoint.com/x/nespracovane',
        spracovaneUrl: 'https://firma.sharepoint.com/x/spracovane',
        chybneUrl: 'https://firma.sharepoint.com/x/chybne',
      },
    });
    expect(odpoved.statusCode).toBe(200);
    expect(odpoved.json()).toMatchObject({ nespracovane: 'nespracovane', spracovane: 'spracovane' });
    const ulozene = await database.query('SELECT drive_id, nespracovane_folder_id, chybne_folder_id FROM sharepoint_folders');
    expect(ulozene.rows[0]).toMatchObject({ drive_id: 'drive-1', nespracovane_folder_id: 'n1', chybne_folder_id: 'c1' });
  });

  it('priečinky z rôznych knižníc odmietne — Graph medzi nimi presúvať nevie', async () => {
    const { app, database, seeded, headers } = await prostredie();
    await pripoj(database, seeded.tenantId);
    const odpoved = await app.inject({
      method: 'PUT', url: '/api/sharepoint/folders', headers,
      payload: {
        organizationId: seeded.organizationId,
        nespracovaneUrl: 'https://firma.sharepoint.com/x/nespracovane',
        spracovaneUrl: 'https://firma.sharepoint.com/ina/kniznica',
      },
    });
    expect(odpoved.statusCode).toBe(422);
    expect(odpoved.json().code).toBe('folders_different_drives');
  });

  it('ten istý priečinok dvakrát by doklady presúval sám do seba', async () => {
    const { app, database, seeded, headers } = await prostredie();
    await pripoj(database, seeded.tenantId);
    const odpoved = await app.inject({
      method: 'PUT', url: '/api/sharepoint/folders', headers,
      payload: {
        organizationId: seeded.organizationId,
        nespracovaneUrl: 'https://firma.sharepoint.com/x/nespracovane',
        spracovaneUrl: 'https://firma.sharepoint.com/x/nespracovane',
      },
    });
    expect(odpoved.json().code).toBe('folders_same');
  });

  it('neexistujúci priečinok povie prečo, nie „500"', async () => {
    const { app, database, seeded, headers } = await prostredie();
    await pripoj(database, seeded.tenantId);
    const odpoved = await app.inject({
      method: 'PUT', url: '/api/sharepoint/folders', headers,
      payload: {
        organizationId: seeded.organizationId,
        nespracovaneUrl: 'https://firma.sharepoint.com/x/neexistuje',
        spracovaneUrl: 'https://firma.sharepoint.com/x/spracovane',
      },
    });
    expect(odpoved.statusCode).toBe(422);
    expect(odpoved.json().code).toBe('folder_unresolved');
  });

  it('bez pripojenia sa priečinky nastaviť nedajú', async () => {
    const { app, seeded, headers } = await prostredie();
    const odpoved = await app.inject({
      method: 'PUT', url: '/api/sharepoint/folders', headers,
      payload: {
        organizationId: seeded.organizationId,
        nespracovaneUrl: 'https://firma.sharepoint.com/x/nespracovane',
        spracovaneUrl: 'https://firma.sharepoint.com/x/spracovane',
      },
    });
    expect(odpoved.json().code).toBe('sharepoint_not_connected');
  });

  it('odpojenie zoberie aj priečinky — inak by sa po znovupripojení ticho rozbehli', async () => {
    const { app, database, seeded, headers } = await prostredie();
    await pripoj(database, seeded.tenantId);
    await app.inject({
      method: 'PUT', url: '/api/sharepoint/folders', headers,
      payload: {
        organizationId: seeded.organizationId,
        nespracovaneUrl: 'https://firma.sharepoint.com/x/nespracovane',
        spracovaneUrl: 'https://firma.sharepoint.com/x/spracovane',
      },
    });
    expect((await database.query('SELECT 1 FROM sharepoint_folders')).rowCount).toBe(1);

    await app.inject({ method: 'DELETE', url: '/api/sharepoint/connection', headers });
    expect((await database.query('SELECT 1 FROM sharepoint_folders')).rowCount).toBe(0);
    expect((await database.query('SELECT 1 FROM sharepoint_connections')).rowCount).toBe(0);
  });

  it('token sa v odpovedi API nikdy neobjaví', async () => {
    const { app, database, seeded, headers } = await prostredie();
    await pripoj(database, seeded.tenantId);
    const telo = (await app.inject({ method: 'GET', url: '/api/sharepoint/connection', headers })).body;
    expect(telo).toContain('ucto@firma.sk');
    expect(telo).not.toContain('refresh');
  });
});

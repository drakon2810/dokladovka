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

describe('SharePoint — okno „Nahrať zo SharePointu"', { timeout: 60_000 }, () => {
  const SUBORY = [
    { id: 'stary', name: 'stary.pdf', size: 100, modifiedAt: '2026-09-01T08:00:00Z' },
    { id: 'novy', name: 'novy.pdf', size: 200, modifiedAt: '2026-09-15T08:00:00Z' },
    { id: 'caka', name: 'caka.pdf', size: 300, modifiedAt: '2026-09-10T08:00:00Z' },
  ];

  function klientSoSubormi(subory = SUBORY, prepis: Partial<SharePointClient> = {}): SharePointClient {
    return { ...fakeClient(REFS), list: async () => subory, ...prepis };
  }

  async function sPriecinkami(client: SharePointClient, chybne: string | null = 'c1') {
    const prostr = await prostredie(client);
    await pripoj(prostr.database, prostr.seeded.tenantId);
    await prostr.database.query(
      `INSERT INTO sharepoint_folders
        (id,tenant_id,organization_id,site_id,drive_id,nespracovane_folder_id,spracovane_folder_id,chybne_folder_id)
       VALUES ($1,$2,$3,'drive-1','drive-1','n1','s1',$4)`,
      [randomUUID(), prostr.seeded.tenantId, prostr.seeded.organizationId, chybne],
    );
    return prostr;
  }

  // Doklad ostáva v „nespracované", kým neprejde do POHODY — teda dni. Bez stavu
  // „nahraté" by ho účtovník v okne videl ako nový a nahral znova.
  it('ukáže obsah priečinka so stavom každého súboru, najnovšie navrch', async () => {
    const { app, database, seeded, headers } = await sPriecinkami(klientSoSubormi());
    const emailId = randomUUID();
    await database.query(
      `INSERT INTO inbound_emails
        (id, tenant_id, organization_id, provider, provider_message_id, envelope_recipients, received_at, status, attachment_count, correlation_id)
       VALUES ($1,$2,$3,'sharepoint',$4,'[]'::jsonb,now(),'received',1,$5)`,
      [emailId, seeded.tenantId, seeded.organizationId, randomUUID(), randomUUID()],
    );
    await database.query(
      `INSERT INTO inbound_attachments
        (id,tenant_id,inbound_email_id,organization_id,original_file_name,safe_file_name,declared_mime_type,byte_size,sha256,status,sharepoint_drive_id,sharepoint_item_id)
       VALUES ($1,$2,$3,$4,'stary.pdf','stary.pdf','application/pdf',100,'x','queued','drive-1','stary')`,
      [randomUUID(), seeded.tenantId, emailId, seeded.organizationId],
    );
    await database.query(
      `INSERT INTO sharepoint_import_requests (id,tenant_id,organization_id,drive_id,item_id,file_name,zdroj)
       VALUES ($1,$2,$3,'drive-1','caka','caka.pdf','nespracovane')`,
      [randomUUID(), seeded.tenantId, seeded.organizationId],
    );

    const odpoved = await app.inject({ method: 'GET', url: `/api/sharepoint/files/${seeded.organizationId}`, headers });
    expect(odpoved.statusCode, odpoved.body).toBe(200);
    expect(odpoved.json().subory.map((subor: { id: string; stav: string }) => [subor.id, subor.stav])).toEqual([
      ['novy', 'nove'], ['caka', 'caka'], ['stary', 'nahrate'],
    ]);
  });

  // Id z požiadavky by inak dovolilo stiahnuť čokoľvek z knižnice dokumentov.
  it('nahrať prijme len súbory, ktoré v priečinku firmy naozaj sú', async () => {
    const { app, database, seeded, headers } = await sPriecinkami(klientSoSubormi());
    const odpoved = await app.inject({
      method: 'POST', url: `/api/sharepoint/import/${seeded.organizationId}`, headers,
      payload: { zdroj: 'nespracovane', itemIds: ['novy', 'cudzi-subor-z-inej-firmy', 'novy'] },
    });
    expect(odpoved.statusCode, odpoved.body).toBe(202);
    expect(odpoved.json()).toEqual({ zaradene: 1, preskocene: 1 });
    const ziadosti = await database.query<{ item_id: string; file_name: string }>(
      'SELECT item_id, file_name FROM sharepoint_import_requests',
    );
    expect(ziadosti.rows).toEqual([{ item_id: 'novy', file_name: 'novy.pdf' }]);

    // Dvojklik: ten istý súbor druhýkrát nezaradí.
    const znova = await app.inject({
      method: 'POST', url: `/api/sharepoint/import/${seeded.organizationId}`, headers,
      payload: { zdroj: 'nespracovane', itemIds: ['novy'] },
    });
    expect(znova.json()).toEqual({ zaradene: 0, preskocene: 1 });
  });

  it('firma bez priečinkov povie, kde ich nastaviť', async () => {
    const { app, database, seeded, headers } = await prostredie(klientSoSubormi());
    await pripoj(database, seeded.tenantId);
    const odpoved = await app.inject({ method: 'GET', url: `/api/sharepoint/files/${seeded.organizationId}`, headers });
    expect(odpoved.statusCode).toBe(409);
    expect(odpoved.json().code).toBe('sharepoint_folders_missing');
  });

  it('bez priečinka „chybné" karta povie, že nie je nastavený', async () => {
    const { app, seeded, headers } = await sPriecinkami(klientSoSubormi(), null);
    const odpoved = await app.inject({ method: 'GET', url: `/api/sharepoint/files/${seeded.organizationId}?zdroj=chybne`, headers });
    expect(odpoved.json()).toEqual({ nastavene: false, subory: [] });
  });

  it('vypršané prihlásenie povie rovno, že treba pripojiť znova', async () => {
    const { SharePointError } = await import('../services/sharepointService.js');
    const { app, seeded, headers } = await sPriecinkami(klientSoSubormi(SUBORY, {
      list: async () => { throw new SharePointError('expired', 'auth_expired'); },
    }));
    const odpoved = await app.inject({ method: 'GET', url: `/api/sharepoint/files/${seeded.organizationId}`, headers });
    expect(odpoved.statusCode).toBe(409);
    expect(odpoved.json().code).toBe('sharepoint_auth_expired');
  });
});

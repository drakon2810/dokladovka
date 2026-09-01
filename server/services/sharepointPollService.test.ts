import { randomUUID } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import type { Database } from '../db/database.js';
import { decryptSecret, encryptSecret } from '../security.js';
import { MemoryObjectStorage } from '../storage.js';
import { createTestDatabase, seedTestUser, testConfig } from '../testHelpers.js';
import { pollAllFolders, pollFolder, type SharePointFolderRow } from './sharepointPollService.js';
import { SharePointError, type SharePointClient, type SharePointFile } from './sharepointService.js';

const PDF = Buffer.from('%PDF-1.7\nfaktura');
const config = testConfig();

/** Fake SharePoint: pole súborov v priečinku a záznam presunov. */
function fakeClient(subory: SharePointFile[], prepis: Partial<SharePointClient> = {}) {
  const presuny: Array<{ itemId: string; ciel: string; nazov: string }> = [];
  const stiahnute: string[] = [];
  const client: SharePointClient = {
    list: async () => subory,
    download: async (_drive, itemId) => { stiahnute.push(itemId); return PDF; },
    move: async (_drive, itemId, ciel, nazov) => { presuny.push({ itemId, ciel, nazov }); },
    resolveFolderUrl: async () => { throw new Error('poller priečinky nehľadá'); },
    ...prepis,
  };
  return { client, presuny, stiahnute };
}

/**
 * Fixtúra sa stavia v teste, nie v beforeEach — prvé PGlite v súbore rozbieha
 * wasm a všetky migrácie, čo je viac, ako povoľuje limit hookov.
 */
async function pripravDb(): Promise<{ database: Database; storage: MemoryObjectStorage; folder: SharePointFolderRow }> {
  const database = await createTestDatabase();
  const storage = new MemoryObjectStorage();
  const seeded = await seedTestUser(database);
  const id = randomUUID();
  await database.query(
    `INSERT INTO sharepoint_folders
      (id,tenant_id,organization_id,site_id,drive_id,nespracovane_folder_id,spracovane_folder_id,chybne_folder_id)
     VALUES ($1,$2,$3,'site','drive-1','nespracovane','spracovane','chybne')`,
    [id, seeded.tenantId, seeded.organizationId],
  );
  return {
    database,
    storage,
    folder: {
      id, tenant_id: seeded.tenantId, organization_id: seeded.organizationId,
      drive_id: 'drive-1', nespracovane_folder_id: 'nespracovane',
      spracovane_folder_id: 'spracovane', chybne_folder_id: 'chybne',
    },
  };
}

// Každý test si stavia vlastnú PGlite so všetkými migráciami; predvolených
// 5 s na to nestačí.
describe('prechod priečinkom', { timeout: 60_000 }, () => {
  it('nový súbor prijme a zapamätá si, odkiaľ je', async () => {
    const { database, storage, folder } = await pripravDb();
    const { client } = fakeClient([{ id: 'item-1', name: 'faktura.pdf', size: PDF.length }]);
    expect(await pollFolder({ database, storage, config }, folder, client))
      .toMatchObject({ videne: 1, prijate: 1, chybne: 0 });

    const priloha = await database.query<{ sharepoint_item_id: string; status: string }>(
      'SELECT sharepoint_item_id, status FROM inbound_attachments',
    );
    expect(priloha.rows[0]).toMatchObject({ sharepoint_item_id: 'item-1', status: 'queued' });
    // Bez odkazu na zdroj by sa súbor nemal ako vrátiť do „spracované".
    expect((await database.query('SELECT 1 FROM processing_jobs')).rowCount).toBe(1);
  });

  it('ten istý súbor druhýkrát ani nesťahuje', async () => {
    const { database, storage, folder } = await pripravDb();
    const subory = [{ id: 'item-1', name: 'faktura.pdf', size: PDF.length }];
    const prvy = fakeClient(subory);
    await pollFolder({ database, storage, config }, folder, prvy.client);
    const druhy = fakeClient(subory);
    expect(await pollFolder({ database, storage, config }, folder, druhy.client))
      .toMatchObject({ videne: 1, prijate: 0, preskocene: 1 });
    // Doklad čaká na prenos dni — sťahovať ho každé tri minúty je zbytočné.
    expect(druhy.stiahnute).toEqual([]);
  });

  it('už známy doklad ide do „spracované", nie medzi chybné', async () => {
    const { database, storage, folder } = await pripravDb();
    // Ten istý obsah pod dvoma rôznymi položkami: klient poslal faktúru
    // e-mailom a potom ju ešte hodil do priečinka.
    await pollFolder({ database, storage, config }, folder,
      fakeClient([{ id: 'prvy', name: 'faktura.pdf', size: PDF.length }]).client);
    const druhy = fakeClient([{ id: 'druhy', name: 'faktura.pdf', size: PDF.length }]);

    const vysledok = await pollFolder({ database, storage, config }, folder, druhy.client);
    expect(vysledok).toMatchObject({ duplicity: 1, chybne: 0, prijate: 0 });
    // Do „chybné" nepatrí — klient by videl svoju úplne v poriadku faktúru
    // medzi odpadom a nevedel by, čo s tým.
    expect(druhy.presuny).toEqual([{ itemId: 'druhy', ciel: 'spracovane', nazov: 'faktura.pdf' }]);
  });

  it('nepoužiteľný súbor odsunie do „chybné"', async () => {
    const { database, storage, folder } = await pripravDb();
    const { client, presuny } = fakeClient(
      [{ id: 'item-2', name: 'fotka.heic', size: 10 }],
      { download: async () => Buffer.from('nie je to doklad') },
    );
    expect(await pollFolder({ database, storage, config }, folder, client))
      .toMatchObject({ prijate: 0, chybne: 1 });
    expect(presuny).toEqual([{ itemId: 'item-2', ciel: 'chybne', nazov: 'fotka.heic' }]);
  });

  it('bez priečinka „chybné" súbor nechá ležať, ale nespadne', async () => {
    const { database, storage, folder } = await pripravDb();
    const { client, presuny } = fakeClient(
      [{ id: 'item-3', name: 'fotka.heic', size: 10 }],
      { download: async () => Buffer.from('nie je to doklad') },
    );
    const bezChybne = { ...folder, chybne_folder_id: null };
    expect(await pollFolder({ database, storage, config }, bezChybne, client)).toMatchObject({ chybne: 1 });
    expect(presuny).toEqual([]);
  });

  it('vypršané prihlásenie zastaví priečinok, nebije Graph ďalšími súbormi', async () => {
    const { database, storage, folder } = await pripravDb();
    const download = vi.fn(async () => { throw new SharePointError('expired', 'auth_expired'); });
    const { client } = fakeClient(
      [{ id: 'a', name: 'a.pdf', size: 9 }, { id: 'b', name: 'b.pdf', size: 9 }],
      { download },
    );
    await pollFolder({ database, storage, config }, folder, client);
    expect(download).toHaveBeenCalledTimes(1);
  });

  it('chybu zapíše, aby sa dala ukázať v nastaveniach', async () => {
    const { database, storage, folder } = await pripravDb();
    const { client } = fakeClient([], { list: async () => { throw new SharePointError('expired', 'auth_expired'); } });
    await pollFolder({ database, storage, config }, folder, client);
    const stav = await database.query<{ last_error: string | null; last_poll_at: Date | null }>(
      'SELECT last_error, last_poll_at FROM sharepoint_folders WHERE id=$1', [folder.id],
    );
    expect(stav.rows[0].last_error).toBe('expired');
    expect(stav.rows[0].last_poll_at).not.toBeNull();
  });

  it('cyklus cez všetky firmy odšifruje token a rotovaný uloží späť zašifrovaný', async () => {
    const { database, storage, folder } = await pripravDb();
    const conf = testConfig({
      sharepoint: { clientId: 'app', clientSecret: 'secret', pollIntervalSeconds: 180 },
    });
    await database.query(
      `INSERT INTO sharepoint_connections
        (id,tenant_id,ms_tenant_id,account_email,refresh_token_encrypted)
       VALUES ($1,$2,'ms-tenant','ucto@firma.sk',$3)`,
      [randomUUID(), folder.tenant_id, encryptSecret('rt-povodny', conf.secretEncryptionKey)],
    );

    let videnyToken: string | undefined;
    const vysledky = await pollAllFolders({ database, storage, config: conf }, (options) => {
      videnyToken = options.tokens.refreshToken;
      const { client } = fakeClient([{ id: 'item-9', name: 'f.pdf', size: PDF.length }]);
      // Microsoft rotuje refresh token pri každom obnovení; ak sa neuloží,
      // pripojenie po prvom vypršaní odumrie.
      return { ...client, list: async () => { await options.tokens.onRefreshTokenRotated('rt-novy'); return [{ id: 'item-9', name: 'f.pdf', size: PDF.length }]; } };
    });

    expect(videnyToken).toBe('rt-povodny');
    expect(vysledky.get(folder.organization_id)).toMatchObject({ prijate: 1 });
    const ulozeny = await database.query<{ refresh_token_encrypted: string }>(
      'SELECT refresh_token_encrypted FROM sharepoint_connections',
    );
    expect(ulozeny.rows[0].refresh_token_encrypted).not.toContain('rt-novy');
    expect(decryptSecret(ulozeny.rows[0].refresh_token_encrypted, conf.secretEncryptionKey)).toBe('rt-novy');
  });

  it('bez registrácie aplikácie nerobí nič — nie je to chyba, len to nie je nastavené', async () => {
    const { database, storage } = await pripravDb();
    expect((await pollAllFolders({ database, storage, config }, () => { throw new Error('nemá sa volať'); })).size).toBe(0);
  });

  it('veľký nával rozdelí na viac cyklov', async () => {
    const { database, storage, folder } = await pripravDb();
    const subory = Array.from({ length: 25 }, (_, i) => ({ id: `f${i}`, name: `f${i}.pdf`, size: PDF.length }));
    // Každý súbor musí byť iný, inak ich zastaví kontrola duplicity obsahu.
    const { client } = fakeClient(subory, { download: async (_d, id) => Buffer.concat([PDF, Buffer.from(id)]) });
    expect(await pollFolder({ database, storage, config }, folder, client)).toMatchObject({ prijate: 20 });
    expect(await pollFolder({ database, storage, config }, folder, client)).toMatchObject({ prijate: 5, preskocene: 20 });
  });
});

import { randomUUID } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import type { Database } from '../db/database.js';
import { decryptSecret, encryptSecret } from '../security.js';
import { MemoryObjectStorage } from '../storage.js';
import { createTestDatabase, seedTestUser, testConfig } from '../testHelpers.js';
import { pollAllFolders, pollFolder, pribudliZiadosti, type SharePointFolderRow } from './sharepointPollService.js';
import { SharePointError, type SharePointClient, type SharePointFile } from './sharepointService.js';

const PDF = Buffer.from('%PDF-1.7\nfaktura');
const config = testConfig();

/** Fake SharePoint: pole súborov v priečinku a záznam presunov aj stiahnutí. */
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

/** Účtovník v okne „Nahrať zo SharePointu" vybral tieto súbory. */
async function vyber(database: Database, folder: SharePointFolderRow, subory: Array<{ id: string; name: string }>, zdroj = 'nespracovane') {
  for (const subor of subory) {
    await database.query(
      `INSERT INTO sharepoint_import_requests (id,tenant_id,organization_id,drive_id,item_id,file_name,zdroj)
       VALUES ($1,$2,$3,$4,$5,$6,$7)`,
      [randomUUID(), folder.tenant_id, folder.organization_id, folder.drive_id, subor.id, subor.name, zdroj],
    );
  }
}

async function cakajuce(database: Database): Promise<number> {
  return (await database.query('SELECT 1 FROM sharepoint_import_requests WHERE done_at IS NULL')).rowCount;
}

// Každý test si stavia vlastnú PGlite so všetkými migráciami; predvolených
// 5 s na to nestačí.
describe('prechod priečinkom', { timeout: 60_000 }, () => {
  // Jadro zmeny: poller doteraz sťahoval všetko, čo v priečinku pribudlo.
  it('bez výberu účtovníka z priečinka nič nesťahuje', async () => {
    const { database, storage, folder } = await pripravDb();
    const { client, stiahnute } = fakeClient([{ id: 'item-1', name: 'faktura.pdf', size: PDF.length }]);
    expect(await pollFolder({ database, storage, config }, folder, client)).toMatchObject({ prijate: 0 });
    expect(stiahnute).toEqual([]);
    expect((await database.query('SELECT 1 FROM inbound_attachments')).rowCount).toBe(0);
  });

  it('nahrá len vybrané súbory a zapamätá si, odkiaľ sú', async () => {
    const { database, storage, folder } = await pripravDb();
    const { client, stiahnute } = fakeClient([
      { id: 'item-1', name: 'faktura.pdf', size: PDF.length },
      { id: 'item-2', name: 'ina.pdf', size: PDF.length },
    ]);
    await vyber(database, folder, [{ id: 'item-1', name: 'faktura.pdf' }]);
    expect(await pollFolder({ database, storage, config }, folder, client))
      .toMatchObject({ videne: 1, prijate: 1, chybne: 0 });
    expect(stiahnute).toEqual(['item-1']);

    const priloha = await database.query<{ sharepoint_item_id: string; status: string }>(
      'SELECT sharepoint_item_id, status FROM inbound_attachments',
    );
    expect(priloha.rows).toHaveLength(1);
    // Bez odkazu na zdroj by sa súbor nemal ako vrátiť do „spracované".
    expect(priloha.rows[0]).toMatchObject({ sharepoint_item_id: 'item-1', status: 'queued' });
    expect((await database.query('SELECT 1 FROM processing_jobs')).rowCount).toBe(1);
    expect(await cakajuce(database)).toBe(0);
  });

  it('už nahratý súbor druhýkrát ani nesťahuje', async () => {
    const { database, storage, folder } = await pripravDb();
    await vyber(database, folder, [{ id: 'item-1', name: 'faktura.pdf' }]);
    await pollFolder({ database, storage, config }, folder, fakeClient([]).client);

    // Druhé okno, druhý účtovník — ten istý súbor vybraný znova.
    await vyber(database, folder, [{ id: 'item-1', name: 'faktura.pdf' }]);
    const druhy = fakeClient([]);
    expect(await pollFolder({ database, storage, config }, folder, druhy.client))
      .toMatchObject({ prijate: 0, preskocene: 1 });
    expect(druhy.stiahnute).toEqual([]);
    expect(await cakajuce(database)).toBe(0);
  });

  it('už známy doklad ide do „spracované", nie medzi chybné', async () => {
    const { database, storage, folder } = await pripravDb();
    // Ten istý obsah pod dvoma rôznymi položkami: klient poslal faktúru
    // e-mailom a potom ju ešte hodil do priečinka.
    await vyber(database, folder, [{ id: 'prvy', name: 'faktura.pdf' }]);
    await pollFolder({ database, storage, config }, folder, fakeClient([]).client);
    await vyber(database, folder, [{ id: 'druhy', name: 'faktura.pdf' }]);
    expect(await pollFolder({ database, storage, config }, folder, fakeClient([]).client))
      .toMatchObject({ duplicity: 1, chybne: 0, prijate: 0 });

    // Presun rieši až ďalší cyklus — do „chybné" nepatrí, klient by videl svoju
    // úplne v poriadku faktúru medzi odpadom.
    const treti = fakeClient([]);
    await pollFolder({ database, storage, config }, folder, treti.client);
    expect(treti.presuny).toEqual([{ itemId: 'druhy', ciel: 'spracovane', nazov: 'faktura.pdf' }]);
  });

  it('nepoužiteľný súbor odsunie do „chybné"', async () => {
    const { database, storage, folder } = await pripravDb();
    await vyber(database, folder, [{ id: 'item-2', name: 'fotka.heic' }]);
    const { client } = fakeClient([], { download: async () => Buffer.from('nie je to doklad') });
    expect(await pollFolder({ database, storage, config }, folder, client))
      .toMatchObject({ prijate: 0, chybne: 1 });
    // Odsun rieši ďalší cyklus, aby sa dal po zlyhaní zopakovať.
    const dalsi = fakeClient([]);
    await pollFolder({ database, storage, config }, folder, dalsi.client);
    expect(dalsi.presuny).toEqual([{ itemId: 'item-2', ciel: 'chybne', nazov: 'fotka.heic' }]);
  });

  // Súbor v „chybné" už raz v systéme bol (karanténa). Nesmie to zablokovať
  // nové nahratie — inak by karta „Chybné" v okne nemala zmysel.
  it('súbor z „chybné" sa dá nahrať znova', async () => {
    const { database, storage, folder } = await pripravDb();
    await vyber(database, folder, [{ id: 'item-7', name: 'faktura.pdf' }]);
    await pollFolder({ database, storage, config }, folder,
      fakeClient([], { download: async () => Buffer.from('pokazené') }).client);

    await vyber(database, folder, [{ id: 'item-7', name: 'faktura.pdf' }], 'chybne');
    const opravene = fakeClient([]);
    expect(await pollFolder({ database, storage, config }, folder, opravene.client))
      .toMatchObject({ prijate: 1 });
    expect(opravene.stiahnute).toEqual(['item-7']);
  });

  it('bez priečinka „chybné" súbor nechá ležať, ale nespadne', async () => {
    const { database, storage, folder } = await pripravDb();
    const { client, presuny } = fakeClient([], { download: async () => Buffer.from('nie je to doklad') });
    // Priečinok musí chýbať v databáze, nielen v odovzdanom objekte — cieľ
    // presunu si `najdiNaPresun` číta z nej.
    await database.query('UPDATE sharepoint_folders SET chybne_folder_id=NULL');
    const bezChybne = { ...folder, chybne_folder_id: null };
    await vyber(database, folder, [{ id: 'item-3', name: 'fotka.heic' }]);
    expect(await pollFolder({ database, storage, config }, bezChybne, client)).toMatchObject({ chybne: 1 });
    await pollFolder({ database, storage, config }, bezChybne, client);
    expect(presuny).toEqual([]);
  });

  it('vypršané prihlásenie zastaví priečinok a výber počká na nové prihlásenie', async () => {
    const { database, storage, folder } = await pripravDb();
    await vyber(database, folder, [{ id: 'a', name: 'a.pdf' }, { id: 'b', name: 'b.pdf' }]);
    const download = vi.fn(async () => { throw new SharePointError('expired', 'auth_expired'); });
    await pollFolder({ database, storage, config }, folder, fakeClient([], { download }).client);
    // Graph sa zbytočne nebije ďalšími súbormi.
    expect(download).toHaveBeenCalledTimes(1);
    // Účtovník nemusí vyberať znova — po prihlásení sa nahrajú samy.
    expect(await cakajuce(database)).toBe(2);
    const stav = await database.query<{ last_error: string | null; last_poll_at: Date | null }>(
      'SELECT last_error, last_poll_at FROM sharepoint_folders WHERE id=$1', [folder.id],
    );
    // Chyba sa zapíše, aby sa dala ukázať v nastaveniach.
    expect(stav.rows[0].last_error).toBe('expired');
    expect(stav.rows[0].last_poll_at).not.toBeNull();
  });

  // Klient súbor medzi výberom a stiahnutím zmazal alebo presunul. Žiadosť sa
  // musí uzavrieť, inak by sa sťahovala každý cyklus donekonečna.
  it('súbor, ktorý medzitým zmizol, uzavrie s dôvodom a neskúša ho dokola', async () => {
    const { database, storage, folder } = await pripravDb();
    await vyber(database, folder, [{ id: 'zmizol', name: 'faktura.pdf' }]);
    const download = vi.fn(async () => { throw new SharePointError('item not found', 'not_found'); });
    await pollFolder({ database, storage, config }, folder, fakeClient([], { download }).client);
    await pollFolder({ database, storage, config }, folder, fakeClient([], { download }).client);
    expect(download).toHaveBeenCalledTimes(1);
    const ziadost = await database.query<{ error: string | null }>('SELECT error FROM sharepoint_import_requests');
    expect(ziadost.rows[0].error).toBe('item not found');
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
    await vyber(database, folder, [{ id: 'item-9', name: 'f.pdf' }]);

    let videnyToken: string | undefined;
    const vysledky = await pollAllFolders({ database, storage, config: conf }, (options) => {
      videnyToken = options.tokens.refreshToken;
      const { client } = fakeClient([]);
      // Microsoft rotuje refresh token pri každom obnovení; ak sa neuloží,
      // pripojenie po prvom vypršaní odumrie.
      return { ...client, download: async () => { await options.tokens.onRefreshTokenRotated('rt-novy'); return PDF; } };
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

  it('veľký výber rozdelí na viac cyklov', async () => {
    const { database, storage, folder } = await pripravDb();
    await vyber(database, folder, Array.from({ length: 25 }, (_, i) => ({ id: `f${i}`, name: `f${i}.pdf` })));
    // Každý súbor musí byť iný, inak ich zastaví kontrola duplicity obsahu.
    const { client } = fakeClient([], { download: async (_d, id) => Buffer.concat([PDF, Buffer.from(id)]) });
    expect(await pollFolder({ database, storage, config }, folder, client)).toMatchObject({ prijate: 20 });
    expect(await pollFolder({ database, storage, config }, folder, client)).toMatchObject({ prijate: 5 });
  });

  // Proces sa po kliknutí „Nahrať" zobudí hneď — ale staré čakajúce žiadosti
  // (po vypršanom prihlásení) ho burcovať nesmú, inak by každých 5 s bil Graph.
  it('zobudí sa len na novú žiadosť, nie na staré čakajúce', async () => {
    const { database, folder } = await pripravDb();
    await vyber(database, folder, [{ id: 'stara', name: 'stara.pdf' }]);
    const zaciatokCyklu = new Date(Date.now() + 1_000);
    expect(await pribudliZiadosti(database, zaciatokCyklu)).toBe(false);
    await database.query(`UPDATE sharepoint_import_requests SET created_at = now() + interval '1 hour'`);
    expect(await pribudliZiadosti(database, zaciatokCyklu)).toBe(true);
  });
});

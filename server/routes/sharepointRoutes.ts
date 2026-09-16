// Pripojenie SharePointu a nastavenie priečinkov.
//
// Pripojenie je jedno na účtovnú kanceláriu — SharePoint si zakladá sám
// účtovník, prihlási sa svojím kontom a to isté konto vidí na všetky firmy,
// ktoré vedie. Priečinky sa priraďujú per firma.
import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { writeAudit } from '../audit.js';
import { requireBrowserAuth, requireCsrf, requireOrganizationAccess, requireRole } from '../auth.js';
import type { ServerConfig } from '../config.js';
import type { Database } from '../db/database.js';
import { HttpError } from '../http.js';
import { decryptSecret, encryptSecret } from '../security.js';
import {
  authorizeUrl, exchangeCodeForTokens, graphClient, SharePointError,
  type SharePointClient,
} from '../services/sharepointService.js';
import { cakajuNaNahratie, uzNahrate } from '../services/sharepointPollService.js';

/** Koľko má účtovník na dokončenie prihlásenia. */
const STATE_PLATNOST_MS = 15 * 60 * 1000;

function redirectUri(config: ServerConfig): string {
  return `${config.appBaseUrl.replace(/\/$/, '')}/api/sharepoint/callback`;
}

/**
 * `state` je podpísaný, nie uložený v tabuľke.
 *
 * Nesie tenanta a používateľa cez presmerovanie k Microsoftu a späť. Podpis
 * (HMAC tým istým kľúčom, ktorým sa šifrujú tokeny) robí to isté, čo by robil
 * riadok v databáze — len bez tabuľky, ktorú treba upratovať. Platnosť je
 * súčasťou podpísaného obsahu, takže starý odkaz sa nedá použiť.
 */
function podpisState(payload: object, key: string | undefined): string {
  if (!key) throw new HttpError(503, 'sharepoint_not_configured', 'SharePoint nie je nakonfigurovaný');
  const telo = Buffer.from(JSON.stringify(payload)).toString('base64url');
  return `${telo}.${createHmac('sha256', key).update(telo).digest('base64url')}`;
}

function overState(state: string, key: string | undefined): { tenantId: string; userId: string; exp: number } {
  const [telo, podpis] = state.split('.');
  if (!telo || !podpis || !key) throw new HttpError(400, 'bad_state', 'Neplatný návrat z prihlásenia');
  const ocakavany = createHmac('sha256', key).update(telo).digest('base64url');
  const a = Buffer.from(podpis);
  const b = Buffer.from(ocakavany);
  if (a.length !== b.length || !timingSafeEqual(a, b)) {
    throw new HttpError(400, 'bad_state', 'Neplatný návrat z prihlásenia');
  }
  const payload = JSON.parse(Buffer.from(telo, 'base64url').toString('utf8'));
  if (typeof payload.exp !== 'number' || payload.exp < Date.now()) {
    throw new HttpError(400, 'state_expired', 'Prihlásenie trvalo príliš dlho, skúste znova');
  }
  return payload;
}

export type SharePointClientFactory = (options: {
  msTenantId: string; refreshToken: string; onRotated(token: string): Promise<void>;
}) => SharePointClient;

export function registerSharePointRoutes(
  app: FastifyInstance,
  database: Database,
  config: ServerConfig,
  /** Kvôli testom — inak skutočný Graph. */
  vytvorKlienta: SharePointClientFactory = (options) => graphClient({
    clientId: config.sharepoint.clientId!, clientSecret: config.sharepoint.clientSecret!,
    tokens: {
      msTenantId: options.msTenantId, refreshToken: options.refreshToken,
      onRefreshTokenRotated: options.onRotated,
    },
  }),
): void {
  interface ConnectionRow extends Record<string, unknown> {
    id: string; ms_tenant_id: string; account_email: string; account_name: string | null;
    refresh_token_encrypted: string; connected_at: Date; last_error: string | null;
  }

  async function nacitajPripojenie(tenantId: string): Promise<ConnectionRow | undefined> {
    const result = await database.query<ConnectionRow>(
      'SELECT * FROM sharepoint_connections WHERE tenant_id=$1', [tenantId],
    );
    return result.rows[0];
  }

  /** Klient postavený na uloženom pripojení kancelárie. */
  async function klientPreTenant(tenantId: string): Promise<SharePointClient> {
    const pripojenie = await nacitajPripojenie(tenantId);
    if (!pripojenie) throw new HttpError(409, 'sharepoint_not_connected', 'SharePoint nie je pripojený');
    return vytvorKlienta({
      msTenantId: pripojenie.ms_tenant_id,
      refreshToken: decryptSecret(pripojenie.refresh_token_encrypted, config.secretEncryptionKey),
      onRotated: async (token) => {
        await database.query(
          'UPDATE sharepoint_connections SET refresh_token_encrypted=$1, updated_at=now() WHERE id=$2',
          [encryptSecret(token, config.secretEncryptionKey), pripojenie.id],
        );
      },
    });
  }

  app.get('/api/sharepoint/connection', async (request) => {
    const auth = await requireBrowserAuth(request, database);
    const pripojenie = await nacitajPripojenie(auth.tenantId);
    const priecinky = await database.query(
      `SELECT f.organization_id AS "organizationId", o.name AS "organizationName",
              f.site_id AS "siteId", f.drive_id AS "driveId",
              f.nespracovane_folder_id AS "nespracovaneId", f.spracovane_folder_id AS "spracovaneId",
              f.chybne_folder_id AS "chybneId", f.active, f.last_poll_at AS "lastPollAt",
              f.last_error AS "lastError"
         FROM sharepoint_folders f
         JOIN organizations o ON o.id = f.organization_id
        WHERE f.tenant_id=$1
        ORDER BY o.name`,
      [auth.tenantId],
    );
    return {
      // Registrácia aplikácie chýba → v nastaveniach sa ukáže, že to najprv
      // musí doplniť správca servera, nie že je niečo pokazené.
      configured: Boolean(config.sharepoint.clientId && config.sharepoint.clientSecret && config.secretEncryptionKey),
      connection: pripojenie
        ? {
          accountEmail: pripojenie.account_email,
          accountName: pripojenie.account_name,
          connectedAt: pripojenie.connected_at,
          lastError: pripojenie.last_error,
        }
        : null,
      folders: priecinky.rows,
    };
  });

  app.post('/api/sharepoint/authorize', async (request) => {
    const auth = await requireBrowserAuth(request, database);
    requireCsrf(request, auth);
    requireRole(auth, ['admin']);
    if (!config.sharepoint.clientId) {
      throw new HttpError(503, 'sharepoint_not_configured', 'SharePoint nie je nakonfigurovaný');
    }
    return {
      url: authorizeUrl({
        clientId: config.sharepoint.clientId,
        redirectUri: redirectUri(config),
        state: podpisState(
          { tenantId: auth.tenantId, userId: auth.userId, exp: Date.now() + STATE_PLATNOST_MS },
          config.secretEncryptionKey,
        ),
      }),
    };
  });

  // Návrat od Microsoftu. Otvára ho prehliadač, nie náš kód — preto žiadne
  // CSRF ani session, totožnosť nesie podpísaný state.
  app.get('/api/sharepoint/callback', async (request, reply) => {
    const query = z.object({
      code: z.string().min(1).optional(),
      state: z.string().min(1),
      error: z.string().optional(),
      error_description: z.string().optional(),
    }).parse(request.query);
    const { tenantId, userId } = overState(query.state, config.secretEncryptionKey);
    const nastavenia = `${config.appBaseUrl.replace(/\/$/, '')}/nastavenia?tab=sharepoint`;

    if (query.error || !query.code) {
      return reply.redirect(`${nastavenia}&sharepoint=${encodeURIComponent(query.error ?? 'no_code')}`);
    }
    try {
      const tokens = await exchangeCodeForTokens({
        clientId: config.sharepoint.clientId!,
        clientSecret: config.sharepoint.clientSecret!,
        redirectUri: redirectUri(config),
        code: query.code,
      });
      await database.query(
        `INSERT INTO sharepoint_connections
          (id,tenant_id,ms_tenant_id,account_email,account_name,refresh_token_encrypted,connected_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7)
         ON CONFLICT (tenant_id) DO UPDATE SET
           ms_tenant_id=EXCLUDED.ms_tenant_id, account_email=EXCLUDED.account_email,
           account_name=EXCLUDED.account_name, refresh_token_encrypted=EXCLUDED.refresh_token_encrypted,
           connected_by=EXCLUDED.connected_by, connected_at=now(),
           last_error=NULL, last_error_at=NULL, updated_at=now()`,
        [randomUUID(), tenantId, tokens.msTenantId, tokens.accountEmail, tokens.accountName ?? null,
          encryptSecret(tokens.refreshToken, config.secretEncryptionKey), userId],
      );
      await writeAudit(database, {
        tenantId, actorType: 'user', actorId: userId,
        action: 'sharepoint.connected', entityType: 'sharepoint_connection', entityId: tokens.msTenantId,
        correlationId: request.id, metadata: { accountEmail: tokens.accountEmail },
      });
      return reply.redirect(`${nastavenia}&sharepoint=ok`);
    } catch (error) {
      const dovod = error instanceof Error ? error.message : 'unknown';
      return reply.redirect(`${nastavenia}&sharepoint=${encodeURIComponent(dovod.slice(0, 120))}`);
    }
  });

  app.delete('/api/sharepoint/connection', async (request) => {
    const auth = await requireBrowserAuth(request, database);
    requireCsrf(request, auth);
    requireRole(auth, ['admin']);
    // Priečinky odchádzajú s pripojením — bez neho sú nepoužiteľné a nechať
    // ich by znamenalo, že po opätovnom pripojení sa ticho rozbehnú znova.
    await database.transaction(async (tx) => {
      await tx.query('DELETE FROM sharepoint_folders WHERE tenant_id=$1', [auth.tenantId]);
      await tx.query('DELETE FROM sharepoint_connections WHERE tenant_id=$1', [auth.tenantId]);
    });
    await writeAudit(database, {
      tenantId: auth.tenantId, actorType: 'user', actorId: auth.userId,
      action: 'sharepoint.disconnected', entityType: 'sharepoint_connection', entityId: auth.tenantId,
      correlationId: request.id, metadata: {},
    });
    return { ok: true };
  });

  app.put('/api/sharepoint/folders', async (request, reply) => {
    const auth = await requireBrowserAuth(request, database);
    requireCsrf(request, auth);
    requireRole(auth, ['admin', 'uctovnik']);
    const body = z.object({
      organizationId: z.string().uuid(),
      nespracovaneUrl: z.string().url().max(2000),
      spracovaneUrl: z.string().url().max(2000),
      chybneUrl: z.string().url().max(2000).optional(),
    }).strict().parse(request.body);
    await requireOrganizationAccess(database, auth, body.organizationId);

    const client = await klientPreTenant(auth.tenantId);
    const [nespracovane, spracovane, chybne] = await Promise.all([
      client.resolveFolderUrl(body.nespracovaneUrl),
      client.resolveFolderUrl(body.spracovaneUrl),
      body.chybneUrl ? client.resolveFolderUrl(body.chybneUrl) : Promise.resolve(undefined),
    ]).catch((error) => {
      const sp = error instanceof SharePointError;
      throw new HttpError(sp && error.code === 'not_found' ? 404 : 422, 'folder_unresolved',
        `Priečinok sa nepodarilo nájsť: ${error instanceof Error ? error.message : 'neznáma chyba'}`);
    });

    // Presun medzi knižnicami Graph nerobí — s rôznymi diskami by doklad
    // navždy zostal v „nespracované" a nikto by nevedel prečo.
    if (spracovane.driveId !== nespracovane.driveId
      || (chybne && chybne.driveId !== nespracovane.driveId)) {
      throw new HttpError(422, 'folders_different_drives',
        'Všetky tri priečinky musia byť v tej istej knižnici dokumentov');
    }
    if (spracovane.itemId === nespracovane.itemId || chybne?.itemId === nespracovane.itemId) {
      throw new HttpError(422, 'folders_same', 'Priečinky musia byť rôzne');
    }

    await database.query(
      `INSERT INTO sharepoint_folders
        (id,tenant_id,organization_id,site_id,drive_id,nespracovane_folder_id,spracovane_folder_id,chybne_folder_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
       ON CONFLICT (organization_id) DO UPDATE SET
         site_id=EXCLUDED.site_id, drive_id=EXCLUDED.drive_id,
         nespracovane_folder_id=EXCLUDED.nespracovane_folder_id,
         spracovane_folder_id=EXCLUDED.spracovane_folder_id,
         chybne_folder_id=EXCLUDED.chybne_folder_id,
         active=true, last_error=NULL, updated_at=now()`,
      [randomUUID(), auth.tenantId, body.organizationId, nespracovane.driveId, nespracovane.driveId,
        nespracovane.itemId, spracovane.itemId, chybne?.itemId ?? null],
    );
    await writeAudit(database, {
      tenantId: auth.tenantId, organizationId: body.organizationId, actorType: 'user', actorId: auth.userId,
      action: 'sharepoint.folders_set', entityType: 'sharepoint_folders', entityId: body.organizationId,
      correlationId: request.id, metadata: { nespracovane: nespracovane.name, spracovane: spracovane.name },
    });
    return reply.code(200).send({
      nespracovane: nespracovane.name, spracovane: spracovane.name, chybne: chybne?.name ?? null,
    });
  });

  app.delete('/api/sharepoint/folders/:organizationId', async (request) => {
    const auth = await requireBrowserAuth(request, database);
    requireCsrf(request, auth);
    requireRole(auth, ['admin', 'uctovnik']);
    const { organizationId } = z.object({ organizationId: z.string().uuid() }).parse(request.params);
    await requireOrganizationAccess(database, auth, organizationId);
    await database.query(
      'DELETE FROM sharepoint_folders WHERE tenant_id=$1 AND organization_id=$2',
      [auth.tenantId, organizationId],
    );
    return { ok: true };
  });

  // ─── Okno „Nahrať zo SharePointu" ─────────────────────────────────────────
  // Poller už nesťahuje všetko, čo v priečinku pribudne. Účtovník si pozrie
  // obsah priečinka firmy, vyberie súbory a poller zoberie len tie.

  interface PriecinkyRow extends Record<string, unknown> {
    drive_id: string;
    nespracovane_folder_id: string;
    chybne_folder_id: string | null;
  }

  async function priecinkyFirmy(tenantId: string, organizationId: string): Promise<PriecinkyRow> {
    const result = await database.query<PriecinkyRow>(
      `SELECT drive_id, nespracovane_folder_id, chybne_folder_id FROM sharepoint_folders
        WHERE tenant_id=$1 AND organization_id=$2 AND active=true`,
      [tenantId, organizationId],
    );
    if (!result.rows[0]) {
      throw new HttpError(409, 'sharepoint_folders_missing', 'Firma nemá nastavené priečinky SharePointu (Nastavenia → SharePoint)');
    }
    return result.rows[0];
  }

  /** Výpis priečinka. Vypršané prihlásenie sa dá opraviť len v nastaveniach — povie to rovno. */
  async function vypisPriecinka(tenantId: string, driveId: string, folderId: string) {
    const client = await klientPreTenant(tenantId);
    try {
      return await client.list(driveId, folderId);
    } catch (error) {
      if (error instanceof SharePointError && error.code === 'auth_expired') {
        throw new HttpError(409, 'sharepoint_auth_expired',
          'Prihlásenie do SharePointu vypršalo — pripojte ho znova v Nastavenia → SharePoint');
      }
      throw new HttpError(502, 'sharepoint_list_failed',
        `Priečinok sa nepodarilo načítať: ${error instanceof Error ? error.message : 'neznáma chyba'}`);
    }
  }

  const zdrojSchema = z.enum(['nespracovane', 'chybne']);

  // Obsah priečinka firmy — vždy živý výpis zo SharePointu, nič sa neukladá.
  app.get('/api/sharepoint/files/:organizationId', async (request) => {
    const auth = await requireBrowserAuth(request, database);
    const { organizationId } = z.object({ organizationId: z.string().uuid() }).parse(request.params);
    const { zdroj } = z.object({ zdroj: zdrojSchema.default('nespracovane') }).parse(request.query);
    await requireOrganizationAccess(database, auth, organizationId);
    const priecinky = await priecinkyFirmy(auth.tenantId, organizationId);
    const folderId = zdroj === 'chybne' ? priecinky.chybne_folder_id : priecinky.nespracovane_folder_id;
    // „Chybné" je nepovinné — bez neho karta povie, že priečinok nie je nastavený.
    if (!folderId) return { nastavene: false, subory: [] };

    const subory = await vypisPriecinka(auth.tenantId, priecinky.drive_id, folderId);
    const scope = { tenantId: auth.tenantId, organizationId };
    const [nahrate, cakaju] = await Promise.all([
      uzNahrate(database, scope, subory.map((subor) => subor.id)),
      cakajuNaNahratie(database, scope),
    ]);
    return {
      nastavene: true,
      subory: subory
        .map((subor) => ({
          id: subor.id,
          nazov: subor.name,
          velkost: subor.size,
          upravene: subor.modifiedAt ?? null,
          // Doklad ostáva v „nespracované", kým neprejde do POHODY — teda dni po
          // nahratí. Bez tohto stavu by ho účtovník videl ako nový a nahral znova.
          stav: nahrate.has(subor.id) ? 'nahrate' : cakaju.has(subor.id) ? 'caka' : 'nove',
        }))
        // Najnovšie navrch: to, čo klient práve hodil, je to, čo účtovník hľadá.
        .sort((a, b) => (b.upravene ?? '').localeCompare(a.upravene ?? '')),
    };
  });

  app.post('/api/sharepoint/import/:organizationId', async (request, reply) => {
    const auth = await requireBrowserAuth(request, database);
    requireCsrf(request, auth);
    requireRole(auth, ['admin', 'uctovnik']);
    const { organizationId } = z.object({ organizationId: z.string().uuid() }).parse(request.params);
    const body = z.object({
      zdroj: zdrojSchema,
      itemIds: z.array(z.string().min(1).max(200)).min(1).max(200),
    }).strict().parse(request.body);
    await requireOrganizationAccess(database, auth, organizationId);
    const priecinky = await priecinkyFirmy(auth.tenantId, organizationId);
    const folderId = body.zdroj === 'chybne' ? priecinky.chybne_folder_id : priecinky.nespracovane_folder_id;
    if (!folderId) throw new HttpError(409, 'sharepoint_folder_missing', 'Priečinok „chybné" nie je nastavený');

    // Prijmú sa len súbory, ktoré v tom priečinku naozaj sú. Id z požiadavky by
    // inak dovolilo stiahnuť čokoľvek z celej knižnice dokumentov — aj súbory
    // inej firmy alebo mimo priečinkov.
    const vPriecinku = new Map(
      (await vypisPriecinka(auth.tenantId, priecinky.drive_id, folderId)).map((subor) => [subor.id, subor]),
    );
    const scope = { tenantId: auth.tenantId, organizationId };
    const nahrate = await uzNahrate(database, scope, body.itemIds);

    let zaradene = 0;
    let preskocene = 0;
    await database.transaction(async (tx) => {
      for (const itemId of new Set(body.itemIds)) {
        const subor = vPriecinku.get(itemId);
        if (!subor || nahrate.has(itemId)) { preskocene += 1; continue; }
        const vlozene = await tx.query(
          `INSERT INTO sharepoint_import_requests
            (id, tenant_id, organization_id, drive_id, item_id, file_name, zdroj, requested_by)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
           ON CONFLICT DO NOTHING`,
          [randomUUID(), auth.tenantId, organizationId, priecinky.drive_id, itemId, subor.name, body.zdroj, auth.userId],
        );
        // Už čaká (dvojklik, druhé okno) — nič sa nestane.
        if (vlozene.rowCount > 0) zaradene += 1; else preskocene += 1;
      }
    });
    await writeAudit(database, {
      tenantId: auth.tenantId, organizationId, actorType: 'user', actorId: auth.userId,
      action: 'sharepoint.import_requested', entityType: 'sharepoint_folders', entityId: organizationId,
      correlationId: request.id, metadata: { zdroj: body.zdroj, zaradene, preskocene },
    });
    return reply.code(202).send({ zaradene, preskocene });
  });
}

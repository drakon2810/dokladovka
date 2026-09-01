// Klient k Microsoft Graphu — čítanie priečinka, stiahnutie súboru, presun.
//
// Celý styk so SharePointom vedie cez rozhranie SharePointClient, aby sa dal
// v testoch nahradiť. Rovnaký prístup ako Embedder v embeddingService: kód,
// ktorý sa nedá spustiť bez cudzieho účtu, sa nesmie dať overiť iba ručne.
import { setTimeout as delay } from 'node:timers/promises';

const GRAPH = 'https://graph.microsoft.com/v1.0';

export interface SharePointFile {
  id: string;
  name: string;
  size: number;
}

export interface SharePointClient {
  /** Súbory v priečinku. Podpriečinky sa ignorujú — klient tam nemá čo triediť. */
  list(driveId: string, folderId: string): Promise<SharePointFile[]>;
  download(driveId: string, itemId: string): Promise<Buffer>;
  /** Presun a premenovanie naraz — Graph to zvládne jedným PATCH-om. */
  move(driveId: string, itemId: string, targetFolderId: string, newName: string): Promise<void>;
}

export type SharePointErrorCode = 'auth_expired' | 'not_found' | 'throttled' | 'graph_error';

/**
 * Dôvod zlyhania sa nesie v kóde, nie v texte správy, lebo volajúci sa podľa
 * neho rozhoduje: 'auth_expired' znamená „povedz účtovníkovi, nech sa pripojí
 * znova" a ďalšie pokusy nemajú zmysel, kým to neurobí. Ostatné sú dočasné.
 */
export class SharePointError extends Error {
  constructor(
    message: string,
    readonly code: SharePointErrorCode,
    readonly status?: number,
  ) {
    super(message);
    this.name = 'SharePointError';
  }
}

export interface GraphTokens {
  msTenantId: string;
  refreshToken: string;
  /**
   * Microsoft pri každom obnovení vydá NOVÝ refresh token a starý po čase
   * zneplatní. Keby sa neuložil, pripojenie by po prvom vypršaní prestalo
   * fungovať a nikto by nevedel prečo — preto to nie je voliteľné.
   */
  onRefreshTokenRotated(token: string): Promise<void>;
}

export interface GraphClientOptions {
  clientId: string;
  clientSecret: string;
  tokens: GraphTokens;
  /** Kvôli testom; inak globálny fetch. */
  fetchImpl?: typeof fetch;
}

interface TokenResponse {
  access_token?: string;
  expires_in?: number;
  refresh_token?: string;
  error?: string;
  error_description?: string;
}

export function graphClient(options: GraphClientOptions): SharePointClient {
  const doFetch = options.fetchImpl ?? fetch;
  let accessToken: string | undefined;
  let expiresAt = 0;
  let refreshToken = options.tokens.refreshToken;

  async function token(): Promise<string> {
    // 60 s rezerva, aby token nevypršal medzi kontrolou a použitím.
    if (accessToken && Date.now() < expiresAt - 60_000) return accessToken;
    const response = await doFetch(
      `https://login.microsoftonline.com/${encodeURIComponent(options.tokens.msTenantId)}/oauth2/v2.0/token`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          client_id: options.clientId,
          client_secret: options.clientSecret,
          grant_type: 'refresh_token',
          refresh_token: refreshToken,
          scope: 'offline_access https://graph.microsoft.com/Files.ReadWrite.All',
        }),
      },
    );
    const body = (await response.json().catch(() => ({}))) as TokenResponse;
    if (!response.ok || !body.access_token) {
      // invalid_grant = token je neplatný natrvalo (zmenené heslo, odvolaný
      // súhlas, 90 dní ticha). Opakovanie nepomôže, treba nové prihlásenie.
      const permanent = body.error === 'invalid_grant' || response.status === 400;
      throw new SharePointError(
        body.error_description || body.error || `Token endpoint vrátil ${response.status}`,
        permanent ? 'auth_expired' : 'graph_error',
        response.status,
      );
    }
    accessToken = body.access_token;
    expiresAt = Date.now() + (body.expires_in ?? 3600) * 1000;
    if (body.refresh_token && body.refresh_token !== refreshToken) {
      refreshToken = body.refresh_token;
      await options.tokens.onRefreshTokenRotated(body.refresh_token);
    }
    return accessToken;
  }

  async function graph(path: string, init: RequestInit = {}, retryOnThrottle = true): Promise<Response> {
    const response = await doFetch(`${GRAPH}${path}`, {
      ...init,
      headers: { ...init.headers, authorization: `Bearer ${await token()}` },
    });
    if (response.status === 429 || response.status === 503) {
      // Graph škrtí a hovorí, ako dlho počkať. Jeden pokus tu ušetrí celý
      // cyklus pollera; ak ani ten neprejde, nech to rieši opakovanie jobu.
      if (retryOnThrottle) {
        const wait = Number(response.headers.get('retry-after') ?? '5');
        await delay(Math.min(Number.isFinite(wait) ? wait : 5, 30) * 1000);
        return graph(path, init, false);
      }
      throw new SharePointError('Microsoft Graph obmedzuje požiadavky', 'throttled', response.status);
    }
    if (response.status === 401) throw new SharePointError('Prístup zamietnutý', 'auth_expired', 401);
    if (response.status === 404) throw new SharePointError('Položka neexistuje', 'not_found', 404);
    // 3xx nie je chyba: sťahovanie chytá presmerovanie zámerne (redirect:
    // 'manual'), aby token neposlalo na cudziu adresu. Bez tejto výnimky by
    // každé stiahnutie spadlo hneď na prvom kroku.
    const presmerovanie = response.status >= 300 && response.status < 400;
    if (!response.ok && !presmerovanie) {
      const detail = await response.text().catch(() => '');
      throw new SharePointError(`Graph vrátil ${response.status}: ${detail}`.slice(0, 500), 'graph_error', response.status);
    }
    return response;
  }

  return {
    async list(driveId, folderId) {
      const files: SharePointFile[] = [];
      let path: string | undefined =
        `/drives/${driveId}/items/${folderId}/children?$select=id,name,size,file&$top=200`;
      while (path) {
        const body = (await (await graph(path)).json()) as {
          value?: Array<{ id?: string; name?: string; size?: number; file?: unknown }>;
          '@odata.nextLink'?: string;
        };
        for (const entry of body.value ?? []) {
          // Bez `file` je to priečinok — do spracovania nepatrí.
          if (!entry.file || !entry.id || !entry.name) continue;
          files.push({ id: entry.id, name: entry.name, size: entry.size ?? 0 });
        }
        path = body['@odata.nextLink']?.replace(GRAPH, '');
      }
      return files;
    },

    async download(driveId, itemId) {
      // /content presmeruje na dočasnú adresu, ktorá už autorizáciu nechce —
      // a poslať jej náš token by znamenalo vypustiť ho na cudzí host. Preto
      // presmerovanie chytáme ručne a druhú požiadavku posielame bez hlavičky.
      const response = await graph(`/drives/${driveId}/items/${itemId}/content`, { redirect: 'manual' });
      const location = response.headers.get('location');
      if (!location) return Buffer.from(await response.arrayBuffer());
      const file = await doFetch(location);
      if (!file.ok) throw new SharePointError(`Stiahnutie zlyhalo (${file.status})`, 'graph_error', file.status);
      return Buffer.from(await file.arrayBuffer());
    },

    async move(driveId, itemId, targetFolderId, newName) {
      // conflictBehavior=rename: dva doklady s rovnakým názvom v ten istý deň
      // sú bežné a prepísať ten prvý by znamenalo stratiť doklad.
      await graph(`/drives/${driveId}/items/${itemId}?@microsoft.graph.conflictBehavior=rename`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name: newName, parentReference: { id: targetFolderId } }),
      });
    },
  };
}

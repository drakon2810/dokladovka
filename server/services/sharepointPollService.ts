// Jeden prechod pre jednu firmu: presun vybavených súborov a nahratie tých,
// ktoré si účtovník vybral.
//
// Poller už NEsťahuje všetko, čo v priečinku „nespracované" pribudne. Účtovník
// si v okne „Nahrať zo SharePointu" vyberie súbory a poller zoberie len tie
// (sharepoint_import_requests). Presun do „spracované" po prenose do POHODY
// ostáva, ako bol — odvodzuje sa zo stavu dokladov.
import { randomUUID } from 'node:crypto';
import type { ServerConfig } from '../config.js';
import type { Queryable } from '../db/database.js';
import { ingestFiles } from '../inbound/ingestFiles.js';
import { najdiNaPresun, presunVybavene } from './sharepointMoveService.js';
import { decryptSecret, encryptSecret } from '../security.js';
import type { ObjectStorage } from '../storage.js';
import { SharePointError, type SharePointClient } from './sharepointService.js';

/** Strop na jeden cyklus. Zvyšok si vezme ďalší beh o pár minút. */
const MAX_NA_CYKLUS = 20;

export interface SharePointFolderRow {
  id: string;
  tenant_id: string;
  organization_id: string;
  drive_id: string;
  nespracovane_folder_id: string;
  spracovane_folder_id: string;
  chybne_folder_id: string | null;
}

export interface PollResult {
  /** Súbory vybrané na nahratie, ktoré tento cyklus spracoval. */
  videne: number;
  prijate: number;
  /** Vybrané, ale medzitým už nahraté — nesťahovali sa znova. */
  preskocene: number;
  chybne: number;
  /** Súbor, ktorý v systéme už je — prišiel skôr inou cestou. Nie je to chyba. */
  duplicity: number;
  /** Vybavené doklady, ktorých súbor odišiel do „spracované". */
  presunute: number;
  chyba?: string;
}

/**
 * Ktoré súbory sú v Dokladovke už nahraté. Kľúčom je id položky v SharePointe,
 * nie obsah — obsah rieši až `isTechnicalDuplicate`, ale to by znamenalo súbor
 * najprv stiahnuť.
 *
 * „Nahratý" znamená to isté, čo pre `isTechnicalDuplicate`: súbor sa práve
 * spracúva, alebo z neho vznikol doklad, ktorý nie je zamietnutý. Fotka v
 * karanténe ani odmietnutá duplicita nahratie znova neblokuje — práve preto
 * sa dá súbor z „chybné" nahrať ešte raz.
 */
export async function uzNahrate(
  database: Queryable,
  scope: { tenantId: string; organizationId: string },
  itemIds: string[],
): Promise<Set<string>> {
  if (itemIds.length === 0) return new Set();
  const result = await database.query<{ sharepoint_item_id: string }>(
    `SELECT DISTINCT a.sharepoint_item_id FROM inbound_attachments a
       LEFT JOIN documents d ON d.id = a.document_id
      WHERE a.tenant_id=$1 AND a.organization_id=$2 AND a.sharepoint_item_id = ANY($3::text[])
        AND (a.status IN ('queued','processing')
          OR (a.status='document_created' AND (a.document_id IS NULL OR d.status <> 'zamietnuty')))`,
    [scope.tenantId, scope.organizationId, itemIds],
  );
  return new Set(result.rows.map((row) => row.sharepoint_item_id));
}

/** Súbory, ktoré už čakajú na nahratie — v okne sa nedajú vybrať znova. */
export async function cakajuNaNahratie(
  database: Queryable,
  scope: { tenantId: string; organizationId: string },
): Promise<Set<string>> {
  const result = await database.query<{ item_id: string }>(
    `SELECT item_id FROM sharepoint_import_requests
      WHERE tenant_id=$1 AND organization_id=$2 AND done_at IS NULL`,
    [scope.tenantId, scope.organizationId],
  );
  return new Set(result.rows.map((row) => row.item_id));
}

/**
 * Pribudla od `od` žiadosť, ktorá ešte čaká? Podľa toho sa proces zobudí skôr
 * než o celý interval — účtovník po kliknutí „Nahrať" nemá minútu pozerať
 * na nič. Staršie čakajúce (napr. po vypršanom prihlásení) proces neburcujú,
 * inak by každých pár sekúnd bil Graph neplatným tokenom.
 */
export async function pribudliZiadosti(database: Queryable, od: Date): Promise<boolean> {
  const result = await database.query(
    'SELECT 1 FROM sharepoint_import_requests WHERE done_at IS NULL AND created_at > $1 LIMIT 1',
    [od.toISOString()],
  );
  return result.rowCount > 0;
}

interface ZiadostRow extends Record<string, unknown> {
  id: string;
  drive_id: string;
  item_id: string;
  file_name: string;
}

async function uzavriZiadost(database: Queryable, id: string, chyba: string | null): Promise<void> {
  await database.query(
    'UPDATE sharepoint_import_requests SET done_at=now(), error=$1 WHERE id=$2',
    [chyba?.slice(0, 500) ?? null, id],
  );
}

export async function pollFolder(
  deps: { database: Queryable; storage: ObjectStorage; config: ServerConfig },
  folder: SharePointFolderRow,
  client: SharePointClient,
): Promise<PollResult> {
  const scope = { tenantId: folder.tenant_id, organizationId: folder.organization_id };
  const vysledok: PollResult = { videne: 0, prijate: 0, preskocene: 0, chybne: 0, duplicity: 0, presunute: 0 };

  // Najprv odchod, potom príchod. Zmiznutie prenesenej faktúry z „nespracované"
  // je to, na čo klient pozerá — a keby sa robilo až po výpise, zdržal by ho
  // ktorýkoľvek nový súbor.
  const presun = await presunVybavene(deps.database, client, await najdiNaPresun(deps.database, scope));
  vysledok.presunute = presun.presunute;
  // Zlyhaný presun sa opakuje donekonečna. Bez zápisu dôvodu by to bol súbor,
  // ktorý ticho leží v „nespracované" a nikto nevie prečo.
  if (presun.chyba) vysledok.chyba = presun.chyba;

  // Len súbory, ktoré si účtovník vybral. Priečinok sa tu vôbec nevypisuje —
  // čo v ňom je, ukazuje okno „Nahrať zo SharePointu", keď ho niekto otvorí.
  const ziadosti = (await deps.database.query<ZiadostRow>(
    `SELECT id, drive_id, item_id, file_name FROM sharepoint_import_requests
      WHERE tenant_id=$1 AND organization_id=$2 AND done_at IS NULL
      ORDER BY created_at LIMIT $3`,
    [scope.tenantId, scope.organizationId, MAX_NA_CYKLUS],
  )).rows;
  vysledok.videne = ziadosti.length;
  const nahrate = await uzNahrate(deps.database, scope, ziadosti.map((ziadost) => ziadost.item_id));

  for (const ziadost of ziadosti) {
    // Medzitým ho nahral niekto iný (dve okná, dvaja účtovníci) — nesťahuje sa.
    if (nahrate.has(ziadost.item_id)) {
      vysledok.preskocene += 1;
      await uzavriZiadost(deps.database, ziadost.id, null);
      continue;
    }
    try {
      const bytes = await client.download(ziadost.drive_id, ziadost.item_id);
      const prijem = await ingestFiles(
        deps,
        { ...scope, correlationId: randomUUID() },
        {
          provider: 'sharepoint', storagePrefix: 'sharepoint',
          subject: `SharePoint — ${ziadost.file_name}`, senderName: 'SharePoint',
        },
        [{
          fileName: ziadost.file_name,
          // Skutočný typ určí magic-byte detekcia; SharePoint nám ho tu nedáva.
          declaredMimeType: 'application/octet-stream',
          bytes,
          sharePoint: { driveId: ziadost.drive_id, itemId: ziadost.item_id },
        }],
      );
      // Presun sa tu nerobí. Duplicity aj karanténu odnesie `presunVybavene`
      // v ďalšom cykle — rovnakou cestou ako doklady po prenose do POHODY.
      // Kým sa to nepodarí, značka nie je nastavená a skúsi sa znova; jeden
      // pokus tu znamenal, že po zlyhaní súbor zostal ležať navždy, lebo
      // druhýkrát sa už nespracuje.
      const stav = prijem.results[0];
      if (stav?.status === 'queued') vysledok.prijate += 1;
      else if (stav?.status === 'duplicate') vysledok.duplicity += 1;
      else vysledok.chybne += 1;
      await uzavriZiadost(deps.database, ziadost.id, null);
    } catch (error) {
      vysledok.chybne += 1;
      const dovod = error instanceof Error ? error.message : String(error);
      vysledok.chyba = dovod;
      // Vypršané prihlásenie zastaví celý priečinok — ďalšie súbory by padli
      // rovnako a len by sme Graph zbytočne bili. Žiadosť ostáva čakať a po
      // novom prihlásení sa nahrá sama; účtovník ju nemusí vyberať znova.
      if (error instanceof SharePointError && error.code === 'auth_expired') break;
      // Ostatné (súbor medzitým zmizol, Graph ho nevydal) sa uzavrú s dôvodom —
      // inak by sa sťahoval každý cyklus donekonečna. V okne je potom znova
      // „nový" a dá sa vybrať ešte raz.
      await uzavriZiadost(deps.database, ziadost.id, dovod);
    }
  }

  await zapisStav(deps.database, folder.id, vysledok.chyba ?? null);
  return vysledok;
}

async function zapisStav(database: Queryable, folderId: string, chyba: string | null): Promise<void> {
  await database.query(
    'UPDATE sharepoint_folders SET last_poll_at=now(), last_error=$1, updated_at=now() WHERE id=$2',
    [chyba?.slice(0, 500) ?? null, folderId],
  );
}

interface PripojenieRow extends SharePointFolderRow, Record<string, unknown> {
  ms_tenant_id: string;
  refresh_token_encrypted: string;
  connection_id: string;
}

/**
 * Jeden cyklus cez všetky nastavené priečinky.
 *
 * Klient sa stavia na firmu, nie na tenanta, hoci pripojenie je spoločné —
 * kvôli jednoduchosti. Token sa aj tak drží v pamäti klienta iba počas jedného
 * priečinka, takže sa raz za cyklus vypýta nanovo; pri intervale v minútach to
 * je zanedbateľné oproti riziku, že by dva priečinky prepisovali ten istý
 * rotovaný refresh token.
 */
export async function pollAllFolders(
  deps: { database: Queryable; storage: ObjectStorage; config: ServerConfig },
  vytvorKlienta: (options: {
    clientId: string; clientSecret: string;
    tokens: { msTenantId: string; refreshToken: string; onRefreshTokenRotated(token: string): Promise<void> };
  }) => SharePointClient,
): Promise<Map<string, PollResult>> {
  const vysledky = new Map<string, PollResult>();
  const { clientId, clientSecret } = deps.config.sharepoint;
  if (!clientId || !clientSecret) return vysledky;

  const rows = await deps.database.query<PripojenieRow>(
    `SELECT f.id, f.tenant_id, f.organization_id, f.drive_id, f.nespracovane_folder_id,
            f.spracovane_folder_id, f.chybne_folder_id,
            c.id AS connection_id, c.ms_tenant_id, c.refresh_token_encrypted
       FROM sharepoint_folders f
       JOIN sharepoint_connections c ON c.tenant_id = f.tenant_id
      WHERE f.active = true`,
  );

  for (const row of rows.rows) {
    try {
      const client = vytvorKlienta({
        clientId, clientSecret,
        tokens: {
          msTenantId: row.ms_tenant_id,
          refreshToken: decryptSecret(row.refresh_token_encrypted, deps.config.secretEncryptionKey),
          onRefreshTokenRotated: async (token) => {
            await deps.database.query(
              'UPDATE sharepoint_connections SET refresh_token_encrypted=$1, updated_at=now() WHERE id=$2',
              [encryptSecret(token, deps.config.secretEncryptionKey), row.connection_id],
            );
          },
        },
      });
      const vysledok = await pollFolder(deps, row, client);
      vysledky.set(row.organization_id, vysledok);
      // Prihlásenie vypršalo — patrí to k pripojeniu, nie k priečinku, lebo
      // opraviť sa to dá len novým prihlásením v nastaveniach.
      if (vysledok.chyba) {
        await deps.database.query(
          'UPDATE sharepoint_connections SET last_error=$1, last_error_at=now() WHERE id=$2',
          [vysledok.chyba.slice(0, 500), row.connection_id],
        );
      } else {
        await deps.database.query(
          'UPDATE sharepoint_connections SET last_error=NULL, last_error_at=NULL WHERE id=$1 AND last_error IS NOT NULL',
          [row.connection_id],
        );
      }
    } catch (error) {
      const dovod = error instanceof Error ? error.message : String(error);
      vysledky.set(row.organization_id, { videne: 0, prijate: 0, preskocene: 0, chybne: 0, duplicity: 0, presunute: 0, chyba: dovod });
      await zapisStav(deps.database, row.id, dovod);
    }
  }
  return vysledky;
}

// Jeden prechod priečinkom „nespracované" pre jednu firmu.
//
// Beží dokola každých pár minút, takže musí byť lacný a musí zniesť, že tie
// isté súbory uvidí stokrát: doklad zostáva v priečinku, kým nie je prenesený
// do POHODY, a to trvá dni.
import { randomUUID } from 'node:crypto';
import type { ServerConfig } from '../config.js';
import type { Queryable } from '../db/database.js';
import { ingestFiles } from '../inbound/ingestFiles.js';
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
  videne: number;
  prijate: number;
  /** Už sme ich videli v predošlom behu — nesťahovali sa znova. */
  preskocene: number;
  chybne: number;
  chyba?: string;
}

/**
 * Ktoré súbory sme už raz zobrali. Kľúčom je id položky v SharePointe, nie
 * obsah: obsah rieši až `isTechnicalDuplicate` pri ukladaní, ale to by
 * znamenalo stiahnuť súbor zakaždým nanovo. Pri desiatkach čakajúcich faktúr
 * a cykle každé tri minúty je to rozdiel medzi „lacné" a „sťahujeme to isté
 * celý deň dokola".
 */
async function uzVidene(
  database: Queryable,
  scope: { tenantId: string; organizationId: string },
  itemIds: string[],
): Promise<Set<string>> {
  if (itemIds.length === 0) return new Set();
  const result = await database.query<{ sharepoint_item_id: string }>(
    `SELECT DISTINCT sharepoint_item_id FROM inbound_attachments
      WHERE tenant_id=$1 AND organization_id=$2 AND sharepoint_item_id = ANY($3::text[])`,
    [scope.tenantId, scope.organizationId, itemIds],
  );
  return new Set(result.rows.map((row) => row.sharepoint_item_id));
}

export async function pollFolder(
  deps: { database: Queryable; storage: ObjectStorage; config: ServerConfig },
  folder: SharePointFolderRow,
  client: SharePointClient,
): Promise<PollResult> {
  const scope = { tenantId: folder.tenant_id, organizationId: folder.organization_id };
  const vysledok: PollResult = { videne: 0, prijate: 0, preskocene: 0, chybne: 0 };

  let subory;
  try {
    subory = await client.list(folder.drive_id, folder.nespracovane_folder_id);
  } catch (error) {
    // Zlyhanie výpisu je zlyhanie celého priečinka — zapíše sa a skúsi znova.
    vysledok.chyba = error instanceof Error ? error.message : String(error);
    await zapisStav(deps.database, folder.id, vysledok.chyba);
    return vysledok;
  }
  vysledok.videne = subory.length;

  const videne = await uzVidene(deps.database, scope, subory.map((s) => s.id));
  const nove = subory.filter((s) => !videne.has(s.id));
  vysledok.preskocene = subory.length - nove.length;

  for (const subor of nove.slice(0, MAX_NA_CYKLUS)) {
    try {
      const bytes = await client.download(folder.drive_id, subor.id);
      const prijem = await ingestFiles(
        deps,
        { ...scope, correlationId: randomUUID() },
        {
          provider: 'sharepoint', storagePrefix: 'sharepoint',
          subject: `SharePoint — ${subor.name}`, senderName: 'SharePoint',
        },
        [{
          fileName: subor.name,
          // Skutočný typ určí magic-byte detekcia; SharePoint nám ho tu nedáva.
          declaredMimeType: 'application/octet-stream',
          bytes,
          sharePoint: { driveId: folder.drive_id, itemId: subor.id },
        }],
      );
      const stav = prijem.results[0];
      if (stav?.status === 'queued') vysledok.prijate += 1;
      else {
        vysledok.chybne += 1;
        // Fotka, .docx, poškodené PDF. Keby ostalo ležať v „nespracované",
        // klient sa nikdy nedozvie prečo sa nič nedeje — a priečinok, ktorý
        // má ukazovať nedokončenú prácu, by sa zaplnil trvalým odpadom.
        if (folder.chybne_folder_id) {
          await client.move(folder.drive_id, subor.id, folder.chybne_folder_id, subor.name)
            .catch(() => undefined);
        }
      }
    } catch (error) {
      vysledok.chybne += 1;
      const dovod = error instanceof Error ? error.message : String(error);
      vysledok.chyba = dovod;
      // Vypršané prihlásenie zastaví celý priečinok — ďalšie súbory by padli
      // rovnako a len by sme Graph zbytočne bili.
      if (error instanceof SharePointError && error.code === 'auth_expired') break;
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
      vysledky.set(row.organization_id, { videne: 0, prijate: 0, preskocene: 0, chybne: 0, chyba: dovod });
      await zapisStav(deps.database, row.id, dovod);
    }
  }
  return vysledky;
}

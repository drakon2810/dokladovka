// Presun vybavených súborov z „nespracované" do „spracované".
//
// Zámerne bez fronty jobov: čo sa má presunúť, sa dá odvodiť zo stavu dokladov.
// Poller si to spočíta zakaždým nanovo, takže výpadok Graphu nič nestratí —
// ďalší cyklus to dobehne. Fronta by k tomu pridala opakovania, mŕtve joby a
// možnosť, že sa presun stratí medzi commitom transakcie a odoslaním.
import type { Queryable } from '../db/database.js';
import type { SharePointClient } from './sharepointService.js';

/**
 * Stavy, po ktorých sa s dokladom už nič nestane. Všetko ostatné — vrátane
 * 'chyba', 'karantena' a 'duplicita' — sa ešte môže rozhýbať a súbor teda
 * ešte nie je vybavený.
 */
const VYBAVENE = ['exportovany', 'zamietnuty'];

export interface NaPresun {
  attachment_id: string;
  drive_id: string;
  item_id: string;
  original_file_name: string;
  spracovane_folder_id: string;
  chybne_folder_id: string | null;
  /** Dátum prenosu do POHODY; NULL, keď boli všetky doklady zamietnuté. */
  preneseny_dna: Date | null;
  pohoda_number: string | null;
}

/**
 * Súbory, ktorých doklady sú všetky vybavené a ktoré ešte nie sú presunuté.
 *
 * `d.id = a.document_id OR d.split_from_document_id = a.document_id` pokrýva
 * aj rozdelenie: pri ňom pôvodný doklad zostáva a nové naň ukazujú, pričom
 * reťaz rozdelení je zakázaná — hlbšie ako o úroveň teda ísť netreba.
 */
export async function najdiNaPresun(
  database: Queryable,
  scope: { tenantId: string; organizationId: string },
): Promise<NaPresun[]> {
  const result = await database.query<NaPresun & Record<string, unknown>>(
    `SELECT a.id AS attachment_id, a.sharepoint_drive_id AS drive_id, a.sharepoint_item_id AS item_id,
            a.original_file_name, f.spracovane_folder_id, f.chybne_folder_id,
            (SELECT max(d.updated_at) FROM documents d
              WHERE (d.id = a.document_id OR d.split_from_document_id = a.document_id)
                AND d.status = 'exportovany') AS preneseny_dna,
            (SELECT d.pohoda_number FROM documents d
              WHERE (d.id = a.document_id OR d.split_from_document_id = a.document_id)
                AND d.status = 'exportovany' AND d.pohoda_number IS NOT NULL
              ORDER BY d.updated_at LIMIT 1) AS pohoda_number
       FROM inbound_attachments a
       JOIN sharepoint_folders f
         ON f.organization_id = a.organization_id AND f.tenant_id = a.tenant_id AND f.active = true
      WHERE a.sharepoint_item_id IS NOT NULL
        AND a.sharepoint_moved_at IS NULL
        AND a.document_id IS NOT NULL
        AND a.tenant_id = $2 AND a.organization_id = $3
        AND NOT EXISTS (
          SELECT 1 FROM documents d
           WHERE (d.id = a.document_id OR d.split_from_document_id = a.document_id)
             AND d.status <> ALL($1::text[])
        )`,
    [VYBAVENE, scope.tenantId, scope.organizationId],
  );
  return result.rows;
}

/**
 * Názov, pod ktorým súbor pristane v „spracované".
 *
 * Dátum je to podstatné — v priečinku klienta je vidieť, kedy bol doklad
 * zaúčtovaný. Číslo z POHODY sa pridá, keď ho poznáme; pri viacerých dokladoch
 * z jedného PDF je to číslo prvého, lebo do názvu sa všetky rozumne nezmestia.
 */
export function nazovPoPresune(povodny: string, den: Date | null, pohodaNumber: string | null): string {
  if (!den) return povodny;
  const datum = den.toISOString().slice(0, 10);
  const cislo = pohodaNumber ? `${pohodaNumber.replace(/[\\/:*?"<>|]/g, '-')}_` : '';
  // Predpona, nie prípona: názvy sa tak v priečinku zoradia podľa dátumu
  // zaúčtovania a pôvodný názov ostáva čitateľný.
  return `${datum}_${cislo}${povodny}`;
}

export interface PresunResult {
  presunute: number;
  chyby: number;
}

export async function presunVybavene(
  database: Queryable,
  client: SharePointClient,
  polozky: NaPresun[],
): Promise<PresunResult> {
  const vysledok: PresunResult = { presunute: 0, chyby: 0 };
  for (const polozka of polozky) {
    // Bez dátumu prenosu neexistuje prenesený doklad — všetky boli zamietnuté.
    // Taký súbor nepatrí do „spracované", ale medzi chybné; a keď priečinok pre
    // chybné nie je nastavený, nechá sa ležať a značka sa nenastaví.
    const ciel = polozka.preneseny_dna ? polozka.spracovane_folder_id : polozka.chybne_folder_id;
    if (!ciel) continue;
    try {
      await client.move(
        polozka.drive_id, polozka.item_id, ciel,
        nazovPoPresune(polozka.original_file_name, polozka.preneseny_dna, polozka.pohoda_number),
      );
      await database.query(
        'UPDATE inbound_attachments SET sharepoint_moved_at=now() WHERE id=$1',
        [polozka.attachment_id],
      );
      vysledok.presunute += 1;
    } catch {
      // Značka sa nenastaví, takže to ďalší cyklus skúsi znova — presne preto
      // tu nie je fronta s obmedzeným počtom pokusov.
      vysledok.chyby += 1;
    }
  }
  return vysledok;
}

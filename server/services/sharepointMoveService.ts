// Presun vybavených súborov z „nespracované" do „spracované".
//
// Zámerne bez fronty jobov: čo sa má presunúť, sa dá odvodiť zo stavu dokladov.
// Poller si to spočíta zakaždým nanovo, takže výpadok Graphu nič nestratí —
// ďalší cyklus to dobehne. Fronta by k tomu pridala opakovania, mŕtve joby a
// možnosť, že sa presun stratí medzi commitom transakcie a odoslaním.
import type { Queryable } from '../db/database.js';
import { SharePointError, type SharePointClient } from './sharepointService.js';

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
  /** Dátum prenosu do POHODY; NULL, keď doklad nevznikol alebo bol zamietnutý. */
  preneseny_dna: Date | null;
  pohoda_number: string | null;
  /** Stav prílohy — rozhoduje pri súboroch, z ktorých doklad nikdy nevznikol. */
  attachment_status: string;
}

/**
 * Všetko, čo už nemá čo robiť v priečinku „nespracované".
 *
 * Tri prípady naraz, lebo všetky tri sú tá istá otázka „je s tým súborom
 * hotovo?":
 *   * doklad prenesený do POHODY (alebo zamietnutý) — bežný koniec cesty;
 *   * duplicita — ten istý súbor už v systéme je, prišiel skôr inou cestou;
 *   * karanténa — fotka, .docx, poškodené PDF, doklad z toho nikdy nebude.
 *
 * Posledné dva sa kedysi presúvali hneď pri príjme, jedným pokusom. Keď ten
 * zlyhal (alebo priečinok pre chybné nebol nastavený), súbor zostal ležať
 * navždy: druhýkrát sa už nespracuje, lebo ho poznáme podľa item_id. Odvodený
 * výber to rieši sám — kým značka nie je nastavená, ďalší cyklus to skúsi znova.
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
            a.original_file_name, a.status AS attachment_status,
            f.spracovane_folder_id, f.chybne_folder_id,
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
        AND a.tenant_id = $2 AND a.organization_id = $3
        AND (
          -- Doklad nikdy nevznikol a ani nevznikne.
          a.status IN ('duplicate', 'quarantine')
          OR (
            a.document_id IS NOT NULL
            AND NOT EXISTS (
              SELECT 1 FROM documents d
               WHERE (d.id = a.document_id OR d.split_from_document_id = a.document_id)
                 AND d.status <> ALL($1::text[])
            )
          )
        )`,
    [VYBAVENE, scope.tenantId, scope.organizationId],
  );
  return result.rows;
}

/**
 * Názov, pod ktorým súbor pristane v „spracované": iba číslo, ktoré dokladu
 * pridelila POHODA. Pod tým je doklad zaúčtovaný a pod tým sa hľadá — pôvodný
 * názov od klienta („305 Faktury - dobropisy SPaP.pdf") už nič nehovorí.
 *
 * Bez čísla sa názov nemení. To je duplicita, karanténa alebo ručný XML export,
 * kde žiadne číslo z POHODY neexistuje a vymýšľať si náhradu by len klamalo.
 *
 * Pri viacerých dokladoch z jedného PDF je to číslo prvého — všetky sa do
 * názvu rozumne nezmestia.
 */
export function nazovPoPresune(povodny: string, pohodaNumber: string | null): string {
  if (!pohodaNumber) return povodny;
  // Prípona musí zostať, inak SharePoint prestane súbor otvárať v prehliadači.
  const bodka = povodny.lastIndexOf('.');
  const pripona = bodka > 0 ? povodny.slice(bodka) : '';
  return `${pohodaNumber.replace(/[\\/:*?"<>|]/g, '-')}${pripona}`;
}

export interface PresunResult {
  presunute: number;
  chyby: number;
  /** Prečo posledný presun neprešiel. Bez toho je zlyhanie neviditeľné —
   *  súbor len ticho zostáva ležať a nikto nevie, čo mu bráni. */
  chyba?: string;
}

export async function presunVybavene(
  database: Queryable,
  client: SharePointClient,
  polozky: NaPresun[],
): Promise<PresunResult> {
  const vysledok: PresunResult = { presunute: 0, chyby: 0 };
  for (const polozka of polozky) {
    // Kam súbor patrí:
    //   * karanténa (fotka, .docx, poškodené PDF) → medzi chybné. Keď priečinok
    //     pre chybné nie je nastavený, nechá sa ležať a značka sa nenastaví,
    //     takže sa to skúsi znova, len čo ho účtovník doplní.
    //   * duplicita → medzi spracované: doklad JE vybavený, len nie cez tento
    //     súbor. V „chybné" by klient videl svoju úplne v poriadku faktúru.
    //   * bez dátumu prenosu (všetky doklady zamietnuté) → medzi chybné.
    const doChybnych = polozka.attachment_status === 'quarantine'
      || (polozka.attachment_status !== 'duplicate' && !polozka.preneseny_dna);
    const ciel = doChybnych ? polozka.chybne_folder_id : polozka.spracovane_folder_id;
    if (!ciel) continue;
    try {
      await client.move(
        polozka.drive_id, polozka.item_id, ciel,
        nazovPoPresune(polozka.original_file_name, polozka.pohoda_number),
      );
      await database.query(
        'UPDATE inbound_attachments SET sharepoint_moved_at=now() WHERE id=$1',
        [polozka.attachment_id],
      );
      vysledok.presunute += 1;
    } catch (error) {
      if (error instanceof SharePointError && error.code === 'not_found') {
        // Súbor na tom mieste už nie je — niekto ho v SharePointe presunul
        // alebo zmazal ručne. Presúvať nie je čo a nikdy nebude, takže sa
        // označí za vybavený. Bez toho by sa to skúšalo každú minútu donekonečna
        // a priečinok by natrvalo svietil chybou.
        await database.query(
          'UPDATE inbound_attachments SET sharepoint_moved_at=now() WHERE id=$1',
          [polozka.attachment_id],
        );
        continue;
      }
      // Značka sa nenastaví, takže to ďalší cyklus skúsi znova — presne preto
      // tu nie je fronta s obmedzeným počtom pokusov.
      vysledok.chyby += 1;
      vysledok.chyba = error instanceof Error ? error.message : String(error);
    }
  }
  return vysledok;
}

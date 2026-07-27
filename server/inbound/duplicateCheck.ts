import type { Queryable } from '../db/database.js';

/**
 * Je ten istý súbor (podľa sha256) už v systéme?
 *
 * Zamietnutý doklad NEblokuje: používateľ ho poslal do koša práve preto, aby
 * mohol súbor nahrať znova (napr. keď AI určila zlý typ dokladu). Bez tejto
 * výnimky sa raz zamietnutý súbor už nikdy nedal doručiť — kontrola videla
 * pôvodnú prílohu a každý ďalší pokus odmietla ako technický duplikát.
 *
 * Prílohy so stavom `duplicate` sa tiež nepočítajú — samy nikdy doklad
 * nevytvorili, takže by blokovali len samy seba dokola.
 */
export async function isTechnicalDuplicate(
  database: Queryable,
  scope: { tenantId: string; organizationId: string; sha256: string },
): Promise<boolean> {
  const result = await database.query(
    `SELECT 1 FROM inbound_attachments a
       LEFT JOIN documents d ON d.id = a.document_id
      WHERE a.tenant_id=$1 AND a.organization_id=$2 AND a.sha256=$3
        AND (
          a.status IN ('queued','processing')
          -- 'document_created' bez dokladu = súbor skončil medzi „Inými
          -- dokladmi" (nie je účtovný doklad) — ten tiež netreba nahrávať znova.
          OR (a.status='document_created' AND (a.document_id IS NULL OR d.status <> 'zamietnuty'))
        )
      LIMIT 1`,
    [scope.tenantId, scope.organizationId, scope.sha256],
  );
  return result.rowCount > 0;
}

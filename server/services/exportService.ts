import type { Database } from '../db/database.js';
import { HttpError } from '../http.js';
import { buildServerDataPack, type PohodaCodeLookup, type PohodaXmlDocument } from '../pohodaXml.js';

interface CodeListRow extends Record<string, unknown> {
  id: string;
  kind: 'predkontacie' | 'cleneniaDph' | 'ciselneRady' | 'strediska';
  code: string;
  name: string;
}

interface DocumentRow extends Record<string, unknown> {
  id: string;
  organization_id: string;
  status: string;
  approved_version?: number;
  approved_snapshot?: PohodaXmlDocument['snapshot'];
}

export async function buildApprovedDocumentsXml(
  database: Database,
  input: {
    tenantId: string; organizationId: string; ico: string; documentIds: string[]; packId: string;
    /** Zopakovanie prenosu: doklad zo zlyhaného exportu je v stave „chyba", nie „schválený". */
    allowFailedDocuments?: boolean;
  },
): Promise<string> {
  const uniqueIds = [...new Set(input.documentIds)];
  if (uniqueIds.length === 0) throw new HttpError(400, 'no_documents', 'Nie sú vybrané žiadne doklady');
  const documents = await database.query<DocumentRow>(
    `SELECT id, organization_id, status, approved_version, approved_snapshot
       FROM documents WHERE tenant_id=$1 AND id = ANY($2::text[])`,
    [input.tenantId, uniqueIds],
  );
  if (documents.rowCount !== uniqueIds.length) throw new HttpError(404, 'document_not_found', 'Niektorý doklad neexistuje');
  if (documents.rows.some((row) => row.organization_id !== input.organizationId)) {
    throw new HttpError(409, 'mixed_organizations', 'Export nesmie miešať organizácie');
  }
  const exportable = input.allowFailedDocuments ? ['schvaleny', 'chyba'] : ['schvaleny'];
  if (documents.rows.some((row) => !exportable.includes(row.status) || !row.approved_snapshot || row.approved_snapshot.version !== row.approved_version)) {
    throw new HttpError(409, 'document_not_approved', 'Exportovať možno iba aktuálnu schválenú verziu dokladu');
  }
  const rows = await database.query<CodeListRow>(
    `SELECT id, kind, code, name FROM code_list_items
      WHERE tenant_id=$1 AND organization_id=$2 AND active=true`,
    [input.tenantId, input.organizationId],
  );
  const codeLists: PohodaCodeLookup = {
    predkontacie: new Map(),
    cleneniaDph: new Map(),
    ciselneRady: new Map(),
    strediska: new Map(),
    predkontacieNazvy: new Map(),
  };
  for (const row of rows.rows) {
    codeLists[row.kind].set(row.id, row.code);
    // Názov predkontácie ide do <inv:text> dokladu.
    if (row.kind === 'predkontacie') codeLists.predkontacieNazvy!.set(row.id, row.name);
  }
  // Poradie v dataPacku = poradie vybrané v exportnom dialógu (dátum/číslo);
  // SELECT ... = ANY($2) poradie vstupu nezachováva.
  const order = new Map(uniqueIds.map((documentId, index) => [documentId, index]));
  return buildServerDataPack({
    id: input.packId,
    ico: input.ico,
    documents: [...documents.rows]
      .sort((a, b) => (order.get(a.id) ?? 0) - (order.get(b.id) ?? 0))
      .map((row) => ({ id: row.id, snapshot: row.approved_snapshot! })),
    codeLists,
  });
}

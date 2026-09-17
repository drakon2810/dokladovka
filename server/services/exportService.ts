import type { Database } from '../db/database.js';
import { HttpError } from '../http.js';
import { buildServerDataPack, type PohodaCodeLookup, type PohodaXmlDocument } from '../pohodaXml.js';
import { prijateCasti, radSamozdanenia, type Samozdanenie } from './samozdanenieService.js';

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
  samozdanenie?: Samozdanenie | null;
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
    `SELECT id, organization_id, status, approved_version, approved_snapshot, samozdanenie
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
    zakazky: new Map(),
    cinnosti: new Map(),
    predkontacieNazvy: new Map(),
  };
  for (const row of rows.rows) {
    // code_list_items pozná aj druhy, ktoré POHODA XML nepoužíva (projekty,
    // clenenieKv) — bez tejto kontroly by export firmy s takým číselníkom spadol.
    codeLists[row.kind]?.set(row.id, row.code);
    // Názov predkontácie ide do <inv:text> dokladu.
    if (row.kind === 'predkontacie') codeLists.predkontacieNazvy!.set(row.id, row.name);
  }
  // Rad interných dokladov samozdanenia: prax firmy z jej histórie, až za ňou
  // predvoľba interných dokladov (MZDY) a nakoniec nič, nech číslo pridelí
  // POHODA. Rad je per doklad, lebo patrí ROKU daňovej povinnosti interného
  // dokladu: pri tovare z EÚ vzniká 15. dňa nasledujúceho mesiaca, takže jeden
  // balík môže niesť decembrovú faktúru s interným dokladom už v ďalšom roku.
  //
  // Rad sa hľadá pri exporte, nie pri schválení: rok daňovej povinnosti je
  // v snapshote hotový, už schválené doklady v rade na prenos sa opravia bez
  // opätovného schválenia a to, s čím doklad naozaj odišiel, drží
  // `samozdanenie.export.<rola>.cislo` — číslo, ktoré POHODA pridelila.
  //
  // ponytail: keby firma rad samozdanenia zmenila medzi prvým prenosom a
  // zopakovaním, dva interné doklady jednej faktúry môžu skončiť v rôznych
  // radoch. Vtedy rad zmraziť do `samozdanenie.interny` pri schválení.
  const rokSamozdanenia = (row: DocumentRow) => {
    if (row.approved_snapshot?.samozdanenie?.volba !== 'vytvorit') return undefined;
    const rok = Number(row.approved_snapshot.samozdanenie.datumDanovejPovinnosti?.slice(0, 4));
    return rok > 0 ? rok : undefined;
  };
  const radyZHistorie = new Map(await Promise.all(
    [...new Set(documents.rows.map(rokSamozdanenia).filter((rok): rok is number => rok !== undefined))]
      .map(async (rok) => [rok, await radSamozdanenia(database, input, rok)] as const),
  ));
  const radMzdy = (await database.query<{ code: string } & Record<string, unknown>>(
    `SELECT c.code FROM organization_series_defaults d
       JOIN code_list_items c ON c.id=d.ciselny_rad_id AND c.active=true
      WHERE d.tenant_id=$1 AND d.organization_id=$2 AND d.document_type='MZDY'`,
    [input.tenantId, input.organizationId],
  )).rows[0]?.code;
  // Poradie v dataPacku = poradie vybrané v exportnom dialógu (dátum/číslo);
  // SELECT ... = ANY($2) poradie vstupu nezachováva.
  const order = new Map(uniqueIds.map((documentId, index) => [documentId, index]));
  const balik = {
    id: input.packId,
    ico: input.ico,
    documents: [...documents.rows]
      .sort((a, b) => (order.get(a.id) ?? 0) - (order.get(b.id) ?? 0))
      .map((row) => ({
        id: row.id,
        snapshot: row.approved_snapshot!,
        prijate: prijateCasti(row.samozdanenie),
        radInternych: radyZHistorie.get(rokSamozdanenia(row) ?? 0) ?? radMzdy,
      })),
    codeLists,
  };
  try {
    return buildServerDataPack(balik);
  } catch (chyba) {
    // Kontroly balíka hlásia neplatný doklad obyčajným Error so slovenskou
    // hláškou — bez 409 ju účtovník videl ako „neočakávanú chybu". HttpError aj
    // chyba v kóde (TypeError a pod.) idú ďalej bez zmeny.
    if (!(chyba instanceof Error) || chyba.constructor !== Error) throw chyba;
    const { message } = chyba;
    // Hláška bez id (neplatná suma, nepodporovaný typ): doklad nájde zostavenie
    // po jednom. Keď zlyhajú všetky rovnako (IČO firmy), nejde o doklad.
    const vHlaske = uniqueIds.find((id) => message.includes(id));
    const zlyhane = vHlaske ? [] : balik.documents.filter((doklad) => {
      try { buildServerDataPack({ ...balik, documents: [doklad] }); return false; } catch (e) { return e instanceof Error && e.message === message; }
    });
    const documentId = vHlaske
      ?? (zlyhane.length < balik.documents.length || balik.documents.length === 1 ? zlyhane[0]?.id : undefined);
    throw new HttpError(409, 'export_neplatny_doklad', message, documentId ? { documentId } : undefined);
  }
}

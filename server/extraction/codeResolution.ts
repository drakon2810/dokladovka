// Preklad kódov z pravidla na id číselníka firmy. Model číselník nevidí — kódy
// (napr. „521100/331100 HM") len opíše z bloku ÚČTOVNÉ PRAVIDLÁ a server ich
// tu spáruje s tým, čo firma naozaj má v POHODE. Čo sa nespáruje, ostáva prázdne
// a doplní ho účtovník; nikdy sa nehádže na najbližší kód.
import type { Queryable } from '../db/database.js';
import type { AdditionalDocumentResult, ExtractionResult } from './contract.js';

export type CodeKind = 'predkontacie' | 'cleneniaDph' | 'ciselneRady';

export interface CodeIndex {
  /** kind → normalizovaný kód → id. Viacznačný prefix sa zahodí. */
  presne: Map<CodeKind, Map<string, string>>;
  prefixy: Map<CodeKind, Map<string, string | null>>;
}

/** Kódy sa píšu rôzne: „331 / 335200" aj „331/335200", s veľkými aj malými. */
function normalizuj(code: unknown): string {
  return String(code ?? '').toLowerCase().replace(/\s+/g, '');
}

export async function nacitajCiselnikIndex(
  database: Queryable,
  tenantId: string,
  organizationId: string,
): Promise<CodeIndex> {
  const rows = await database.query<{ id: string; kind: string; code: string } & Record<string, unknown>>(
    `SELECT id, kind, code FROM code_list_items
      WHERE tenant_id=$1 AND organization_id=$2 AND active=true
        AND kind IN ('predkontacie','cleneniaDph','ciselneRady')`,
    [tenantId, organizationId],
  );
  const presne = new Map<CodeKind, Map<string, string>>();
  const prefixy = new Map<CodeKind, Map<string, string | null>>();
  for (const row of rows.rows) {
    const kind = row.kind as CodeKind;
    const kod = normalizuj(row.code);
    if (!kod) continue;
    if (!presne.has(kind)) presne.set(kind, new Map());
    if (!prefixy.has(kind)) prefixy.set(kind, new Map());
    presne.get(kind)!.set(kod, row.id);
    // Pravidlo často píše kód bez chvosta („521100/331100" namiesto
    // „521100/331100 HM"). Prefix pomôže len vtedy, keď je jednoznačný —
    // pri dvoch kandidátoch radšej nič ako nesprávne zaúčtovanie.
    const prefix = prefixy.get(kind)!;
    prefix.set(kod, prefix.has(kod) ? null : row.id);
  }
  return { presne, prefixy };
}

/** Id číselníka pre kód z pravidla; undefined, keď kód firma nemá. */
export function najdiKod(index: CodeIndex, kind: CodeKind, code: unknown): string | undefined {
  const hladane = normalizuj(code);
  if (!hladane) return undefined;
  const presne = index.presne.get(kind)?.get(hladane);
  if (presne) return presne;
  // Jednoznačný kandidát, ktorý hľadaným kódom začína („521100/331100" → „…HM").
  let najdene: string | undefined;
  for (const [kod, id] of index.prefixy.get(kind) ?? []) {
    if (!kod.startsWith(hladane) || id === null) continue;
    if (najdene) return undefined;
    najdene = id;
  }
  return najdene;
}

/** Štatutárne sekcie kontrolného výkazu — nie číselník, pevný zoznam. */
const KV_SEKCIE = new Set(['A1', 'A2', 'B1', 'B2', 'B3', 'C1', 'C2', 'D1', 'D2', 'KN']);

export interface ZauctovanieZPravidla {
  predkontaciaId?: string;
  clenenieDphId?: string;
  ciselnyRadId?: string;
  clenenieKvKod?: string;
}

/** Hlavičkové zaúčtovanie dokladu podľa kódov, ktoré model opísal z pravidla. */
export function zauctovanieZKodov(
  index: CodeIndex,
  zdroj: Pick<ExtractionResult, 'accountCode' | 'vatClassificationCode' | 'vatControlStatementCode' | 'numberSeriesCode'>,
): ZauctovanieZPravidla {
  // Sekcia KV má vlastné pole — doklad má bežne obidve naraz („UN" ako členenie
  // DPH a „KN" do kontrolného výkazu). Kým bolo pole jedno, KN sa nedalo poslať
  // bez toho, aby vypadlo členenie. Fallback drží behy uložené pred zmenou.
  const kv = String(zdroj.vatControlStatementCode ?? zdroj.vatClassificationCode ?? '').trim().toUpperCase();
  return {
    ...(najdiKod(index, 'predkontacie', zdroj.accountCode) ? { predkontaciaId: najdiKod(index, 'predkontacie', zdroj.accountCode) } : {}),
    ...(najdiKod(index, 'cleneniaDph', zdroj.vatClassificationCode) ? { clenenieDphId: najdiKod(index, 'cleneniaDph', zdroj.vatClassificationCode) } : {}),
    ...(najdiKod(index, 'ciselneRady', zdroj.numberSeriesCode) ? { ciselnyRadId: najdiKod(index, 'ciselneRady', zdroj.numberSeriesCode) } : {}),
    // Sekcia KV DPH nie je číselník firmy — model ju uvádza priamo (A1…KN).
    ...(KV_SEKCIE.has(kv) ? { clenenieKvKod: kv } : {}),
  };
}

/**
 * Doplní `polozky[].ucto` podľa kódov na položkách. Mení kópiu — pôvodné
 * `extracted` z normalizácie ostáva nedotknuté.
 */
export function polozkySKodmi(
  index: CodeIndex,
  extracted: Record<string, unknown>,
  lineItems: ExtractionResult['lineItems'] | AdditionalDocumentResult['lineItems'],
): Record<string, unknown> {
  const polozky = Array.isArray(extracted.polozky) ? (extracted.polozky as Array<Record<string, any>>) : [];
  if (polozky.length === 0) return extracted;
  const doplnene = polozky.map((polozka, poradie) => {
    const zdroj = lineItems[poradie];
    if (!zdroj) return polozka;
    const predkontaciaId = najdiKod(index, 'predkontacie', zdroj.accountCode);
    const clenenieDphId = najdiKod(index, 'cleneniaDph', zdroj.vatClassificationCode);
    if (!predkontaciaId && !clenenieDphId) return polozka;
    return {
      ...polozka,
      ucto: {
        ...polozka.ucto,
        ...(predkontaciaId ? { predkontaciaId } : {}),
        ...(clenenieDphId ? { clenenieDphId } : {}),
      },
    };
  });
  return { ...extracted, polozky: doplnene };
}

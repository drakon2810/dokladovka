import { createHash, randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { Database, Queryable } from '../db/database.js';
import { jeBezPredkontacia, normalizeName, platnyKvKod } from './accountingSuggestionService.js';

// Korpus histórie zaúčtovaní (ucto_historia): úplná POHODA po riadkoch a cez
// všetky agendy. Zdroj pravdy pre jednorazovú analýzu kategórií plnení.
// Zámerne NIE je v ceste návrhu na doklade — tá beží nad ucto_decisions.

export const AGENDY = ['FP', 'FV', 'PD', 'BV', 'MZDY', 'OZ', 'INE'] as const;

/** Riadok histórie tak, ako ho posiela prehliadač (.mdb) aj agent (POHODA XML). */
export const historyRowSchema = z.object({
  agenda: z.enum(AGENDY),
  dokladCislo: z.string().trim().max(60).optional(),
  /** Poradie položky v doklade — dva rovnaké riadky jednej faktúry sú dva riadky. */
  riadokIndex: z.number().int().min(0).max(10_000).optional(),
  datum: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  supplierIco: z.string().trim().max(20).optional(),
  supplierName: z.string().trim().max(300).optional(),
  lineText: z.string().trim().max(2000),
  suma: z.number().finite().optional(),
  sadzbaDph: z.number().finite().optional(),
  predkontaciaKod: z.string().trim().max(100).optional(),
  clenenieDphKod: z.string().trim().max(100).optional(),
  clenenieKvKod: z.string().trim().max(20).optional(),
  strediskoKod: z.string().trim().max(100).optional(),
}).strict();

export type HistoryRow = z.infer<typeof historyRowSchema>;

/** Dávka: 20 000 krátkych riadkov sa pod bodyLimit (30 MB) pohodlne zmestí. */
export const historyImportSchema = z.object({
  rows: z.array(historyRowSchema).max(20_000),
}).strict();

interface ResolvedRow {
  agenda: string;
  dokladCislo: string | null;
  datum: string | null;
  supplierIco: string | null;
  supplierName: string | null;
  lineText: string;
  suma: number | null;
  sadzbaDph: number | null;
  predkontaciaKod: string | null;
  predkontaciaId: string | null;
  clenenieDphKod: string | null;
  clenenieDphId: string | null;
  clenenieKvKod: string | null;
  strediskoKod: string | null;
  strediskoId: string | null;
  hash: string;
}

/** Kľúč idempotencie importu — pozri komentár v tele. */
function riadokHash(row: ResolvedRow, poradie: number): string {
  // Odtlačok PÔVODU riadka, nie obsahu: opakovaný import tej istej histórie nič
  // nezduplikuje, ale dve rovnaké položky dvoch rôznych faktúr ostanú dve. Pre
  // analýzu je početnosť hlavný signál — zlučovanie podľa obsahu by z „1240×
  // preprava" spravilo jeden riadok. Bez čísla dokladu sa padá späť na obsah.
  if (row.dokladCislo) {
    return createHash('sha256')
      .update([row.agenda, row.dokladCislo, row.datum ?? '', String(poradie)].join(''))
      .digest('hex').slice(0, 32);
  }
  return createHash('sha256').update([
    row.agenda, row.dokladCislo ?? '', row.datum ?? '', row.supplierIco ?? '', row.supplierName ?? '',
    row.lineText, row.suma ?? '', row.sadzbaDph ?? '',
    row.predkontaciaKod ?? '', row.clenenieDphKod ?? '', row.clenenieKvKod ?? '', row.strediskoKod ?? '',
  ].join('')).digest('hex').slice(0, 32);
}

async function kodyNaId(
  db: Queryable,
  tenantId: string,
  organizationId: string,
): Promise<Map<string, string>> {
  const result = await db.query<{ id: string; kind: string; code: string } & Record<string, unknown>>(
    `SELECT id, kind, code FROM code_list_items
      WHERE tenant_id=$1 AND organization_id=$2 AND active=true
        AND kind IN ('predkontacie','cleneniaDph','strediska')`,
    [tenantId, organizationId],
  );
  return new Map(result.rows.map((row) => [`${row.kind}:${row.code.trim()}`, row.id]));
}

/**
 * Uloží dávku histórie. Na rozdiel od tréningového importu riadok s neznámym
 * kódom NEODMIETA — kód sa uloží ako text a id ostane prázdne, takže analýza
 * vidí aj prax, ktorá už v aktívnych číselníkoch nie je.
 */
export async function importUctoHistory(
  database: Database,
  input: {
    tenantId: string;
    organizationId: string;
    rows: HistoryRow[];
    source: 'mdb' | 'agent';
  },
): Promise<{ imported: number; duplicates: number; bezKodu: number }> {
  const { tenantId, organizationId } = input;
  const idPreKod = await kodyNaId(database, tenantId, organizationId);
  const id = (kind: string, kod: string | undefined) =>
    (kod ? idPreKod.get(`${kind}:${kod.trim()}`) ?? null : null);

  const resolved: ResolvedRow[] = [];
  let bezKodu = 0;
  for (const row of input.rows) {
    const lineText = normalizeName(row.lineText).slice(0, 1000);
    if (!lineText) continue; // riadok bez textu nenesie pre analýzu žiadny signál
    const base: ResolvedRow = {
      agenda: row.agenda,
      dokladCislo: row.dokladCislo ?? null,
      datum: row.datum ?? null,
      supplierIco: row.supplierIco?.replace(/\D/g, '') || null,
      supplierName: normalizeName(row.supplierName) || null,
      lineText,
      suma: row.suma ?? null,
      sadzbaDph: row.sadzbaDph ?? null,
      // „BEZ…" nie je účet, ale doklad bez zaúčtovania — do korpusu sa nedostane
      // ani ako kód, inak by z neho analýza spravila kategóriu s účtom BEZ321100.
      predkontaciaKod: jeBezPredkontacia(row.predkontaciaKod) ? null : row.predkontaciaKod?.trim() || null,
      predkontaciaId: jeBezPredkontacia(row.predkontaciaKod) ? null : id('predkontacie', row.predkontaciaKod),
      clenenieDphKod: row.clenenieDphKod?.trim() || null,
      clenenieDphId: id('cleneniaDph', row.clenenieDphKod),
      clenenieKvKod: platnyKvKod(row.clenenieKvKod) ?? null,
      strediskoKod: row.strediskoKod?.trim() || null,
      strediskoId: id('strediska', row.strediskoKod),
      hash: '',
    };
    if (!base.predkontaciaKod && !base.clenenieDphKod) {
      bezKodu += 1;
      continue; // riadok bez zaúčtovania sa nemá čo učiť
    }
    base.hash = riadokHash(base, row.riadokIndex ?? resolved.length);
    resolved.push(base);
  }

  let imported = 0;
  for (const row of resolved) {
    const result = await database.query(
      `INSERT INTO ucto_historia
        (id,tenant_id,organization_id,agenda,doklad_cislo,datum,supplier_ico,supplier_name_normalized,
         line_text_normalized,suma,sadzba_dph,predkontacia_kod,predkontacia_id,clenenie_dph_kod,
         clenenie_dph_id,clenenie_kv_kod,stredisko_kod,stredisko_id,source,riadok_hash)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20)
       ON CONFLICT (organization_id, riadok_hash) DO NOTHING`,
      [randomUUID(), tenantId, organizationId, row.agenda, row.dokladCislo, row.datum,
        row.supplierIco, row.supplierName, row.lineText, row.suma, row.sadzbaDph,
        row.predkontaciaKod, row.predkontaciaId, row.clenenieDphKod, row.clenenieDphId,
        row.clenenieKvKod, row.strediskoKod, row.strediskoId, input.source, row.hash],
    );
    if (result.rowCount > 0) imported += 1;
  }
  return { imported, duplicates: resolved.length - imported, bezKodu };
}

/**
 * Preklopí už existujúcu pamäť rozhodnutí do korpusu, aby analýza mala z čoho
 * vychádzať ešte pred prvým plným exportom z POHODY. Agenda sa z pamäte nedá
 * zistiť (pamäť pozná len prijaté faktúry), preto 'FP'.
 */
export async function backfillHistoryFromDecisions(
  database: Database,
  tenantId: string,
  organizationId: string,
): Promise<{ imported: number }> {
  const rows = await database.query<Record<string, any>>(
    `SELECT d.id, d.supplier_ico, d.supplier_name_normalized, d.line_text_normalized,
            d.clenenie_kv_kod,
            p.code AS predkontacia_kod, d.predkontacia_id,
            c.code AS clenenie_dph_kod, d.clenenie_dph_id,
            s.code AS stredisko_kod, d.stredisko_id
       FROM ucto_decisions d
       LEFT JOIN code_list_items p ON p.id=d.predkontacia_id
       LEFT JOIN code_list_items c ON c.id=d.clenenie_dph_id
       LEFT JOIN code_list_items s ON s.id=d.stredisko_id
      WHERE d.tenant_id=$1 AND d.organization_id=$2 AND d.excluded=false
        AND coalesce(d.line_text_normalized,'') <> ''`,
    [tenantId, organizationId],
  );
  let imported = 0;
  for (const row of rows.rows) {
    const resolved: ResolvedRow = {
      agenda: 'FP',
      dokladCislo: null,
      datum: null,
      supplierIco: row.supplier_ico ?? null,
      supplierName: row.supplier_name_normalized ?? null,
      lineText: row.line_text_normalized,
      suma: null,
      sadzbaDph: null,
      predkontaciaKod: jeBezPredkontacia(row.predkontacia_kod) ? null : row.predkontacia_kod ?? null,
      predkontaciaId: jeBezPredkontacia(row.predkontacia_kod) ? null : row.predkontacia_id ?? null,
      clenenieDphKod: row.clenenie_dph_kod ?? null,
      clenenieDphId: row.clenenie_dph_id ?? null,
      clenenieKvKod: row.clenenie_kv_kod ?? null,
      strediskoKod: row.stredisko_kod ?? null,
      strediskoId: row.stredisko_id ?? null,
      hash: '',
    };
    if (!resolved.predkontaciaKod && !resolved.clenenieDphKod) continue;
    // Kľúčom je id rozhodnutia — každý riadok pamäte je samostatný výskyt,
    // inak by sa opakované rovnaké zaúčtovania zlúčili a analýza by stratila
    // početnosť, ktorá je pre ňu hlavným signálom.
    resolved.hash = createHash('sha256').update(`decision:${row.id}`).digest('hex').slice(0, 32);
    const result = await database.query(
      `INSERT INTO ucto_historia
        (id,tenant_id,organization_id,agenda,line_text_normalized,supplier_ico,supplier_name_normalized,
         predkontacia_kod,predkontacia_id,clenenie_dph_kod,clenenie_dph_id,clenenie_kv_kod,
         stredisko_kod,stredisko_id,source,riadok_hash)
       VALUES ($1,$2,$3,'FP',$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,'decisions',$14)
       ON CONFLICT (organization_id, riadok_hash) DO NOTHING`,
      [randomUUID(), tenantId, organizationId, resolved.lineText, resolved.supplierIco,
        resolved.supplierName, resolved.predkontaciaKod, resolved.predkontaciaId,
        resolved.clenenieDphKod, resolved.clenenieDphId, resolved.clenenieKvKod,
        resolved.strediskoKod, resolved.strediskoId, resolved.hash],
    );
    if (result.rowCount > 0) imported += 1;
  }
  return { imported };
}

export async function historyStats(
  database: Database,
  tenantId: string,
  organizationId: string,
): Promise<{ spolu: number; podlaAgendy: Array<{ agenda: string; pocet: number }>; dodavatelov: number; roznychTextov: number }> {
  const spolu = await database.query<{ pocet: string } & Record<string, unknown>>(
    'SELECT count(*) AS pocet FROM ucto_historia WHERE tenant_id=$1 AND organization_id=$2',
    [tenantId, organizationId],
  );
  const agendy = await database.query<{ agenda: string; pocet: string } & Record<string, unknown>>(
    `SELECT agenda, count(*) AS pocet FROM ucto_historia
      WHERE tenant_id=$1 AND organization_id=$2 GROUP BY agenda ORDER BY 2 DESC`,
    [tenantId, organizationId],
  );
  const ostatne = await database.query<{ dodavatelov: string; textov: string } & Record<string, unknown>>(
    `SELECT count(DISTINCT coalesce(supplier_ico, supplier_name_normalized)) AS dodavatelov,
            count(DISTINCT line_text_normalized) AS textov
       FROM ucto_historia WHERE tenant_id=$1 AND organization_id=$2`,
    [tenantId, organizationId],
  );
  return {
    spolu: Number(spolu.rows[0]?.pocet ?? 0),
    podlaAgendy: agendy.rows.map((row) => ({ agenda: row.agenda, pocet: Number(row.pocet) })),
    dodavatelov: Number(ostatne.rows[0]?.dodavatelov ?? 0),
    roznychTextov: Number(ostatne.rows[0]?.textov ?? 0),
  };
}

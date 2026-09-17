import { randomUUID } from 'node:crypto';
import type { Queryable } from '../db/database.js';
import { normalizeName, platnyKvKod, protistranaDokladu } from './accountingSuggestionService.js';
import { zaradNavrhZauctovania } from './navrhZauctovaniaJob.js';

/**
 * Podoba praxe, ktorú účtovník vybral, sa stane pravidlom protistrany — z karty
 * dokladu (R09) aj z otázky v profile klienta. Staré pravidlá LEN pre protistranu
 * sa deaktivujú (nemažú — návrhy a „Prečo" na ne ukazujú): pravidlá sa skladajú
 * od najstaršieho a staré by vyhralo. Pravidlá s kľúčovými slovami ostávajú —
 * hovoria o druhu plnenia.
 *
 * undefined = predkontácia alebo členenie už nie je aktívne v číselníku firmy;
 * čo s tým, rozhodne volajúci. Transakciu drží volajúci.
 */
export async function ulozPravidloProtistrany(tx: Queryable, input: {
  tenantId: string;
  organizationId: string;
  userId: string;
  correlationId: string;
  /** IČO len číslice, meno normalizované (normalizeName); aspoň jedno neprázdne. */
  ico: string;
  nazov: string;
  predkontaciaId: string;
  clenenieDphId: string;
  clenenieKvKod?: string;
  /** Odkiaľ výber prišiel — ide do dôvodu pravidla, napr. „doklad F-1". */
  zdroj: string;
  /** Typ dokladu (FP, OZ, PD…), na ktorom prax platí; bez neho pravidlo platí na všetkých. */
  typDokladu?: string;
  /** Doklad, na ktorom účtovník vyberal: jeho koncept výber už nesie, nový návrh nedostane. */
  documentId?: string;
}) {
  const { tenantId, organizationId, ico, nazov } = input;
  const kody = await tx.query<{ id: string; kind: string; code: string } & Record<string, unknown>>(
    `SELECT id, kind, code FROM code_list_items
      WHERE tenant_id=$1 AND organization_id=$2 AND active=true AND id = ANY($3::text[])`,
    [tenantId, organizationId, [input.predkontaciaId, input.clenenieDphId]],
  );
  const predkontacia = kody.rows.find((row) => row.id === input.predkontaciaId && row.kind === 'predkontacie');
  const clenenie = kody.rows.find((row) => row.id === input.clenenieDphId && row.kind === 'cleneniaDph');
  if (!predkontacia || !clenenie) return undefined;
  const kv = input.clenenieKvKod ? platnyKvKod(input.clenenieKvKod) : undefined;
  const dovod = `Účtovník vybral prax ${predkontacia.code.trim()} / ${clenenie.code.trim()}${kv ? ` / ${kv}` : ''}`
    + ` pre tohto dodávateľa${input.typDokladu ? ` na dokladoch ${input.typDokladu}` : ''} (${input.zdroj}).`;
  const ruleId = randomUUID();
  // Deaktivujú sa pravidlá, ktoré by pri návrhu zasiahli — tá istá zhoda ako
  // v zhodnePravidla (IČO ALEBO meno), inak by staršie pravidlo vyhralo.
  const deaktivovane = (await tx.query<{ id: string; ciselny_rad_id: string | null; stredisko_id: string | null } & Record<string, unknown>>(
    `UPDATE accounting_rules SET active=false, updated_at=now()
      WHERE tenant_id=$1 AND organization_id=$2 AND active=true AND coalesce(keywords, '[]'::jsonb) = '[]'::jsonb
        AND (($3::text <> '' AND regexp_replace(coalesce(supplier_ico, ''), '[^0-9]', '', 'g')=$3)
          OR ($4::text <> '' AND supplier_name_normalized=$4))
        -- Len pravidlá s rovnakým rozsahom: pravidlo pre OZ nevypne pravidlo pre všetky doklady.
        AND typy_dokladov IS NOT DISTINCT FROM $5::text[]
      RETURNING id, ciselny_rad_id, stredisko_id, created_at`,
    [tenantId, organizationId, ico, nazov, input.typDokladu ? [input.typDokladu] : null],
  )).rows.sort((a, b) => String(a.created_at).localeCompare(String(b.created_at)));
  // Rad a stredisko zo starých pravidiel sa prenesú — o nich účtovník
  // nerozhodoval a nesmú ticho zmiznúť. Zdrojom sú vypnuté pravidlá aj všeobecné
  // pravidlá dodávateľa, ktoré ostali platiť pre iné typy. Len aktívne kódy.
  const vseobecne = input.typDokladu ? (await tx.query<{ ciselny_rad_id: string | null; stredisko_id: string | null } & Record<string, unknown>>(
    `SELECT ciselny_rad_id, stredisko_id, created_at FROM accounting_rules
      WHERE tenant_id=$1 AND organization_id=$2 AND active=true AND typy_dokladov IS NULL
        AND coalesce(keywords, '[]'::jsonb) = '[]'::jsonb
        AND (($3::text <> '' AND regexp_replace(coalesce(supplier_ico, ''), '[^0-9]', '', 'g')=$3)
          OR ($4::text <> '' AND supplier_name_normalized=$4))
      ORDER BY created_at`,
    [tenantId, organizationId, ico, nazov],
  )).rows : [];
  const prenesene = async (pole: 'ciselny_rad_id' | 'stredisko_id') => {
    for (const row of [...deaktivovane, ...vseobecne]) {
      const kodId = row[pole];
      if (!kodId) continue;
      const aktivny = await tx.query('SELECT 1 FROM code_list_items WHERE id=$1 AND tenant_id=$2 AND organization_id=$3 AND active=true',
        [kodId, tenantId, organizationId]);
      if (aktivny.rowCount) return kodId;
    }
    return null;
  };
  const rad = await prenesene('ciselny_rad_id');
  const stredisko = await prenesene('stredisko_id');
  await tx.query(
    `INSERT INTO accounting_rules
      (id,tenant_id,organization_id,supplier_ico,supplier_name_normalized,keywords,predkontacia_id,clenenie_dph_id,
       clenenie_kv_kod,ciselny_rad_id,stredisko_id,origin,dovod,dovod_source,dovod_updated_at,dovod_updated_by,typy_dokladov)
     VALUES ($1,$2,$3,$4,$5,'[]'::jsonb,$6,$7,$8,$9,$10,'manual',$11,'human',now(),$12,$13::text[])`,
    [ruleId, tenantId, organizationId, ico || null, nazov || null,
      predkontacia.id, clenenie.id, kv ?? null, rad, stredisko, dovod, input.userId, input.typDokladu ? [input.typDokladu] : null],
  );
  // Otázka zmizne zo všetkých otvorených dokladov tejto protistrany — pravidlo
  // o nej už rozhodlo a ďalší návrh ju nevytvorí.
  const otvorene = (await tx.query<{ document_id: string; document_type: string; extracted: unknown } & Record<string, unknown>>(
    `SELECT s.document_id, d.document_type, d.extracted FROM accounting_suggestions s
       JOIN documents d ON d.id=s.document_id AND d.tenant_id=s.tenant_id
      WHERE s.tenant_id=$1 AND s.organization_id=$2 AND s.otazka IS NOT NULL`,
    [tenantId, organizationId],
  )).rows.filter((row) => {
    if (input.typDokladu && row.document_type !== input.typDokladu) return false;
    const ina = protistranaDokladu(row.document_type, row.extracted);
    const inaIco = String(ina.ico ?? '').replace(/\D/g, '');
    return ico ? inaIco === ico : !inaIco && normalizeName(ina.nazov) === nazov;
  }).map((row) => row.document_id);
  if (otvorene.length > 0) {
    await tx.query('UPDATE accounting_suggestions SET otazka=NULL WHERE tenant_id=$1 AND document_id = ANY($2::text[])',
      [tenantId, otvorene]);
  }
  // Ostatné otvorené doklady protistrany nesú ešte návrh so starou podobou —
  // nový návrh už pôjde podľa pravidla.
  for (const ineId of otvorene.filter((documentId) => documentId !== input.documentId)) {
    await zaradNavrhZauctovania(tx, { tenantId, organizationId, documentId: ineId, correlationId: input.correlationId });
  }
  return {
    ruleId, deaktivovane: deaktivovane.map((row) => row.id), predkontaciaId: predkontacia.id,
    clenenieDphId: clenenie.id, clenenieKvKod: kv ?? null, ciselnyRadId: rad, strediskoId: stredisko,
  };
}

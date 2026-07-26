// Kontextový asistent firmy. Server sám deterministicky pozbiera dôkazy (profil
// DPH, reálne používané predkontácie, aktívne pravidlá s dôvodmi, podobné
// rozhodnutia, prípadne otvorený doklad) a až tie pošle modelu. Model NIKDY
// nevyberá tenant/organizáciu ani nerobí SQL — dostane hotové fakty len tejto
// firmy, takže cudziu firmu nemá odkiaľ spomenúť.
import { normalizeName, textSimilarity } from './accountingSuggestionService.js';
import { dphPokynyPreAi } from './dphAdvisor.js';
import { loadDphProfil } from './dphProfileService.js';
import { loadUctovnyProfil } from './accountingProfileService.js';
import type { Database } from '../db/database.js';

export interface AssistantScope {
  tenantId: string;
  organizationId: string;
}

export interface AssistantEvidence {
  firma: Record<string, unknown>;
  profilDph?: { platitelDph: string; rezim: string; pokyny: string[] };
  uctovnyProfil?: Record<string, unknown>;
  pouzivanePredkontacie: Array<{ kod: string; nazov: string; pocet: number }>;
  pravidla: Array<Record<string, unknown>>;
  podobneRozhodnutia: Array<Record<string, unknown>>;
  otvorenyDoklad?: Record<string, unknown>;
}

/** Text položiek dokladu pre retrieval (rovnaký tvar ako pri návrhu účtovania). */
function textDokladu(extracted: Record<string, any>): string {
  const polozky = Array.isArray(extracted?.polozky)
    ? extracted.polozky.map((item: any) => String(item?.popis ?? '')).join(' | ')
    : '';
  return normalizeName(`${extracted?.dodavatel?.nazov ?? ''} ${polozky}`).slice(0, 1000);
}

/**
 * Dôkazy pre jednu otázku. Všetky dopyty sú tvrdo zúžené na (tenant, org);
 * documentId sa overuje voči tej istej organizácii, inak sa ignoruje.
 */
export async function zozbierajDokazy(
  database: Database,
  scope: AssistantScope,
  input: { otazka: string; documentId?: string },
): Promise<AssistantEvidence> {
  const organizacia = (await database.query<Record<string, any>>(
    'SELECT name, ico, dic, ic_dph FROM organizations WHERE id=$1 AND tenant_id=$2',
    [scope.organizationId, scope.tenantId],
  )).rows[0];

  const dphProfil = await loadDphProfil(database, scope.tenantId, scope.organizationId);
  const uctovnyProfil = await loadUctovnyProfil(database, scope.tenantId, scope.organizationId);

  // Reálne používané predkontácie — nie celý číselník (stovky riadkov), ale to,
  // čo firma naozaj používa, zoradené podľa frekvencie.
  const pouzivane = await database.query<Record<string, any>>(
    `SELECT c.code, c.name, count(*)::int AS pocet
       FROM ucto_decisions d
       JOIN code_list_items c ON c.id=d.predkontacia_id AND c.tenant_id=d.tenant_id AND c.organization_id=d.organization_id
      WHERE d.tenant_id=$1 AND d.organization_id=$2 AND d.excluded=false AND c.active=true
      GROUP BY c.code, c.name
      ORDER BY count(*) DESC
      LIMIT 100`,
    [scope.tenantId, scope.organizationId],
  );

  const pravidla = await database.query<Record<string, any>>(
    `SELECT r.supplier_ico, r.supplier_name_normalized, r.keywords, r.clenenie_kv_kod,
            r.dovod, r.dovod_source, r.corrections_count,
            p.code AS predkontacia_kod, d.code AS dph_kod
       FROM accounting_rules r
       LEFT JOIN code_list_items p ON p.id=r.predkontacia_id AND p.tenant_id=r.tenant_id AND p.organization_id=r.organization_id
       LEFT JOIN code_list_items d ON d.id=r.clenenie_dph_id AND d.tenant_id=r.tenant_id AND d.organization_id=r.organization_id
      WHERE r.tenant_id=$1 AND r.organization_id=$2 AND r.active=true
      ORDER BY r.corrections_count ASC, r.created_at DESC
      LIMIT 60`,
    [scope.tenantId, scope.organizationId],
  );

  let otvorenyDoklad: Record<string, unknown> | undefined;
  let textPreRetrieval = normalizeName(input.otazka).slice(0, 1000);
  if (input.documentId) {
    const doklad = (await database.query<Record<string, any>>(
      `SELECT d.document_type, d.extracted, d.accounting, s.source, s.confidence, s.reason,
              p.code AS predkontacia_kod, dp.code AS dph_kod, s.clenenie_kv_kod,
              r.dovod, r.dovod_source
         FROM documents d
         LEFT JOIN accounting_suggestions s ON s.document_id=d.id AND s.tenant_id=d.tenant_id AND s.organization_id=d.organization_id
         LEFT JOIN accounting_rules r ON r.id=s.rule_id AND r.tenant_id=d.tenant_id AND r.organization_id=d.organization_id
         LEFT JOIN code_list_items p ON p.id=s.predkontacia_id AND p.tenant_id=d.tenant_id AND p.organization_id=d.organization_id
         LEFT JOIN code_list_items dp ON dp.id=s.clenenie_dph_id AND dp.tenant_id=d.tenant_id AND dp.organization_id=d.organization_id
        WHERE d.id=$1 AND d.tenant_id=$2 AND d.organization_id=$3`,
      [input.documentId, scope.tenantId, scope.organizationId],
    )).rows[0];
    if (doklad) {
      const extracted = (doklad.extracted ?? {}) as Record<string, any>;
      textPreRetrieval = `${textDokladu(extracted)} ${textPreRetrieval}`.slice(0, 1200);
      otvorenyDoklad = {
        typ: doklad.document_type,
        dodavatel: extracted.dodavatel?.nazov,
        icDph: extracted.dodavatel?.icDph,
        adresa: extracted.dodavatel?.adresa,
        suma: extracted.sumaSpolu,
        mena: extracted.mena,
        polozky: Array.isArray(extracted.polozky)
          ? extracted.polozky.slice(0, 10).map((item: any) => String(item?.popis ?? '').slice(0, 120))
          : [],
        navrh: {
          zdroj: doklad.source ?? 'none',
          predkontacia: doklad.predkontacia_kod ?? null,
          clenenieDph: doklad.dph_kod ?? null,
          clenenieKv: doklad.clenenie_kv_kod ?? null,
          dovodPravidla: doklad.dovod ?? null,
          dovodPravidlaZdroj: doklad.dovod_source ?? null,
        },
      };
    }
  }

  // Retrieval bez embeddingov — rovnaká podobnosť ako pri návrhu účtovania.
  const rozhodnutia = await database.query<Record<string, any>>(
    `SELECT d.line_text_normalized, d.supplier_name_normalized,
            p.code AS predkontacia_kod, dp.code AS dph_kod, d.clenenie_kv_kod
       FROM ucto_decisions d
       LEFT JOIN code_list_items p ON p.id=d.predkontacia_id AND p.tenant_id=d.tenant_id AND p.organization_id=d.organization_id
       LEFT JOIN code_list_items dp ON dp.id=d.clenenie_dph_id AND dp.tenant_id=d.tenant_id AND dp.organization_id=d.organization_id
      WHERE d.tenant_id=$1 AND d.organization_id=$2 AND d.excluded=false
      ORDER BY d.created_at DESC
      LIMIT 500`,
    [scope.tenantId, scope.organizationId],
  );
  const podobne = rozhodnutia.rows
    .map((row) => ({
      row,
      podobnost: textSimilarity(
        `${row.supplier_name_normalized ?? ''} ${row.line_text_normalized ?? ''}`,
        textPreRetrieval,
      ),
    }))
    .filter((item) => item.podobnost >= 0.25)
    .sort((a, b) => b.podobnost - a.podobnost)
    .slice(0, 5)
    .map((item) => ({
      dodavatel: item.row.supplier_name_normalized ?? undefined,
      text: (item.row.line_text_normalized ?? '').slice(0, 160),
      predkontacia: item.row.predkontacia_kod ?? null,
      clenenieDph: item.row.dph_kod ?? null,
      clenenieKv: item.row.clenenie_kv_kod ?? null,
      podobnost: Number(item.podobnost.toFixed(2)),
    }));

  return {
    firma: {
      nazov: organizacia?.name,
      ico: organizacia?.ico,
      icDph: organizacia?.ic_dph ?? undefined,
    },
    profilDph: dphProfil
      ? { platitelDph: dphProfil.platitelDph, rezim: dphProfil.rezim, pokyny: dphPokynyPreAi(dphProfil) }
      : undefined,
    uctovnyProfil: uctovnyProfil
      ? { obdobieUctovania: uctovnyProfil.obdobieUctovania, zaokruhlovanieDph: uctovnyProfil.zaokruhlovanieDph }
      : undefined,
    pouzivanePredkontacie: pouzivane.rows.map((row) => ({ kod: row.code, nazov: row.name, pocet: Number(row.pocet) })),
    pravidla: pravidla.rows.map((row) => ({
      dodavatel: row.supplier_name_normalized ?? row.supplier_ico ?? undefined,
      klucoveSlova: Array.isArray(row.keywords) ? row.keywords : [],
      predkontacia: row.predkontacia_kod ?? null,
      clenenieDph: row.dph_kod ?? null,
      clenenieKv: row.clenenie_kv_kod ?? null,
      dovod: row.dovod ?? null,
      dovodZdroj: row.dovod_source ?? null,
      opravene: Number(row.corrections_count ?? 0),
    })),
    podobneRozhodnutia: podobne,
    otvorenyDoklad,
  };
}

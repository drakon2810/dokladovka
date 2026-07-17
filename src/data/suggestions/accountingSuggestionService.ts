// AccountingSuggestionService — SPEC §11.15.
// Návrh zaúčtovania NIKDY nenahrádza rozhodnutie účtovníka; UI ho zobrazuje
// oddelene a prenáša do formulára až akciou „Použiť návrh".
// Poradie zdrojov: manual_rule > supplier_history > organization_default > ai > none.
// História INEJ organizácie sa nikdy nepoužije, aj keď je dodávateľ rovnaký.
import type { AccountingSuggestion, DocumentItem } from '../types';
import type { AppDataState } from '../store';
import { nowIso } from '../../lib/id';

// Produkčný backend ukladá manual rules, históriu a organizačné defaults
// server-side. Tento modul zostáva deterministickým adaptérom pre mock režim.

function activeUcto(
  state: Pick<AppDataState, 'codeLists'>,
  doc: DocumentItem,
): DocumentItem['ucto'] {
  const activeId = (
    list: AppDataState['codeLists'][keyof AppDataState['codeLists']],
    id: string | undefined,
  ) =>
    id &&
    list.some(
      (item) =>
        item.id === id &&
        item.tenantId === doc.tenantId &&
        item.orgId === doc.orgId &&
        item.active,
    )
      ? id
      : undefined;
  return {
    predkontaciaId: activeId(state.codeLists.predkontacie, doc.ucto.predkontaciaId),
    clenenieDphId: activeId(state.codeLists.cleneniaDph, doc.ucto.clenenieDphId),
    ciselnyRadId: activeId(state.codeLists.ciselneRady, doc.ucto.ciselnyRadId),
    strediskoId: activeId(state.codeLists.strediska, doc.ucto.strediskoId),
  };
}

export function buildSuggestionForDocument(
  state: Pick<AppDataState, 'documents' | 'codeLists'>,
  doc: DocumentItem,
): AccountingSuggestion {
  const supplierIco = doc.extracted.dodavatel.ico;

  // 1) supplier_history — posledné schválené doklady TOHO ISTÉHO dodávateľa
  //    v TEJ ISTEJ organizácii (SPEC §11.15 bod 3)
  if (supplierIco) {
    const history = state.documents
      .filter(
        (d) =>
          d.tenantId === doc.tenantId &&
          d.orgId === doc.orgId &&
          d.id !== doc.id &&
          (d.status === 'schvaleny' || d.status === 'exportovany') &&
          d.extracted.dodavatel.ico === supplierIco,
      )
      .map((document) => ({ document, ucto: activeUcto(state, document) }))
      .filter(({ ucto }) => ucto.predkontaciaId)
      .sort((a, b) => (a.document.prijateDna < b.document.prijateDna ? 1 : -1));
    if (history.length > 0) {
      const { document: last, ucto } = history[0];
      return {
        tenantId: doc.tenantId,
        organizationId: doc.orgId,
        documentId: doc.id,
        predkontaciaId: ucto.predkontaciaId,
        clenenieDphId: ucto.clenenieDphId,
        ciselnyRadId: ucto.ciselnyRadId,
        strediskoId: ucto.strediskoId,
        source: 'supplier_history',
        confidence: Math.min(0.6 + history.length * 0.1, 0.95),
        reason: `Navrhnuté podľa posledných ${history.length} schválených faktúr od tohto dodávateľa.`,
        basedOnDocumentId: last.id,
        createdAt: nowIso(),
      };
    }
  }

  // 2) organization_default — default organizácie podľa typu dokladu
  const orgLists = {
    predkontacie: state.codeLists.predkontacie.filter(
      (c) => c.tenantId === doc.tenantId && c.orgId === doc.orgId && c.active,
    ),
    cleneniaDph: state.codeLists.cleneniaDph.filter(
      (c) => c.tenantId === doc.tenantId && c.orgId === doc.orgId && c.active,
    ),
    ciselneRady: state.codeLists.ciselneRady.filter(
      (c) => c.tenantId === doc.tenantId && c.orgId === doc.orgId && c.active,
    ),
    strediska: state.codeLists.strediska.filter(
      (c) => c.tenantId === doc.tenantId && c.orgId === doc.orgId && c.active,
    ),
  };
  const radKod = doc.typ === 'FV' ? '26FV' : doc.typ === 'OZ' ? '26OZ' : '26FP';
  const defaultRad = orgLists.ciselneRady.find((c) => c.kod === radKod);
  const defaultPk = orgLists.predkontacie.find((c) => c.kod === '518/321');
  const defaultCd = orgLists.cleneniaDph.find((c) => c.kod === 'PD');

  if ((doc.typ === 'FP' || doc.typ === 'FV' || doc.typ === 'OZ' || doc.typ === 'PD') && defaultRad) {
    return {
      tenantId: doc.tenantId,
      organizationId: doc.orgId,
      documentId: doc.id,
      predkontaciaId: defaultPk?.id,
      clenenieDphId: defaultCd?.id,
      ciselnyRadId: defaultRad.id,
      strediskoId: undefined,
      source: 'organization_default',
      confidence: 0.4,
      reason: 'Navrhnuté podľa predvolieb organizácie pre tento typ dokladu.',
      createdAt: nowIso(),
    };
  }

  // 3) none — istota nestačí, polia zostanú prázdne (SPEC §11.15 bod 6)
  return {
    tenantId: doc.tenantId,
    organizationId: doc.orgId,
    documentId: doc.id,
    source: 'none',
    confidence: 0,
    reason: 'Žiadny spoľahlivý návrh — vyplňte zaúčtovanie ručne.',
    createdAt: nowIso(),
  };
}

/** „Naposledy pre tohto dodávateľa: 518/321 · PD" — mock logika (SPEC §6.4). */
export function lastUsedForSupplier(
  state: Pick<AppDataState, 'documents' | 'codeLists'>,
  doc: DocumentItem,
): { label: string; ucto: DocumentItem['ucto'] } | undefined {
  const supplierIco = doc.extracted.dodavatel.ico;
  if (!supplierIco) return undefined;
  const last = state.documents
    .filter(
      (d) =>
        d.tenantId === doc.tenantId &&
        d.orgId === doc.orgId &&
        d.id !== doc.id &&
        (d.status === 'schvaleny' || d.status === 'exportovany') &&
        d.extracted.dodavatel.ico === supplierIco,
    )
    .map((document) => ({ document, ucto: activeUcto(state, document) }))
    .filter(({ ucto }) => ucto.predkontaciaId)
    .sort((a, b) => (a.document.prijateDna < b.document.prijateDna ? 1 : -1))[0];
  if (!last) return undefined;
  const { document, ucto } = last;
  const pk = state.codeLists.predkontacie.find(
    (c) => c.id === ucto.predkontaciaId && c.tenantId === doc.tenantId && c.active,
  );
  const cd = state.codeLists.cleneniaDph.find(
    (c) => c.id === ucto.clenenieDphId && c.tenantId === doc.tenantId && c.active,
  );
  const label = [pk?.kod, cd?.kod].filter(Boolean).join(' · ');
  return label ? { label, ucto: { ...ucto, poznamka: document.ucto.poznamka } } : undefined;
}

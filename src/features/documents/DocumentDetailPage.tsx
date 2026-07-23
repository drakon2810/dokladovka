import {
  useCallback,
  useEffect,
  lazy,
  useMemo,
  useRef,
  useState,
  Suspense,
  type CSSProperties,
  type ReactNode,
} from 'react';
import { Document, Page, pdfjs } from 'react-pdf';
import { Link, useLocation, useNavigate, useParams } from 'react-router-dom';
import {
  addComment,
  applyExtractionRun,
  approveDocument,
  checkApprovable,
  getDocument,
  getDphAdvice,
  getLastUsedForSupplier,
  getSuggestion,
  listExtractionRuns,
  markNotDuplicate,
  processManually,
  quarantineDocument,
  rejectDocument,
  reprocessDocument,
  saveDocument,
  updatePaymentStatus,
} from '../../data/api';
import { useDataQuery } from '../../data/query';
import type {
  AccountingSuggestion,
  DocumentExtractedData,
  DocumentItem,
  DocumentType,
  DocumentUcto,
  DphPosudok,
  ExtractionRun,
  VatBreakdownRow,
} from '../../data/types';
import { CLENENIE_KV_KODY } from '../../data/types';
import { nextNumberInSeries } from '../../data/pohoda/numbering';
import {
  ConfidenceIndicator,
  Modal,
  OrgChip,
  PaymentStatusBadge,
  ProcessingBadge,
  StatusBadge,
} from '../../components/ui';
import { showToast } from '../../components/toast';
import { formatDateTime } from '../../lib/format';
import {
  isTotalConsistent,
  isVatRowConsistent,
  round2,
  validateIBAN,
  validateICO,
  vatBreakdownTotal,
} from '../../lib/validate';
import { isForeignSupplier } from '../../data/validation/documentValidation';
import { t, type SkKey } from '../../i18n/sk';
import { getLocalDocumentFile } from '../../data/files/localDocumentFileStore';
import { EInvoicePreview } from './EInvoicePreview';
import { BankStatementPreview } from './BankStatementPreview';
import { PaymentCard } from './PaymentCard';
import { InvoicePanel } from './InvoicePanel';
import { useAuth } from '../../auth/AuthContext';
import {
  createMostikExportJob,
  getOrganizationMostikStatus,
  type OrganizationMostikStatus,
} from '../../data/mostik/mostikService';

const PaymentQrModal = lazy(() =>
  import('../payments/PaymentQrModal').then((module) => ({ default: module.PaymentQrModal })),
);

// ===== Komunikácia: @-spomenutia v komentároch =====

const MENTION_TOKEN = /@([\p{L}\p{N}. ]{0,40})$/u;

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Zvýrazní @-spomenutia známych používateľov v texte komentára. */
function CommentText({ text, names }: { text: string; names: string[] }) {
  if (names.length === 0) return <p className="whitespace-pre-wrap">{text}</p>;
  const pattern = names
    .map(escapeRegExp)
    .sort((a, b) => b.length - a.length)
    .join('|');
  const parts = text.split(new RegExp(`(@(?:${pattern}))`, 'gu'));
  return (
    <p className="whitespace-pre-wrap">
      {parts.map((part, index) =>
        part.startsWith('@') && names.includes(part.slice(1)) ? (
          <span key={index} className="rounded bg-accent/10 px-1 font-medium text-accent-hover">
            {part}
          </span>
        ) : (
          <span key={index}>{part}</span>
        ),
      )}
    </p>
  );
}

pdfjs.GlobalWorkerOptions.workerSrc = new URL(
  'pdfjs-dist/build/pdf.worker.min.mjs',
  import.meta.url,
).toString();

const DOCUMENT_TYPES: DocumentType[] = ['FP', 'FV', 'BV', 'MZDY', 'OZ', 'PD'];

const FIELD_ALIASES: Record<string, string[]> = {
  'dodavatel.nazov': ['dodavatel.nazov', 'supplier.nazov'],
  'dodavatel.ico': ['dodavatel.ico', 'supplier.ico'],
  'dodavatel.dic': ['dodavatel.dic', 'supplier.dic'],
  'dodavatel.icDph': ['dodavatel.icDph', 'supplier.icDph'],
  'dodavatel.adresa': ['dodavatel.adresa', 'supplier.adresa'],
  'dodavatel.iban': ['dodavatel.iban', 'supplier.iban'],
  cisloFaktury: ['cisloFaktury', 'invoiceNumber'],
  variabilnySymbol: ['variabilnySymbol', 'variableSymbol'],
  konstantnySymbol: ['konstantnySymbol', 'constantSymbol'],
  specifickySymbol: ['specifickySymbol', 'specificSymbol'],
  datumVystavenia: ['datumVystavenia', 'issueDate'],
  datumDodania: ['datumDodania', 'taxDate'],
  datumSplatnosti: ['datumSplatnosti', 'dueDate'],
  mena: ['mena', 'currency'],
  sumaSpolu: ['sumaSpolu', 'totalAmount'],
};

const QUARANTINE_KEYS: Record<string, SkKey> = {
  buyer_ico_mismatch: 'detail.karantena.buyer_ico_mismatch',
  unknown_alias: 'detail.karantena.unknown_alias',
  sender_not_whitelisted: 'detail.karantena.sender_not_whitelisted',
  alias_disabled: 'detail.karantena.alias_disabled',
  ambiguous_recipient: 'detail.karantena.ambiguous_recipient',
  organization_archived: 'detail.karantena.organization_archived',
  corrupted_file: 'detail.karantena.corrupted_file',
  password_protected_pdf: 'detail.karantena.password_protected_pdf',
  no_supported_attachment: 'detail.karantena.no_supported_attachment',
  unsupported_type: 'detail.karantena.unsupported_type',
  queue_type_mismatch: 'detail.karantena.queue_type_mismatch',
};

function cloneDocument(document: DocumentItem): DocumentItem {
  return structuredClone(document);
}

function confidenceFor(document: DocumentItem, field: string): number | undefined {
  for (const key of FIELD_ALIASES[field] ?? [field]) {
    const value = document.fieldConfidence?.[key];
    if (value !== undefined) return value;
  }
  return undefined;
}

function evidenceFor(runs: ExtractionRun[], field: string, appliedRunId?: string): string[] {
  const run = runs.find((item) => item.id === appliedRunId && item.status === 'succeeded' && item.result)
    ?? runs.find((item) => item.status === 'succeeded' && item.result);
  if (!run?.result) return [];
  for (const key of FIELD_ALIASES[field] ?? [field]) {
    const evidence = run.result.evidence[key]
      ?.map((item) => {
        const text = item.text?.trim();
        if (!text) return undefined;
        return item.page ? `${t('detail.strana')} ${item.page}: ${text}` : text;
      })
      .filter((item): item is string => Boolean(item));
    if (evidence?.length) return evidence;
  }
  return [];
}

const WARNING_FIELDS: Record<string, string[]> = {
  supplier_name_required: ['dodavatel.nazov'],
  invalid_supplier_ico: ['dodavatel.ico'],
  invalid_supplier_dic: ['dodavatel.dic'],
  invalid_supplier_vat_id: ['dodavatel.icDph'],
  unverified_supplier_vat_id: ['dodavatel.icDph'],
  invalid_buyer_vat_id: ['odberatel.icDph'],
  unverified_buyer_vat_id: ['odberatel.icDph'],
  invalid_iban: ['dodavatel.iban'],
  invoice_number_required: ['cisloFaktury'],
  invalid_issue_date: ['datumVystavenia'],
  tax_date_required: ['datumDodania'],
  due_date_required: ['datumSplatnosti'],
  due_before_issue: ['datumSplatnosti'],
  unsupported_currency: ['mena'],
  total_required: ['sumaSpolu'],
  total_mismatch: ['sumaSpolu'],
  declared_totals_mismatch: ['sumaSpolu'],
};

function hasFieldWarning(runs: ExtractionRun[], field: string, appliedRunId?: string): boolean {
  const run = runs.find((item) => item.id === appliedRunId && item.status === 'succeeded' && item.result)
    ?? runs.find((item) => item.status === 'succeeded' && item.result);
  return run?.result?.warnings.some((warning) => WARNING_FIELDS[warning.code]?.includes(field)) ?? false;
}

function Field({
  label,
  confidence,
  evidence,
  error,
  children,
}: {
  label: string;
  confidence?: number;
  evidence?: string[];
  error?: string;
  children: ReactNode;
}) {
  const lowConfidence = confidence !== undefined && confidence < 0.7;
  return (
    <div
      className={`rounded p-2 ${
        lowConfidence ? 'bg-amber-50 ring-1 ring-amber-200' : ''
      } ${error ? 'ring-1 ring-red-300' : ''}`}
      title={lowConfidence ? t('detail.nizkaIstota') : undefined}
    >
      <div className="mb-1 flex items-center justify-between gap-2">
        <span className="label mb-0">{label}</span>
        {confidence !== undefined && <ConfidenceIndicator value={confidence} />}
      </div>
      {children}
      {error && <p className="mt-1 text-xs text-red-700">{error}</p>}
      {evidence?.slice(0, 2).map((text, index) => (
        <p key={`${text}-${index}`} className="mt-1 text-xs text-ink-soft">
          {t('detail.evidence')}: {text}
        </p>
      ))}
    </div>
  );
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="card p-4">
      <h2 className="mb-3 text-[13px] font-semibold">{title}</h2>
      {children}
    </section>
  );
}

/** Zelená fajka vnútri poľa pre hodnotu overenú deterministickou validáciou. */
function ValidTick({ show, children }: { show: boolean; children: ReactNode }) {
  return (
    <div className="relative min-w-0 flex-1">
      {children}
      {show && (
        <svg
          width="15"
          height="15"
          viewBox="0 0 24 24"
          fill="none"
          stroke="#16A34A"
          strokeWidth="2.5"
          strokeLinecap="round"
          strokeLinejoin="round"
          className="anim-pop pointer-events-none absolute right-2.5 top-1/2 -translate-y-1/2"
          aria-hidden
        >
          <path d="M20 6 9 17l-5-5" />
        </svg>
      )}
    </div>
  );
}

function SourceRow({ label, value }: { label: string; value?: string }) {
  return (
    <div className="grid grid-cols-[10rem_1fr] gap-3 border-b border-line py-1.5 text-sm last:border-0">
      <dt className="text-ink-soft">{label}</dt>
      <dd className="min-w-0 break-words tnum">{value || '—'}</dd>
    </div>
  );
}

function normalizeQueueText(value: string): string {
  return value
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLocaleLowerCase('sk');
}

function processingMatches(status: DocumentItem['processingStatus'], filter: string): boolean {
  if (!filter) return true;
  if (filter === 'caka') return ['received', 'validating', 'queued'].includes(status);
  if (filter === 'spracuva') return ['extracting', 'normalizing'].includes(status);
  if (filter === 'hotovo') return status === 'ready_for_review';
  return status === 'failed_retryable' || status === 'failed_permanent';
}

export function DocumentDetailPage() {
  const { session } = useAuth();
  const { id = '' } = useParams();
  const navigate = useNavigate();
  const location = useLocation();
  const { data, loading, error } = useDataQuery();

  const sourceDocument = data?.documents.find((item) => item.id === id);
  const organization = data?.organizations.find((item) => item.id === sourceDocument?.orgId);
  const role = data?.role ?? 'uctovnik';
  const [draft, setDraft] = useState<DocumentItem>();
  const [dirty, setDirty] = useState(false);
  const [busy, setBusy] = useState(false);
  const [runs, setRuns] = useState<ExtractionRun[]>([]);
  const [suggestion, setSuggestion] = useState<AccountingSuggestion>();
  const [dphAdvice, setDphAdvice] = useState<DphPosudok>();
  const [lastUsed, setLastUsed] = useState<{ label: string; ucto: DocumentUcto }>();
  const [activeBottomTab, setActiveBottomTab] = useState<'comments' | 'history'>('comments');
  const [comment, setComment] = useState('');
  const [pageNumber, setPageNumber] = useState(1);
  const [pageCount, setPageCount] = useState(0);
  const [zoom, setZoom] = useState(1);
  const [pdfError, setPdfError] = useState(false);
  const [localFileUrl, setLocalFileUrl] = useState<string>();
  const [localFileLoading, setLocalFileLoading] = useState(false);
  const [splitPercent, setSplitPercent] = useState(50);
  const [paymentModalOpen, setPaymentModalOpen] = useState(false);
  const [rejectModalOpen, setRejectModalOpen] = useState(false);
  const [rejectionReason, setRejectionReason] = useState('');
  const [mostikStatus, setMostikStatus] = useState<OrganizationMostikStatus>();
  const [autoFilled, setAutoFilled] = useState(false);
  const autoFilledFor = useRef<string>();
  const splitRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!sourceDocument) {
      setDraft(undefined);
      return;
    }
    setDraft(cloneDocument(sourceDocument));
    setDirty(false);
    setAutoFilled(false);
    autoFilledFor.current = undefined;
    setPageNumber(1);
    setPageCount(0);
    setZoom(1);
    setPdfError(false);
  }, [sourceDocument?.id, sourceDocument?.version]);

  useEffect(() => {
    const key = sourceDocument?.zdroj.localFileKey;
    let active = true;
    let objectUrl: string | undefined;
    if (!key) {
      setLocalFileUrl(undefined);
      setLocalFileLoading(false);
      return undefined;
    }
    setLocalFileUrl(undefined);
    setLocalFileLoading(true);
    void getLocalDocumentFile(key)
      .then((stored) => {
        if (!stored) return;
        objectUrl = URL.createObjectURL(stored.blob);
        if (active) setLocalFileUrl(objectUrl);
        else URL.revokeObjectURL(objectUrl);
      })
      .catch(() => undefined)
      .finally(() => {
        if (active) setLocalFileLoading(false);
      });
    return () => {
      active = false;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [sourceDocument?.id, sourceDocument?.zdroj.localFileKey]);

  useEffect(() => {
    let active = true;
    if (!id) return undefined;
    void Promise.all([
      listExtractionRuns(id),
      getSuggestion(id),
      getLastUsedForSupplier(id),
    ])
      .then(([nextRuns, nextSuggestion, nextLastUsed]) => {
        if (!active) return;
        setRuns(nextRuns);
        setSuggestion(nextSuggestion);
        setLastUsed(nextLastUsed);
      })
      .catch(() => {
        if (active) showToast(t('chyba.vseobecna'), { tone: 'error' });
      });
    return () => {
      active = false;
    };
  }, [id]);

  // Automatické predvyplnenie: návrh s vysokou istotou (pravidlo, pamäť
  // rozhodnutí, predvoľby partnera) sa vpíše do konceptu hneď pri otvorení —
  // účtovník ho len skontroluje a schváli. Nižšia istota (história, AI)
  // ostáva na tlačidle „Použiť návrh". Nikdy sa nič neschvaľuje samo.
  useEffect(() => {
    if (!draft || !suggestion || suggestion.source === 'none' || suggestion.confidence < 0.9) return;
    if (suggestion.documentId !== draft.id || autoFilledFor.current === draft.id) return;
    if (role === 'schvalovatel') return; // read-only rola koncept nemení
    if (!['extrahovany', 'na_kontrole'].includes(draft.status)) return;
    // Nič sa neprepisuje: koncept musí byť nedotknutý a zaúčtovanie úplne prázdne.
    if (dirty || draft.ucto.predkontaciaId || draft.ucto.clenenieDphId || draft.ucto.ciselnyRadId
      || draft.ucto.strediskoId || draft.ucto.clenenieKvKod) return;
    autoFilledFor.current = draft.id;
    setDraft((current) => current && {
      ...current,
      ucto: {
        ...current.ucto,
        ...(suggestion.predkontaciaId ? { predkontaciaId: suggestion.predkontaciaId } : {}),
        ...(suggestion.clenenieDphId ? { clenenieDphId: suggestion.clenenieDphId } : {}),
        ...(suggestion.ciselnyRadId ? { ciselnyRadId: suggestion.ciselnyRadId } : {}),
        ...(suggestion.strediskoId ? { strediskoId: suggestion.strediskoId } : {}),
        ...(suggestion.clenenieKvKod ? { clenenieKvKod: suggestion.clenenieKvKod } : {}),
      },
    });
    setDirty(true);
    setAutoFilled(true);
  }, [draft, dirty, role, suggestion]);

  // DPH poradca sa prepočítava na serveri — po každej uloženej verzii dokladu
  // sa načíta znova, aby varovania zodpovedali aktuálnemu zaúčtovaniu.
  useEffect(() => {
    let active = true;
    if (!id) return undefined;
    void getDphAdvice(id)
      .then((advice) => {
        if (active) setDphAdvice(advice);
      })
      .catch(() => undefined);
    return () => {
      active = false;
    };
  }, [id, sourceDocument?.version]);

  useEffect(() => {
    let active = true;
    if (!sourceDocument?.orgId) {
      setMostikStatus(undefined);
      return undefined;
    }
    void getOrganizationMostikStatus(sourceDocument.orgId)
      .then((status) => { if (active) setMostikStatus(status); })
      .catch(() => { if (active) setMostikStatus({ enabled: false, connected: false, matched: false, available: false }); });
    return () => { active = false; };
  }, [sourceDocument?.orgId]);

  const queueDocuments = useMemo(() => {
    if (!data) return [];
    const params = new URLSearchParams(location.search);
    const exactStatus = params.get('status');
    const tab = params.get('tab');
    const query = normalizeQueueText(params.get('q') ?? '').trim();
    const queueId = params.get('fronta');
    const type = params.get('typ');
    const supplier = params.get('dodavatel');
    const dateFrom = params.get('od');
    const dateTo = params.get('do');
    const source = params.get('zdroj');
    const processing = params.get('spracovanie') ?? '';
    const actionOnly = params.get('zasah') === '1';
    const emailOnly = params.get('email') === '1';
    const problemStatuses = ['chyba', 'karantena', 'duplicita'];

    const filtered = data.documents.filter((item) => {
      if (data.currentOrgId !== 'all' && item.orgId !== data.currentOrgId) return false;
      if (queueId && item.queueId !== queueId) return false;
      if (exactStatus && item.status !== exactStatus) return false;
      if (!exactStatus && tab === 'na_kontrole' && !['extrahovany', 'na_kontrole'].includes(item.status)) return false;
      if (!exactStatus && tab === 'schvalene' && item.status !== 'schvaleny') return false;
      if (!exactStatus && tab === 'exportovane' && item.status !== 'exportovany') return false;
      if (
        !exactStatus &&
        tab === 'na_uhradu' &&
        !['to_pay', 'payment_order', 'partially_paid'].includes(item.payment?.status ?? '')
      ) return false;
      if (!exactStatus && tab === 'problemy' && !problemStatuses.includes(item.status)) return false;
      if (query) {
        const searchable = normalizeQueueText(
          `${item.extracted.dodavatel.nazov} ${item.extracted.cisloFaktury} ${item.extracted.variabilnySymbol ?? ''}`,
        );
        if (!searchable.includes(query)) return false;
      }
      if (type && item.typ !== type) return false;
      if (supplier && item.extracted.dodavatel.nazov !== supplier) return false;
      const periodDate = item.extracted.datumDodania ?? item.extracted.datumVystavenia;
      if (dateFrom && periodDate < dateFrom) return false;
      if (dateTo && periodDate > dateTo) return false;
      if (source && item.zdroj.typ !== source) return false;
      if (!processingMatches(item.processingStatus, processing)) return false;
      if (emailOnly && item.zdroj.typ !== 'email') return false;
      if (
        actionOnly &&
        !(
          problemStatuses.includes(item.status) ||
          item.processingStatus.startsWith('failed') ||
          item.confidence < 0.7
        )
      ) return false;
      return true;
    });

    const sortKey = params.get('zoradit') ?? 'delivery';
    const direction = params.get('smer') === 'asc' ? 1 : -1;
    const organizationNames = new Map(
      data.organizations.map((item) => [item.id, item.nazov]),
    );
    const valueOf = (item: DocumentItem): string | number => {
      if (sortKey === 'organization') return organizationNames.get(item.orgId) ?? '';
      if (sortKey === 'type') return item.typ;
      if (sortKey === 'supplier') return item.extracted.dodavatel.nazov;
      if (sortKey === 'invoice') return item.extracted.cisloFaktury;
      if (sortKey === 'due') return item.extracted.datumSplatnosti ?? '';
      if (sortKey === 'amount') return item.extracted.sumaSpolu;
      if (sortKey === 'status') return item.status;
      if (sortKey === 'processing') return item.processingStatus;
      if (sortKey === 'confidence') return item.confidence;
      return item.extracted.datumDodania ?? item.extracted.datumVystavenia;
    };
    return filtered.sort((left, right) => {
      const leftValue = valueOf(left);
      const rightValue = valueOf(right);
      const compared =
        typeof leftValue === 'number' && typeof rightValue === 'number'
          ? leftValue - rightValue
          : String(leftValue).localeCompare(String(rightValue), 'sk', { numeric: true });
      return (compared || left.id.localeCompare(right.id)) * direction;
    });
  }, [data, location.search]);
  const queueIndex = queueDocuments.findIndex((item) => item.id === id);
  const previousDocument = queueIndex > 0 ? queueDocuments[queueIndex - 1] : undefined;
  const nextDocument =
    queueIndex >= 0 && queueIndex < queueDocuments.length - 1
      ? queueDocuments[queueIndex + 1]
      : undefined;

  const goToDocument = useCallback(
    (documentId: string | undefined) => {
      if (documentId) navigate(`/doklady/${documentId}${location.search}`);
    },
    [location.search, navigate],
  );

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      if (
        target?.matches('input, textarea, select, button, a') ||
        target?.isContentEditable
      ) {
        return;
      }
      if (event.key.toLowerCase() === 'j' && nextDocument) {
        event.preventDefault();
        goToDocument(nextDocument.id);
      }
      if (event.key.toLowerCase() === 'k' && previousDocument) {
        event.preventDefault();
        goToDocument(previousDocument.id);
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [goToDocument, nextDocument, previousDocument]);

  const approval = useMemo(
    () =>
      draft && data
        ? checkApprovable(draft, data.codeLists, data.organizations)
        : undefined,
    [data, draft],
  );

  const beginResize = useCallback((event: React.PointerEvent<HTMLButtonElement>) => {
    const container = splitRef.current;
    if (!container) return;
    event.preventDefault();
    const update = (clientX: number) => {
      const bounds = container.getBoundingClientRect();
      const percent = ((clientX - bounds.left) / bounds.width) * 100;
      setSplitPercent(Math.min(70, Math.max(30, percent)));
    };
    const onMove = (moveEvent: PointerEvent) => update(moveEvent.clientX);
    const onUp = () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
    };
    update(event.clientX);
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp, { once: true });
  }, []);

  if (loading) {
    return <p className="text-sm text-ink-soft">{t('stav.nacitavam')}</p>;
  }
  if (error) {
    return <p className="text-sm text-red-700">{t('chyba.vseobecna')}</p>;
  }
  if (!data || !draft || !organization) {
    return (
      <div className="space-y-3">
        <p className="text-sm text-ink-soft">{t('stav.ziadneData')}</p>
        <Link className="btn" to={`/doklady${location.search}`}>
          {t('detail.spat')}
        </Link>
      </div>
    );
  }

  const hasAttachedFile = Boolean(draft.zdroj.localFileKey || draft.pdfUrl);
  const fileUrl = draft.zdroj.localFileKey ? localFileUrl : draft.pdfUrl || undefined;
  const imagePreview = ['image/jpeg', 'image/png', 'image/webp'].includes(draft.zdroj.mimeType ?? '');
  // XML doklady nemajú PDF — náhľad sa generuje z extrahovaných dát
  // (e-faktúra PEPPOL alebo bankový výpis SEPA).
  const xmlPreview = draft.zdroj.mimeType === 'application/xml'
    || draft.zdroj.format === 'peppol_xml'
    || draft.zdroj.format === 'sepa_xml';
  const sepaPreview = draft.zdroj.format === 'sepa_xml';
  const formatBadgeKey: SkKey | undefined =
    draft.zdroj.format === 'peppol_xml'
      ? 'format.peppol'
      : draft.zdroj.format === 'sepa_xml'
        ? 'format.sepa'
        : draft.zdroj.format === 'blocek_foto'
          ? 'format.blocek'
          : draft.zdroj.format === 'mzdova_paska'
            ? 'format.mzdova'
            : undefined;
  const intakeProcessingLabel =
    draft.processingStatus === 'ready_for_review' && draft.zdroj.typ === 'manual'
      ? t('processing.manual')
      : draft.processingStatus === 'ready_for_review' &&
          draft.zdroj.typ === 'upload' &&
          draft.confidence === 0
        ? t('processing.upload')
        : undefined;
  const readOnly = role === 'schvalovatel' || draft.status === 'exportovany';
  const canApproveStatus =
    role === 'schvalovatel'
      ? draft.status === 'na_kontrole'
      : ['na_kontrole', 'extrahovany'].includes(draft.status);
  const buyerMismatch =
    Boolean(draft.extracted.odberatel?.ico) &&
    draft.extracted.odberatel?.ico !== organization.ico;
  const foreignSupplier = isForeignSupplier(draft.extracted.dodavatel);
  const codeLists = {
    predkontacie: data.codeLists.predkontacie.filter(
      (item) => item.orgId === draft.orgId && item.active,
    ),
    cleneniaDph: data.codeLists.cleneniaDph.filter(
      (item) => item.orgId === draft.orgId && item.active,
    ),
    ciselneRady: data.codeLists.ciselneRady.filter(
      (item) => item.orgId === draft.orgId && item.active,
    ),
    strediska: data.codeLists.strediska.filter(
      (item) => item.orgId === draft.orgId && item.active,
    ),
    zakazky: (data.codeLists.zakazky ?? []).filter(
      (item) => item.orgId === draft.orgId && item.active,
    ),
    cinnosti: (data.codeLists.cinnosti ?? []).filter(
      (item) => item.orgId === draft.orgId && item.active,
    ),
    projekty: (data.codeLists.projekty ?? []).filter(
      (item) => item.orgId === draft.orgId && item.active,
    ),
  };
  const orgNoteTemplates = (data.noteTemplates ?? []).filter(
    (template) => template.organizationId === draft.orgId,
  );

  const markDirty = (updater: (current: DocumentItem) => DocumentItem) => {
    setDraft((current) => (current ? updater(current) : current));
    setDirty(true);
  };

  const updateSupplier = (
    key: keyof DocumentExtractedData['dodavatel'],
    value: string,
  ) => {
    markDirty((current) => ({
      ...current,
      extracted: {
        ...current.extracted,
        dodavatel: { ...current.extracted.dodavatel, [key]: value || undefined },
      },
    }));
  };

  const updateExtracted = <K extends keyof DocumentExtractedData>(
    key: K,
    value: DocumentExtractedData[K],
  ) => {
    markDirty((current) => ({
      ...current,
      extracted: { ...current.extracted, [key]: value },
    }));
  };

  const updateVatRow = (index: number, patch: Partial<VatBreakdownRow>) => {
    updateExtracted(
      'rozpisDph',
      draft.extracted.rozpisDph.map((row, rowIndex) =>
        rowIndex === index ? { ...row, ...patch } : row,
      ),
    );
  };

  const updateUcto = (patch: Partial<DocumentUcto>) => {
    markDirty((current) => ({ ...current, ucto: { ...current.ucto, ...patch } }));
  };

  const fieldProps = (field: string) => ({
    confidence: confidenceFor(draft, field),
    evidence: evidenceFor(runs, field, draft.appliedExtractionRunId),
    error: hasFieldWarning(runs, field, draft.appliedExtractionRunId) ? t('detail.aiWarning') : undefined,
  });

  const storeDraft = async (): Promise<DocumentItem> =>
    saveDocument(draft.id, {
      typ: draft.typ,
      extracted: draft.extracted,
      ucto: draft.ucto,
    }, draft.version);

  const handleSave = async () => {
    setBusy(true);
    try {
      const saved = await storeDraft();
      setDraft(cloneDocument(saved));
      setDirty(false);
      showToast(t('toast.ulozene'));
    } catch {
      showToast(t('chyba.vseobecna'), { tone: 'error' });
    } finally {
      setBusy(false);
    }
  };

  const handleApprove = async () => {
    setBusy(true);
    try {
      const version = dirty && !readOnly ? (await storeDraft()).version : draft.version;
      const approved = await approveDocument(draft.id, version);
      setDraft(cloneDocument(approved));
      setDirty(false);
      showToast(t('toast.schvalene'));
    } catch (cause) {
      // Server vracia zrozumiteľné slovenské správy (prahy schvaľovania,
      // blokácie DPH profilu) — zobrazíme ich namiesto všeobecnej chyby.
      showToast(cause instanceof Error && cause.message ? cause.message : t('chyba.vseobecna'), { tone: 'error' });
    } finally {
      setBusy(false);
    }
  };

  const runDocumentAction = async (
    action: () => Promise<DocumentItem>,
    successKey: SkKey,
  ) => {
    setBusy(true);
    try {
      const result = await action();
      setDraft(cloneDocument(result));
      setDirty(false);
      showToast(t(successKey));
    } catch {
      showToast(t('chyba.vseobecna'), { tone: 'error' });
    } finally {
      setBusy(false);
    }
  };

  const handleReprocess = async () => {
    setBusy(true);
    try {
      await reprocessDocument(draft.id);
      const [nextRuns, nextDocument] = await Promise.all([
        listExtractionRuns(draft.id),
        getDocument(draft.id),
      ]);
      setRuns(nextRuns);
      if (nextDocument) setDraft(cloneDocument(nextDocument));
      showToast(t('toast.ulozene'));
    } catch {
      showToast(t('chyba.vseobecna'), { tone: 'error' });
    } finally {
      setBusy(false);
    }
  };

  const handleApplyRun = async (runId: string) => {
    setBusy(true);
    try {
      const updated = await applyExtractionRun(draft.id, runId, draft.version);
      setDraft(cloneDocument(updated));
      setDirty(false);
      setSuggestion(await getSuggestion(draft.id));
      showToast(t('toast.ulozene'));
    } catch {
      showToast(t('chyba.vseobecna'), { tone: 'error' });
    } finally {
      setBusy(false);
    }
  };

  // @-spomenutia: kandidáti sa ponúkajú pre rozpísaný @token na konci textu.
  const userNames = (data?.users ?? []).map((user) => user.meno).filter(Boolean);
  const mentionMatch = MENTION_TOKEN.exec(comment);
  const mentionCandidates = mentionMatch
    ? (data?.users ?? [])
        .filter((user) => user.meno.toLocaleLowerCase('sk').startsWith(mentionMatch[1].toLocaleLowerCase('sk'))
          && user.meno.toLocaleLowerCase('sk') !== mentionMatch[1].trim().toLocaleLowerCase('sk'))
        .slice(0, 5)
    : [];
  const insertMention = (name: string) => {
    setComment((current) => current.replace(MENTION_TOKEN, `@${name} `));
  };

  const handleComment = async () => {
    const text = comment.trim();
    if (!text) return;
    setBusy(true);
    try {
      const result = await addComment(draft.id, text);
      setDraft((current) =>
        current
          ? { ...current, comments: result.comments, history: result.history }
          : cloneDocument(result),
      );
      setComment('');
    } catch {
      showToast(t('chyba.vseobecna'), { tone: 'error' });
    } finally {
      setBusy(false);
    }
  };

  const handleReject = async () => {
    setBusy(true);
    try {
      const rejected = await rejectDocument(draft.id, draft.version, rejectionReason);
      setDraft(cloneDocument(rejected));
      setDirty(false);
      setRejectionReason('');
      setRejectModalOpen(false);
      showToast(t('toast.zamietnute'));
    } catch {
      showToast(t('zamietnutie.chyba'), { tone: 'error' });
    } finally {
      setBusy(false);
    }
  };

  const handleMostikExport = async () => {
    if (!mostikStatus?.available || draft.status !== 'schvaleny' || dirty) return;
    setBusy(true);
    try {
      await createMostikExportJob(draft.orgId, [draft.id], session?.csrfToken);
      showToast(t('mostik.prenosVytvoreny'));
    } catch {
      showToast(t('chyba.vseobecna'), { tone: 'error' });
    } finally {
      setBusy(false);
    }
  };

  return (
    <div
      className="-m-1 space-y-4 border-l-[3px] p-1 pl-4"
      style={{ borderLeftColor: organization.farba }}
    >
      <div className="flex flex-wrap items-center gap-3">
        <Link className="btn" to={`/doklady${location.search}`}>
          ← {t('detail.spat')}
        </Link>
        <div>
          <h1 className="text-xl font-semibold">{t('detail.titulok')}</h1>
          <div className="mt-1 flex flex-wrap items-center gap-2">
            <OrgChip org={organization} />
            <StatusBadge status={draft.status} />
            <ProcessingBadge status={draft.processingStatus} label={intakeProcessingLabel} />
            <PaymentStatusBadge status={draft.payment?.status ?? 'unpaid'} />
            {draft.confidence > 0 && (
              <span
                className="inline-flex items-center gap-1.5 whitespace-nowrap rounded-full border border-line bg-app px-2.5 py-0.5 text-xs text-ink-soft"
                title={t('detail.aiIstotaTooltip')}
              >
                {t('detail.aiIstota')}
                <ConfidenceIndicator value={draft.confidence} showPercent />
              </span>
            )}
          </div>
        </div>
        <div className="ml-auto flex items-center gap-2">
          {queueIndex >= 0 && queueDocuments.length > 1 && (
            <span className="tnum text-xs text-ink-soft" aria-hidden>
              {queueIndex + 1} / {queueDocuments.length}
            </span>
          )}
          <button
            type="button"
            className="btn"
            disabled={!previousDocument}
            onClick={() => goToDocument(previousDocument?.id)}
          >
            ← {t('detail.predchadzajuci')}
          </button>
          <button
            type="button"
            className="btn"
            disabled={!nextDocument}
            onClick={() => goToDocument(nextDocument?.id)}
          >
            {t('detail.nasledujuci')} →
          </button>
        </div>
      </div>

      {buyerMismatch && (
        <div className="anim-in rounded-xl border border-amber-300 bg-amber-50 px-4 py-3 text-sm text-amber-900">
          <p className="font-semibold">{t('detail.icoMismatch')}</p>
          <p>{t('detail.icoMismatchPopis')}</p>
        </div>
      )}
      {(draft.status === 'duplicita' ||
        (draft.duplicateOfDocumentId && !draft.notDuplicate)) && (
        <div className="anim-in rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-900">
          <p className="font-semibold">{t('detail.duplicita.banner')}</p>
          <p>{t('detail.duplicita.popis')}</p>
          {draft.duplicateOfDocumentId && (
            <button
              type="button"
              className="btn mt-2"
              onClick={() => goToDocument(draft.duplicateOfDocumentId)}
            >
              {t('detail.duplicita.zobrazit')}
            </button>
          )}
        </div>
      )}
      {draft.status === 'karantena' && (
        <div className="anim-in rounded-xl border border-yellow-300 bg-yellow-50 px-4 py-3 text-sm text-yellow-900">
          <p className="font-semibold">{t('detail.karantena.banner')}</p>
          {draft.quarantineReason && QUARANTINE_KEYS[draft.quarantineReason] && (
            <p>{t(QUARANTINE_KEYS[draft.quarantineReason])}</p>
          )}
        </div>
      )}
      {(draft.status === 'chyba' || draft.processingStatus.startsWith('failed')) && (
        <div className="anim-in rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-900">
          <p className="font-semibold">{t('detail.chyba.banner')}</p>
          <ProcessingBadge status={draft.processingStatus} label={intakeProcessingLabel} />
        </div>
      )}
      {dphAdvice && dphAdvice.blokacie.length > 0 && (
        <div className="anim-in rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-900">
          <p className="font-semibold">{t('detail.dph.blokacia')} — {t('detail.dph.titulok')}</p>
          {dphAdvice.blokacie.map((zistenie) => (
            <p key={`${zistenie.kod}-${zistenie.sprava}`}>{zistenie.sprava}</p>
          ))}
        </div>
      )}
      {dphAdvice && dphAdvice.varovania.length > 0 && (
        <div className="anim-in rounded-xl border border-amber-300 bg-amber-50 px-4 py-3 text-sm text-amber-900">
          <p className="font-semibold">{t('detail.dph.varovanie')}</p>
          {dphAdvice.varovania.map((zistenie) => (
            <p key={`${zistenie.kod}-${zistenie.sprava}`}>{zistenie.sprava}</p>
          ))}
        </div>
      )}
      {dphAdvice && dphAdvice.navrhy.length > 0 && (
        <div className="anim-in rounded-xl border border-sky-200 bg-sky-50 px-4 py-3 text-sm text-sky-900">
          <p className="font-semibold">{t('detail.dph.navrh')} — {t('detail.dph.titulok')}</p>
          {dphAdvice.navrhy.map((zistenie) => (
            <div key={`${zistenie.kod}-${zistenie.sprava}`} className="mt-1 flex flex-wrap items-center gap-2">
              <p>{zistenie.sprava}</p>
              {!readOnly
                && (zistenie.clenenieDphId || zistenie.clenenieKvKod)
                && (draft.ucto.clenenieDphId !== zistenie.clenenieDphId
                  || (zistenie.clenenieKvKod && draft.ucto.clenenieKvKod !== zistenie.clenenieKvKod)) && (
                <button
                  type="button"
                  className="btn"
                  onClick={() => updateUcto({
                    ...(zistenie.clenenieDphId ? { clenenieDphId: zistenie.clenenieDphId } : {}),
                    ...(zistenie.clenenieKvKod ? { clenenieKvKod: zistenie.clenenieKvKod } : {}),
                  })}
                >
                  {t('detail.dph.pouzitClenenie')}
                </button>
              )}
            </div>
          ))}
        </div>
      )}

      <div
        ref={splitRef}
        className="detail-split grid min-w-0 gap-4"
        style={{ '--detail-left': `${splitPercent}%` } as CSSProperties}
      >
        <section className="card anim-in min-w-0 self-start overflow-hidden xl:sticky xl:top-4">
          <div className="flex flex-wrap items-center gap-2 border-b border-line p-3">
            <button
              type="button"
              className="btn px-2"
              disabled={!hasAttachedFile}
              onClick={() => setZoom((value) => Math.max(0.6, round2(value - 0.1)))}
              aria-label={`${t('detail.titulok')} −`}
            >
              −
            </button>
            <span className="tnum w-14 text-center text-sm">{Math.round(zoom * 100)} %</span>
            <button
              type="button"
              className="btn px-2"
              disabled={!hasAttachedFile}
              onClick={() => setZoom((value) => Math.min(2, round2(value + 0.1)))}
              aria-label={`${t('detail.titulok')} +`}
            >
              +
            </button>
            <button
              type="button"
              className="btn px-2.5 text-xs"
              disabled={!hasAttachedFile || zoom === 1}
              onClick={() => setZoom(1)}
            >
              {t('detail.naSirku')}
            </button>
            {formatBadgeKey && (
              <span className="ml-2 inline-flex items-center gap-1.5 whitespace-nowrap rounded-full border border-accent/30 bg-accent/10 px-2.5 py-1 text-[11px] font-semibold text-accent-hover">
                {t(formatBadgeKey)}
              </span>
            )}
            {!imagePreview && !xmlPreview && hasAttachedFile && (
              <>
                <button
                  type="button"
                  className="btn ml-2 px-2"
                  disabled={pageNumber <= 1}
                  onClick={() => setPageNumber((value) => Math.max(1, value - 1))}
                  aria-label={`${t('detail.strana')} ←`}
                >
                  ←
                </button>
                <span className="tnum text-sm">
                  {t('detail.strana')} {pageNumber} {t('detail.z')} {pageCount || '—'}
                </span>
                <button
                  type="button"
                  className="btn px-2"
                  disabled={!pageCount || pageNumber >= pageCount}
                  onClick={() => setPageNumber((value) => Math.min(pageCount, value + 1))}
                  aria-label={`${t('detail.strana')} →`}
                >
                  →
                </button>
              </>
            )}
            {fileUrl && (
              <a
                className="btn ml-auto"
                href={fileUrl}
                download={draft.zdroj.povodnyNazovSuboru}
              >
                {t('detail.stiahnutSubor')}
              </a>
            )}
          </div>
          <div className="flex min-h-[34rem] justify-center overflow-auto bg-[#EDF0EE] p-5">
            {xmlPreview ? (
              sepaPreview ? (
                <BankStatementPreview doklad={draft} zoom={zoom} />
              ) : (
                <EInvoicePreview doklad={draft} zoom={zoom} />
              )
            ) : !hasAttachedFile ? (
              <p className="self-center text-sm text-ink-soft">{t('detail.bezSuboru')}</p>
            ) : localFileLoading ? (
              <p className="self-center text-sm">{t('stav.nacitavam')}</p>
            ) : !fileUrl ? (
              <p className="self-center text-sm text-red-700">{t('detail.suborNedostupny')}</p>
            ) : imagePreview ? (
              pdfError ? (
                <p className="self-center text-sm text-red-700">{t('detail.suborNedostupny')}</p>
              ) : (
                <img
                  src={fileUrl}
                  alt={draft.zdroj.povodnyNazovSuboru ?? t('detail.titulok')}
                  className="h-auto max-w-none self-start shadow"
                  style={{ width: Math.round(520 * zoom) }}
                  onError={() => setPdfError(true)}
                />
              )
            ) : pdfError ? (
              <p className="self-center text-sm text-red-700">{t('detail.pdfChyba')}</p>
            ) : (
              <Document
                file={fileUrl}
                loading={<p className="self-center text-sm">{t('stav.nacitavam')}</p>}
                error={<p className="self-center text-sm text-red-700">{t('detail.pdfChyba')}</p>}
                onLoadSuccess={({ numPages }) => {
                  setPageCount(numPages);
                  setPageNumber((value) => Math.min(Math.max(1, value), numPages));
                }}
                onLoadError={() => setPdfError(true)}
              >
                <Page
                  pageNumber={pageNumber}
                  scale={zoom}
                  width={520}
                  renderTextLayer={false}
                  renderAnnotationLayer={false}
                />
              </Document>
            )}
          </div>
        </section>

        <button
          type="button"
          className="detail-splitter hidden cursor-col-resize rounded bg-line hover:bg-accent focus-visible:bg-accent xl:block"
          aria-label={t('detail.rozdelovac')}
          onPointerDown={beginResize}
          onKeyDown={(event) => {
            if (event.key === 'ArrowLeft') {
              event.preventDefault();
              setSplitPercent((value) => Math.max(30, value - 2));
            } else if (event.key === 'ArrowRight') {
              event.preventDefault();
              setSplitPercent((value) => Math.min(70, value + 2));
            }
          }}
        />

        <div className="detail-stack min-w-0 space-y-4">
          {draft.typ !== 'BV' && (
            <PaymentCard
              doklad={draft}
              payments={(data.payments ?? []).filter((payment) => payment.documentId === draft.id)}
              readOnly={role === 'schvalovatel'}
            />
          )}
          <fieldset disabled={readOnly} className="space-y-4 disabled:opacity-75">
            <InvoicePanel
              draft={draft}
              readOnly={readOnly}
              busy={busy}
              codeLists={{
                predkontacie: codeLists.predkontacie,
                cleneniaDph: codeLists.cleneniaDph,
                ciselneRady: codeLists.ciselneRady,
                strediska: codeLists.strediska,
              }}
              suggestion={suggestion}
              autoFilled={autoFilled}
              setTyp={(typ) => markDirty((current) => ({ ...current, typ }))}
              updateUcto={updateUcto}
              updateExtracted={updateExtracted}
              updateSupplier={updateSupplier}
              onSave={handleSave}
            />
          </fieldset>

          <Section title={t('detail.zdroj')}>
            <dl>
              <SourceRow label={t('detail.zdroj.odosielatel')} value={draft.zdroj.odosielatel} />
              <SourceRow label={t('detail.zdroj.alias')} value={draft.zdroj.prijemcaAlias} />
              <SourceRow label={t('detail.zdroj.predmet')} value={draft.zdroj.predmet} />
              <SourceRow label={t('detail.zdroj.prijate')} value={formatDateTime(draft.prijateDna)} />
              <SourceRow label={t('detail.zdroj.subor')} value={draft.zdroj.povodnyNazovSuboru} />
              <SourceRow label={t('detail.zdroj.messageId')} value={draft.zdroj.inboundEmailId} />
            </dl>
            <div className="mt-3 flex flex-wrap items-center gap-2">
              <button type="button" className="btn" disabled>
                {t('detail.zdroj.zobrazitEmail')}
              </button>
              <ProcessingBadge status={draft.processingStatus} label={intakeProcessingLabel} />
              <button
                type="button"
                className="btn ml-auto"
                disabled={
                  busy ||
                  !hasAttachedFile ||
                  role === 'schvalovatel' ||
                  draft.status === 'exportovany'
                }
                onClick={() => void handleReprocess()}
              >
                {t('detail.zdroj.spustitZnova')}
              </button>
            </div>
            <h3 className="mb-2 mt-4 text-sm font-semibold">{t('detail.zdroj.behy')}</h3>
            {runs.length ? (
              <div className="space-y-2">
                {runs.map((run) => (
                  <div key={run.id} className="flex items-start gap-2 rounded border border-line p-2 text-sm">
                    <span
                      className={run.status === 'failed' ? 'text-red-700' : 'text-green-700'}
                      aria-label={
                        run.status === 'failed'
                          ? t('detail.chyba.banner')
                          : t('detail.zdroj.extrakcia')
                      }
                    >
                      {run.status === 'failed' ? '!' : run.status === 'succeeded' ? '✓' : '~'}
                    </span>
                    <div className="min-w-0">
                      <p className="font-medium">
                        {run.provider.toUpperCase()}
                        {run.model ? ` · ${run.model}` : ''}
                      </p>
                      <p className="tnum text-xs text-ink-soft">
                        {formatDateTime(run.completedAt ?? run.startedAt ?? run.createdAt)}
                      </p>
                      {run.status === 'failed' && run.errorMessage && (
                        <p className="mt-1 text-xs text-red-700">
                          {t('detail.zdroj.chyba')}: {run.errorMessage}
                        </p>
                      )}
                      {run.status === 'succeeded' && run.result && (
                        <button
                          type="button"
                          className="btn mt-2 px-2 py-1 text-xs"
                          disabled={
                            busy || dirty || role === 'schvalovatel' || draft.status === 'exportovany'
                          }
                          onClick={() => void handleApplyRun(run.id)}
                        >
                          {t('detail.zdroj.pouzitExtrakciu')}
                        </button>
                      )}
                    </div>
                  </div>
                ))}
              </div>
            ) : (
              <p className="text-sm text-ink-soft">{t('stav.ziadneData')}</p>
            )}
          </Section>

          <section className="card overflow-hidden">
            <div className="flex border-b border-line" role="tablist">
              <button
                type="button"
                role="tab"
                aria-selected={activeBottomTab === 'comments'}
                className={`px-4 py-2 text-sm font-medium ${
                  activeBottomTab === 'comments' ? 'border-b-2 border-accent text-accent' : ''
                }`}
                onClick={() => setActiveBottomTab('comments')}
              >
                {t('detail.komentare')}
              </button>
              <button
                type="button"
                role="tab"
                aria-selected={activeBottomTab === 'history'}
                className={`px-4 py-2 text-sm font-medium ${
                  activeBottomTab === 'history' ? 'border-b-2 border-accent text-accent' : ''
                }`}
                onClick={() => setActiveBottomTab('history')}
              >
                {t('detail.historia')}
              </button>
            </div>
            <div className="p-4">
              {activeBottomTab === 'comments' ? (
                <>
                  <div className="mb-3 max-h-64 space-y-2 overflow-y-auto">
                    {draft.comments.length ? (
                      draft.comments.map((item, index) => (
                        <div key={`${item.ts}-${index}`} className="rounded border border-line p-2 text-sm">
                          <CommentText text={item.text} names={userNames} />
                          <p className="mt-1 text-xs text-ink-soft">
                            {item.user} · {formatDateTime(item.ts)}
                          </p>
                        </div>
                      ))
                    ) : (
                      <p className="text-sm text-ink-soft">{t('stav.ziadneData')}</p>
                    )}
                  </div>
                  <div className="relative flex gap-2">
                    <textarea
                      className="input min-h-20 flex-1"
                      value={comment}
                      maxLength={4000}
                      onChange={(event) => setComment(event.target.value)}
                      placeholder={t('detail.pridatKomentar')}
                    />
                    {mentionCandidates.length > 0 && (
                      <div className="absolute bottom-full left-0 z-10 mb-1 w-72 rounded border border-line bg-white shadow-lg">
                        {mentionCandidates.map((candidate) => (
                          <button
                            key={candidate.id}
                            type="button"
                            className="block w-full px-3 py-2 text-left text-sm hover:bg-app"
                            onClick={() => insertMention(candidate.meno)}
                          >
                            @{candidate.meno}
                            <span className="ml-2 text-xs text-ink-soft">{candidate.email}</span>
                          </button>
                        ))}
                      </div>
                    )}
                    <button
                      type="button"
                      className="btn btn-primary self-end"
                      disabled={busy || !comment.trim()}
                      onClick={() => void handleComment()}
                    >
                      {t('akcia.pridat')}
                    </button>
                  </div>
                  <p className="mt-1 text-right text-xs text-ink-soft">
                    {t('detail.spomenutTip')} · {comment.length} / 4000
                  </p>
                </>
              ) : draft.history.length ? (
                <div className="max-h-72 space-y-2 overflow-y-auto">
                  {[...draft.history].reverse().map((item, index) => (
                    <div key={`${item.ts}-${index}`} className="border-l-2 border-line pl-3 text-sm">
                      <p>{item.akcia}</p>
                      <p className="text-xs text-ink-soft">
                        {item.user} · {formatDateTime(item.ts)}
                      </p>
                    </div>
                  ))}
                </div>
              ) : (
                <p className="text-sm text-ink-soft">{t('stav.ziadneData')}</p>
              )}
            </div>
          </section>
        </div>
      </div>

      <div className="sticky bottom-0 z-20 -mx-4 flex flex-wrap items-center justify-end gap-2 border-t border-line/80 bg-surface/75 px-4 py-3 shadow-[0_-8px_24px_-16px_rgba(27,31,29,0.12)] backdrop-blur-md">
        {dirty && (
          <span className="anim-in mr-auto inline-flex items-center gap-1.5 text-xs text-amber-800">
            <span className="h-[7px] w-[7px] rounded-full bg-amber-600" aria-hidden />
            {t('detail.neulozeneZmeny')}
          </span>
        )}
        {draft.status === 'schvaleny' && role !== 'schvalovatel' && (
          <button
            type="button"
            className="btn btn-primary"
            disabled={busy || dirty || !mostikStatus?.available}
            title={dirty ? t('mostik.neulozeneZmeny') : !mostikStatus?.available ? t('mostik.nepripojenyTooltip') : undefined}
            onClick={() => void handleMostikExport()}
          >
            {t('mostik.odoslat')}
          </button>
        )}
        {role !== 'schvalovatel' && (
          <>
            {!draft.payment || draft.payment.status === 'unpaid' ? (
              <button
                type="button"
                className="btn"
                disabled={busy}
                onClick={() =>
                  void runDocumentAction(
                    () => updatePaymentStatus(draft.id, 'to_pay'),
                    'toast.platbaNaUhradu',
                  )
                }
              >
                {t('platba.oznacitNaUhradu')}
              </button>
            ) : null}
            <button
              type="button"
              className="btn"
              disabled={busy}
              onClick={() => setPaymentModalOpen(true)}
            >
              {t('platba.titulok')}
            </button>
          </>
        )}
        {!readOnly && (
          <button
            type="button"
            className="btn"
            disabled={busy}
            onClick={() => void handleSave()}
          >
            {t('akcia.ulozit')}
          </button>
        )}
        {!readOnly && draft.status === 'duplicita' && (
          <button
            type="button"
            className="btn"
            disabled={busy}
            onClick={() =>
              void runDocumentAction(() => markNotDuplicate(draft.id), 'toast.ulozene')
            }
          >
            {t('detail.duplicita.nieJe')}
          </button>
        )}
        {!readOnly && ['chyba', 'karantena', 'duplicita'].includes(draft.status) && (
          <button
            type="button"
            className="btn"
            disabled={busy}
            onClick={() =>
              void runDocumentAction(() => processManually(draft.id), 'toast.ulozene')
            }
          >
            {t('detail.spracovatRucne')}
          </button>
        )}
        {!readOnly && draft.status !== 'karantena' && (
          <button
            type="button"
            className="btn"
            disabled={busy}
            onClick={() =>
              void runDocumentAction(() => quarantineDocument(draft.id), 'toast.karantena')
            }
          >
            {t('detail.karantena')}
          </button>
        )}
        {draft.status !== 'exportovany' && draft.status !== 'zamietnuty' && (
          <button
            type="button"
            className="btn btn-danger"
            disabled={busy}
            onClick={() => setRejectModalOpen(true)}
          >
            {t('detail.zamietnut')}
          </button>
        )}
        <button
          type="button"
          className="btn btn-primary"
          disabled={busy || !canApproveStatus || !approval?.ok}
          title={!approval?.ok ? t('detail.schvalitTooltip') : undefined}
          onClick={() => void handleApprove()}
        >
          {t('detail.schvalit')}
        </button>
      </div>

      {paymentModalOpen && (
        <Suspense fallback={<p className="text-sm text-ink-soft">{t('stav.nacitavam')}</p>}>
          <PaymentQrModal
            documents={[draft]}
            organizations={data.organizations}
            bankAccounts={data.bankAccounts}
            initialDocumentId={draft.id}
            onClose={() => setPaymentModalOpen(false)}
            onUpdated={(updated) => setDraft(cloneDocument(updated))}
          />
        </Suspense>
      )}


      {rejectModalOpen && (
        <Modal
          title={t('zamietnutie.titulok')}
          onClose={() => {
            if (busy) return;
            setRejectModalOpen(false);
            setRejectionReason('');
          }}
        >
          <p className="mb-3 text-sm text-ink-soft">{t('zamietnutie.popis')}</p>
          <label className="label" htmlFor="rejection-reason">
            {t('zamietnutie.dovod')}
          </label>
          <textarea
            id="rejection-reason"
            className="input min-h-28"
            value={rejectionReason}
            maxLength={1000}
            disabled={busy}
            onChange={(event) => setRejectionReason(event.target.value)}
            placeholder={t('zamietnutie.placeholder')}
          />
          <p className="mt-1 text-right text-xs text-ink-soft">
            {rejectionReason.length} / 1000
          </p>
          <div className="mt-4 flex justify-end gap-2">
            <button
              type="button"
              className="btn"
              disabled={busy}
              onClick={() => {
                setRejectModalOpen(false);
                setRejectionReason('');
              }}
            >
              {t('akcia.zrusit')}
            </button>
            <button
              type="button"
              className="btn btn-danger"
              disabled={busy || !rejectionReason.trim()}
              onClick={() => void handleReject()}
            >
              {t('detail.zamietnut')}
            </button>
          </div>
        </Modal>
      )}
    </div>
  );
}

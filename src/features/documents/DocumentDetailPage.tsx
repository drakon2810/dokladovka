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
import 'react-pdf/dist/Page/TextLayer.css';
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
import { cisloMzdovehoDokladu, pocetCakajucichVRade } from '../../data/pohoda/numbering';
import {
  ConfidenceIndicator,
  Modal,
  OrgChip,
  PaymentStatusBadge,
  ProcessingBadge,
  StatusBadge,
} from '../../components/ui';
import { showToast } from '../../components/toast';
import { formatDateTime, formatMoney } from '../../lib/format';
import {
  isTotalConsistent,
  isVatRowConsistent,
  round2,
  validateIBAN,
  validateICO,
  vatBreakdownTotal,
} from '../../lib/validate';
import { isForeignSupplier } from '../../data/validation/documentValidation';
import { supplierAddressParts } from '../../data/xml/pohodaDataPack';
import { t, type SkKey } from '../../i18n/sk';
import { getLocalDocumentFile } from '../../data/files/localDocumentFileStore';
import { EInvoicePreview } from './EInvoicePreview';
import { BankStatementPreview } from './BankStatementPreview';
import { InvoicePanel } from './InvoicePanel';
import { BankPanel } from './BankPanel';
import { ExportPohodaModal } from './ExportPohodaModal';
import { SplitDocumentModal, splitGroup } from './SplitDocumentModal';
import {
  SOURCE_SECTIONS,
  buildMarks,
  buildSourceMap,
  editedFields,
  highlightHtml,
} from './sourceHighlight';
import './sourceHighlight.css';
import { AssistantPanel } from '../assistant/AssistantPanel';
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

/**
 * Doklad sa otvára priblížený — pri 100 % je text faktúry na kontrolu zbytočne
 * drobný a každý si ho aj tak hneď zväčšoval. Tlačidlo „obnoviť" vracia sem,
 * nie na 100 %.
 */
const DEFAULT_ZOOM = 1.55;

const SRC_STORAGE_KEY = 'dokladovka.zvyraznitZdroj';

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
  const [asistentOpen, setAsistentOpen] = useState(false);
  const [runs, setRuns] = useState<ExtractionRun[]>([]);
  const [suggestion, setSuggestion] = useState<AccountingSuggestion>();
  const [dphAdvice, setDphAdvice] = useState<DphPosudok>();
  const [lastUsed, setLastUsed] = useState<{ label: string; ucto: DocumentUcto }>();
  const [activeBottomTab, setActiveBottomTab] = useState<'comments' | 'history'>('comments');
  const [comment, setComment] = useState('');
  const [pageNumber, setPageNumber] = useState(1);
  const [pageCount, setPageCount] = useState(0);
  const [zoom, setZoom] = useState(DEFAULT_ZOOM);
  const [pdfError, setPdfError] = useState(false);
  const [localFileUrl, setLocalFileUrl] = useState<string>();
  const [localFileLoading, setLocalFileLoading] = useState(false);
  // Náhľad 52 % / editor 46 % — doklad otvorený na predvolených 155 % je
  // ~845 px široký a pri užšom náhľade ho editor vizuálne prekrýval.
  const [splitPercent, setSplitPercent] = useState(52);
  const [paymentModalOpen, setPaymentModalOpen] = useState(false);
  const [rejectModalOpen, setRejectModalOpen] = useState(false);
  const [exportModalOpen, setExportModalOpen] = useState(false);
  const [splitModalOpen, setSplitModalOpen] = useState(false);
  const [rejectionReason, setRejectionReason] = useState('');
  const [mostikStatus, setMostikStatus] = useState<OrganizationMostikStatus>();
  const [autoFilled, setAutoFilled] = useState(false);
  // Zvýraznenie zdroja údajov: prepínač je vlastnosť používateľa, nie dokladu.
  const [srcOn, setSrcOn] = useState(() => localStorage.getItem(SRC_STORAGE_KEY) !== '0');
  const [activeSrc, setActiveSrc] = useState<string>();
  const [textLayerTick, setTextLayerTick] = useState(0);
  const autoFilledFor = useRef<string>();
  const radFilledFor = useRef<string>();
  const cisloFilledFor = useRef<string>();
  const splitRef = useRef<HTMLDivElement>(null);
  const previewRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!sourceDocument) {
      setDraft(undefined);
      return;
    }
    setDraft(cloneDocument(sourceDocument));
    setDirty(false);
    setAutoFilled(false);
    autoFilledFor.current = undefined;
    radFilledFor.current = undefined;
    cisloFilledFor.current = undefined;
    setPageNumber(1);
    setPageCount(0);
    setZoom(DEFAULT_ZOOM);
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
    // Nič sa neprepisuje: koncept musí byť nedotknutý a dopĺňajú sa len prázdne
    // polia. Podmienka „zaúčtovanie úplne prázdne" tu bola dovtedy, kým doklad
    // prichádzal bez zaúčtovania — odkedy si členenie DPH a číselný rad nesie
    // z pravidla, zhodila celé predvyplnenie a predkontácia ostávala prázdna.
    if (dirty) return;
    // KV chýbajúce v návrhu sa odvodí zo sekcie KV členenia DPH — rovnako ako
    // tlačidlo „Automatické účtovanie" a ručný výber členenia.
    const kvKod = suggestion.clenenieKvKod
      ?? data?.codeLists.cleneniaDph.find((item) => item.id === suggestion.clenenieDphId)?.kvSekcia;
    const doplnene = {
      ...(suggestion.predkontaciaId && !draft.ucto.predkontaciaId ? { predkontaciaId: suggestion.predkontaciaId } : {}),
      ...(suggestion.clenenieDphId && !draft.ucto.clenenieDphId ? { clenenieDphId: suggestion.clenenieDphId } : {}),
      ...(suggestion.ciselnyRadId && !draft.ucto.ciselnyRadId ? { ciselnyRadId: suggestion.ciselnyRadId } : {}),
      ...(suggestion.strediskoId && !draft.ucto.strediskoId ? { strediskoId: suggestion.strediskoId } : {}),
      ...(kvKod && !draft.ucto.clenenieKvKod ? { clenenieKvKod: kvKod } : {}),
    };
    autoFilledFor.current = draft.id;
    if (Object.keys(doplnene).length === 0) return;
    setDraft((current) => current && { ...current, ucto: { ...current.ucto, ...doplnene } });
    setDirty(true);
    setAutoFilled(true);
  }, [data, draft, dirty, role, suggestion]);

  // Číselný rad nie je úsudok AI, ale nastavenie firmy (Nastavenia → Číselníky,
  // inak rad reálne používaný v POHODE). Predvyplní sa preto vždy, aj keď zvyšok
  // návrhu čaká na tlačidlo pre nižšiu istotu — účtovník ho inak klikal ručne
  // pri každom doklade. Prepisuje sa len prázdne pole nedotknutého konceptu.
  useEffect(() => {
    if (!draft || !suggestion?.ciselnyRadId) return;
    if (suggestion.documentId !== draft.id || radFilledFor.current === draft.id) return;
    if (role === 'schvalovatel') return;
    if (!['extrahovany', 'na_kontrole'].includes(draft.status)) return;
    if (dirty || draft.ucto.ciselnyRadId) return;
    radFilledFor.current = draft.id;
    setDraft((current) => current && {
      ...current,
      ucto: { ...current.ucto, ciselnyRadId: suggestion.ciselnyRadId },
    });
    setDirty(true);
  }, [draft, dirty, role, suggestion]);

  // Mzdy nemajú na páske číslo dokladu — účtovník ho píše ako kód číselného radu
  // + mesiac dokladu (26MZD03). Dopĺňa sa len do prázdneho poľa a až keď je rad
  // známy (predvyplní ho efekt vyššie), takže ručnú hodnotu nikdy neprepíše.
  useEffect(() => {
    if (!draft || draft.typ !== 'MZDY' || cisloFilledFor.current === draft.id) return;
    if (role === 'schvalovatel') return;
    if (!['extrahovany', 'na_kontrole'].includes(draft.status)) return;
    if (String(draft.extracted.cisloFaktury ?? '').trim()) return;
    const radKod = data?.codeLists.ciselneRady.find((item) => item.id === draft.ucto.ciselnyRadId)?.kod;
    const cislo = cisloMzdovehoDokladu(radKod, draft.extracted.datumVystavenia);
    if (!cislo) return;
    cisloFilledFor.current = draft.id;
    setDraft((current) => current && {
      ...current,
      extracted: { ...current.extracted, cisloFaktury: cislo },
    });
    setDirty(true);
  }, [data, draft, role]);

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
      // Tab „Na kontrolu" obsahuje aj problémové doklady (rovnako ako zoznam).
      if (
        !exactStatus &&
        tab === 'na_kontrole' &&
        !['extrahovany', 'na_kontrole', ...problemStatuses].includes(item.status)
      ) return false;
      if (!exactStatus && tab === 'schvalene' && item.status !== 'schvaleny') return false;
      if (!exactStatus && tab === 'exportovane' && item.status !== 'exportovany') return false;
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

  // ---- Zvýraznenie zdroja údajov -------------------------------------------
  // Mapa závisí len na behoch extrakcie, preto sa pri písaní do formulára
  // neprepočítava — textová vrstva PDF sa prekresľuje len keď sa naozaj zmení,
  // čo pole je „z dokladu" a čo už prepísal účtovník.
  const srcMap = useMemo(
    () => buildSourceMap(runs, draft?.appliedExtractionRunId),
    [runs, draft?.appliedExtractionRunId],
  );
  const srcEditedKey = useMemo(
    () => (draft ? editedFields(srcMap, draft.extracted).join('|') : ''),
    [srcMap, draft?.extracted],
  );
  const srcEdited = useMemo(
    () => new Set(srcEditedKey ? srcEditedKey.split('|') : []),
    [srcEditedKey],
  );
  const srcMarks = useMemo(
    () => buildMarks(srcMap, pageNumber, srcEdited),
    [srcMap, pageNumber, srcEdited],
  );
  const srcSections = useMemo(
    () => SOURCE_SECTIONS.filter((section) => Object.values(srcMap).some((field) => field.section === section.n)),
    [srcMap],
  );
  // Stabilná referencia je nutná: react-pdf má onRenderTextLayerSuccess medzi
  // závislosťami vykreslenia vrstvy, takže inline funkcia by vrstvu prekresľovala
  // donekonečna.
  const handleTextLayerRendered = useCallback(() => setTextLayerTick((value) => value + 1), []);

  // Obdĺžniky sa kreslia priamo do hotovej textovej vrstvy. customTextRenderer
  // z react-pdf 9 sa tu použiť nedá: páruje položky textu s <span>-mi podľa
  // indexu a s aktuálnym pdf.js sa rozíde (preskakuje <br>), takže by zvýraznil
  // nesprávne miesta alebo nič.
  useEffect(() => {
    const root = previewRef.current;
    if (!root) return;
    for (const span of root.querySelectorAll<HTMLSpanElement>('.react-pdf__Page__textContent > span')) {
      const text = span.textContent ?? '';
      const html = srcOn ? highlightHtml(text, srcMarks) : '';
      if (html.includes('<mark')) span.innerHTML = html;
      else if (span.querySelector('mark')) span.textContent = text;
    }
  }, [srcMarks, srcOn, textLayerTick]);

  // Stav zvýraznenia sa prepína ručne — obdĺžniky nie sú React uzly a po
  // každom prekreslení vrstvy (strana, zoom) sa efekt spustí znova.
  useEffect(() => {
    const root = previewRef.current;
    if (!root) return;
    for (const mark of root.querySelectorAll<HTMLElement>('mark[data-src]')) {
      const focused = Boolean(activeSrc)
        && (mark.dataset.src === activeSrc || `sec:${mark.dataset.sec}` === activeSrc);
      mark.classList.toggle('dv-src-on', focused);
      mark.classList.toggle('dv-src-off', Boolean(activeSrc) && !focused);
    }
    if (activeSrc && !activeSrc.startsWith('sec:')) {
      root.querySelector<HTMLElement>(`mark[data-src="${CSS.escape(activeSrc)}"]`)
        ?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
    }
  }, [activeSrc, srcMarks, textLayerTick]);

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

  // Časti rozdeleného súboru sú už načítané v snapshote — stačí ich vyfiltrovať.
  const casti = splitGroup(draft, data.documents);
  // Koľko ďalších dokladov ešte čaká na číslo z toho istého radu — detail podľa
  // toho ukáže buď konkrétne číslo, alebo len spodnú hranicu „od …".
  const cakajuceVRade = pocetCakajucichVRade(
    { id: draft.id, orgId: draft.orgId, ciselnyRadId: draft.ucto.ciselnyRadId },
    data.documents.map((item) => ({
      id: item.id, orgId: item.orgId, status: item.status, ciselnyRadId: item.ucto.ciselnyRadId,
    })),
  );
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
    bankoveUcty: (data.codeLists.bankoveUcty ?? []).filter(
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

  /**
   * Adresa sa ukladá po častiach naraz — vrátane prázdnych. Keby sa zapisovala
   * len upravená časť, ostatné by ostali undefined a `supplierAddressParts` by
   * ich pri exporte znovu doplnil z pôvodnej voľnej `adresa`, takže vymazaná
   * ulica by sa vrátila. `adresa` sa drží v súlade — číta ju párovanie partnera
   * aj kontext pre AI.
   */
  const updateSupplierAddress = (patch: {
    ulica?: string; psc?: string; obec?: string; krajina?: string;
  }) => {
    markDirty((current) => {
      const dodavatel = current.extracted.dodavatel;
      const parts = { ...supplierAddressParts(dodavatel), ...patch };
      const ulica = parts.ulica ?? '';
      const psc = parts.psc ?? '';
      const obec = parts.obec ?? '';
      return {
        ...current,
        extracted: {
          ...current.extracted,
          dodavatel: {
            ...dodavatel,
            ulica,
            psc,
            obec,
            krajina: (parts.krajina ?? '').toUpperCase(),
            adresa: [ulica, [psc, obec].filter(Boolean).join(' ')].filter(Boolean).join(', ') || undefined,
          },
        },
      };
    });
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
      await createMostikExportJob(draft.orgId, [draft.id]);
      showToast(t('mostik.prenosVytvoreny'));
    } catch {
      showToast(t('chyba.vseobecna'), { tone: 'error' });
    } finally {
      setBusy(false);
    }
  };

  return (
    <div
      className="-m-1 space-y-3 border-l-[3px] p-1 pl-4"
      style={{ borderLeftColor: organization.farba }}
    >
      {/* Hlavička je zložená do úzkeho pruhu a vysunie sa až pri prejdení myšou —
          jej výška patrí náhľadu a editoru. Návrat do zoznamu je dole v akčnom
          pruhu, takže sa bez hlavičky dá z dokladu kedykoľvek odísť. */}
      <div className="group/head relative z-30">
        <div className="flex h-3 cursor-pointer items-center justify-center" title={t('detail.titulok')}>
          <span className="h-1 w-24 rounded-full bg-line transition-colors group-hover/head:bg-accent" />
        </div>
        {/* opacity + pointer-events namiesto visibility: skryté tlačidlá tak
            ostávajú v tab-orderi a Tab hlavičku vysunie aj bez myši. */}
        <div className="pointer-events-none absolute inset-x-0 top-full z-30 opacity-0 transition-opacity duration-150 focus-within:pointer-events-auto focus-within:opacity-100 group-hover/head:pointer-events-auto group-hover/head:opacity-100">
          <div className="flex items-center gap-3 rounded-xl border border-line bg-surface p-3 shadow-lg">
        <div className="min-w-0 flex-1">
          <h1 className="text-lg font-semibold leading-tight">{t('detail.titulok')}</h1>
          <div className="mt-0.5 flex flex-wrap items-center gap-2">
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
        <div className="ml-auto flex shrink-0 items-center gap-2">
          <button
            type="button"
            className={`btn ${asistentOpen ? 'btn-primary' : ''}`}
            onClick={() => setAsistentOpen((open) => !open)}
            title="Opýtať sa asistenta na tento doklad"
          >
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" aria-hidden><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" /></svg>
            Asistent
          </button>
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
        </div>
      </div>

      {/* Sken je spoločný, zápisy do POHODY sú samostatné. Bez zoznamu všetkých
          častí účtovník doúčtuje tú, ktorú otvoril, a o zvyšku sa nedozvie. */}
      {casti.length > 0 && (
        <div className="anim-in rounded-xl border border-line bg-app px-4 py-2.5 text-sm text-ink-soft">
          <p className="mb-1.5">{t('rozdelenie.casti')}</p>
          <div className="flex flex-wrap gap-2">
            {casti.map((cast, index) => {
              const popis = `${index + 1}/${casti.length} · ${cast.extracted.textPolozky || cast.extracted.dodavatel.nazov || t('rozdelenie.bezTextu')} · ${formatMoney(cast.extracted.sumaSpolu, cast.extracted.mena)}`;
              return cast.id === draft.id ? (
                <span
                  key={cast.id}
                  className="tnum rounded-lg border border-accent/40 bg-tint px-3 py-1.5 font-medium text-accent-hover"
                >
                  {popis}
                </span>
              ) : (
                <button key={cast.id} type="button" className="btn tnum" onClick={() => goToDocument(cast.id)}>
                  {popis}
                </button>
              );
            })}
          </div>
        </div>
      )}
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
              disabled={!hasAttachedFile || zoom === DEFAULT_ZOOM}
              onClick={() => setZoom(DEFAULT_ZOOM)}
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
            {srcSections.length > 0 && (
              <label className="dv-src-toggle ml-auto">
                <input
                  type="checkbox"
                  checked={srcOn}
                  onChange={(event) => {
                    setSrcOn(event.target.checked);
                    setActiveSrc(undefined);
                    localStorage.setItem(SRC_STORAGE_KEY, event.target.checked ? '1' : '0');
                  }}
                />
                <span className="dv-src-switch" />
                {t('detail.zvyraznitZdroj')}
              </label>
            )}
            {fileUrl && (
              <a
                className={`btn ${srcSections.length > 0 ? 'ml-2' : 'ml-auto'}`}
                href={fileUrl}
                download={draft.zdroj.povodnyNazovSuboru}
              >
                {t('detail.stiahnutSubor')}
              </a>
            )}
          </div>
          {/* Legenda stojí nad dokladom — tam, kde treba farbu rozlúštiť; pravý
              stĺpec je popísaný nadpismi sekcií. */}
          {srcOn && srcSections.length > 0 && (
            <div className="dv-src-legend">
              <span className="dv-src-legend-label">{t('detail.zdrojUdajov')}</span>
              {srcSections.map((section) => (
                <span
                  key={section.n}
                  className={`dv-src-lgd dv-src-${section.n}`}
                  onMouseEnter={() => setActiveSrc(`sec:${section.n}`)}
                  onMouseLeave={() => setActiveSrc(undefined)}
                >
                  <span className="dv-src-chip">{section.n}</span>
                  {section.title}
                </span>
              ))}
              <span className="dv-src-legend-hint">{t('detail.zdrojUpravene')}</span>
            </div>
          )}
          {/* Náhľad má vlastnú výšku a scrolluje sa sám — bez pevnej výšky rástol
              donekonečna a doklad sa dal dočítať len tak, že sa preskrolovala
              celá stránka (teda aj formulár vedľa). `safe center` centruje, kým
              sa doklad zmestí; po priblížení nechá doskrolovať aj k ľavému
              okraju (obyčajné `center` by ho odrezalo). */}
          <div
            ref={previewRef}
            className="preview-center flex h-[34rem] items-start overflow-auto overscroll-contain bg-[#EDF0EE] p-5 xl:h-[calc(100vh-6rem)]"
            onMouseOver={(event) => {
              const mark = (event.target as HTMLElement).closest?.('mark[data-src]');
              setActiveSrc(mark instanceof HTMLElement ? mark.dataset.src : undefined);
            }}
            onMouseLeave={() => setActiveSrc(undefined)}
          >
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
                  // shrink-0: bez toho flexbox priblížený doklad zmenší späť na
                  // šírku rámika a zoom nič neurobí — má pretiecť a scrollovať sa.
                  className="h-auto max-w-none shrink-0 self-start shadow"
                  style={{ width: Math.round(520 * zoom) }}
                  onError={() => setPdfError(true)}
                />
              )
            ) : pdfError ? (
              <p className="self-center text-sm text-red-700">{t('detail.pdfChyba')}</p>
            ) : (
              <Document
                file={fileUrl}
                className="shrink-0"
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
                  // Textová vrstva sa zapína len kvôli zvýrazneniu zdroja —
                  // skenované doklady ju nemajú a vtedy sa nič nevykreslí.
                  renderTextLayer={srcOn && srcMarks.length > 0}
                  onRenderTextLayerSuccess={handleTextLayerRendered}
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
          {/* Panel „Úhrada" tu zámerne nie je — miesto patrí formuláru dokladu.
              Úhrady sa spravujú v sekcii Úhrady a v hromadných akciách zoznamu.
              Bez <fieldset disabled>: editor si stráži readOnly sám a tlačidlo
              „Export do POHODA" musí fungovať aj pri exportovanom doklade. */}
          {draft.typ === 'BV' ? (
            <BankPanel
              key={draft.id}
              draft={draft}
              readOnly={readOnly}
              codeLists={{
                predkontacie: codeLists.predkontacie,
                bankoveUcty: codeLists.bankoveUcty,
              }}
              onExport={() => setExportModalOpen(true)}
              exportDisabledReason={
                draft.status !== 'schvaleny'
                  ? 'Exportovať sa dá až schválený doklad'
                  : dirty
                    ? t('mostik.neulozeneZmeny')
                    : !mostikStatus?.available
                      ? t('mostik.nepripojenyTooltip')
                      : undefined
              }
              setTyp={(typ) => markDirty((current) => ({ ...current, typ }))}
              updateUcto={updateUcto}
              updateExtracted={updateExtracted}
              predvolenaPokladna={(data.seriesDefaults ?? []).find(
                (item) => item.organizationId === draft.orgId && item.documentType === 'PD',
              )?.pokladnaKod}
            />
          ) : (
          <InvoicePanel
            key={draft.id}
            draft={draft}
            readOnly={readOnly}
            codeLists={{
              predkontacie: codeLists.predkontacie,
              cleneniaDph: codeLists.cleneniaDph,
              ciselneRady: codeLists.ciselneRady,
              strediska: codeLists.strediska,
              cinnosti: codeLists.cinnosti,
              zakazky: codeLists.zakazky,
            }}
            suggestion={suggestion}
            autoFilled={autoFilled}
            cakajuceVRade={cakajuceVRade}
            src={srcMap}
            srcEdited={srcEdited}
            srcOn={srcOn}
            activeSrc={activeSrc}
            onHoverSrc={setActiveSrc}
            onExport={() => setExportModalOpen(true)}
            onSplit={() => setSplitModalOpen(true)}
            exportDisabledReason={
              draft.status !== 'schvaleny'
                ? 'Exportovať sa dá až schválený doklad'
                : dirty
                  ? t('mostik.neulozeneZmeny')
                  : !mostikStatus?.available
                    ? t('mostik.nepripojenyTooltip')
                    : undefined
            }
            setTyp={(typ) => markDirty((current) => ({ ...current, typ }))}
            updateUcto={updateUcto}
            updateExtracted={updateExtracted}
            updateSupplier={updateSupplier}
            updateSupplierAddress={updateSupplierAddress}
            predvolenaPokladna={(data.seriesDefaults ?? []).find(
              (item) => item.organizationId === draft.orgId && item.documentType === 'PD',
            )?.pokladnaKod}
          />
          )}

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

      {asistentOpen && draft.orgId && (
        <div className="fixed inset-y-0 right-0 z-40 flex w-full max-w-[420px] flex-col p-3 sm:p-4">
          <AssistantPanel
            organizationId={draft.orgId}
            organizationName={organization?.nazov}
            documentId={draft.id}
            onClose={() => setAsistentOpen(false)}
          />
        </div>
      )}

      <div className="sticky bottom-0 z-20 -mx-4 flex flex-wrap items-center justify-end gap-2 border-t border-line/80 bg-surface/75 px-4 py-2 shadow-[0_-8px_24px_-16px_rgba(27,31,29,0.12)] backdrop-blur-md">
        <div className="mr-auto flex shrink-0 items-center gap-3">
          <Link className="btn" to={`/doklady${location.search}`}>
            ← {t('detail.spat')}
          </Link>
          {dirty && (
            <span className="anim-in inline-flex items-center gap-1.5 text-xs text-amber-800">
              <span className="h-[7px] w-[7px] rounded-full bg-amber-600" aria-hidden />
              {t('detail.neulozeneZmeny')}
            </span>
          )}
        </div>
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


      {splitModalOpen && (
        <SplitDocumentModal
          doklad={draft}
          onClose={() => setSplitModalOpen(false)}
          onSplit={(novyId) => {
            setSplitModalOpen(false);
            goToDocument(novyId);
          }}
        />
      )}

      {exportModalOpen && (
        <ExportPohodaModal
          documents={[draft]}
          organizations={data.organizations}
          onClose={() => setExportModalOpen(false)}
          onExported={() => setExportModalOpen(false)}
        />
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

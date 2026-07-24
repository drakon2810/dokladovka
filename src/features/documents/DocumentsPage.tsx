import { lazy, Suspense, useEffect, useMemo, useState, type ReactNode } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import { useNavigate, useSearchParams } from 'react-router-dom';
import {
  approveDocuments,
  listQueues,
  moveDocumentToReview,
  quarantineDocument,
  rejectDocuments,
  restoreDocument,
} from '../../data/api';
import { paymentStateFor } from './PaymentCard';
import { useDataQuery } from '../../data/query';
import type {
  DocumentItem,
  DocumentQueue,
  DocumentStatus,
  DocumentType,
  ProcessingStatus,
} from '../../data/types';
import { OrgDot, TypBadge, Modal } from '../../components/ui';
import { showToast } from '../../components/toast';
import { t } from '../../i18n/sk';
import { formatDate, formatMoney } from '../../lib/format';
import { DocumentCreateModal } from './DocumentCreateModal';
import { UploadModal } from './UploadModal';

const PaymentQrModal = lazy(() =>
  import('../payments/PaymentQrModal').then((module) => ({ default: module.PaymentQrModal })),
);

const DOCUMENT_TYPES: DocumentType[] = ['FP', 'FV', 'BV', 'MZDY', 'OZ', 'PD'];
const DOCUMENT_STATUSES: DocumentStatus[] = [
  'novy',
  'extrahovany',
  'na_kontrole',
  'schvaleny',
  'exportovany',
  'chyba',
  'karantena',
  'duplicita',
  'zamietnuty',
];
const PROBLEM_STATUSES = new Set<DocumentStatus>(['chyba', 'karantena', 'duplicita']);

type TabId = 'vsetky' | 'na_kontrole' | 'schvalene' | 'exportovane' | 'na_uhradu' | 'problemy' | 'kos';
type SourceFilter = '' | DocumentItem['zdroj']['typ'];
type ProcessingFilter = '' | 'caka' | 'spracuva' | 'hotovo' | 'chyba';
type SortKey =
  | 'organization'
  | 'type'
  | 'supplier'
  | 'invoice'
  | 'delivery'
  | 'due'
  | 'amount'
  | 'status'
  | 'processing'
  | 'confidence';
type SortDirection = 'asc' | 'desc';
type Density = 'comfortable' | 'compact';

const TAB_IDS: TabId[] = ['vsetky', 'na_kontrole', 'schvalene', 'exportovane', 'na_uhradu', 'problemy', 'kos'];
const COLLATOR = new Intl.Collator('sk', { sensitivity: 'base', numeric: true });

const svg = { fill: 'none', stroke: 'currentColor', strokeWidth: 2, strokeLinecap: 'round', strokeLinejoin: 'round' } as const;
const IcCheck = () => <svg viewBox="0 0 24 24" width="12" height="12" {...svg}><path d="M20 6 9 17l-5-5" /></svg>;
const IcX = () => <svg viewBox="0 0 24 24" width="12" height="12" {...svg}><path d="M18 6 6 18M6 6l12 12" /></svg>;
const IcClock = () => <svg viewBox="0 0 24 24" width="12" height="12" {...svg}><circle cx="12" cy="12" r="9" /><path d="M12 7.5V12l3 1.8" /></svg>;
const IcBox = () => <svg viewBox="0 0 24 24" width="12" height="12" {...svg}><path d="M21 8v13H3V8" /><path d="M1 3h22v5H1z" /><path d="M10 12h4" /></svg>;
const IcAlert = () => <svg viewBox="0 0 24 24" width="12" height="12" {...svg}><path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z" /><path d="M12 9v4" /><path d="M12 17h.01" /></svg>;
const IcOpen = () => <svg viewBox="0 0 24 24" width="15" height="15" {...svg}><path d="M15 3h6v6" /><path d="M10 14 21 3" /><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6" /></svg>;
const IcQr = () => <svg viewBox="0 0 24 24" width="15" height="15" {...svg} strokeWidth={1.9}><rect x="3" y="3" width="7" height="7" rx="1" /><rect x="14" y="3" width="7" height="7" rx="1" /><rect x="3" y="14" width="7" height="7" rx="1" /><path d="M14 14h3v3" /><path d="M21 14v.01" /><path d="M14 21h3" /><path d="M21 18v3" /></svg>;
const IcInbox = () => <svg viewBox="0 0 24 24" width="42" height="42" {...svg} strokeWidth={1.6}><path d="M22 12h-6l-2 3h-4l-2-3H2" /><path d="M5.45 5.11 2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.45-6.89A2 2 0 0 0 16.76 4H7.24a2 2 0 0 0-1.79 1.11z" /></svg>;
const IcCal = () => <svg viewBox="0 0 24 24" width="14" height="14" {...svg} strokeWidth={1.9}><rect x="3" y="4.5" width="18" height="16.5" rx="2.5" /><path d="M3 9.5h18" /><path d="M8 2.5v4" /><path d="M16 2.5v4" /></svg>;
const IcRows = ({ compact }: { compact?: boolean }) => (
  <svg viewBox="0 0 24 24" width="15" height="15" {...svg}>
    {compact ? <><path d="M4 6h16M4 10h16M4 14h16M4 18h16" /></> : <><path d="M4 7h16M4 12h16M4 17h16" /></>}
  </svg>
);

type StatusCategory = 'kontrola' | 'schvalene' | 'export' | 'problem' | 'novy' | 'zamietnuty';
const STATUS_CAT: Record<DocumentStatus, StatusCategory> = {
  novy: 'novy',
  extrahovany: 'kontrola',
  na_kontrole: 'kontrola',
  schvaleny: 'schvalene',
  exportovany: 'export',
  chyba: 'problem',
  karantena: 'problem',
  duplicita: 'problem',
  zamietnuty: 'zamietnuty',
};
const STATUS_CHIP: Record<StatusCategory, { cls: string; icon: ReactNode }> = {
  kontrola: { cls: 'border-amber-200 bg-amber-50 text-amber-800', icon: <IcClock /> },
  schvalene: { cls: 'border-[#BFE0D2] bg-tint text-accent-hover', icon: <IcCheck /> },
  export: { cls: 'border-slate-200 bg-slate-100 text-slate-600', icon: <IcBox /> },
  problem: { cls: 'border-red-200 bg-red-50 text-red-700', icon: <IcAlert /> },
  novy: { cls: 'border-slate-200 bg-slate-100 text-slate-600', icon: <span className="h-1.5 w-1.5 rounded-full bg-current" /> },
  zamietnuty: { cls: 'border-gray-200 bg-gray-100 text-gray-500', icon: <IcX /> },
};

function StatusChip({ status }: { status: DocumentStatus }) {
  const cat = STATUS_CAT[status];
  const style = STATUS_CHIP[cat];
  return (
    <span className={`inline-flex items-center gap-1.5 whitespace-nowrap rounded-full border px-2.5 py-1 text-[11.5px] font-semibold ${style.cls}`}>
      {style.icon}
      {t(`status.${status}`)}
    </span>
  );
}

function AiChip({ value }: { value: number }) {
  const [sym, cls] =
    value >= 0.9 ? ['✓', 'text-accent'] : value >= 0.7 ? ['~', 'text-amber-600'] : ['!', 'text-red-700'];
  return (
    <span className={`tnum inline-flex items-center gap-1 whitespace-nowrap text-[12.5px] font-bold ${cls}`} title={t('doklady.ai.tooltip')}>
      <span className="text-[13px] leading-none">{sym}</span>
      {Math.round(value * 100)} %
    </span>
  );
}

function ProcessingCell({ document, manualLabel }: { document: DocumentItem; manualLabel?: string }) {
  if (manualLabel) {
    return <span className="whitespace-nowrap text-[12px] text-ink-faint">{manualLabel}</span>;
  }
  const isError = document.processingStatus.startsWith('failed');
  const isDone = document.processingStatus === 'ready_for_review';
  if (isError) {
    return (
      <span className="inline-flex items-center gap-1.5 whitespace-nowrap text-[12px] font-medium text-red-700">
        <span className="text-red-600"><IcAlert /></span>
        {t('doklady.spracovanie.chybaExtrakcie')}
      </span>
    );
  }
  if (isDone) {
    return (
      <span className="inline-flex items-center gap-1.5 whitespace-nowrap text-[12px] text-ink-soft">
        <span className="text-accent"><IcCheck /></span>
        {t('doklady.spracovanie.dokoncene')}
      </span>
    );
  }
  return (
    <span className="inline-flex items-center gap-1.5 whitespace-nowrap text-[12px] text-sky-700">
      <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-sky-600" aria-hidden />
      {t(`processing.${document.processingStatus}`)}
    </span>
  );
}

function normalizeSearch(value: string): string {
  return value
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLocaleLowerCase('sk')
    .trim();
}

function matchesTab(document: DocumentItem, tab: TabId): boolean {
  if (tab === 'na_kontrole') {
    return document.status === 'extrahovany' || document.status === 'na_kontrole';
  }
  if (tab === 'schvalene') return document.status === 'schvaleny';
  if (tab === 'exportovane') return document.status === 'exportovany';
  if (tab === 'na_uhradu') {
    return ['to_pay', 'payment_order', 'partially_paid'].includes(document.payment?.status ?? '');
  }
  if (tab === 'problemy') return PROBLEM_STATUSES.has(document.status);
  // Kôš: zamietnuté doklady žijú len tu — vo „Všetky" sa neukazujú.
  if (tab === 'kos') return document.status === 'zamietnuty';
  return document.status !== 'zamietnuty';
}

function matchesProcessing(status: ProcessingStatus, filter: ProcessingFilter): boolean {
  if (!filter) return true;
  if (filter === 'caka') return ['received', 'validating', 'queued'].includes(status);
  if (filter === 'spracuva') return status === 'extracting' || status === 'normalizing';
  if (filter === 'hotovo') return status === 'ready_for_review';
  return status === 'failed_retryable' || status === 'failed_permanent';
}

function requiresAction(document: DocumentItem): boolean {
  return (
    PROBLEM_STATUSES.has(document.status) ||
    document.processingStatus.startsWith('failed') ||
    document.confidence < 0.7
  );
}

function manualProcessingLabel(document: DocumentItem): string | undefined {
  if (document.zdroj.typ === 'manual') return t('processing.manual');
  if (document.zdroj.typ === 'upload' && document.confidence === 0) {
    return t('processing.upload');
  }
  return undefined;
}

/** Mena súčtu — spoločná, ak sú všetky doklady v rovnakej mene, inak EUR. */
function sumCurrency(docs: DocumentItem[]): 'EUR' | 'CZK' | 'USD' {
  const first = docs[0]?.extracted.mena ?? 'EUR';
  return docs.every((d) => d.extracted.mena === first) ? first : 'EUR';
}

/** Pill-obal filtra: uppercase caption + natívny select/input vnútri. */
function FilterPill({ caption, icon, children }: { caption: string; icon?: ReactNode; children: ReactNode }) {
  return (
    <label className="inline-flex h-[38px] cursor-pointer items-center gap-2 rounded-[10px] border border-line bg-surface px-3 transition hover:border-[#A7D9C9] hover:shadow-card">
      {icon && <span className="text-ink-faint">{icon}</span>}
      <span className="text-[9.5px] font-bold uppercase tracking-wider text-ink-mute">{caption}</span>
      {children}
    </label>
  );
}
const selectCls = 'cursor-pointer border-0 bg-transparent pr-0.5 text-[13px] font-semibold text-ink outline-none';

function HeaderCell({
  label,
  sortKey,
  activeKey,
  direction,
  onSort,
  align = 'left',
}: {
  label: string;
  sortKey?: SortKey;
  activeKey: SortKey;
  direction: SortDirection;
  onSort: (key: SortKey) => void;
  align?: 'left' | 'right';
}) {
  const active = sortKey === activeKey;
  const base = `flex items-center gap-1 text-[11px] font-semibold uppercase tracking-[0.045em] ${
    align === 'right' ? 'justify-end' : ''
  }`;
  if (!sortKey) {
    return <span className={`${base} text-ink-faint`}>{label}</span>;
  }
  return (
    <button
      type="button"
      aria-label={`${label}${active ? ', ' + (direction === 'asc' ? t('doklady.zoradeneVzostupne') : t('doklady.zoradeneZostupne')) : ''}`}
      className={`${base} group ${active ? 'text-accent-hover' : 'text-ink-faint hover:text-ink'}`}
      onClick={() => onSort(sortKey)}
    >
      {label}
      <span className={`text-[9px] transition-opacity ${active ? 'opacity-100' : 'opacity-0 group-hover:opacity-100'}`} aria-hidden>
        {active ? (direction === 'asc' ? '▲' : '▼') : '▼'}
      </span>
    </button>
  );
}

export function DocumentsPage() {
  const { data, loading, error } = useDataQuery();
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  const [typeFilter, setTypeFilter] = useState<DocumentType | ''>(() => {
    const value = searchParams.get('typ');
    return DOCUMENT_TYPES.includes(value as DocumentType) ? (value as DocumentType) : '';
  });
  const [supplierFilter, setSupplierFilter] = useState(() => searchParams.get('dodavatel') ?? '');
  const [dateFrom, setDateFrom] = useState(() => searchParams.get('od') ?? '');
  const [dateTo, setDateTo] = useState(() => searchParams.get('do') ?? '');
  const [sourceFilter, setSourceFilter] = useState<SourceFilter>(() => {
    const value = searchParams.get('zdroj');
    return value === 'email' || value === 'manual' || value === 'upload' ? value : '';
  });
  const [processingFilter, setProcessingFilter] = useState<ProcessingFilter>(() => {
    const value = searchParams.get('spracovanie');
    return value === 'caka' || value === 'spracuva' || value === 'hotovo' || value === 'chyba'
      ? value
      : '';
  });
  const [selected, setSelected] = useState<Set<string>>(() => new Set());
  const [queues, setQueues] = useState<DocumentQueue[]>([]);
  const [bulkBusy, setBulkBusy] = useState(false);
  const [bulkRejectOpen, setBulkRejectOpen] = useState(false);
  const [bulkRejectReason, setBulkRejectReason] = useState('');
  const [rejectTargetId, setRejectTargetId] = useState<string | null>(null);
  const [createModalOpen, setCreateModalOpen] = useState(false);
  const [uploadModalOpen, setUploadModalOpen] = useState(false);
  const [paymentModalOpen, setPaymentModalOpen] = useState(false);
  const [qrDocId, setQrDocId] = useState<string | null>(null);
  const [density, setDensity] = useState<Density>('comfortable');
  const [exitingId, setExitingId] = useState<string | null>(null);
  const [sortKey, setSortKey] = useState<SortKey>(() => {
    const value = searchParams.get('zoradit') as SortKey | null;
    return value && ['organization', 'type', 'supplier', 'invoice', 'delivery', 'due', 'amount', 'status', 'processing', 'confidence'].includes(value)
      ? value
      : 'delivery';
  });
  const [sortDirection, setSortDirection] = useState<SortDirection>(
    () => (searchParams.get('smer') === 'asc' ? 'asc' : 'desc'),
  );

  const documents = data?.documents ?? [];
  const organizations = data?.organizations ?? [];
  const currentOrgId = data?.currentOrgId ?? 'all';
  const rawTab = searchParams.get('tab');
  const activeTab = TAB_IDS.includes(rawTab as TabId) ? (rawTab as TabId) : 'vsetky';
  const rawExactStatus = searchParams.get('status');
  const exactStatus = DOCUMENT_STATUSES.includes(rawExactStatus as DocumentStatus)
    ? (rawExactStatus as DocumentStatus)
    : undefined;
  const query = normalizeSearch(searchParams.get('q') ?? '');
  const queueFilter = searchParams.get('fronta') ?? '';
  // Odvodené z URL (nie lokálny stav) — aby rýchle filtre z topbaru fungovali aj
  // pri navigácii v rámci /doklady, keď sa stránka neremountuje.
  const actionRequiredOnly = searchParams.get('zasah') === '1';
  const emailOnly = searchParams.get('email') === '1';

  const organizationMap = useMemo(
    () => new Map(organizations.map((organization) => [organization.id, organization])),
    [organizations],
  );
  useEffect(() => {
    let active = true;
    void listQueues()
      .then((items) => {
        if (active) setQueues(items.filter((queue) => queue.active));
      })
      .catch(() => {
        if (active) setQueues([]);
      });
    return () => {
      active = false;
    };
  }, [data?.queues]);
  const visibleQueues = useMemo(
    () =>
      queues
        .filter(
          (queue) => currentOrgId === 'all' || queue.organizationId === currentOrgId,
        )
        .sort((left, right) => {
          const organizationComparison = COLLATOR.compare(
            organizationMap.get(left.organizationId)?.nazov ?? '',
            organizationMap.get(right.organizationId)?.nazov ?? '',
          );
          return organizationComparison || COLLATOR.compare(left.name, right.name);
        }),
    [currentOrgId, organizationMap, queues],
  );
  const orgScopedDocuments = useMemo(
    () =>
      documents.filter(
        (document) => currentOrgId === 'all' || document.orgId === currentOrgId,
      ),
    [currentOrgId, documents],
  );
  const queueScopedDocuments = useMemo(
    () =>
      queueFilter
        ? orgScopedDocuments.filter((document) => document.queueId === queueFilter)
        : orgScopedDocuments,
    [orgScopedDocuments, queueFilter],
  );
  const suppliers = useMemo(
    () =>
      Array.from(
        new Set(
          queueScopedDocuments
            .map((document) => document.extracted.dodavatel.nazov)
            .filter(Boolean),
        ),
      ).sort((left, right) => COLLATOR.compare(left, right)),
    [queueScopedDocuments],
  );

  useEffect(() => {
    if (supplierFilter && !suppliers.includes(supplierFilter)) setSupplierFilter('');
  }, [supplierFilter, suppliers]);

  const filteredDocuments = useMemo(
    () =>
      queueScopedDocuments.filter((document) => {
        if (exactStatus ? document.status !== exactStatus : !matchesTab(document, activeTab)) {
          return false;
        }
        if (query) {
          const searchable = normalizeSearch(
            [
              document.extracted.dodavatel.nazov,
              document.extracted.cisloFaktury,
              document.extracted.variabilnySymbol ?? '',
            ].join(' '),
          );
          if (!searchable.includes(query)) return false;
        }
        if (typeFilter && document.typ !== typeFilter) return false;
        if (supplierFilter && document.extracted.dodavatel.nazov !== supplierFilter) return false;
        const periodDate = document.extracted.datumDodania ?? document.extracted.datumVystavenia;
        if (dateFrom && periodDate < dateFrom) return false;
        if (dateTo && periodDate > dateTo) return false;
        if (sourceFilter && document.zdroj.typ !== sourceFilter) return false;
        if (!matchesProcessing(document.processingStatus, processingFilter)) return false;
        if (actionRequiredOnly && !requiresAction(document)) return false;
        if (emailOnly && document.zdroj.typ !== 'email') return false;
        return true;
      }),
    [
      actionRequiredOnly,
      activeTab,
      dateFrom,
      dateTo,
      emailOnly,
      exactStatus,
      processingFilter,
      queueScopedDocuments,
      query,
      sourceFilter,
      supplierFilter,
      typeFilter,
    ],
  );

  const sortedDocuments = useMemo(() => {
    const valueOf = (document: DocumentItem): string | number => {
      if (sortKey === 'organization') return organizationMap.get(document.orgId)?.nazov ?? '';
      if (sortKey === 'type') return document.typ;
      if (sortKey === 'supplier') return document.extracted.dodavatel.nazov;
      if (sortKey === 'invoice') return document.extracted.cisloFaktury;
      if (sortKey === 'delivery') {
        return document.extracted.datumDodania ?? document.extracted.datumVystavenia;
      }
      if (sortKey === 'due') return document.extracted.datumSplatnosti ?? '';
      if (sortKey === 'amount') return document.extracted.sumaSpolu;
      if (sortKey === 'status') return document.status;
      if (sortKey === 'processing') return document.processingStatus;
      return document.confidence;
    };
    const multiplier = sortDirection === 'asc' ? 1 : -1;
    return [...filteredDocuments].sort((left, right) => {
      const leftValue = valueOf(left);
      const rightValue = valueOf(right);
      const compared =
        typeof leftValue === 'number' && typeof rightValue === 'number'
          ? leftValue - rightValue
          : COLLATOR.compare(String(leftValue), String(rightValue));
      return compared === 0
        ? COLLATOR.compare(left.id, right.id) * multiplier
        : compared * multiplier;
    });
  }, [filteredDocuments, organizationMap, sortDirection, sortKey]);

  const visibleIds = useMemo(
    () => new Set(sortedDocuments.map((document) => document.id)),
    [sortedDocuments],
  );
  useEffect(() => {
    setSelected((current) => {
      const next = new Set([...current].filter((id) => visibleIds.has(id)));
      return next.size === current.size ? current : next;
    });
  }, [visibleIds]);

  const showOrganization = currentOrgId === 'all';

  if (error || !data) {
    if (loading) return <TableSkeleton showOrganization={showOrganization} />;
    return <p className="text-sm text-red-700">{t('chyba.vseobecna')}</p>;
  }
  if (loading && documents.length === 0) {
    return <TableSkeleton showOrganization={showOrganization} />;
  }

  const statusTabs: Array<{ id: TabId; label: string }> = [
    { id: 'vsetky', label: t('doklady.tab.vsetky') },
    { id: 'na_kontrole', label: t('doklady.tab.naKontrolu') },
    { id: 'schvalene', label: t('doklady.tab.schvalene') },
    { id: 'exportovane', label: t('doklady.tab.exportovane') },
    { id: 'na_uhradu', label: t('doklady.tab.naUhradu') },
    { id: 'problemy', label: t('doklady.tab.problemy') },
    { id: 'kos', label: t('doklady.tab.kos') },
  ];
  const tabCount = (tab: TabId) =>
    queueScopedDocuments.filter((document) => matchesTab(document, tab)).length;
  const paymentsByDocument = new Map<string, typeof data.payments>();
  for (const payment of data.payments ?? []) {
    const list = paymentsByDocument.get(payment.documentId) ?? [];
    list.push(payment);
    paymentsByDocument.set(payment.documentId, list);
  }
  const selectedIds = [...selected];
  const allVisibleSelected =
    sortedDocuments.length > 0 && sortedDocuments.every((document) => selected.has(document.id));
  const currentOrganization = organizationMap.get(currentOrgId);
  const emptyAlias =
    visibleQueues.find((queue) => queue.id === queueFilter)?.importAlias ??
    currentOrganization?.emailAlias ??
    organizations.find((organization) => !organization.archived)?.emailAlias;
  const today = new Date().toISOString().slice(0, 10);
  const grandTotal = sortedDocuments.reduce((sum, d) => sum + d.extracted.sumaSpolu, 0);

  // Zoskupenie podľa organizácie len v predvolenom pohľade (Všetky · všetky firmy).
  const grouped = showOrganization && activeTab === 'vsetky' && !exactStatus;
  const groups: Array<{ id: string; name: string; dot: string; rows: DocumentItem[]; subtotal: number }> = [];
  if (grouped) {
    for (const document of sortedDocuments) {
      let bucket = groups.find((g) => g.id === document.orgId);
      if (!bucket) {
        const org = organizationMap.get(document.orgId);
        bucket = { id: document.orgId, name: org?.nazov ?? '—', dot: org?.farba ?? '#5A635D', rows: [], subtotal: 0 };
        groups.push(bucket);
      }
      bucket.rows.push(document);
      bucket.subtotal += document.extracted.sumaSpolu;
    }
  } else {
    groups.push({ id: 'all', name: '', dot: '', rows: sortedDocuments, subtotal: grandTotal });
  }

  const gridTemplate = showOrganization
    ? '24px minmax(140px,1.15fr) 40px minmax(180px,1.55fr) minmax(120px,1fr) minmax(86px,.78fr) minmax(96px,.82fr) minmax(96px,.86fr) minmax(112px,.95fr) minmax(118px,1fr) minmax(126px,1.05fr) 66px'
    : '24px 40px minmax(180px,1.55fr) minmax(120px,1fr) minmax(86px,.78fr) minmax(96px,.82fr) minmax(96px,.86fr) minmax(112px,.95fr) minmax(118px,1fr) minmax(126px,1.05fr) 66px';
  const gridMinWidth = showOrganization ? 1300 : 1160;
  const rowPadY = density === 'compact' ? '7px' : '13px';

  const selectTab = (tab: TabId) => {
    const next = new URLSearchParams(searchParams);
    if (tab === 'vsetky') next.delete('tab');
    else next.set('tab', tab);
    next.delete('status');
    setSearchParams(next);
  };

  const changeSort = (key: SortKey) => {
    if (sortKey === key) setSortDirection((current) => (current === 'asc' ? 'desc' : 'asc'));
    else {
      setSortKey(key);
      setSortDirection('asc');
    }
  };

  const resetAll = () => {
    setTypeFilter('');
    setSupplierFilter('');
    setDateFrom('');
    setDateTo('');
    setSourceFilter('');
    setProcessingFilter('');
    const next = new URLSearchParams(searchParams);
    ['tab', 'status', 'q', 'fronta', 'zasah', 'email'].forEach((key) => next.delete(key));
    setSearchParams(next);
  };

  const toggleSelect = (id: string, checked: boolean) =>
    setSelected((current) => {
      const next = new Set(current);
      if (checked) next.add(id);
      else next.delete(id);
      return next;
    });

  const runBulk = async (
    mutation: (id: string) => Promise<unknown>,
    successText: string,
  ) => {
    setBulkBusy(true);
    try {
      const results = await Promise.allSettled(selectedIds.map((id) => mutation(id)));
      const succeeded = results
        .map((result, index) => (result.status === 'fulfilled' ? selectedIds[index] : undefined))
        .filter((id): id is string => id !== undefined);
      if (succeeded.length > 0) {
        showToast(`${successText} (${succeeded.length})`);
        setSelected((current) => {
          const next = new Set(current);
          succeeded.forEach((id) => next.delete(id));
          return next;
        });
      }
      if (succeeded.length !== results.length) {
        showToast(t('chyba.vseobecna'), { tone: 'error' });
      }
    } finally {
      setBulkBusy(false);
    }
  };

  const versionRequestsFor = (ids: string[]) =>
    ids.map((id) => {
      const document = data.documents.find((item) => item.id === id);
      if (!document) throw new Error('selected_document_missing');
      return { id, expectedVersion: document.version };
    });

  const runBulkApprove = async () => {
    setBulkBusy(true);
    try {
      const updated = await approveDocuments(versionRequestsFor(selectedIds));
      showToast(`${t('toast.schvalene')} (${updated.length})`);
      setSelected(new Set());
    } catch (cause) {
      showToast(
        cause instanceof Error && cause.message
          ? `${t('doklady.bulk.chybaBezZmien')} ${cause.message}`
          : t('doklady.bulk.chybaBezZmien'),
        { tone: 'error' },
      );
    } finally {
      setBulkBusy(false);
    }
  };

  const quickApprove = (document: DocumentItem) => {
    setExitingId(document.id);
    approveDocuments([{ id: document.id, expectedVersion: document.version }])
      .then((updated) => {
        showToast(`${t('toast.schvalene')} (${updated.length})`);
      })
      .catch((cause) => {
        showToast(
          cause instanceof Error && cause.message
            ? `${t('doklady.bulk.chybaBezZmien')} ${cause.message}`
            : t('doklady.bulk.chybaBezZmien'),
          { tone: 'error' },
        );
      })
      .finally(() => setExitingId(null));
  };

  const rejectIds = rejectTargetId ? [rejectTargetId] : selectedIds;
  const closeReject = () => {
    if (bulkBusy) return;
    setBulkRejectOpen(false);
    setBulkRejectReason('');
    setRejectTargetId(null);
  };
  const runReject = async () => {
    setBulkBusy(true);
    try {
      const updated = await rejectDocuments(versionRequestsFor(rejectIds), bulkRejectReason);
      showToast(`${t('toast.zamietnute')} (${updated.length})`);
      if (!rejectTargetId) setSelected(new Set());
      setBulkRejectReason('');
      setBulkRejectOpen(false);
      setRejectTargetId(null);
    } catch (cause) {
      showToast(
        cause instanceof Error && cause.message
          ? `${t('doklady.bulk.chybaBezZmien')} ${cause.message}`
          : t('doklady.bulk.chybaBezZmien'),
        { tone: 'error' },
      );
    } finally {
      setBulkBusy(false);
    }
  };

  const detailHref = (documentId: string, queueIdOverride?: string) => {
    const params = new URLSearchParams(searchParams);
    const setOptional = (key: string, value: string) => {
      if (value) params.set(key, value);
      else params.delete(key);
    };
    setOptional('typ', typeFilter);
    setOptional('fronta', queueIdOverride ?? queueFilter);
    setOptional('dodavatel', supplierFilter);
    setOptional('od', dateFrom);
    setOptional('do', dateTo);
    setOptional('zdroj', sourceFilter);
    setOptional('spracovanie', processingFilter);
    setOptional('zasah', actionRequiredOnly ? '1' : '');
    setOptional('email', emailOnly ? '1' : '');
    setOptional('zoradit', sortKey);
    setOptional('smer', sortDirection);
    const suffix = params.toString();
    return `/doklady/${documentId}${suffix ? `?${suffix}` : ''}`;
  };

  const paymentDocs = qrDocId
    ? [data.documents.find((d) => d.id === qrDocId)].filter((d): d is DocumentItem => Boolean(d))
    : selectedIds
        .map((id) => data.documents.find((document) => document.id === id))
        .filter((document): document is DocumentItem => Boolean(document));

  const headerCells = (
    <>
      <button
        type="button"
        role="checkbox"
        aria-checked={allVisibleSelected}
        className={`grid h-[18px] w-[18px] place-items-center self-center rounded-[5px] border-[1.6px] text-white transition ${
          allVisibleSelected ? 'border-accent bg-accent' : 'border-line bg-surface'
        }`}
        aria-label={t('doklady.vybratVsetko')}
        onClick={() => {
          if (allVisibleSelected) setSelected(new Set());
          else setSelected(new Set(sortedDocuments.map((document) => document.id)));
        }}
      >
        {allVisibleSelected && <IcCheck />}
      </button>
      {showOrganization && (
        <HeaderCell label={t('doklady.st.organizacia')} sortKey="organization" activeKey={sortKey} direction={sortDirection} onSort={changeSort} />
      )}
      <HeaderCell label={t('doklady.st.typ')} sortKey="type" activeKey={sortKey} direction={sortDirection} onSort={changeSort} />
      <HeaderCell label={t('doklady.st.dodavatel')} sortKey="supplier" activeKey={sortKey} direction={sortDirection} onSort={changeSort} />
      <HeaderCell label={t('doklady.st.cislo')} sortKey="invoice" activeKey={sortKey} direction={sortDirection} onSort={changeSort} />
      <HeaderCell label={t('doklady.st.datumDodania')} sortKey="delivery" activeKey={sortKey} direction={sortDirection} onSort={changeSort} />
      <HeaderCell label={t('doklady.st.splatnost')} sortKey="due" activeKey={sortKey} direction={sortDirection} onSort={changeSort} />
      <HeaderCell label={t('doklady.st.suma')} sortKey="amount" activeKey={sortKey} direction={sortDirection} onSort={changeSort} align="right" />
      <HeaderCell label={t('platba.titulok')} activeKey={sortKey} direction={sortDirection} onSort={changeSort} />
      <HeaderCell label={t('doklady.st.stav')} sortKey="status" activeKey={sortKey} direction={sortDirection} onSort={changeSort} />
      <HeaderCell label={t('processing.label')} sortKey="processing" activeKey={sortKey} direction={sortDirection} onSort={changeSort} />
      <HeaderCell label={t('doklady.st.ai')} sortKey="confidence" activeKey={sortKey} direction={sortDirection} onSort={changeSort} align="right" />
    </>
  );

  return (
    <div>
      <div className="mb-4 flex items-center justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold tracking-tight">{t('doklady.titulok')}</h1>
          {tabCount('na_kontrole') > 0 && (
            <p className="mt-0.5 text-[13px] text-ink-faint">
              {tabCount('na_kontrole')} {t('notif.cakaNaKontrolu').toLowerCase()}
            </p>
          )}
        </div>
        {data.role !== 'schvalovatel' && (
          <div className="flex items-center gap-2">
            <button type="button" className="btn" onClick={() => setUploadModalOpen(true)}>
              {t('doklady.nahrat.tlacidlo')}
            </button>
            <button type="button" className="btn btn-primary" onClick={() => setCreateModalOpen(true)}>
              + {t('doklady.pridat')}
            </button>
          </div>
        )}
      </div>

      {/* Taby */}
      <div className="mb-4 flex items-center gap-1 overflow-x-auto border-b border-line" role="tablist">
        {statusTabs.map((tab) => {
          const isActive = activeTab === tab.id && !exactStatus;
          const count = tabCount(tab.id);
          return (
            <button
              key={tab.id}
              type="button"
              role="tab"
              aria-selected={isActive}
              className={`relative -mb-px inline-flex items-center gap-2 whitespace-nowrap px-3 py-2.5 text-[13.5px] transition ${
                isActive ? 'font-semibold text-accent-hover' : 'font-medium text-ink-soft hover:text-ink'
              }`}
              onClick={() => selectTab(tab.id)}
            >
              {tab.label}
              <span
                className={`tnum inline-flex h-[19px] min-w-[19px] items-center justify-center rounded-full px-1.5 text-[11px] font-semibold ${
                  isActive ? 'bg-tint text-accent-hover' : count === 0 ? 'bg-transparent text-ink-mute' : 'bg-line-soft text-ink-faint'
                }`}
              >
                {count}
              </span>
              {isActive && <span className="absolute inset-x-2 bottom-0 h-0.5 rounded-t bg-accent" aria-hidden />}
            </button>
          );
        })}
        <div className="ml-auto hidden items-center gap-1 rounded-[9px] border border-line bg-surface p-0.5 md:flex">
          <button
            type="button"
            className={`grid h-7 w-7 place-items-center rounded-[7px] transition ${density === 'comfortable' ? 'bg-tint text-accent-hover' : 'text-ink-faint hover:text-ink'}`}
            aria-label={t('doklady.hustota.komfort')}
            title={t('doklady.hustota.komfort')}
            aria-pressed={density === 'comfortable'}
            onClick={() => setDensity('comfortable')}
          >
            <IcRows />
          </button>
          <button
            type="button"
            className={`grid h-7 w-7 place-items-center rounded-[7px] transition ${density === 'compact' ? 'bg-tint text-accent-hover' : 'text-ink-faint hover:text-ink'}`}
            aria-label={t('doklady.hustota.kompakt')}
            title={t('doklady.hustota.kompakt')}
            aria-pressed={density === 'compact'}
            onClick={() => setDensity('compact')}
          >
            <IcRows compact />
          </button>
        </div>
      </div>

      {/* Filtre */}
      <div className="mb-4 flex flex-wrap items-center gap-2.5">
        <FilterPill caption={t('fronta.label')}>
          <select
            className={selectCls}
            value={queueFilter}
            aria-label={t('fronta.label')}
            onChange={(event) => {
              const next = new URLSearchParams(searchParams);
              if (event.target.value) next.set('fronta', event.target.value);
              else next.delete('fronta');
              setSearchParams(next);
            }}
          >
            <option value="">{t('fronta.vsetky')}</option>
            {visibleQueues.map((queue) => (
              <option key={queue.id} value={queue.id}>
                {currentOrgId === 'all'
                  ? `${organizationMap.get(queue.organizationId)?.nazov ?? ''} · ${queue.name}`
                  : queue.name}
              </option>
            ))}
          </select>
        </FilterPill>
        <FilterPill caption={t('doklady.filter.typ')}>
          <select className={selectCls} value={typeFilter} aria-label={t('doklady.filter.typ')} onChange={(event) => setTypeFilter(event.target.value as DocumentType | '')}>
            <option value="">{t('doklady.filter.vsetko')}</option>
            {DOCUMENT_TYPES.map((type) => (
              <option key={type} value={type}>{type}</option>
            ))}
          </select>
        </FilterPill>
        <FilterPill caption={t('doklady.filter.dodavatel')}>
          <select className={`${selectCls} max-w-[160px]`} value={supplierFilter} aria-label={t('doklady.filter.dodavatel')} onChange={(event) => setSupplierFilter(event.target.value)}>
            <option value="">{t('doklady.filter.vsetko')}</option>
            {suppliers.map((supplier) => (
              <option key={supplier} value={supplier}>{supplier}</option>
            ))}
          </select>
        </FilterPill>
        <FilterPill caption={t('doklady.filter.obdobieOd')} icon={<IcCal />}>
          <input className="tnum w-[112px] cursor-pointer border-0 bg-transparent text-[13px] font-semibold text-ink outline-none" type="date" value={dateFrom} aria-label={t('doklady.filter.obdobieOd')} onChange={(event) => setDateFrom(event.target.value)} />
          <span className="text-ink-mute">–</span>
          <input className="tnum w-[112px] cursor-pointer border-0 bg-transparent text-[13px] font-semibold text-ink outline-none" type="date" value={dateTo} aria-label={t('doklady.filter.obdobieDo')} onChange={(event) => setDateTo(event.target.value)} />
        </FilterPill>
        <FilterPill caption={t('doklady.filter.zdroj')}>
          <select className={selectCls} value={sourceFilter} aria-label={t('doklady.filter.zdroj')} onChange={(event) => setSourceFilter(event.target.value as SourceFilter)}>
            <option value="">{t('doklady.filter.vsetko')}</option>
            <option value="email">{t('doklady.zdroj.email')}</option>
            <option value="manual">{t('doklady.zdroj.manual')}</option>
            <option value="upload">{t('doklady.zdroj.upload')}</option>
          </select>
        </FilterPill>
        <FilterPill caption={t('doklady.filter.spracovanie')}>
          <select className={selectCls} value={processingFilter} aria-label={t('doklady.filter.spracovanie')} onChange={(event) => setProcessingFilter(event.target.value as ProcessingFilter)}>
            <option value="">{t('doklady.filter.vsetko')}</option>
            <option value="caka">{t('doklady.spracovanie.caka')}</option>
            <option value="spracuva">{t('doklady.spracovanie.spracuva')}</option>
            <option value="hotovo">{t('doklady.spracovanie.hotovo')}</option>
            <option value="chyba">{t('doklady.spracovanie.chyba')}</option>
          </select>
        </FilterPill>
      </div>

      {/* Tabuľka / prázdny stav */}
      {sortedDocuments.length === 0 ? (
        <div className="card flex flex-col items-center gap-1.5 px-6 py-16 text-center">
          <div className="mb-2 grid h-24 w-24 place-items-center rounded-3xl bg-tint text-accent" style={{ boxShadow: '0 10px 28px -14px rgba(14,122,95,.5)' }}>
            <IcInbox />
          </div>
          <p className="text-[17px] font-bold text-ink">{t('doklady.prazdne.titulok')}</p>
          <p className="max-w-sm text-[13.5px] leading-relaxed text-ink-faint">{t('doklady.prazdne.popis')}</p>
          {emptyAlias && <code className="tnum mt-1 rounded-md bg-app px-2 py-1 text-xs text-ink">{emptyAlias}</code>}
          <div className="mt-4 flex gap-2.5">
            {data.role !== 'schvalovatel' && (
              <button type="button" className="btn btn-primary" onClick={() => setCreateModalOpen(true)}>
                + {t('doklady.pridat')}
              </button>
            )}
            <button type="button" className="btn" onClick={resetAll}>
              {t('doklady.zobrazitVsetky')}
            </button>
          </div>
        </div>
      ) : (
        <div className="card overflow-hidden">
          <div className="overflow-auto" style={{ maxHeight: 'calc(100vh - 17rem)' }}>
            <div style={{ minWidth: gridMinWidth }}>
              {/* Hlavička */}
              <div
                className="sticky top-0 z-[3] items-center border-b border-line bg-surface-2 px-4 py-3"
                style={{ display: 'grid', gridTemplateColumns: gridTemplate, columnGap: '11px', backdropFilter: 'blur(8px)' }}
              >
                {headerCells}
              </div>

              {groups.map((group) => (
                <div key={group.id}>
                  {grouped && group.rows.length > 0 && (
                    <div className="flex items-center gap-2.5 border-b border-line-soft bg-surface-2 px-4 py-2.5">
                      <span className="h-2 w-2 shrink-0 rounded-full" style={{ background: group.dot }} aria-hidden />
                      <span className="text-[12px] font-bold text-ink">{group.name}</span>
                      <span className="text-[11.5px] text-ink-mute">· {group.rows.length} {t('doklady.pocetDokladov')}</span>
                      <span className="ml-auto text-[12px] font-semibold text-ink-soft">
                        {t('doklady.medzisucet')}: <span className="tnum font-bold text-ink">{formatMoney(group.subtotal, sumCurrency(group.rows))}</span>
                      </span>
                    </div>
                  )}
                  {group.rows.map((document) => {
                    const organization = organizationMap.get(document.orgId);
                    const due = document.extracted.datumSplatnosti;
                    const overdue = !!due && due < today;
                    const overdueDays = overdue ? Math.max(1, Math.round((Date.parse(today) - Date.parse(due!)) / 86_400_000)) : 0;
                    const manualLabel = manualProcessingLabel(document);
                    const isSelected = selected.has(document.id);
                    const isKos = activeTab === 'kos';
                    const payable = document.typ !== 'BV';
                    const rowLabel = [
                      showOrganization ? organization?.nazov : null,
                      document.extracted.dodavatel.nazov,
                      document.typ,
                      formatMoney(document.extracted.sumaSpolu, document.extracted.mena),
                      t(`status.${document.status}`),
                      overdue ? t('doklady.poSplatnosti') : null,
                    ]
                      .filter(Boolean)
                      .join(', ');
                    return (
                      <div
                        key={document.id}
                        role="link"
                        aria-label={rowLabel}
                        tabIndex={0}
                        className="group relative cursor-pointer border-b border-line-soft text-[13px] text-ink transition last:border-0 hover:bg-[#F7F9F7] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-accent"
                        style={{
                          display: 'grid',
                          gridTemplateColumns: gridTemplate,
                          columnGap: '11px',
                          alignItems: 'center',
                          padding: `${rowPadY} 16px`,
                          opacity: exitingId === document.id ? 0.4 : 1,
                          pointerEvents: exitingId === document.id ? 'none' : undefined,
                        }}
                        onClick={() => navigate(detailHref(document.id))}
                        onKeyDown={(event) => {
                          if (event.currentTarget === event.target && (event.key === 'Enter' || event.key === ' ')) {
                            event.preventDefault();
                            navigate(detailHref(document.id));
                          }
                        }}
                      >
                        <button
                          type="button"
                          role="checkbox"
                          aria-checked={isSelected}
                          className={`grid h-[18px] w-[18px] place-items-center self-center rounded-[5px] border-[1.6px] text-white transition ${
                            isSelected ? 'border-accent bg-accent' : 'border-line bg-surface'
                          }`}
                          aria-label={`${t('doklady.bulk.vybranych')}: ${document.extracted.cisloFaktury}`}
                          onClick={(event) => {
                            event.stopPropagation();
                            toggleSelect(document.id, !isSelected);
                          }}
                        >
                          {isSelected && <IcCheck />}
                        </button>
                        {showOrganization && (
                          <span className="flex min-w-0 items-center gap-2">
                            {organization && <OrgDot org={organization} size={8} />}
                            <span className="truncate font-medium">{organization?.nazov ?? '—'}</span>
                          </span>
                        )}
                        <span><TypBadge typ={document.typ} /></span>
                        <span className="min-w-0">
                          <span className="block truncate font-medium">{document.extracted.dodavatel.nazov}</span>
                          <span className="tnum block truncate text-[11.5px] text-ink-faint">
                            {t('doklady.ico')} {document.extracted.dodavatel.ico ?? '—'}
                          </span>
                        </span>
                        <span className="tnum min-w-0">
                          <span className="block truncate font-medium">{document.extracted.cisloFaktury}</span>
                          <span className="block truncate text-[11.5px] text-ink-faint">VS {document.extracted.variabilnySymbol ?? '—'}</span>
                        </span>
                        <span className="tnum whitespace-nowrap text-ink-soft">{formatDate(document.extracted.datumDodania)}</span>
                        <span className="tnum min-w-0">
                          <span className={`block whitespace-nowrap ${overdue ? 'font-semibold text-red-700' : 'text-ink-soft'}`}>
                            {formatDate(document.extracted.datumSplatnosti)}
                          </span>
                          {overdue && (
                            <span className="mt-1 inline-flex items-center gap-1 whitespace-nowrap rounded-md bg-red-50 px-1.5 py-0.5 text-[10.5px] font-semibold text-red-700">
                              <IcAlert />
                              {overdueDays} {t('doklady.dniPoSplatnosti')}
                            </span>
                          )}
                        </span>
                        <span className="tnum whitespace-nowrap text-right font-semibold">{formatMoney(document.extracted.sumaSpolu, document.extracted.mena)}</span>
                        <span>
                          {isKos ? (
                            <button
                              type="button"
                              className="btn px-2.5 py-1 text-xs"
                              onClick={(event) => {
                                event.stopPropagation();
                                void restoreDocument(document.id)
                                  .then(() => showToast(t('doklady.obnovene')))
                                  .catch((cause) => showToast(cause instanceof Error ? cause.message : t('chyba.vseobecna')));
                              }}
                            >
                              {t('doklady.obnovit')}
                            </button>
                          ) : !payable ? (
                            <span className="text-ink-mute">—</span>
                          ) : (() => {
                            const state = paymentStateFor(document, paymentsByDocument.get(document.id) ?? []);
                            const styles: Record<string, string> = {
                              uhradena: 'border-[#BFE0D2] bg-tint text-accent-hover',
                              ciastocna: 'border-amber-300 bg-amber-50 text-amber-800',
                              neuhradena: 'border-line bg-app text-ink-soft',
                              po_splatnosti: 'border-red-200 bg-red-50 text-red-700',
                            };
                            return (
                              <span className={`inline-flex whitespace-nowrap rounded-full border px-2 py-0.5 text-[11px] font-semibold ${styles[state.status]}`}>
                                {t(`platby.stav.${state.status}`)}
                              </span>
                            );
                          })()}
                        </span>
                        <span><StatusChip status={document.status} /></span>
                        <span className="min-w-0"><ProcessingCell document={document} manualLabel={manualLabel} /></span>
                        <span className="flex justify-end">
                          {manualLabel ? <span className="text-ink-mute">—</span> : <AiChip value={document.confidence} />}
                        </span>

                        {/* Akcie pri hoveri */}
                        <span
                          className="pointer-events-none absolute inset-y-0 right-2 flex items-center gap-1.5 pl-10 opacity-0 transition-opacity duration-150 group-hover:pointer-events-auto group-hover:opacity-100 group-focus-within:pointer-events-auto group-focus-within:opacity-100"
                          style={{ background: 'linear-gradient(90deg,transparent,#F7F9F7 32%)' }}
                        >
                          <button
                            type="button"
                            className="grid h-[30px] w-[30px] place-items-center rounded-lg border border-line bg-surface text-ink-soft transition hover:-translate-y-px hover:border-accent hover:bg-tint hover:text-accent-hover"
                            title={t('doklady.akcia.otvorit')}
                            aria-label={t('doklady.akcia.otvorit')}
                            onClick={(event) => {
                              event.stopPropagation();
                              navigate(detailHref(document.id));
                            }}
                          >
                            <IcOpen />
                          </button>
                          {isKos ? null : (
                            <>
                              {payable && (
                                <button
                                  type="button"
                                  className="grid h-[30px] w-[30px] place-items-center rounded-lg border border-line bg-surface text-ink-soft transition hover:-translate-y-px hover:border-accent hover:bg-tint hover:text-accent-hover"
                                  title={t('doklady.akcia.qr')}
                                  aria-label={t('doklady.akcia.qr')}
                                  onClick={(event) => {
                                    event.stopPropagation();
                                    setQrDocId(document.id);
                                    setPaymentModalOpen(true);
                                  }}
                                >
                                  <IcQr />
                                </button>
                              )}
                              <button
                                type="button"
                                className="grid h-[30px] w-[30px] place-items-center rounded-lg border border-line bg-surface text-ink-soft transition hover:-translate-y-px hover:border-[#BFE0D2] hover:bg-tint hover:text-accent-hover"
                                title={t('doklady.bulk.schvalit')}
                                aria-label={t('doklady.bulk.schvalit')}
                                onClick={(event) => {
                                  event.stopPropagation();
                                  quickApprove(document);
                                }}
                              >
                                <IcCheck />
                              </button>
                              <button
                                type="button"
                                className="grid h-[30px] w-[30px] place-items-center rounded-lg border border-line bg-surface text-ink-soft transition hover:-translate-y-px hover:border-red-200 hover:bg-red-50 hover:text-red-700"
                                title={t('doklady.bulk.zamietnut')}
                                aria-label={t('doklady.bulk.zamietnut')}
                                onClick={(event) => {
                                  event.stopPropagation();
                                  setRejectTargetId(document.id);
                                  setBulkRejectOpen(true);
                                }}
                              >
                                <IcX />
                              </button>
                            </>
                          )}
                        </span>
                      </div>
                    );
                  })}
                </div>
              ))}

              {/* Súčtový riadok */}
              <div className="sticky bottom-0 z-[3] flex items-center justify-between border-t border-line bg-surface-2 px-4 py-3">
                <span className="text-[12.5px] font-medium text-ink-soft">
                  {sortedDocuments.length} {t('doklady.pocetDokladov')}
                </span>
                <span className="text-[13px] font-semibold text-ink-soft">
                  {t('doklady.spolu')}: <span className="tnum text-[15px] font-bold text-ink">{formatMoney(grandTotal, sumCurrency(sortedDocuments))}</span>
                </span>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Plávajúca lišta hromadných akcií */}
      <AnimatePresence>
        {selected.size > 0 && (
          <motion.div
            initial={{ opacity: 0, y: 14, x: '-50%' }}
            animate={{ opacity: 1, y: 0, x: '-50%' }}
            exit={{ opacity: 0, y: 14, x: '-50%' }}
            transition={{ duration: 0.22, ease: [0.32, 0.72, 0, 1] }}
            className="fixed bottom-6 left-1/2 z-40 flex items-center gap-1.5 rounded-2xl py-2 pl-4 pr-2 text-sm text-white shadow-pop"
            style={{ background: '#12211C' }}
          >
            <span className="font-semibold">
              {t('doklady.bulk.vybranych').replace(/^./, (c) => c.toUpperCase())}:{' '}
              <span className="tnum text-[#7FE8C6]">{selected.size}</span>
            </span>
            <span className="mx-1 h-5 w-px bg-white/15" />
            <button
              type="button"
              className="inline-flex h-[34px] items-center gap-1.5 rounded-[9px] bg-gradient-to-br from-accent-bright to-accent px-3 text-[12.5px] font-semibold text-white disabled:opacity-50"
              disabled={bulkBusy}
              onClick={() => void runBulkApprove()}
            >
              <IcCheck />
              {t('doklady.bulk.schvalit')}
            </button>
            <button
              type="button"
              className="h-[34px] rounded-[9px] bg-white/10 px-3 text-[12.5px] font-semibold text-[#EAF0EC] transition hover:bg-white/20 disabled:opacity-50"
              disabled={bulkBusy}
              onClick={() => {
                setRejectTargetId(null);
                setBulkRejectOpen(true);
              }}
            >
              {t('doklady.bulk.zamietnut')}
            </button>
            <button
              type="button"
              className="h-[34px] rounded-[9px] bg-white/10 px-3 text-[12.5px] font-semibold text-[#EAF0EC] transition hover:bg-white/20 disabled:opacity-50"
              disabled={bulkBusy}
              onClick={() => {
                setQrDocId(null);
                setPaymentModalOpen(true);
              }}
            >
              {t('doklady.bulk.platbaQr')}
            </button>
            <select
              className="h-[34px] cursor-pointer rounded-[9px] bg-white/10 px-2.5 text-[12.5px] font-semibold text-[#EAF0EC] outline-none disabled:opacity-50"
              value=""
              disabled={bulkBusy}
              aria-label={t('doklady.bulk.presunut')}
              onChange={(event) => {
                const target = event.target.value;
                event.target.value = '';
                if (target === 'na_kontrole') void runBulk(moveDocumentToReview, t('toast.ulozene'));
                else if (target === 'karantena') void runBulk(quarantineDocument, t('toast.karantena'));
              }}
            >
              <option value="" className="text-ink">{t('doklady.bulk.presunut')}</option>
              <option value="na_kontrole" className="text-ink">{t('status.na_kontrole')}</option>
              <option value="karantena" className="text-ink">{t('status.karantena')}</option>
            </select>
            <button
              type="button"
              className="h-[34px] rounded-[9px] px-3 text-[12.5px] font-semibold text-[#9FB0A8] transition hover:text-white"
              onClick={() => setSelected(new Set())}
            >
              {t('doklady.zrusitVyber')}
            </button>
          </motion.div>
        )}
      </AnimatePresence>

      {createModalOpen && (
        <DocumentCreateModal
          initialOrganizationId={currentOrgId === 'all' ? undefined : currentOrgId}
          initialQueueId={queueFilter || undefined}
          onClose={() => setCreateModalOpen(false)}
          onCreated={(document) => {
            setCreateModalOpen(false);
            navigate(detailHref(document.id, document.queueId));
          }}
        />
      )}

      {uploadModalOpen && (
        <UploadModal
          organizations={organizations}
          currentOrgId={currentOrgId}
          onClose={() => setUploadModalOpen(false)}
        />
      )}

      {paymentModalOpen && paymentDocs.length > 0 && (
        <Suspense fallback={<p className="text-sm text-ink-soft">{t('stav.nacitavam')}</p>}>
          <PaymentQrModal
            documents={paymentDocs}
            organizations={data.organizations}
            bankAccounts={data.bankAccounts}
            onClose={() => {
              setPaymentModalOpen(false);
              setQrDocId(null);
            }}
          />
        </Suspense>
      )}

      {bulkRejectOpen && (
        <Modal title={t('zamietnutie.hromadneTitulok')} onClose={closeReject}>
          <p className="mb-3 text-sm text-ink-soft">
            {t('zamietnutie.hromadnePopis')} ({rejectIds.length})
          </p>
          <label className="label" htmlFor="bulk-rejection-reason">
            {t('zamietnutie.dovod')}
          </label>
          <textarea
            id="bulk-rejection-reason"
            className="input min-h-28"
            value={bulkRejectReason}
            maxLength={1000}
            disabled={bulkBusy}
            onChange={(event) => setBulkRejectReason(event.target.value)}
            placeholder={t('zamietnutie.placeholder')}
          />
          <p className="mt-1 text-right text-xs text-ink-soft">{bulkRejectReason.length} / 1000</p>
          <div className="mt-4 flex justify-end gap-2">
            <button type="button" className="btn" disabled={bulkBusy} onClick={closeReject}>
              {t('akcia.zrusit')}
            </button>
            <button
              type="button"
              className="btn btn-danger"
              disabled={bulkBusy || !bulkRejectReason.trim()}
              onClick={() => void runReject()}
            >
              {t('doklady.bulk.zamietnut')}
            </button>
          </div>
        </Modal>
      )}
    </div>
  );
}

function TableSkeleton({ showOrganization }: { showOrganization: boolean }) {
  const cols = showOrganization ? 12 : 11;
  return (
    <div>
      <div className="mb-4 h-7 w-40 skeleton" />
      <div className="mb-4 flex gap-2.5">
        {Array.from({ length: 6 }).map((_, index) => (
          <div key={index} className="h-[38px] w-28 rounded-[10px] skeleton" />
        ))}
      </div>
      <div className="card overflow-hidden p-4">
        {Array.from({ length: 7 }).map((_, row) => (
          <div key={row} className="grid items-center gap-3 border-b border-line-soft py-4 last:border-0" style={{ gridTemplateColumns: `repeat(${cols}, 1fr)` }}>
            {Array.from({ length: cols }).map((_, cell) => (
              <div key={cell} className="h-3.5 skeleton" style={{ width: `${60 + ((cell * 7) % 35)}%` }} />
            ))}
          </div>
        ))}
      </div>
    </div>
  );
}

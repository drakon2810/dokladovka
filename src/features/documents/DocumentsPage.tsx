import { lazy, Suspense, useEffect, useMemo, useState } from 'react';
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
import {
  ConfidenceIndicator,
  EmptyState,
  OrgChip,
  PaymentStatusBadge,
  ProcessingBadge,
  StatusBadge,
  TypBadge,
  Modal,
} from '../../components/ui';
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

const TAB_IDS: TabId[] = ['vsetky', 'na_kontrole', 'schvalene', 'exportovane', 'na_uhradu', 'problemy', 'kos'];
const COLLATOR = new Intl.Collator('sk', { sensitivity: 'base', numeric: true });

function normalizeSearch(value: string): string {
  return value
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
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

function SortHeader({
  label,
  sortKey,
  activeKey,
  direction,
  onSort,
  className = '',
}: {
  label: string;
  sortKey: SortKey;
  activeKey: SortKey;
  direction: SortDirection;
  onSort: (key: SortKey) => void;
  className?: string;
}) {
  const active = activeKey === sortKey;
  const ariaSort: 'ascending' | 'descending' | 'none' = active
    ? direction === 'asc'
      ? 'ascending'
      : 'descending'
    : 'none';
  return (
    <th className={`px-3 py-2 font-medium ${className}`} aria-sort={ariaSort}>
      <button
        type="button"
        className="inline-flex items-center gap-1 whitespace-nowrap rounded hover:text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
        onClick={() => onSort(sortKey)}
      >
        {label}
        <span className="text-[10px]" aria-hidden>
          {active ? (direction === 'asc' ? '▲' : '▼') : '↕'}
        </span>
      </button>
    </th>
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
  const [actionRequiredOnly, setActionRequiredOnly] = useState(
    () => searchParams.get('zasah') === '1',
  );
  const [emailOnly, setEmailOnly] = useState(() => searchParams.get('email') === '1');
  const [selected, setSelected] = useState<Set<string>>(() => new Set());
  const [queues, setQueues] = useState<DocumentQueue[]>([]);
  const [bulkBusy, setBulkBusy] = useState(false);
  const [bulkRejectOpen, setBulkRejectOpen] = useState(false);
  const [bulkRejectReason, setBulkRejectReason] = useState('');
  const [createModalOpen, setCreateModalOpen] = useState(false);
  const [uploadModalOpen, setUploadModalOpen] = useState(false);
  const [paymentModalOpen, setPaymentModalOpen] = useState(false);
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

  if (loading) {
    return <p className="text-sm text-ink-soft">{t('stav.nacitavam')}</p>;
  }
  if (error || !data) {
    return <p className="text-sm text-red-700">{t('chyba.vseobecna')}</p>;
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
  const showOrganization = currentOrgId === 'all';
  const selectedIds = [...selected];
  const allVisibleSelected =
    sortedDocuments.length > 0 && sortedDocuments.every((document) => selected.has(document.id));
  const currentOrganization = organizationMap.get(currentOrgId);
  const emptyAlias =
    visibleQueues.find((queue) => queue.id === queueFilter)?.importAlias ??
    currentOrganization?.emailAlias ??
    organizations.find((organization) => !organization.archived)?.emailAlias;
  const today = new Date().toISOString().slice(0, 10);

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

  const selectedVersionRequests = () =>
    selectedIds.map((id) => {
      const document = data.documents.find((item) => item.id === id);
      if (!document) throw new Error('selected_document_missing');
      return { id, expectedVersion: document.version };
    });

  const runBulkApprove = async () => {
    setBulkBusy(true);
    try {
      const requests = selectedVersionRequests();
      const updated = await approveDocuments(requests);
      showToast(`${t('toast.schvalene')} (${updated.length})`);
      setSelected(new Set());
    } catch (cause) {
      // Server vracia zrozumiteľný dôvod (karanténa, neúplné zaúčtovanie…) —
      // zobrazíme ho, generická hláška bez príčiny bola mätúca.
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

  const runBulkReject = async () => {
    setBulkBusy(true);
    try {
      const requests = selectedVersionRequests();
      const updated = await rejectDocuments(requests, bulkRejectReason);
      showToast(`${t('toast.zamietnute')} (${updated.length})`);
      setSelected(new Set());
      setBulkRejectReason('');
      setBulkRejectOpen(false);
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

  return (
    <div>
      <div className="mb-4 flex items-center justify-between gap-3">
        <h1 className="text-xl font-semibold">{t('doklady.titulok')}</h1>
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

      <div className="mb-4 flex gap-1 overflow-x-auto border-b border-line" role="tablist">
        {statusTabs.map((tab) => (
          <button
            key={tab.id}
            type="button"
            role="tab"
            aria-selected={activeTab === tab.id && !exactStatus}
            className={`-mb-px inline-flex items-center gap-2 whitespace-nowrap rounded-t border-b-2 px-3 py-2 text-sm font-medium ${
              activeTab === tab.id && !exactStatus
                ? 'border-accent text-accent'
                : 'border-transparent text-ink-soft hover:text-ink'
            }`}
            onClick={() => selectTab(tab.id)}
          >
            {tab.label}
            <span className="tnum rounded-full bg-app px-1.5 py-0.5 text-xs">{tabCount(tab.id)}</span>
          </button>
        ))}
      </div>

      <div className="card mb-4 grid grid-cols-1 gap-3 p-3 md:grid-cols-2 xl:grid-cols-7">
        <label className="text-xs text-ink-soft">
          <span className="label">{t('fronta.label')}</span>
          <select
            className="input"
            value={queueFilter}
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
        </label>
        <label className="text-xs text-ink-soft">
          <span className="label">{t('doklady.filter.typ')}</span>
          <select
            className="input"
            value={typeFilter}
            onChange={(event) => setTypeFilter(event.target.value as DocumentType | '')}
          >
            <option value="">{t('doklady.filter.vsetko')}</option>
            {DOCUMENT_TYPES.map((type) => (
              <option key={type} value={type}>
                {type}
              </option>
            ))}
          </select>
        </label>
        <label className="text-xs text-ink-soft">
          <span className="label">{t('doklady.filter.dodavatel')}</span>
          <select
            className="input"
            value={supplierFilter}
            onChange={(event) => setSupplierFilter(event.target.value)}
          >
            <option value="">{t('doklady.filter.vsetko')}</option>
            {suppliers.map((supplier) => (
              <option key={supplier} value={supplier}>
                {supplier}
              </option>
            ))}
          </select>
        </label>
        <label className="text-xs text-ink-soft">
          <span className="label">{t('doklady.filter.obdobieOd')}</span>
          <input
            className="input tnum"
            type="date"
            value={dateFrom}
            onChange={(event) => setDateFrom(event.target.value)}
          />
        </label>
        <label className="text-xs text-ink-soft">
          <span className="label">{t('doklady.filter.obdobieDo')}</span>
          <input
            className="input tnum"
            type="date"
            value={dateTo}
            onChange={(event) => setDateTo(event.target.value)}
          />
        </label>
        <label className="text-xs text-ink-soft">
          <span className="label">{t('doklady.filter.zdroj')}</span>
          <select
            className="input"
            value={sourceFilter}
            onChange={(event) => setSourceFilter(event.target.value as SourceFilter)}
          >
            <option value="">{t('doklady.filter.vsetko')}</option>
            <option value="email">{t('doklady.zdroj.email')}</option>
            <option value="manual">{t('doklady.zdroj.manual')}</option>
            <option value="upload">{t('doklady.zdroj.upload')}</option>
          </select>
        </label>
        <label className="text-xs text-ink-soft">
          <span className="label">{t('doklady.filter.spracovanie')}</span>
          <select
            className="input"
            value={processingFilter}
            onChange={(event) => setProcessingFilter(event.target.value as ProcessingFilter)}
          >
            <option value="">{t('doklady.filter.vsetko')}</option>
            <option value="caka">{t('doklady.spracovanie.caka')}</option>
            <option value="spracuva">{t('doklady.spracovanie.spracuva')}</option>
            <option value="hotovo">{t('doklady.spracovanie.hotovo')}</option>
            <option value="chyba">{t('doklady.spracovanie.chyba')}</option>
          </select>
        </label>
        <label className="flex items-center gap-2 text-sm text-ink md:col-span-1 xl:col-span-2">
          <input
            type="checkbox"
            checked={actionRequiredOnly}
            onChange={(event) => setActionRequiredOnly(event.target.checked)}
          />
          {t('doklady.filter.vyzadujeZasah')}
        </label>
        <label className="flex items-center gap-2 text-sm text-ink md:col-span-1 xl:col-span-2">
          <input
            type="checkbox"
            checked={emailOnly}
            onChange={(event) => setEmailOnly(event.target.checked)}
          />
          {t('doklady.filter.prijateNaEmail')}
        </label>
      </div>

      {selected.size > 0 && (
        <div className="mb-3 flex flex-wrap items-center gap-2 rounded border border-accent/30 bg-accent/5 px-3 py-2 text-sm">
          <strong className="tnum mr-auto">
            {selected.size} {t('doklady.bulk.vybranych')}
          </strong>
          <button
            type="button"
            className="btn btn-primary"
            disabled={bulkBusy}
            onClick={() => void runBulkApprove()}
          >
            {t('doklady.bulk.schvalit')}
          </button>
          <button
            type="button"
            className="btn btn-danger"
            disabled={bulkBusy}
            onClick={() => setBulkRejectOpen(true)}
          >
            {t('doklady.bulk.zamietnut')}
          </button>
          <button
            type="button"
            className="btn"
            disabled={bulkBusy}
            onClick={() => setPaymentModalOpen(true)}
          >
            {t('doklady.bulk.platbaQr')}
          </button>
          <select
            className="input w-auto"
            value=""
            disabled={bulkBusy}
            aria-label={t('doklady.bulk.presunut')}
            onChange={(event) => {
              const target = event.target.value;
              event.target.value = '';
              if (target === 'na_kontrole') {
                void runBulk(moveDocumentToReview, t('toast.ulozene'));
              } else if (target === 'karantena') {
                void runBulk(quarantineDocument, t('toast.karantena'));
              }
            }}
          >
            <option value="">{t('doklady.bulk.presunut')}</option>
            <option value="na_kontrole">{t('status.na_kontrole')}</option>
            <option value="karantena">{t('status.karantena')}</option>
          </select>
        </div>
      )}

      {sortedDocuments.length === 0 ? (
        <EmptyState>
          <p>{t('doklady.prazdne')}</p>
          {emptyAlias && <code className="tnum mt-1 text-xs text-ink">{emptyAlias}</code>}
        </EmptyState>
      ) : (
        <div className="card overflow-x-auto">
          <table className="w-full min-w-[1180px] text-sm">
            <thead>
              <tr className="border-b border-line text-left text-xs text-ink-soft">
                <th className="w-10 px-3 py-2">
                  <input
                    type="checkbox"
                    checked={allVisibleSelected}
                    aria-label={t('doklady.bulk.vybranych')}
                    onChange={() => {
                      if (allVisibleSelected) setSelected(new Set());
                      else setSelected(new Set(sortedDocuments.map((document) => document.id)));
                    }}
                  />
                </th>
                {showOrganization && (
                  <SortHeader
                    label={t('doklady.st.organizacia')}
                    sortKey="organization"
                    activeKey={sortKey}
                    direction={sortDirection}
                    onSort={changeSort}
                  />
                )}
                <SortHeader label={t('doklady.st.typ')} sortKey="type" activeKey={sortKey} direction={sortDirection} onSort={changeSort} />
                <SortHeader label={t('doklady.st.dodavatel')} sortKey="supplier" activeKey={sortKey} direction={sortDirection} onSort={changeSort} />
                <SortHeader label={t('doklady.st.cislo')} sortKey="invoice" activeKey={sortKey} direction={sortDirection} onSort={changeSort} />
                <SortHeader label={t('doklady.st.datumDodania')} sortKey="delivery" activeKey={sortKey} direction={sortDirection} onSort={changeSort} />
                <SortHeader label={t('doklady.st.splatnost')} sortKey="due" activeKey={sortKey} direction={sortDirection} onSort={changeSort} />
                <SortHeader label={t('doklady.st.suma')} sortKey="amount" activeKey={sortKey} direction={sortDirection} onSort={changeSort} className="text-right" />
                <SortHeader label={t('doklady.st.stav')} sortKey="status" activeKey={sortKey} direction={sortDirection} onSort={changeSort} />
                <th className="px-3 py-2 font-medium">{t('platba.titulok')}</th>
                <SortHeader label={t('processing.label')} sortKey="processing" activeKey={sortKey} direction={sortDirection} onSort={changeSort} />
                <SortHeader label={t('doklady.st.ai')} sortKey="confidence" activeKey={sortKey} direction={sortDirection} onSort={changeSort} className="text-center" />
              </tr>
            </thead>
            <tbody>
              {sortedDocuments.map((document) => {
                const organization = organizationMap.get(document.orgId);
                const overdue =
                  !!document.extracted.datumSplatnosti &&
                  document.extracted.datumSplatnosti < today;
                return (
                  <tr
                    key={document.id}
                    role="link"
                    tabIndex={0}
                    className="cursor-pointer border-b border-line last:border-0 hover:bg-app focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-accent"
                    onClick={() => navigate(detailHref(document.id))}
                    onKeyDown={(event) => {
                      if (
                        event.currentTarget === event.target &&
                        (event.key === 'Enter' || event.key === ' ')
                      ) {
                        event.preventDefault();
                        navigate(detailHref(document.id));
                      }
                    }}
                  >
                    <td className="px-3 py-2.5">
                      <input
                        type="checkbox"
                        checked={selected.has(document.id)}
                        aria-label={`${t('doklady.bulk.vybranych')}: ${document.extracted.cisloFaktury}`}
                        onClick={(event) => event.stopPropagation()}
                        onChange={(event) => {
                          const checked = event.target.checked;
                          setSelected((current) => {
                            const next = new Set(current);
                            if (checked) next.add(document.id);
                            else next.delete(document.id);
                            return next;
                          });
                        }}
                      />
                    </td>
                    {showOrganization && (
                      <td className="px-3 py-2.5">{organization && <OrgChip org={organization} />}</td>
                    )}
                    <td className="px-3 py-2.5"><TypBadge typ={document.typ} /></td>
                    <td className="max-w-56 px-3 py-2.5">
                      <span className="block truncate font-medium">{document.extracted.dodavatel.nazov}</span>
                      <span className="tnum block text-xs text-ink-soft">{document.extracted.dodavatel.ico ?? '—'}</span>
                    </td>
                    <td className="px-3 py-2.5">
                      <span className="tnum block font-medium">{document.extracted.cisloFaktury}</span>
                      <span className="tnum block text-xs text-ink-soft">{document.extracted.variabilnySymbol ?? '—'}</span>
                    </td>
                    <td className="tnum whitespace-nowrap px-3 py-2.5">{formatDate(document.extracted.datumDodania)}</td>
                    <td className={`tnum whitespace-nowrap px-3 py-2.5 ${overdue ? 'font-medium text-red-700' : ''}`} title={overdue ? t('doklady.poSplatnosti') : undefined}>
                      {formatDate(document.extracted.datumSplatnosti)}
                    </td>
                    <td className="tnum whitespace-nowrap px-3 py-2.5 text-right font-medium">{formatMoney(document.extracted.sumaSpolu, document.extracted.mena)}</td>
                    <td className="px-3 py-2.5"><StatusBadge status={document.status} /></td>
                    <td className="px-3 py-2.5">
                      {activeTab === 'kos' ? (
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
                      ) : document.typ === 'BV' ? (
                        <span className="text-ink-soft">—</span>
                      ) : (() => {
                        const state = paymentStateFor(document, paymentsByDocument.get(document.id) ?? []);
                        const styles: Record<string, string> = {
                          uhradena: 'bg-accent/10 text-accent-hover border-accent/30',
                          ciastocna: 'bg-amber-50 text-amber-800 border-amber-300',
                          neuhradena: 'bg-app text-ink-soft border-line',
                          po_splatnosti: 'bg-red-50 text-red-700 border-red-200',
                        };
                        return (
                          <span className={`inline-flex whitespace-nowrap rounded-full border px-2 py-0.5 text-[11px] font-semibold ${styles[state.status]}`}>
                            {t(`platby.stav.${state.status}`)}
                          </span>
                        );
                      })()}
                    </td>
                    <td className="px-3 py-2.5">
                      <ProcessingBadge
                        status={document.processingStatus}
                        label={manualProcessingLabel(document)}
                      />
                    </td>
                    <td className="px-3 py-2.5 text-center">
                      {manualProcessingLabel(document) ? (
                        <span className="text-ink-soft">—</span>
                      ) : (
                        <ConfidenceIndicator value={document.confidence} showPercent />
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

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

      {paymentModalOpen && selectedIds.length > 0 && (
        <Suspense fallback={<p className="text-sm text-ink-soft">{t('stav.nacitavam')}</p>}>
          <PaymentQrModal
            documents={selectedIds
              .map((id) => data.documents.find((document) => document.id === id))
              .filter((document): document is DocumentItem => Boolean(document))}
            organizations={data.organizations}
            bankAccounts={data.bankAccounts}
            onClose={() => setPaymentModalOpen(false)}
          />
        </Suspense>
      )}

      {bulkRejectOpen && (
        <Modal
          title={t('zamietnutie.hromadneTitulok')}
          onClose={() => {
            if (bulkBusy) return;
            setBulkRejectOpen(false);
            setBulkRejectReason('');
          }}
        >
          <p className="mb-3 text-sm text-ink-soft">
            {t('zamietnutie.hromadnePopis')} ({selectedIds.length})
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
          <p className="mt-1 text-right text-xs text-ink-soft">
            {bulkRejectReason.length} / 1000
          </p>
          <div className="mt-4 flex justify-end gap-2">
            <button
              type="button"
              className="btn"
              disabled={bulkBusy}
              onClick={() => {
                setBulkRejectOpen(false);
                setBulkRejectReason('');
              }}
            >
              {t('akcia.zrusit')}
            </button>
            <button
              type="button"
              className="btn btn-danger"
              disabled={bulkBusy || !bulkRejectReason.trim()}
              onClick={() => void runBulkReject()}
            >
              {t('doklady.bulk.zamietnut')}
            </button>
          </div>
        </Modal>
      )}
    </div>
  );
}

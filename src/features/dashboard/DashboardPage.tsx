// DashboardPage — редизайн: KPI-карточки с иконками, лента событий, график.
// Логика и данные (useDataQuery, buildThirtyDaySeries, роуты) без изменений.
import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { motion } from 'framer-motion';
import { useDataQuery } from '../../data/query';
import type { DocumentItem, DocumentPayment, DocumentStatus } from '../../data/types';
import { t } from '../../i18n/sk';
import { formatDate, formatDateTime, formatMoney } from '../../lib/format';

const PROBLEM_STATUSES = new Set<DocumentStatus>(['chyba', 'karantena', 'duplicita']);

function buildThirtyDaySeries(documents: DocumentItem[]) {
  const counts = new Map<string, number>();
  for (const document of documents) {
    const key = document.prijateDna.slice(0, 10);
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }

  const today = new Date();
  today.setHours(12, 0, 0, 0);
  return Array.from({ length: 30 }, (_, index) => {
    const day = new Date(today);
    day.setDate(today.getDate() - (29 - index));
    const key = day.toISOString().slice(0, 10);
    return { key, count: counts.get(key) ?? 0 };
  });
}

const stroke = { fill: 'none', strokeWidth: 2, strokeLinecap: 'round', strokeLinejoin: 'round' } as const;

// ===== Financie: výnosy / náklady + očakávané, prepínač s/bez DPH =====

const FINANCNE_STATUSY = new Set<DocumentStatus>(['extrahovany', 'na_kontrole', 'schvaleny', 'exportovany']);

type FinObdobie = 'mesiac' | 'stvrtrok' | 'rok';

function zaciatokObdobia(obdobie: FinObdobie): string {
  const now = new Date();
  if (obdobie === 'mesiac') return new Date(now.getFullYear(), now.getMonth(), 1).toISOString().slice(0, 10);
  if (obdobie === 'stvrtrok') {
    return new Date(now.getFullYear(), Math.floor(now.getMonth() / 3) * 3, 1).toISOString().slice(0, 10);
  }
  return new Date(now.getFullYear(), 0, 1).toISOString().slice(0, 10);
}

function sumaDokladu(document: DocumentItem, sDph: boolean): number {
  const spolu = document.extracted.sumaSpolu ?? 0;
  if (sDph) return spolu;
  const dph = (document.extracted.rozpisDph ?? []).reduce((sum, row) => sum + (row.dph ?? 0), 0);
  return spolu - dph;
}

function FinanciePrehlad({ documents, payments }: { documents: DocumentItem[]; payments: DocumentPayment[] }) {
  const [obdobie, setObdobie] = useState<FinObdobie>('mesiac');
  const [sDph, setSDph] = useState(true);

  const prehlad = useMemo(() => {
    const od = zaciatokObdobia(obdobie);
    const paidByDocument = new Map<string, number>();
    for (const payment of payments) {
      paidByDocument.set(payment.documentId, (paidByDocument.get(payment.documentId) ?? 0) + payment.amount);
    }
    let naklady = 0;
    let vynosy = 0;
    let ocakavaneNaklady = 0;
    let ocakavaneVynosy = 0;
    for (const document of documents) {
      if (!FINANCNE_STATUSY.has(document.status)) continue;
      if (document.typ === 'BV' || document.typ === 'MZDY' || document.typ === 'OZ') continue;
      const datum = (document.extracted.datumDodania ?? document.extracted.datumVystavenia ?? '').slice(0, 10);
      if (!datum || datum < od) continue;
      const suma = sumaDokladu(document, sDph);
      const zostatokSDph = (document.extracted.sumaSpolu ?? 0) - (paidByDocument.get(document.id) ?? 0);
      const pomer = (document.extracted.sumaSpolu ?? 0) > 0 ? suma / (document.extracted.sumaSpolu ?? 1) : 1;
      const zostatok = Math.max(0, zostatokSDph) * pomer;
      if (document.typ === 'FV') {
        vynosy += suma;
        ocakavaneVynosy += zostatok;
      } else {
        naklady += suma;
        ocakavaneNaklady += zostatok;
      }
    }
    return { naklady, vynosy, ocakavaneNaklady, ocakavaneVynosy };
  }, [documents, payments, obdobie, sDph]);

  const bunky = [
    { label: t('dash.fin.vynosy'), value: prehlad.vynosy, tone: 'text-emerald-700' },
    { label: t('dash.fin.naklady'), value: prehlad.naklady, tone: 'text-ink' },
    { label: t('dash.fin.ocakavaneVynosy'), value: prehlad.ocakavaneVynosy, tone: 'text-emerald-700/80' },
    { label: t('dash.fin.ocakavaneNaklady'), value: prehlad.ocakavaneNaklady, tone: 'text-amber-700' },
  ];

  return (
    <section className="card mb-4 p-5">
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-[15px] font-semibold">{t('dash.fin.titulok')}</h2>
        <div className="flex items-center gap-2">
          <div className="flex rounded-lg border border-line p-0.5" role="tablist">
            {(['mesiac', 'stvrtrok', 'rok'] as const).map((value) => (
              <button
                key={value}
                type="button"
                role="tab"
                aria-selected={obdobie === value}
                className={`rounded-md px-2.5 py-1 text-xs font-medium ${
                  obdobie === value ? 'bg-accent text-white' : 'text-ink-soft hover:text-ink'
                }`}
                onClick={() => setObdobie(value)}
              >
                {t(`dash.fin.obdobie.${value}`)}
              </button>
            ))}
          </div>
          <label className="flex items-center gap-1.5 text-xs text-ink-soft">
            <input type="checkbox" checked={sDph} onChange={(event) => setSDph(event.target.checked)} />
            {t('dash.fin.sDph')}
          </label>
        </div>
      </div>
      <div className="grid grid-cols-2 gap-3 xl:grid-cols-4">
        {bunky.map((bunka) => (
          <div key={bunka.label} className="rounded-xl bg-app p-3">
            <span className="block text-xs font-medium text-ink-soft">{bunka.label}</span>
            <strong className={`tnum mt-1 block text-xl font-bold tracking-tight ${bunka.tone}`}>
              {formatMoney(bunka.value)}
            </strong>
          </div>
        ))}
      </div>
      <p className="mt-2 text-xs text-ink-soft">{t('dash.fin.popis')}</p>
    </section>
  );
}

const KPI_ICONS = {
  nove: (
    <svg width="18" height="18" viewBox="0 0 24 24" {...stroke} stroke="#0E7A5F" aria-hidden>
      <polyline points="22 12 16 12 14 15 10 15 8 12 2 12" />
      <path d="M5.45 5.11 2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.45-6.89A2 2 0 0 0 16.76 4H7.24a2 2 0 0 0-1.79 1.11z" />
    </svg>
  ),
  naKontrolu: (
    <svg width="18" height="18" viewBox="0 0 24 24" {...stroke} stroke="#D97706" aria-hidden>
      <circle cx="12" cy="12" r="10" /><polyline points="12 6 12 12 16 14" />
    </svg>
  ),
  schvalene: (
    <svg width="18" height="18" viewBox="0 0 24 24" {...stroke} stroke="#047857" aria-hidden>
      <circle cx="12" cy="12" r="10" /><path d="m9 12 2 2 4-4" />
    </svg>
  ),
  problemy: (
    <svg width="18" height="18" viewBox="0 0 24 24" {...stroke} stroke="#DC2626" aria-hidden>
      <path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 20h16a2 2 0 0 0 1.73-2Z" />
      <path d="M12 9v4" /><path d="M12 17h.01" />
    </svg>
  ),
};

export function DashboardPage() {
  const { data, loading, error } = useDataQuery();

  if (loading) {
    return <p className="text-sm text-ink-soft">{t('stav.nacitavam')}</p>;
  }
  if (error || !data) {
    return <p className="text-sm text-red-700">{t('chyba.vseobecna')}</p>;
  }

  const documents = data.documents.filter(
    (document) => data.currentOrgId === 'all' || document.orgId === data.currentOrgId,
  );
  const counters = [
    {
      label: t('dash.nove'),
      count: documents.filter((document) => document.status === 'novy').length,
      to: '/doklady?status=novy',
      icon: KPI_ICONS.nove,
      tint: '#E6F4EF',
      number: 'text-ink',
    },
    {
      label: t('dash.naKontrolu'),
      count: documents.filter(
        (document) => document.status === 'extrahovany' || document.status === 'na_kontrole',
      ).length,
      to: '/doklady?tab=na_kontrole',
      icon: KPI_ICONS.naKontrolu,
      tint: '#FFFBEB',
      number: 'text-ink',
    },
    {
      label: t('dash.schvalene'),
      count: documents.filter((document) => document.status === 'schvaleny').length,
      to: '/doklady?tab=schvalene',
      icon: KPI_ICONS.schvalene,
      tint: '#ECFDF5',
      number: 'text-ink',
    },
    {
      label: t('dash.problemy'),
      count: documents.filter((document) => PROBLEM_STATUSES.has(document.status)).length,
      to: '/doklady?tab=problemy',
      icon: KPI_ICONS.problemy,
      tint: '#FEF2F2',
      number: 'text-red-600',
    },
  ];

  const recentEvents = documents
    .flatMap((document) =>
      document.history.map((event, index) => ({
        ...event,
        document,
        key: `${document.id}-${index}-${event.ts}`,
      })),
    )
    .sort((left, right) => Date.parse(right.ts) - Date.parse(left.ts))
    .slice(0, 10);
  const series = buildThirtyDaySeries(documents);
  const maxCount = Math.max(1, ...series.map((day) => day.count));

  // Avízo: neuhradené doklady so splatnosťou do 7 dní alebo po splatnosti.
  const paidByDocument = new Map<string, number>();
  for (const payment of data.payments ?? []) {
    paidByDocument.set(payment.documentId, (paidByDocument.get(payment.documentId) ?? 0) + payment.amount);
  }
  const today = new Date().toISOString().slice(0, 10);
  const dueSoon = data.documents.filter((document) => {
    if (document.typ === 'BV' || !['extrahovany', 'na_kontrole', 'schvaleny', 'exportovany'].includes(document.status)) return false;
    const due = document.extracted.datumSplatnosti;
    if (!due) return false;
    const remaining = (document.extracted.sumaSpolu ?? 0) - (paidByDocument.get(document.id) ?? 0);
    if (remaining <= 0.005) return false;
    const days = Math.round((Date.parse(due) - Date.parse(today)) / 86_400_000);
    return days <= 7;
  });

  return (
    <div className="mx-auto max-w-[1240px]">
      <h1 className="mb-5 text-[22px] font-bold tracking-tight">{t('dash.titulok')}</h1>

      {dueSoon.length > 0 && (
        <motion.div
          initial={{ opacity: 0, y: -8 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.3 }}
          className="mb-4 rounded-2xl border border-amber-300 bg-gradient-to-b from-amber-50 to-[#FEF7DC] px-4 py-3"
        >
          <p className="text-sm font-semibold text-amber-900">⚠ {t('platby.avizo')} ({dueSoon.length})</p>
          <ul className="mt-1.5 space-y-0.5">
            {dueSoon.slice(0, 5).map((document) => {
              const days = Math.round((Date.parse(document.extracted.datumSplatnosti!) - Date.parse(today)) / 86_400_000);
              return (
                <li key={document.id} className="text-sm text-amber-900/90">
                  <Link className="underline-offset-2 hover:underline" to={`/doklady/${document.id}`}>
                    {document.extracted.dodavatel.nazov || document.extracted.cisloFaktury || document.id.slice(0, 8)}
                  </Link>
                  {' · '}
                  <span className="tnum">{(document.extracted.sumaSpolu ?? 0).toLocaleString('sk-SK', { minimumFractionDigits: 2 })} {document.extracted.mena ?? 'EUR'}</span>
                  {' · '}
                  <span className={`tnum font-medium ${days < 0 ? 'text-red-700' : ''}`}>
                    {days < 0 ? `${-days} ${t('platby.dniPo')}` : `${t('platby.o')} ${days} ${t('platby.dni')}`}
                  </span>
                </li>
              );
            })}
          </ul>
        </motion.div>
      )}

      <FinanciePrehlad documents={documents} payments={data.payments ?? []} />

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-4">
        {counters.map((counter) => (
          <Link
            key={counter.label}
            to={counter.to}
            className="card p-5 transition hover:-translate-y-0.5 hover:shadow-card-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
          >
            <span
              className="grid h-10 w-10 place-items-center rounded-xl"
              style={{ backgroundColor: counter.tint }}
              aria-hidden
            >
              {counter.icon}
            </span>
            <span className="mt-3 block text-sm font-medium text-ink-soft">{counter.label}</span>
            <strong className={`tnum mt-0.5 block text-3xl font-extrabold tracking-tight ${counter.number}`}>
              {counter.count}
            </strong>
          </Link>
        ))}
      </div>

      <div className="mt-5 grid grid-cols-1 gap-4 xl:grid-cols-[minmax(0,1.15fr)_minmax(0,1fr)]">
        <section className="card p-5">
          <h2 className="mb-3 text-[15px] font-semibold">{t('dash.posledneUdalosti')}</h2>
          {recentEvents.length === 0 ? (
            <p className="py-6 text-center text-sm text-ink-soft">{t('dash.ziadneUdalosti')}</p>
          ) : (
            <ol className="divide-y divide-line/60">
              {recentEvents.map((event) => (
                <li key={event.key}>
                  <Link
                    to={`/doklady/${event.document.id}`}
                    className="flex gap-3 rounded-lg px-2 py-2.5 transition hover:bg-app focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
                  >
                    <span
                      className="mt-1.5 h-2 w-2 shrink-0 rounded-full"
                      style={{
                        backgroundColor:
                          data.organizations.find((organization) => organization.id === event.document.orgId)
                            ?.farba ?? '#64748B',
                      }}
                      aria-hidden
                    />
                    <span className="min-w-0 flex-1">
                      <span className="block text-sm font-medium text-ink">{event.akcia}</span>
                      <span className="mt-0.5 block truncate text-xs text-ink-soft">
                        {event.document.extracted.dodavatel.nazov} ·{' '}
                        {event.document.extracted.cisloFaktury} · {event.user}
                      </span>
                    </span>
                    <time className="tnum shrink-0 text-xs text-ink-soft/80" dateTime={event.ts}>
                      {formatDateTime(event.ts)}
                    </time>
                  </Link>
                </li>
              ))}
            </ol>
          )}
        </section>

        <section className="card p-5">
          <h2 className="mb-4 text-[15px] font-semibold">{t('dash.grafTitulok')}</h2>
          <div
            className="flex h-52 items-end gap-[3px] border-b border-line px-1 pt-4"
            role="img"
            aria-label={t('dash.grafTitulok')}
          >
            {series.map((day, index) => (
              <div key={day.key} className="flex h-full min-w-0 flex-1 flex-col justify-end">
                <div
                  className={`w-full rounded-t ${
                    day.count > 0 ? 'bg-accent transition-colors hover:bg-accent-hover' : 'bg-line'
                  }`}
                  style={{ height: `${day.count > 0 ? Math.max(7, (day.count / maxCount) * 100) : 2}%` }}
                  title={`${formatDate(day.key)}: ${day.count}`}
                />
                <span className="tnum mt-1 h-4 text-center text-[9px] text-ink-soft/70" aria-hidden>
                  {index % 5 === 0 || index === series.length - 1 ? day.key.slice(8, 10) : ''}
                </span>
              </div>
            ))}
          </div>
        </section>
      </div>
    </div>
  );
}

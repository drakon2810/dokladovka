import { Link } from 'react-router-dom';
import { useDataQuery } from '../../data/query';
import type { DocumentItem, DocumentStatus } from '../../data/types';
import { t } from '../../i18n/sk';
import { formatDate, formatDateTime } from '../../lib/format';

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
      accent: 'border-l-slate-500',
    },
    {
      label: t('dash.naKontrolu'),
      count: documents.filter(
        (document) => document.status === 'extrahovany' || document.status === 'na_kontrole',
      ).length,
      to: '/doklady?tab=na_kontrole',
      accent: 'border-l-amber-600',
    },
    {
      label: t('dash.schvalene'),
      count: documents.filter((document) => document.status === 'schvaleny').length,
      to: '/doklady?tab=schvalene',
      accent: 'border-l-green-700',
    },
    {
      label: t('dash.problemy'),
      count: documents.filter((document) => PROBLEM_STATUSES.has(document.status)).length,
      to: '/doklady?tab=problemy',
      accent: 'border-l-red-700',
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

  return (
    <div>
      <h1 className="mb-4 text-xl font-semibold">{t('dash.titulok')}</h1>

      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-4">
        {counters.map((counter) => (
          <Link
            key={counter.label}
            to={counter.to}
            className={`card border-l-[3px] ${counter.accent} p-4 transition-colors hover:bg-app focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent`}
          >
            <span className="text-sm text-ink-soft">{counter.label}</span>
            <strong className="tnum mt-1 block text-2xl font-semibold text-ink">
              {counter.count}
            </strong>
          </Link>
        ))}
      </div>

      <div className="mt-5 grid grid-cols-1 gap-4 xl:grid-cols-[minmax(0,1.15fr)_minmax(0,1fr)]">
        <section className="card p-4">
          <h2 className="mb-3 text-sm font-semibold">{t('dash.posledneUdalosti')}</h2>
          {recentEvents.length === 0 ? (
            <p className="py-6 text-center text-sm text-ink-soft">{t('dash.ziadneUdalosti')}</p>
          ) : (
            <ol className="divide-y divide-line">
              {recentEvents.map((event) => (
                <li key={event.key}>
                  <Link
                    to={`/doklady/${event.document.id}`}
                    className="flex gap-3 rounded px-1 py-2.5 hover:bg-app focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
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
                    <time className="tnum shrink-0 text-xs text-ink-soft" dateTime={event.ts}>
                      {formatDateTime(event.ts)}
                    </time>
                  </Link>
                </li>
              ))}
            </ol>
          )}
        </section>

        <section className="card p-4">
          <h2 className="mb-3 text-sm font-semibold">{t('dash.grafTitulok')}</h2>
          <div
            className="flex h-52 items-end gap-1 border-b border-line px-1 pt-4"
            role="img"
            aria-label={t('dash.grafTitulok')}
          >
            {series.map((day, index) => (
              <div key={day.key} className="flex h-full min-w-0 flex-1 flex-col justify-end">
                <div
                  className={`w-full rounded-t ${day.count > 0 ? 'bg-accent' : 'bg-line'}`}
                  style={{ height: `${day.count > 0 ? Math.max(7, (day.count / maxCount) * 100) : 2}%` }}
                  title={`${formatDate(day.key)}: ${day.count}`}
                />
                <span className="tnum mt-1 h-4 text-center text-[9px] text-ink-soft" aria-hidden>
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

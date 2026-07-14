import { useCallback, useEffect, useMemo, useState } from 'react';
import { useAuth } from '../../auth/AuthContext';
import { showToast } from '../../components/toast';
import { EmptyState } from '../../components/ui';
import {
  MOSTIK_DATA_MODE,
  disconnectMostikInstallation,
  getMostikOverview,
  retryMostikExportJob,
  setMostikEnabled,
  simulateMostikAgentResult,
  simulateMostikCodeListSync,
  updateMostikOrganizationLink,
  type MostikOverview,
} from '../../data/mostik/mostikService';
import { useDataQuery } from '../../data/query';
import type { ExportJob, PohodaCompanyLink } from '../../data/types';
import { t } from '../../i18n/sk';
import { formatDateTime } from '../../lib/format';
import { MostikOnboarding } from './MostikOnboarding';

function connected(lastSeenAt?: string): boolean {
  return Boolean(lastSeenAt && Date.now() - Date.parse(lastSeenAt) < 5 * 60 * 1000);
}

function transferLabel(job: ExportJob): string {
  if (job.status === 'pending' || job.status === 'sent') return t('mostik.cakaNaAgenta');
  const summary = job.responseMeta?.summary;
  if (job.status === 'confirmed') return t('mostik.uspech');
  return summary?.ok ? t('mostik.ciastocne') : t('mostik.chyba');
}

function LinkYearEditor({
  link,
  disabled,
  csrfToken,
  onSaved,
}: {
  link: PohodaCompanyLink;
  disabled: boolean;
  csrfToken?: string;
  onSaved: () => Promise<void>;
}) {
  const [year, setYear] = useState(link.uctovnyRok ?? '');
  const [preferred, setPreferred] = useState(link.preferredYear);
  return (
    <div className="flex min-w-[16rem] items-center gap-2">
      <select
        className="input min-w-[10rem]"
        value={preferred === 'latest' ? 'latest' : 'manual'}
        disabled={disabled || !link.dbName}
        onChange={(event) => setPreferred(event.target.value === 'latest' ? 'latest' : year)}
      >
        <option value="latest">{t('mostik.najnovsiRok')}</option>
        <option value="manual">{t('mostik.rok')}</option>
      </select>
      {preferred !== 'latest' && (
        <input className="input w-24" value={year} onChange={(event) => setYear(event.target.value)} disabled={disabled} />
      )}
      <button
        type="button"
        className="btn whitespace-nowrap"
        disabled={disabled || !link.dbName || !year}
        onClick={() => {
          void updateMostikOrganizationLink(
            link.organizationId,
            { dbName: link.dbName!, uctovnyRok: year, preferredYear: preferred === 'latest' ? 'latest' : year },
            csrfToken,
          ).then(onSaved);
        }}
      >
        {t('mostik.ulozitRok')}
      </button>
    </div>
  );
}

export function MostikTab() {
  const { data } = useDataQuery();
  const { session } = useAuth();
  const [overview, setOverview] = useState<MostikOverview>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(false);
  const [expandedJobId, setExpandedJobId] = useState<string>();
  const csrfToken = session?.csrfToken;

  const load = useCallback(async () => {
    try {
      setOverview(await getMostikOverview());
      setError(false);
    } catch {
      setError(true);
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  const organizationMap = useMemo(
    () => new Map((data?.organizations ?? []).map((organization) => [organization.id, organization])),
    [data?.organizations],
  );

  async function run(action: () => Promise<void>, toast?: string) {
    setBusy(true);
    try {
      await action();
      await load();
      if (toast) showToast(toast);
    } catch {
      showToast(t('chyba.vseobecna'), { tone: 'error' });
    } finally {
      setBusy(false);
    }
  }

  if (error) return <p className="text-sm text-red-700">{t('mostik.nacitanieChyba')}</p>;
  if (!overview || !data) return <p className="text-sm text-ink-soft">{t('stav.nacitavam')}</p>;

  return (
    <div className="space-y-4">
      <section className="card p-4">
        <label className="flex items-start gap-3">
          <input
            type="checkbox"
            className="mt-1"
            checked={overview.enabled}
            disabled={busy}
            onChange={(event) => {
              const enabled = event.target.checked;
              void run(() => setMostikEnabled(enabled, csrfToken), t('mostik.nastavenieUlozene'));
            }}
          />
          <span>
            <strong className="block text-sm">{t('mostik.povolit')}</strong>
            <span className="text-sm text-ink-soft">{t('mostik.povolitPopis')}</span>
          </span>
        </label>
        {!overview.enabled && <p className="mt-3 rounded bg-app p-3 text-sm text-ink-soft">{t('mostik.vypnutyPopis')}</p>}
      </section>

      {overview.health && (
        <section className="card p-4">
          <h2 className="mb-3 text-sm font-semibold">{t('mostik.zdravie')}</h2>
          <div className="grid gap-3 sm:grid-cols-4">
            <div><p className="text-xs text-ink-soft">{t('mostik.agentiOffline')}</p><p className="tnum text-lg font-semibold">{overview.health.installations.filter((item) => !item.online).length}</p></div>
            <div><p className="text-xs text-ink-soft">{t('mostik.syncChyby')}</p><p className="tnum text-lg font-semibold">{overview.health.latestSyncs.filter((item) => item.state === 'error').length}</p></div>
            <div><p className="text-xs text-ink-soft">{t('mostik.exportChyby24h')}</p><p className="tnum text-lg font-semibold">{overview.health.exports24h.failed} / {overview.health.exports24h.total}</p></div>
            <div><p className="text-xs text-ink-soft">{t('mostik.alerty7d')}</p><p className="tnum text-lg font-semibold">{overview.health.alerts.length}</p></div>
          </div>
        </section>
      )}

      <fieldset disabled={!overview.enabled || busy} className="space-y-4 disabled:opacity-60">
        <MostikOnboarding
          overview={overview}
          organizations={data.organizations.filter((item) => !item.archived)}
          csrfToken={csrfToken}
          onReload={load}
        />

        <section className="card p-4">
          <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
            <h2 className="text-sm font-semibold">{t('mostik.instalacie')}</h2>
          </div>
          {overview.installations.length === 0 ? (
            <p className="text-sm text-ink-soft">{t('mostik.ziadneInstalacie')}</p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead><tr className="border-b border-line text-left text-xs text-ink-soft">
                  <th className="px-2 py-2">{t('mostik.hostname')}</th><th className="px-2 py-2">{t('mostik.verzia')}</th>
                  <th className="px-2 py-2">{t('mostik.posledneSpojenie')}</th><th className="px-2 py-2">{t('mostik.stav')}</th><th />
                </tr></thead>
                <tbody>{overview.installations.map((installation) => {
                  const online = installation.status === 'connected' && connected(installation.lastSeenAt);
                  return <tr key={installation.id} className="border-b border-line last:border-0">
                    <td className="px-2 py-2 font-medium">{installation.hostname}</td>
                    <td className="tnum px-2 py-2">{installation.agentVersion}</td>
                    <td className="tnum px-2 py-2">{installation.lastSeenAt ? formatDateTime(installation.lastSeenAt) : '—'}</td>
                    <td className="px-2 py-2"><span className={online ? 'text-green-700' : 'text-red-700'}>{online ? t('mostik.pripojene') : t('mostik.nepripojene')}</span></td>
                    <td className="px-2 py-2 text-right"><button type="button" className="btn" disabled={installation.status === 'revoked'} onClick={() => void run(() => disconnectMostikInstallation(installation.id, csrfToken))}>{t('mostik.odpojit')}</button></td>
                  </tr>;
                })}</tbody>
              </table>
            </div>
          )}
        </section>

        <section className="card overflow-x-auto">
          <div className="flex items-center justify-between gap-2 p-4">
            <h2 className="text-sm font-semibold">{t('mostik.organizacie')}</h2>
            {MOSTIK_DATA_MODE === 'mock' && <button type="button" className="btn" onClick={() => void run(() => simulateMostikCodeListSync(), t('mostik.ciselnikySynchronizovane'))}>{t('mostik.simulovatCiselniky')}</button>}
          </div>
          <table className="w-full min-w-[900px] text-sm">
            <thead><tr className="border-y border-line text-left text-xs text-ink-soft">
              <th className="px-3 py-2">{t('mostik.organizacia')}</th><th className="px-3 py-2">{t('nast.org.ico')}</th><th className="px-3 py-2">{t('mostik.uctovnaJednotka')}</th>
              <th className="px-3 py-2">{t('mostik.rok')}</th><th className="px-3 py-2">{t('mostik.stav')}</th><th className="px-3 py-2">{t('mostik.pravidloRoka')}</th>
            </tr></thead>
            <tbody>{overview.links.map((link) => {
              const organization = organizationMap.get(link.organizationId);
              return <tr key={link.organizationId} className="border-b border-line last:border-0">
                <td className="px-3 py-2 font-medium">{organization?.nazov ?? '—'}</td><td className="tnum px-3 py-2">{link.ico}</td>
                <td className="px-3 py-2">{link.dbName ?? '—'}</td><td className="tnum px-3 py-2">{link.uctovnyRok ?? '—'}</td>
                <td className="px-3 py-2">{link.matchedAt ? t('mostik.sparovane') : t('mostik.caka')}</td>
                <td className="px-3 py-2"><LinkYearEditor link={link} disabled={busy} csrfToken={csrfToken} onSaved={load} /></td>
              </tr>;
            })}</tbody>
          </table>
        </section>

        <section className="card overflow-x-auto">
          <h2 className="p-4 text-sm font-semibold">{t('mostik.historia')}</h2>
          {overview.exportJobs.length === 0 ? <EmptyState>{t('mostik.ziadnaHistoria')}</EmptyState> : (
            <table className="w-full min-w-[850px] text-sm">
              <thead><tr className="border-y border-line text-left text-xs text-ink-soft">
                <th className="px-3 py-2">{t('export.hist.datum')}</th><th className="px-3 py-2">{t('mostik.pouzivatel')}</th>
                <th className="px-3 py-2">{t('mostik.organizacia')}</th><th className="px-3 py-2 text-right">{t('mostik.pocetDokladov')}</th><th className="px-3 py-2">{t('mostik.stav')}</th><th />
              </tr></thead>
              <tbody>{overview.exportJobs.map((job) => <FragmentJob key={job.id} job={job} organizationName={organizationMap.get(job.organizationId)?.nazov} expanded={expandedJobId === job.id} busy={busy} csrfToken={csrfToken} onToggle={() => setExpandedJobId((current) => current === job.id ? undefined : job.id)} onRun={run} />)}</tbody>
            </table>
          )}
        </section>
      </fieldset>
    </div>
  );
}

function FragmentJob({ job, organizationName, expanded, busy, csrfToken, onToggle, onRun }: {
  job: ExportJob; organizationName?: string; expanded: boolean; busy: boolean; csrfToken?: string;
  onToggle: () => void; onRun: (action: () => Promise<void>, toast?: string) => Promise<void>;
}) {
  return <>
    <tr className="border-b border-line">
      <td className="tnum px-3 py-2">{formatDateTime(job.createdAt)}</td><td className="px-3 py-2">{job.createdBy}</td>
      <td className="px-3 py-2">{organizationName ?? '—'}</td><td className="tnum px-3 py-2 text-right">{job.documentIds.length}</td>
      <td className="px-3 py-2">{transferLabel(job)}</td>
      <td className="space-x-1 px-3 py-2 text-right">
        <button type="button" className="btn" onClick={onToggle}>{t('mostik.detailPrenosu')}</button>
        {job.status === 'failed' && <button type="button" className="btn" disabled={busy} onClick={() => void onRun(async () => { await retryMostikExportJob(job.id, csrfToken); })}>{t('mostik.zopakovat')}</button>}
        {MOSTIK_DATA_MODE === 'mock' && ['pending', 'sent'].includes(job.status) && <>
          <button type="button" className="btn" disabled={busy} onClick={() => void onRun(async () => { await simulateMostikAgentResult(job.id, 'ok'); }, t('mostik.prenosPotvrdeny'))}>{t('mostik.simulovatUspech')}</button>
          <button type="button" className="btn" disabled={busy} onClick={() => void onRun(async () => { await simulateMostikAgentResult(job.id, 'error'); })}>{t('mostik.simulovatChybu')}</button>
        </>}
      </td>
    </tr>
    {expanded && <tr className="border-b border-line bg-app"><td colSpan={6} className="px-4 py-3">
      <div className="space-y-1 text-xs">{job.responseMeta?.perDocument?.map((result) => <p key={result.documentId}><span className="tnum font-medium">{result.documentId}</span> · {t(`mostik.vysledok.${result.state}` as 'mostik.vysledok.ok' | 'mostik.vysledok.warning' | 'mostik.vysledok.error')}{result.pohodaNumber ? ` · ${result.pohodaNumber}` : ''}{result.message ? ` · ${result.message}` : ''}</p>) ?? <p>{t('mostik.cakaNaAgenta')}</p>}</div>
    </td></tr>}
  </>;
}

import { useEffect, useMemo, useState } from 'react';
import { CopyButton } from '../../components/ui';
import { showToast } from '../../components/toast';
import {
  MOSTIK_DATA_MODE,
  generateMostikPairingCode,
  simulateMostikAgentConnection,
  type MostikOverview,
} from '../../data/mostik/mostikService';
import type { AgentPairingCode, Organization } from '../../data/types';
import { t } from '../../i18n/sk';
import { formatDateTime } from '../../lib/format';

const REQUIREMENTS = [
  'windows',
  'pohoda',
  'licencia',
  'prava',
  'internet',
  'admin',
] as const;

type Requirement = typeof REQUIREMENTS[number];

function formatBytes(value: number): string {
  const megabytes = value / (1024 * 1024);
  return `${new Intl.NumberFormat('sk-SK', { maximumFractionDigits: 1 }).format(megabytes)} MB`;
}

function secondsRemaining(expiresAt: string, now: number): number {
  return Math.max(0, Math.ceil((Date.parse(expiresAt) - now) / 1000));
}

function formatCountdown(seconds: number): string {
  const minutes = Math.floor(seconds / 60).toString().padStart(2, '0');
  const rest = (seconds % 60).toString().padStart(2, '0');
  return `${minutes}:${rest}`;
}

export function MostikOnboarding({
  overview,
  organizations,
  csrfToken,
  onReload,
}: {
  overview: MostikOverview;
  organizations: Organization[];
  csrfToken?: string;
  onReload: () => Promise<void>;
}) {
  const [step, setStep] = useState(1);
  const [selectedOrganizationId, setSelectedOrganizationId] = useState(organizations[0]?.id ?? '');
  const [requirements, setRequirements] = useState<Record<Requirement, boolean>>({
    windows: false,
    pohoda: false,
    licencia: false,
    prava: false,
    internet: false,
    admin: false,
  });
  const [pairing, setPairing] = useState<AgentPairingCode>();
  const [busy, setBusy] = useState(false);
  const [now, setNow] = useState(Date.now());

  const organization = organizations.find((item) => item.id === selectedOrganizationId);
  const link = overview.links.find((item) => item.organizationId === selectedOrganizationId);
  const onlineInstallation = overview.installations.find((item) =>
    item.status === 'connected' && Boolean(item.lastSeenAt && Date.now() - Date.parse(item.lastSeenAt) < 5 * 60 * 1000),
  );
  const connected = Boolean(onlineInstallation && link?.matchedAt);
  const remaining = pairing ? secondsRemaining(pairing.expiresAt, now) : 0;
  const allRequirementsConfirmed = REQUIREMENTS.every((key) => requirements[key]);
  const latestSync = useMemo(
    () => overview.health?.latestSyncs
      .filter((item) => item.organizationId === selectedOrganizationId)
      .sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt))[0],
    [overview.health?.latestSyncs, selectedOrganizationId],
  );
  const latestExport = overview.exportJobs.find((item) => item.organizationId === selectedOrganizationId);

  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 1_000);
    return () => window.clearInterval(timer);
  }, []);

  useEffect(() => {
    if (!pairing && step !== 6) return;
    const poll = window.setInterval(() => { void onReload(); }, 10_000);
    return () => window.clearInterval(poll);
  }, [onReload, pairing, step]);

  useEffect(() => {
    if (pairing && pairing.organizationId !== selectedOrganizationId) setPairing(undefined);
  }, [pairing, selectedOrganizationId]);

  async function createPairingCode() {
    if (!selectedOrganizationId) return;
    setBusy(true);
    try {
      setPairing(await generateMostikPairingCode(selectedOrganizationId, csrfToken));
      showToast(t('mostik.kodVygenerovany'));
    } catch {
      showToast(t('mostik.parovanieChyba'), { tone: 'error' });
    } finally {
      setBusy(false);
    }
  }

  async function simulateConnection() {
    if (!pairing) return;
    setBusy(true);
    try {
      await simulateMostikAgentConnection(pairing.code);
      setPairing(undefined);
      await onReload();
      setStep(6);
      showToast(t('mostik.agentPripojeny'));
    } catch {
      showToast(t('mostik.parovanieChyba'), { tone: 'error' });
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="card overflow-hidden">
      <div className="border-b border-line p-4">
        <h2 className="text-base font-semibold">{t('mostik.sprievodca')}</h2>
        <p className="mt-1 text-sm text-ink-soft">{t('mostik.sprievodcaPopis')}</p>
        <ol className="mt-4 grid grid-cols-2 gap-2 text-xs md:grid-cols-6">
          {[1, 2, 3, 4, 5, 6].map((number) => (
            <li key={number}>
              <button
                type="button"
                className={`w-full rounded border px-2 py-2 text-left ${step === number ? 'border-accent bg-emerald-50 text-accent' : 'border-line bg-white text-ink-soft'}`}
                onClick={() => setStep(number)}
              >
                <span className="tnum mr-1 font-semibold">{number}.</span>
                {t(`mostik.krok.${number}` as 'mostik.krok.1' | 'mostik.krok.2' | 'mostik.krok.3' | 'mostik.krok.4' | 'mostik.krok.5' | 'mostik.krok.6')}
              </button>
            </li>
          ))}
        </ol>
      </div>

      <div className="p-4">
        {step === 1 && (
          <div>
            <h3 className="text-sm font-semibold">{t('mostik.kontrolaPoziadaviek')}</h3>
            <p className="mt-1 text-xs text-ink-soft">{t('mostik.poziadavkyCestne')}</p>
            <div className="mt-3 grid gap-2 md:grid-cols-2">
              {REQUIREMENTS.map((key) => (
                <label key={key} className="flex items-center justify-between gap-3 rounded border border-line p-3 text-sm">
                  <span>{t(`mostik.poziadavka.${key}` as `mostik.poziadavka.${Requirement}`)}</span>
                  <span className="flex items-center gap-2">
                    <span className={requirements[key] ? 'text-green-700' : 'text-amber-700'}>
                      {requirements[key] ? t('mostik.splnene') : t('mostik.vyzadujeKontrolu')}
                    </span>
                    <input
                      type="checkbox"
                      checked={requirements[key]}
                      onChange={(event) => setRequirements((current) => ({ ...current, [key]: event.target.checked }))}
                    />
                  </span>
                </label>
              ))}
            </div>
          </div>
        )}

        {step === 2 && (
          <div className="max-w-xl">
            <h3 className="text-sm font-semibold">{t('mostik.vyberOrganizacie')}</h3>
            <label className="mt-3 block text-sm">
              <span className="mb-1 block text-ink-soft">{t('mostik.organizacia')}</span>
              <select className="input w-full" value={selectedOrganizationId} onChange={(event) => setSelectedOrganizationId(event.target.value)}>
                {organizations.map((item) => <option key={item.id} value={item.id}>{item.nazov} · {item.ico}</option>)}
              </select>
            </label>
            {organization && (
              <dl className="mt-3 grid grid-cols-2 gap-2 rounded bg-app p-3 text-sm">
                <dt className="text-ink-soft">{t('nast.org.ico')}</dt><dd className="tnum">{organization.ico}</dd>
                <dt className="text-ink-soft">{t('mostik.rok')}</dt><dd className="tnum">{link?.uctovnyRok ?? t('mostik.zistiAgent')}</dd>
                <dt className="text-ink-soft">{t('mostik.stav')}</dt><dd>{connected ? t('mostik.pripojene') : t('mostik.nepripojene')}</dd>
              </dl>
            )}
          </div>
        )}

        {step === 3 && (
          <div className="max-w-xl">
            <h3 className="text-sm font-semibold">{t('mostik.parovanie')}</h3>
            <p className="mt-1 text-sm text-ink-soft">{t('mostik.kodJednorazovy')}</p>
            {!pairing || remaining === 0 ? (
              <button type="button" className="btn btn-primary mt-4" disabled={busy || !selectedOrganizationId} onClick={() => void createPairingCode()}>
                {pairing ? t('mostik.vygenerovatNovyKod') : t('mostik.vygenerovatKod')}
              </button>
            ) : (
              <div className="mt-4 rounded border border-accent/30 bg-emerald-50 p-4">
                <div className="flex flex-wrap items-center gap-3">
                  <span className="tnum text-2xl font-semibold tracking-widest">{pairing.code}</span>
                  <CopyButton value={pairing.code} />
                </div>
                <p className="mt-2 text-xs text-ink-soft">{t('mostik.kodZostava')}: <span className="tnum font-medium">{formatCountdown(remaining)}</span></p>
                <p className="mt-1 text-xs text-ink-soft">{t('mostik.kodKamZadat')}</p>
                <button type="button" className="btn mt-3" disabled={busy} onClick={() => void createPairingCode()}>{t('mostik.vygenerovatNovyKod')}</button>
                {MOSTIK_DATA_MODE === 'mock' && (
                  <button type="button" className="btn ml-2 mt-3" disabled={busy} onClick={() => void simulateConnection()}>{t('mostik.simulovatPripojenie')}</button>
                )}
              </div>
            )}
          </div>
        )}

        {step === 4 && (
          <div>
            <h3 className="text-sm font-semibold">{t('mostik.stiahnutieAgenta')}</h3>
            {overview.latestRelease ? (
              <div className="mt-3 rounded border border-line p-4">
                <a className="btn btn-primary" href={overview.latestRelease.downloadUrl}>{t('mostik.stiahnutAgentWindows')}</a>
                {overview.latestRelease.signatureTrust === 'self-signed' && (
                  <div className="mt-4 rounded border border-amber-300 bg-amber-50 p-3 text-sm text-amber-950" role="alert">
                    <strong>{t('mostik.selfSignedTitulok')}</strong>
                    <p className="mt-1">{t('mostik.selfSignedPopis')}</p>
                    {overview.latestRelease.certificateUrl && (
                      <a className="mt-2 inline-block underline" href={overview.latestRelease.certificateUrl}>{t('mostik.stiahnutCertifikat')}</a>
                    )}
                  </div>
                )}
                <dl className="mt-4 grid gap-x-4 gap-y-2 text-sm sm:grid-cols-[12rem_1fr]">
                  <dt className="text-ink-soft">{t('mostik.verzia')}</dt><dd className="tnum">{overview.latestRelease.version}</dd>
                  <dt className="text-ink-soft">{t('mostik.velkost')}</dt><dd className="tnum">{formatBytes(overview.latestRelease.fileSize)}</dd>
                  <dt className="text-ink-soft">{t('mostik.publikovane')}</dt><dd>{formatDateTime(overview.latestRelease.publishedAt)}</dd>
                  <dt className="text-ink-soft">{t('mostik.vydavatel')}</dt><dd>{overview.latestRelease.publisher}</dd>
                  <dt className="text-ink-soft">{t('mostik.system')}</dt><dd>{t('mostik.windows')} {overview.latestRelease.minimumWindowsVersion}+</dd>
                </dl>
                <p className="mt-3 text-xs text-ink-soft">{t('mostik.jedenInstalator')}</p>
              </div>
            ) : (
              <div className="mt-3 rounded border border-amber-200 bg-amber-50 p-4 text-sm text-amber-900">
                <strong>{t('mostik.instalatorNedostupnyTitulok')}</strong>
                <p className="mt-1">{t('mostik.instalatorNedostupny')}</p>
              </div>
            )}
          </div>
        )}

        {step === 5 && (
          <div>
            <h3 className="text-sm font-semibold">{t('mostik.instalacia')}</h3>
            <ol className="mt-3 list-decimal space-y-2 pl-5 text-sm text-ink-soft">
              <li>{t('mostik.instalacia.1')}</li>
              <li>{t('mostik.instalacia.2')}</li>
              <li>{t('mostik.instalacia.3')}</li>
              <li>{t('mostik.instalacia.4')}</li>
              <li>{t('mostik.instalacia.5')}</li>
            </ol>
            <details className="mt-4 rounded border border-line p-3 text-sm">
              <summary className="cursor-pointer font-medium">{t('mostik.riesenieProblemov')}</summary>
              <p className="mt-2 text-ink-soft">{t('mostik.riesenieProblemovPopis')}</p>
            </details>
          </div>
        )}

        {step === 6 && (
          <div>
            <div className={`rounded border p-4 ${connected ? 'border-green-200 bg-green-50' : 'border-amber-200 bg-amber-50'}`}>
              <h3 className={`text-sm font-semibold ${connected ? 'text-green-800' : 'text-amber-900'}`}>
                {connected ? t('mostik.uspesnePripojeny') : t('mostik.cakaNaSpojenie')}
              </h3>
              <p className="mt-1 text-xs text-ink-soft">{t('mostik.kontrolaAutomaticka')}</p>
            </div>
            <dl className="mt-4 grid gap-x-4 gap-y-2 text-sm sm:grid-cols-[13rem_1fr]">
              <dt className="text-ink-soft">{t('mostik.hostname')}</dt><dd>{onlineInstallation?.hostname ?? '—'}</dd>
              <dt className="text-ink-soft">{t('mostik.verzia')}</dt><dd className="tnum">{onlineInstallation?.agentVersion ?? '—'}</dd>
              <dt className="text-ink-soft">{t('mostik.posledneSpojenie')}</dt><dd>{formatDateTime(onlineInstallation?.lastSeenAt)}</dd>
              <dt className="text-ink-soft">{t('mostik.uctovnaJednotka')}</dt><dd>{link?.dbName ?? '—'}</dd>
              <dt className="text-ink-soft">{t('nast.org.ico')}</dt><dd className="tnum">{link?.ico ?? organization?.ico ?? '—'}</dd>
              <dt className="text-ink-soft">{t('mostik.rok')}</dt><dd className="tnum">{link?.uctovnyRok ?? '—'}</dd>
              <dt className="text-ink-soft">{t('mostik.mserverStav')}</dt><dd>{connected && latestSync?.state === 'ok' ? t('mostik.dostupny') : t('mostik.vyzadujeKontrolu')}</dd>
              <dt className="text-ink-soft">{t('mostik.poslednaSynchronizacia')}</dt><dd>{formatDateTime(latestSync?.createdAt)}</dd>
              <dt className="text-ink-soft">{t('mostik.poslednyExport')}</dt><dd>{formatDateTime(latestExport?.createdAt)}</dd>
            </dl>
            <button type="button" className="btn mt-4" disabled={busy} onClick={() => void onReload()}>{t('mostik.skontrolovatZnova')}</button>
          </div>
        )}

        <div className="mt-5 flex justify-between border-t border-line pt-4">
          <button type="button" className="btn" disabled={step === 1} onClick={() => setStep((current) => Math.max(1, current - 1))}>{t('mostik.spat')}</button>
          <button
            type="button"
            className="btn btn-primary"
            disabled={step === 6 || (step === 1 && !allRequirementsConfirmed) || (step === 2 && !selectedOrganizationId)}
            onClick={() => setStep((current) => Math.min(6, current + 1))}
          >
            {t('mostik.pokracovat')}
          </button>
        </div>
      </div>
    </section>
  );
}

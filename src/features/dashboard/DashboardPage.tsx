// Prehľad = zoznam firiem (vzor Doklado). Vstupná obrazovka nie je dashboard,
// ale rozcestník: vyber firmu → pracuje sa v nej. Kliknutie na riadok prepne
// globálny kontext (rovnaký prepínač ako v ľavom paneli) a otvorí jej doklady.
import { useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { setCurrentOrg } from '../../data/api';
import { useDataQuery } from '../../data/query';
import { t } from '../../i18n/sk';

interface FirmRow {
  id: string;
  nazov: string;
  ico: string;
  farba: string;
  naKontrolu: number;
  naExport: number;
  rozpory: number;
  nespracovane: number;
  spolu: number;
}

function initials(nazov: string): string {
  return nazov
    .split(/[\s,.]+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((word) => word[0]?.toLocaleUpperCase('sk') ?? '')
    .join('');
}

export function DashboardPage() {
  const { data, loading, error } = useDataQuery();
  const navigate = useNavigate();
  const [search, setSearch] = useState('');

  const rows = useMemo<FirmRow[]>(() => {
    if (!data) return [];
    const byOrg = new Map<string, FirmRow>();
    for (const org of data.organizations) {
      if (org.archived) continue;
      byOrg.set(org.id, {
        id: org.id, nazov: org.nazov, ico: org.ico, farba: org.farba,
        naKontrolu: 0, naExport: 0, nespracovane: 0, rozpory: 0, spolu: 0,
      });
    }
    for (const document of data.documents) {
      const row = byOrg.get(document.orgId);
      if (!row) continue;
      row.spolu += 1;
      if (document.status === 'na_kontrole' || document.status === 'extrahovany') row.naKontrolu += 1;
      if (document.status === 'schvaleny') row.naExport += 1;
    }
    // Nevyriešený rozpor medzi pamäťou a právnou kontrolou DPH. Kým ho nikto
    // neuzavrie, doklad odchádza do POHODY s členením, ktoré kontrola
    // spochybnila — a zistí sa to až pri kontrolnom výkaze.
    for (const audit of data.dphAudit ?? []) {
      if (audit.verdikt === 'suhlasi' || audit.rozhodnutie) continue;
      const row = byOrg.get(audit.organizationId);
      if (row) row.rozpory += 1;
    }
    for (const email of data.inboundEmails) {
      if (!['quarantine', 'failed'].includes(email.status)) continue;
      const row = email.organizationId ? byOrg.get(email.organizationId) : undefined;
      if (row) row.nespracovane += 1;
    }
    return [...byOrg.values()].sort((a, b) => a.nazov.localeCompare(b.nazov, 'sk'));
  }, [data]);

  if (loading) return <p className="text-sm text-ink-soft">{t('stav.nacitavam')}</p>;
  if (error || !data) return <p className="text-sm text-red-700">{t('chyba.vseobecna')}</p>;

  const needle = search.trim().toLocaleLowerCase('sk');
  const filtered = needle
    ? rows.filter((row) => `${row.nazov} ${row.ico}`.toLocaleLowerCase('sk').includes(needle))
    : rows;
  // E-maily, ktoré sa nepodarilo priradiť žiadnej firme, nepatria do žiadneho
  // riadku — inak by sa v zozname stratili.
  const bezFirmy = data.inboundEmails.filter(
    (email) => !email.organizationId && ['quarantine', 'failed'].includes(email.status),
  ).length;

  const otvorit = (orgId: string) => {
    void setCurrentOrg(orgId);
    navigate('/doklady');
  };

  return (
    <div className="mx-auto max-w-[1240px]">
      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-[22px] font-bold tracking-tight">
          {t('firmy.titulok')} <span className="tnum text-ink-soft">({rows.length})</span>
        </h1>
        <input
          className="input w-72"
          type="search"
          value={search}
          onChange={(event) => setSearch(event.target.value)}
          placeholder={t('firmy.hladat')}
          aria-label={t('firmy.hladat')}
        />
      </div>

      {bezFirmy > 0 && (
        <button
          type="button"
          className="mb-4 w-full rounded-2xl border border-amber-300 bg-amber-50 px-4 py-3 text-left text-sm font-medium text-amber-900 transition hover:bg-amber-100"
          onClick={() => navigate('/nespracovane')}
        >
          ⚠ {bezFirmy} · {t('firmy.bezFirmy')}
        </button>
      )}

      {filtered.length === 0 ? (
        <div className="card border-dashed p-10 text-center text-sm text-ink-soft">
          {rows.length === 0 ? t('firmy.ziadne') : t('firmy.ziadnaZhoda')}
        </div>
      ) : (
        <div className="card overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-line text-left text-xs text-ink-soft">
                <th className="px-4 py-2.5 font-medium">{t('firmy.stlpec.firma')}</th>
                <th className="px-3 py-2.5 text-right font-medium">{t('firmy.stlpec.naKontrolu')}</th>
                <th className="px-3 py-2.5 text-right font-medium">{t('firmy.stlpec.naExport')}</th>
                <th className="px-3 py-2.5 text-right font-medium">{t('firmy.stlpec.rozpory')}</th>
                <th className="px-3 py-2.5 text-right font-medium">{t('firmy.stlpec.nespracovane')}</th>
                <th className="px-3 py-2.5 text-right font-medium">{t('firmy.stlpec.doklady')}</th>
                <th className="px-4 py-2.5" />
              </tr>
            </thead>
            <tbody>
              {filtered.map((row) => (
                <tr
                  key={row.id}
                  className={`cursor-pointer border-b border-line/60 transition last:border-0 hover:bg-app ${
                    data.currentOrgId === row.id ? 'bg-tint' : ''
                  }`}
                  onClick={() => otvorit(row.id)}
                >
                  <td className="px-4 py-3">
                    <span className="flex items-center gap-3">
                      <span
                        className="grid h-8 w-8 shrink-0 place-items-center rounded-[10px] text-[11px] font-bold text-white"
                        style={{ backgroundColor: row.farba }}
                        aria-hidden
                      >
                        {initials(row.nazov)}
                      </span>
                      <span className="min-w-0">
                        <span className="block truncate font-semibold text-ink">{row.nazov}</span>
                        <span className="tnum block text-xs text-ink-soft">
                          {t('nast.org.ico')} {row.ico || '—'}
                        </span>
                      </span>
                    </span>
                  </td>
                  <td className="tnum px-3 py-3 text-right">
                    {row.naKontrolu > 0 ? (
                      <span className="inline-flex h-[22px] min-w-[22px] items-center justify-center rounded-full bg-amber-50 px-2 text-xs font-semibold text-amber-800">
                        {row.naKontrolu}
                      </span>
                    ) : (
                      <span className="text-ink-mute">—</span>
                    )}
                  </td>
                  <td className="tnum px-3 py-3 text-right">
                    {row.naExport > 0 ? row.naExport : <span className="text-ink-mute">—</span>}
                  </td>
                    <td className="px-3 py-2.5 text-right tnum">
                      {row.rozpory > 0
                        ? <span className="text-amber-700" title={t('firmy.stlpec.rozporyPopis')}>{row.rozpory}</span>
                        : <span className="text-ink-mute">—</span>}
                    </td>
                  <td className="tnum px-3 py-3 text-right">
                    {row.nespracovane > 0 ? (
                      <span className="font-semibold text-red-700">{row.nespracovane}</span>
                    ) : (
                      <span className="text-ink-mute">—</span>
                    )}
                  </td>
                  <td className="tnum px-3 py-3 text-right text-ink-soft">{row.spolu}</td>
                  <td className="px-4 py-3 text-right">
                    <span className="btn px-3 py-1 text-xs">{t('firmy.otvorit')}</span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <p className="mt-3 text-xs text-ink-soft">{t('firmy.popis')}</p>
    </div>
  );
}

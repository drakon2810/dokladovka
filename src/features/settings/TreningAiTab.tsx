// Tréning AI — import historických zaúčtovaní (Excel) do pamäte rozhodnutí.
// Klient parsuje súbor (SheetJS, dynamický import) a validuje kódy proti
// číselníkom vybranej firmy len kvôli náhľadu; autoritatívna validácia beží
// na serveri pri PUT /ai-training/import.
import { useEffect, useRef, useState } from 'react';
import {
  activateAiRule, analyzeAiTraining, confirmAiRules, deleteAiRule,
  getAiTrainingStats, importAiTraining, listAiRules,
  type AiRule, type AiRuleProposal,
} from '../../data/api';
import { useDataQuery } from '../../data/query';
import { showToast } from '../../components/toast';
import { t } from '../../i18n/sk';
import type { CodeListKind } from '../../data/types';
import { parseTrainingRows, type ParsedTrainingRow } from './treningImport';

export function TreningAiTab() {
  const { data, loading, error } = useDataQuery();
  const [selectedOrgId, setSelectedOrgId] = useState<string>();
  const [stats, setStats] = useState<{ schvalene: number; importovane: number }>();
  const [rows, setRows] = useState<ParsedTrainingRow[]>([]);
  const [busy, setBusy] = useState(false);
  const [proposals, setProposals] = useState<AiRuleProposal[]>();
  const [checked, setChecked] = useState<boolean[]>([]);
  const [rules, setRules] = useState<AiRule[]>([]);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const organizations = data?.organizations.filter((org) => !org.archived) ?? [];
  const orgId = selectedOrgId ?? organizations[0]?.id;

  async function refreshRules(id: string) {
    try {
      setRules(await listAiRules(id));
    } catch {
      setRules([]);
    }
  }

  useEffect(() => {
    let active = true;
    if (!orgId) return undefined;
    setStats(undefined);
    setRules([]);
    void getAiTrainingStats(orgId)
      .then((next) => {
        if (active) setStats(next);
      })
      .catch(() => undefined);
    void listAiRules(orgId)
      .then((next) => {
        if (active) setRules(next);
      })
      .catch(() => undefined);
    return () => {
      active = false;
    };
  }, [orgId]);

  if (loading) return <p className="text-sm text-ink-soft">{t('stav.nacitavam')}</p>;
  if (error || !data) return <p className="text-sm text-red-700">{t('chyba.vseobecna')}</p>;

  const aktivneKody = (kind: CodeListKind): Set<string> =>
    new Set(data.codeLists[kind]
      .filter((item) => item.orgId === orgId && item.active)
      .map((item) => item.kod.trim()));

  async function handleFile(file: File) {
    if (!orgId) return;
    setBusy(true);
    try {
      const XLSX = await import('xlsx');
      const workbook = XLSX.read(await file.arrayBuffer());
      const sheet = workbook.Sheets[workbook.SheetNames[0]];
      const raw: Array<Record<string, unknown>> = sheet
        ? XLSX.utils.sheet_to_json<Record<string, unknown>>(sheet, { defval: '' })
        : [];
      const parsed = parseTrainingRows(raw, {
        predkontacie: aktivneKody('predkontacie'),
        cleneniaDph: aktivneKody('cleneniaDph'),
        ciselneRady: aktivneKody('ciselneRady'),
        strediska: aktivneKody('strediska'),
      });
      setRows(parsed);
      if (parsed.length === 0) showToast(t('trening.ziadneRiadky'), { tone: 'error' });
    } catch (cause) {
      showToast(cause instanceof Error ? cause.message : t('chyba.vseobecna'), { tone: 'error' });
    } finally {
      setBusy(false);
      if (fileInputRef.current) fileInputRef.current.value = '';
    }
  }

  async function submit() {
    if (!orgId) return;
    const valid = rows.filter((row) => !row.chyba);
    if (valid.length === 0) return;
    setBusy(true);
    try {
      const result = await importAiTraining(orgId, valid.map(({ chyba: _chyba, ...row }) => row));
      showToast(`${t('trening.hotovo')}: ${result.imported} nových, ${result.duplicates} duplicít, ${result.rejected.length} odmietnutých`);
      setRows([]);
      setStats(await getAiTrainingStats(orgId));
    } catch (cause) {
      showToast(cause instanceof Error ? cause.message : t('chyba.vseobecna'), { tone: 'error' });
    } finally {
      setBusy(false);
    }
  }

  async function analyze() {
    if (!orgId) return;
    setBusy(true);
    try {
      const next = await analyzeAiTraining(orgId);
      setProposals(next);
      setChecked(next.map(() => false));
      if (next.length === 0) showToast(t('trening.ziadneNavrhy'));
    } catch (cause) {
      showToast(cause instanceof Error ? cause.message : t('chyba.vseobecna'), { tone: 'error' });
    } finally {
      setBusy(false);
    }
  }

  async function confirmSelected() {
    if (!orgId || !proposals) return;
    const selected = proposals.filter((_, index) => checked[index]);
    if (selected.length === 0) return;
    setBusy(true);
    try {
      const created = await confirmAiRules(orgId, selected);
      showToast(`${t('trening.pravidlaVytvorene')}: ${created}`);
      setProposals(undefined);
      setChecked([]);
      await refreshRules(orgId);
    } catch (cause) {
      showToast(cause instanceof Error ? cause.message : t('chyba.vseobecna'), { tone: 'error' });
    } finally {
      setBusy(false);
    }
  }

  const kodPodlaId = new Map<string, string>();
  for (const kind of ['predkontacie', 'cleneniaDph', 'ciselneRady', 'strediska'] as CodeListKind[]) {
    for (const item of data.codeLists[kind]) kodPodlaId.set(item.id, item.kod);
  }
  const kod = (id?: string | null) => (id ? kodPodlaId.get(id) ?? '—' : undefined);
  const ciele = (rule: { predkontaciaId?: string | null; clenenieDphId?: string | null; ciselnyRadId?: string | null; strediskoId?: string | null; clenenieKvKod?: string | null }) =>
    [kod(rule.predkontaciaId), kod(rule.clenenieDphId), kod(rule.ciselnyRadId), kod(rule.strediskoId), rule.clenenieKvKod ?? undefined]
      .filter(Boolean)
      .join(' · ');
  const podmienka = (rule: { supplierIco?: string | null; supplierName?: string | null; klucoveSlova: string[] }) => {
    const parts: string[] = [];
    if (rule.supplierIco || rule.supplierName) {
      parts.push(`${t('trening.dodavatel')}: ${[rule.supplierName, rule.supplierIco].filter(Boolean).join(' / ')}`);
    }
    if (rule.klucoveSlova.length > 0) parts.push(`${t('trening.klucoveSlova')}: ${rule.klucoveSlova.join(', ')}`);
    return parts.join(' + ');
  };

  const okCount = rows.filter((row) => !row.chyba).length;
  const errorCount = rows.length - okCount;
  const checkedCount = checked.filter(Boolean).length;

  return (
    <div className="space-y-4">
      <p className="max-w-3xl text-sm text-ink-soft">{t('trening.popis')}</p>

      <div className="flex flex-wrap items-end gap-3">
        <label className="block">
          <span className="label">{t('nast.tab.organizacie')}</span>
          <select
            className="input w-64"
            value={orgId ?? ''}
            onChange={(event) => {
              setSelectedOrgId(event.target.value);
              setRows([]);
            }}
          >
            {organizations.map((org) => (
              <option key={org.id} value={org.id}>{org.nazov}</option>
            ))}
          </select>
        </label>
        <button
          type="button"
          className="btn btn-primary"
          disabled={busy || !orgId}
          onClick={() => fileInputRef.current?.click()}
        >
          {t('trening.nahrat')}
        </button>
        <button
          type="button"
          className="btn"
          disabled={busy || !orgId}
          onClick={() => void analyze()}
        >
          {t('trening.analyzovat')}
        </button>
        <input
          ref={fileInputRef}
          type="file"
          accept=".xlsx,.xls,.csv"
          className="hidden"
          onChange={(event) => {
            const file = event.target.files?.[0];
            if (file) void handleFile(file);
          }}
        />
      </div>

      {stats && (
        <p className="text-sm text-ink-soft">
          {t('trening.pamat')}: <strong className="tnum text-ink">{stats.schvalene + stats.importovane}</strong>
          {' '}({stats.schvalene} {t('trening.schvalene')}, {stats.importovane} {t('trening.importovane')})
        </p>
      )}

      <p className="max-w-3xl text-xs text-ink-soft">{t('trening.stlpce')}</p>

      {rows.length > 0 && (
        <section className="card p-4">
          <div className="mb-3 flex flex-wrap items-center gap-3">
            <span className="text-sm"><strong className="tnum">{okCount}</strong> {t('trening.riadkovOk')}</span>
            {errorCount > 0 && (
              <span className="text-sm text-red-700"><strong className="tnum">{errorCount}</strong> {t('trening.riadkovChyba')}</span>
            )}
            <button
              type="button"
              className="btn btn-primary ml-auto"
              disabled={busy || okCount === 0}
              onClick={() => void submit()}
            >
              {busy ? t('stav.nacitavam') : t('trening.importovat')}
            </button>
          </div>
          <div className="overflow-x-auto">
            <table className="w-full text-left text-sm">
              <thead>
                <tr className="border-b border-line text-xs text-ink-soft">
                  <th className="py-1 pr-3">IČO</th>
                  <th className="py-1 pr-3">Dodávateľ</th>
                  <th className="py-1 pr-3">Text</th>
                  <th className="py-1 pr-3">Predkontácia</th>
                  <th className="py-1 pr-3">Členenie DPH</th>
                  <th className="py-1 pr-3">KV</th>
                  <th className="py-1">Stav</th>
                </tr>
              </thead>
              <tbody>
                {rows.slice(0, 100).map((row, index) => (
                  <tr key={index} className="border-b border-line/60">
                    <td className="tnum py-1 pr-3">{row.supplierIco}</td>
                    <td className="py-1 pr-3">{row.supplierName}</td>
                    <td className="max-w-56 truncate py-1 pr-3">{row.lineText}</td>
                    <td className="tnum py-1 pr-3">{row.predkontaciaKod}</td>
                    <td className="py-1 pr-3">{row.clenenieDphKod}</td>
                    <td className="py-1 pr-3">{row.clenenieKvKod}</td>
                    <td className={`py-1 ${row.chyba ? 'text-red-700' : 'text-green-700'}`}>
                      {row.chyba ?? 'OK'}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            {rows.length > 100 && (
              <p className="mt-2 text-xs text-ink-soft">… + {rows.length - 100}</p>
            )}
          </div>
        </section>
      )}

      {proposals && proposals.length > 0 && (
        <section className="card p-4">
          <h3 className="mb-1 text-sm font-semibold">{t('trening.navrhy')}</h3>
          <p className="mb-3 max-w-3xl text-xs text-ink-soft">{t('trening.navrhyPopis')}</p>
          <ul className="space-y-2">
            {proposals.map((proposal, index) => (
              <li key={index} className="flex items-start gap-3 rounded border border-line p-2 text-sm">
                <input
                  type="checkbox"
                  className="mt-1"
                  checked={checked[index] ?? false}
                  onChange={(event) =>
                    setChecked((current) => current.map((value, i) => (i === index ? event.target.checked : value)))
                  }
                />
                <div>
                  <p><strong>{podmienka(proposal)}</strong> → <span className="tnum">{ciele(proposal)}</span></p>
                  <p className="text-xs text-ink-soft">{proposal.dovod}</p>
                </div>
              </li>
            ))}
          </ul>
          <button
            type="button"
            className="btn btn-primary mt-3"
            disabled={busy || checkedCount === 0}
            onClick={() => void confirmSelected()}
          >
            {t('trening.potvrdit')} ({checkedCount})
          </button>
        </section>
      )}

      {rules.length > 0 && (
        <section className="card p-4">
          <h3 className="mb-3 text-sm font-semibold">{t('trening.pravidla')}</h3>
          <ul className="space-y-2">
            {rules.map((rule) => (
              <li key={rule.id} className="flex flex-wrap items-center gap-3 rounded border border-line p-2 text-sm">
                <div className="min-w-0 flex-1">
                  <p className="truncate"><strong>{podmienka(rule)}</strong> → <span className="tnum">{ciele(rule)}</span></p>
                  <p className={`text-xs ${rule.needsReview ? 'text-amber-700' : rule.active ? 'text-green-700' : 'text-ink-soft'}`}>
                    {rule.needsReview
                      ? t('trening.stavNaKontrolu')
                      : rule.active
                        ? t('trening.stavAktivne')
                        : t('trening.stavNeaktivne')}
                    {rule.origin === 'ai' ? ' · AI' : ''}
                  </p>
                </div>
                {(rule.needsReview || !rule.active) && (
                  <button
                    type="button"
                    className="btn"
                    disabled={busy}
                    onClick={() => {
                      if (!orgId) return;
                      void activateAiRule(orgId, rule.id)
                        .then(() => {
                          showToast(t('trening.pravidloObnovene'));
                          return refreshRules(orgId);
                        })
                        .catch(() => showToast(t('chyba.vseobecna'), { tone: 'error' }));
                    }}
                  >
                    {t('trening.obnovit')}
                  </button>
                )}
                <button
                  type="button"
                  className="btn"
                  disabled={busy}
                  onClick={() => {
                    if (!orgId) return;
                    void deleteAiRule(orgId, rule.id)
                      .then(() => {
                        showToast(t('trening.pravidloZmazane'));
                        return refreshRules(orgId);
                      })
                      .catch(() => showToast(t('chyba.vseobecna'), { tone: 'error' }));
                  }}
                >
                  {t('trening.zmazat')}
                </button>
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}

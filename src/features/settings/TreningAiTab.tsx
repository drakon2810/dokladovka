// Tréning AI — import historických zaúčtovaní (Excel) do pamäte rozhodnutí.
// Klient parsuje súbor (SheetJS, dynamický import) a validuje kódy proti
// číselníkom vybranej firmy len kvôli náhľadu; autoritatívna validácia beží
// na serveri pri PUT /ai-training/import.
import { useEffect, useRef, useState } from 'react';
import {
  activateAiRule, analyzeAiTraining, confirmAiRules, deleteAiRule,
  excludeAiTrainingSupplier, getAiTrainingStats, importAiTraining,
  importUctoDennik, importUctoHistoryRows, listAiRules, listAiTrainingSuppliers,
  type AiRule, type AiRuleProposal, type AiTrainingSupplier,
} from '../../data/api';
import { useDataQuery } from '../../data/query';
import { useOrgSelection } from '../../data/orgSelection';
import { showToast } from '../../components/toast';
import { t } from '../../i18n/sk';
import type { CodeListKind } from '../../data/types';
import { parseTrainingRows, validateTrainingRows, type ParsedTrainingRow, type TrainingKody } from './treningImport';
import { extractPohodaDecisions, extractPohodaHistory } from './pohodaMdbImport';
import { requestMostikTrainingSync } from '../../data/mostik/mostikService';
import { buildDennikRequestFileName, buildDennikRequestXml } from '../../data/pohoda/requestTemplates';
import { decodePohodaXml } from '../../data/pohoda/encoding';
import { UctovnyProfil } from './UctovnyProfil';

export function TreningAiTab() {
  const { data, loading, error } = useDataQuery();
  // Firma sa berie z globálneho prepínača — inak sa dá omylom nahrať história
  // pod inú firmu, než je práve otvorená.
  const { orgId } = useOrgSelection();
  const [stats, setStats] = useState<{ schvalene: number; importovane: number }>();
  const [rows, setRows] = useState<ParsedTrainingRow[]>([]);
  const [busy, setBusy] = useState(false);
  const [proposals, setProposals] = useState<AiRuleProposal[]>();
  const [checked, setChecked] = useState<boolean[]>([]);
  const [rules, setRules] = useState<AiRule[]>([]);
  const [suppliers, setSuppliers] = useState<AiTrainingSupplier[]>([]);
  // Po importe histórie z .mdb sa profil (štatistiky korpusu) načíta nanovo.
  const [profilVerzia, setProfilVerzia] = useState(0);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const dennikInputRef = useRef<HTMLInputElement>(null);

  const organizations = data?.organizations.filter((org) => !org.archived) ?? [];

  async function refreshRules(id: string) {
    try {
      setRules(await listAiRules(id));
    } catch {
      setRules([]);
    }
  }

  async function refreshSuppliers(id: string) {
    try {
      setSuppliers(await listAiTrainingSuppliers(id));
    } catch {
      setSuppliers([]);
    }
  }

  useEffect(() => {
    let active = true;
    if (!orgId) return undefined;
    setStats(undefined);
    setRules([]);
    setSuppliers([]);
    setRows([]);
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
    void listAiTrainingSuppliers(orgId)
      .then((next) => {
        if (active) setSuppliers(next);
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

  const kodyFirmy = (): TrainingKody => ({
    predkontacie: aktivneKody('predkontacie'),
    cleneniaDph: aktivneKody('cleneniaDph'),
    ciselneRady: aktivneKody('ciselneRady'),
    strediska: aktivneKody('strediska'),
  });

  async function handleFile(file: File) {
    if (!orgId) return;
    setBusy(true);
    try {
      if (/\.(mdb|accdb)$/i.test(file.name)) {
        // Priamy import celej agendy z POHODA databázy (mdb-reader v prehliadači).
        // mdb-reader a jeho krypto závislosti (browserify-aes, create-hash) čakajú
        // Node globály Buffer/process/global, ktoré v prehliadači nie sú — pred
        // importom ich doplníme (inak padne „process is not defined"). Dynamické
        // importy držia mdb-reader aj polyfill mimo hlavného balíka.
        const { Buffer: BufferPolyfill } = await import('buffer');
        const g = globalThis as unknown as Record<string, unknown>;
        if (!g.Buffer) g.Buffer = BufferPolyfill;
        if (!g.global) g.global = globalThis;
        if (!g.process) {
          const noop = () => undefined;
          g.process = {
            env: {}, browser: true, version: '', versions: {}, platform: 'browser', argv: [],
            nextTick: (fn: (...args: unknown[]) => void, ...args: unknown[]) => queueMicrotask(() => fn(...args)),
            emitWarning: noop, on: noop, once: noop, off: noop, removeListener: noop, cwd: () => '/',
          };
        }
        const { default: MDBReader } = await import('mdb-reader');
        const bytes = BufferPolyfill.from(new Uint8Array(await file.arrayBuffer())) as unknown as ConstructorParameters<typeof MDBReader>[0];
        const reader = new MDBReader(bytes);
        const { rows: extracted, summary } = extractPohodaDecisions(reader);
        setRows(validateTrainingRows(extracted, kodyFirmy()));
        showToast(
          `${t('trening.mdbNacitane')}: ${summary.unikatne} (${summary.prijate} ${t('trening.prijatych')}, ${summary.vydane} ${t('trening.vydanychPreskocene')})`,
        );
        if (extracted.length === 0) showToast(t('trening.ziadneRiadky'), { tone: 'error' });
        // Z tej istej databázy sa naplní aj korpus histórie pre účtovný profil —
        // všetky dokladové agendy (faktúry, pokladňa, interné doklady), banka
        // zatiaľ nie. Zlyhanie tu nesmie zhodiť náhľad pamäte vyššie.
        try {
          const historia = extractPohodaHistory(reader);
          if (historia.rows.length > 0) {
            const vysledok = await importUctoHistoryRows(orgId, historia.rows);
            const agendy = Object.entries(historia.summary.poAgende)
              .map(([agenda, pocet]) => `${agenda} ${pocet}`)
              .join(', ');
            showToast(`${t('uctoProfil.historiaNahrata')}: ${vysledok.imported} (${agendy})`);
            setProfilVerzia((verzia) => verzia + 1);
          }
        } catch (cause) {
          showToast(cause instanceof Error ? cause.message : t('chyba.vseobecna'), { tone: 'error' });
        }
        return;
      }
      const XLSX = await import('xlsx');
      const workbook = XLSX.read(await file.arrayBuffer());
      const sheet = workbook.Sheets[workbook.SheetNames[0]];
      const raw: Array<Record<string, unknown>> = sheet
        ? XLSX.utils.sheet_to_json<Record<string, unknown>>(sheet, { defval: '' })
        : [];
      const parsed = parseTrainingRows(raw, kodyFirmy());
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
      await refreshSuppliers(orgId);
    } catch (cause) {
      showToast(cause instanceof Error ? cause.message : t('chyba.vseobecna'), { tone: 'error' });
    } finally {
      setBusy(false);
    }
  }

  // Namiesto ručného nahrávania súboru si históriu stiahne agent priamo
  // z POHODY; pamäť sa doplní na pozadí (import robí server, nie prehliadač).
  async function syncViaMostik() {
    if (!orgId) return;
    setBusy(true);
    try {
      await requestMostikTrainingSync(orgId);
      showToast(t('trening.mostikSyncOdoslane'));
    } catch (cause) {
      showToast(cause instanceof Error && cause.message ? cause.message : t('chyba.vseobecna'), { tone: 'error' });
    } finally {
      setBusy(false);
    }
  }

  // Účtovný denník: request si účtovník stiahne, prežene v POHODE a odpoveď
  // nahrá späť. Je to jediný zdroj, z ktorého vidno rozdelené doklady —
  // hlavičková história po rozdelení nezachová nič.
  function stiahniDennikRequest() {
    const organizacia = data?.organizations.find((item) => item.id === orgId);
    if (!organizacia) return;
    const rok = new Date().getFullYear();
    const blob = new Blob([buildDennikRequestXml(organizacia, rok)], { type: 'application/xml' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = buildDennikRequestFileName(organizacia, rok);
    link.click();
    URL.revokeObjectURL(url);
  }

  async function nahrajDennik(file: File) {
    if (!orgId) return;
    setBusy(true);
    try {
      const vysledok = await importUctoDennik(orgId, decodePohodaXml(await file.arrayBuffer()));
      showToast(`${t('trening.dennikNahraty')} ${vysledok.ulozenych} · ${t('trening.dennikSPredkontaciou')}: ${vysledok.sJednouPredkontaciou}`);
    } catch (cause) {
      showToast(cause instanceof Error && cause.message ? cause.message : t('chyba.vseobecna'), { tone: 'error' });
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

      {orgId && <UctovnyProfil key={profilVerzia} orgId={orgId} />}

      <div className="flex flex-wrap items-end gap-3">
        {/* Organizácia sa preberá z globálneho prepínača v hlavičke. */}
        <p className="text-sm text-ink-soft">
          {t('nast.tab.organizacie')}: <strong className="text-ink">{organizations.find((org) => org.id === orgId)?.nazov ?? '—'}</strong>
        </p>
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
          onClick={() => void syncViaMostik()}
        >
          {t('trening.syncMostikom')}
        </button>
        <button
          type="button"
          className="btn"
          disabled={busy || !orgId}
          onClick={() => void analyze()}
        >
          {t('trening.analyzovat')}
        </button>
        <button
          type="button"
          className="btn"
          disabled={busy || !orgId}
          onClick={stiahniDennikRequest}
        >
          {t('trening.stiahnutDennikRequest')}
        </button>
        <button
          type="button"
          className="btn"
          disabled={busy || !orgId}
          onClick={() => dennikInputRef.current?.click()}
        >
          {t('trening.nahratDennik')}
        </button>
        <input
          ref={dennikInputRef}
          type="file"
          accept=".xml,application/xml,text/xml"
          className="hidden"
          onChange={(event) => {
            const file = event.target.files?.[0];
            event.target.value = '';
            if (file) void nahrajDennik(file);
          }}
        />
        <input
          ref={fileInputRef}
          type="file"
          accept=".xlsx,.xls,.csv,.mdb,.accdb"
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

      {suppliers.length > 0 && (
        <DodavateliaVPamati
          suppliers={suppliers}
          busy={busy}
          onPrepnut={(supplier) => {
            if (!orgId) return;
            void excludeAiTrainingSupplier(orgId, {
              supplierIco: supplier.supplierIco,
              supplierName: supplier.supplierName,
              excluded: !supplier.vylucene,
            })
              .then(() => refreshSuppliers(orgId))
              .catch(() => showToast(t('chyba.vseobecna'), { tone: 'error' }));
          }}
        />
      )}
    </div>
  );
}

/** Hranice skupín — účtovník hľadá „toho, čo chodí často", nie 549 riadkov. */
const SKUPINY = [
  { id: 'caste', nazov: 'trening.dod.caste', poznamka: 'trening.dod.castePopis', patri: (pocet: number) => pocet >= 30 },
  { id: 'obcasne', nazov: 'trening.dod.obcasne', poznamka: 'trening.dod.obcasnePopis', patri: (pocet: number) => pocet >= 10 && pocet < 30 },
  { id: 'zriedkave', nazov: 'trening.dod.zriedkave', poznamka: 'trening.dod.zriedkavePopis', patri: (pocet: number) => pocet < 10 },
] as const;

/**
 * Dodávatelia v pamäti — maketa „Nastavenia 1c“. Plochý zoznam 549 mien sa
 * nedal prejsť očami; hľadanie a tri skupiny podľa frekvencie z neho robia
 * niečo, v čom sa dá nájsť konkrétny dodávateľ.
 */
function DodavateliaVPamati({
  suppliers,
  busy,
  onPrepnut,
}: {
  suppliers: AiTrainingSupplier[];
  busy: boolean;
  onPrepnut: (supplier: AiTrainingSupplier) => void;
}) {
  const [hladane, setHladane] = useState('');
  const [zbalene, setZbalene] = useState<ReadonlySet<string>>(() => new Set(['zriedkave']));
  const dopyt = hladane.trim().toLowerCase();

  const najdene = dopyt
    ? suppliers.filter((supplier) =>
        `${supplier.supplierName ?? ''} ${supplier.supplierIco ?? ''}`.toLowerCase().includes(dopyt))
    : suppliers;

  return (
    <section className="card p-4">
      <div className="mb-1 flex flex-wrap items-center gap-3">
        <h3 className="text-sm font-semibold">{t('trening.dodavateliaVPamati')}</h3>
        <input
          className="input ml-auto w-full max-w-[260px] px-3 py-1.5 text-[13px]"
          placeholder={t('trening.dod.hladat')}
          value={hladane}
          onChange={(event) => setHladane(event.target.value)}
          aria-label={t('trening.dod.hladat')}
        />
      </div>
      <p className="mb-3 max-w-3xl text-xs text-ink-soft">{t('trening.vylucitPopis')}</p>

      {najdene.length === 0 ? (
        <p className="py-6 text-center text-sm text-ink-soft">{t('stav.ziadneData')}</p>
      ) : (
        <div className="flex flex-col gap-2.5">
          {SKUPINY.map((skupina) => {
            const riadky = najdene.filter((supplier) => skupina.patri(supplier.pocet));
            if (riadky.length === 0) return null;
            // Pri hľadaní sa otvorí všetko — inak by účtovník našiel zhodu
            // schovanú v zbalenej skupine a myslel si, že tam nie je.
            const otvorena = Boolean(dopyt) || !zbalene.has(skupina.id);
            return (
              <div key={skupina.id} className="overflow-hidden rounded-[13px] border border-line">
                <button
                  type="button"
                  className="flex w-full items-center gap-3 bg-[#FBFCFA] px-4 py-3 text-left transition hover:bg-app"
                  aria-expanded={otvorena}
                  onClick={() => setZbalene((current) => {
                    const dalsie = new Set(current);
                    if (dalsie.has(skupina.id)) dalsie.delete(skupina.id);
                    else dalsie.add(skupina.id);
                    return dalsie;
                  })}
                >
                  <svg
                    width="13" height="13" viewBox="0 0 16 16" fill="none" aria-hidden
                    className={`shrink-0 text-ink-soft transition-transform ${otvorena ? 'rotate-180' : ''}`}
                  >
                    <path d="M3.5 6l4.5 4.5L12.5 6" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" />
                  </svg>
                  <span className="text-[13.5px] font-semibold">{t(skupina.nazov)}</span>
                  <span className="tnum rounded-full border border-line bg-surface px-2 py-0.5 text-[11.5px] font-semibold text-ink-soft">
                    {riadky.length}
                  </span>
                  <span className="ml-auto text-[12.5px] text-ink-faint">{t(skupina.poznamka)}</span>
                </button>
                {otvorena && (
                  <div className="px-4 pb-2.5">
                    {riadky.map((supplier) => {
                      const kluc = supplier.supplierIco ? `ico:${supplier.supplierIco}` : `name:${supplier.supplierName ?? ''}`;
                      return (
                        <div key={kluc} className="flex items-center gap-3.5 border-t border-line-soft py-2.5 first:border-0">
                          <span className={`min-w-0 flex-1 truncate text-[13.5px] ${supplier.vylucene ? 'text-ink-soft line-through' : ''}`}>
                            {supplier.supplierName ?? '—'}{supplier.supplierIco ? ` · ${supplier.supplierIco}` : ''}
                          </span>
                          <span className="tnum text-[12.5px] text-ink-soft">{supplier.pocet}</span>
                          <button
                            type="button"
                            className="text-[12.5px] text-ink-faint transition hover:text-red-700 disabled:opacity-50"
                            disabled={busy}
                            onClick={() => onPrepnut(supplier)}
                          >
                            {supplier.vylucene ? t('trening.zaradit') : t('trening.vylucit')}
                          </button>
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </section>
  );
}

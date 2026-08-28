// Číselníky per organizácia — SPEC §6.6, POHODA SPEC §4.6.
import { useEffect, useRef, useState } from 'react';
import {
  addCodeListItem,
  deactivateCodeListItem,
  importPohodaCodeLists,
  saveSeriesDefaults,
  updateCodeListItem,
} from '../../data/api';
import { useDataQuery } from '../../data/query';
import { useOrgSelection } from '../../data/orgSelection';
import type { CodeListItem, CodeListKind, DocumentType } from '../../data/types';
import { decodePohodaXml } from '../../data/pohoda/encoding';
import {
  parseCodeListResponse,
  type CodeListImportPreview,
} from '../../data/pohoda/parseCodeListResponse';
import {
  buildCodeListRequestFileName,
  buildCodeListRequestXml,
} from '../../data/pohoda/requestTemplates';
import { nextNumberInSeries } from '../../data/pohoda/numbering';
import { AGENDA_PRE_TYP } from '../../data/pohoda/agendas';
import { Modal } from '../../components/ui';
import { showToast } from '../../components/toast';
import { OrgDot } from '../../components/ui';
import { formatDateTime } from '../../lib/format';
import { requestMostikCodeListSync } from '../../data/mostik/mostikService';
import { t } from '../../i18n/sk';

// Prehľadné slovenské názvy agend číselných radov z POHODY (element „agenda").
const AGENDA_LABELS: Record<string, string> = {
  vydane_faktury: 'Vydané faktúry',
  prijate_faktury: 'Prijaté faktúry',
  vydane_zalohove_faktury: 'Vydané zálohové faktúry',
  prijate_zalohove_faktury: 'Prijaté zálohové faktúry',
  interni_doklady: 'Interné doklady',
  ostatni_zavazky: 'Ostatné záväzky',
  ostatni_pohledavky: 'Ostatné pohľadávky',
  pokladna: 'Pokladňa',
  banka: 'Banka',
  prijemky: 'Príjemky',
  vydejky: 'Výdajky',
  prevod: 'Prevod',
  vydane_objednavky: 'Vydané objednávky',
  prijate_objednavky: 'Prijaté objednávky',
  zakazky: 'Zákazky',
};

function agendaLabel(agenda: string | undefined): string {
  if (!agenda) return '—';
  return AGENDA_LABELS[agenda] ?? agenda;
}

const KINDS: Array<{ kind: CodeListKind; label: string }> = [
  { kind: 'predkontacie', label: t('nast.cis.predkontacie') },
  { kind: 'cleneniaDph', label: t('nast.cis.cleneniaDph') },
  { kind: 'ciselneRady', label: t('nast.cis.ciselneRady') },
  { kind: 'strediska', label: t('nast.cis.strediska') },
  { kind: 'bankoveUcty', label: t('nast.cis.bankoveUcty') },
  { kind: 'zakazky', label: t('nast.cis.zakazky') },
  { kind: 'cinnosti', label: t('nast.cis.cinnosti') },
  { kind: 'projekty', label: t('nast.cis.projekty') },
];

function downloadXml(xml: string, fileName: string): void {
  const blob = new Blob([xml], { type: 'application/xml;charset=windows-1250' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = fileName;
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
}

const TYP_LABEL: Partial<Record<DocumentType, string>> = {
  FP: 'Prijatá faktúra', FV: 'Vydaná faktúra', PD: 'Pokladničný doklad',
  BV: 'Bankový výpis', MZDY: 'Interný doklad', OZ: 'Ostatný záväzok',
};

/**
 * Predvolený číselný rad na typ dokladu. Prázdna voľba = automatika: server
 * vyberie rad, ktorý firma v POHODE reálne používa (podľa počtu použití
 * a najvyššieho čísla radu).
 */
/**
 * Predvolené číselné rady. Zbalené (maketa „Nastavenia 2a"): je to nastavenie
 * „raz a zabudni" — šesť riadkov navrchu tlačilo samotné číselníky pod ohyb.
 */
function PredvoleneRady({ organizationId }: { organizationId: string }) {
  const [otvorene, setOtvorene] = useState(false);
  const { data } = useDataQuery();
  const [busy, setBusy] = useState(false);
  const rady = (data?.codeLists.ciselneRady ?? []).filter((item) => item.orgId === organizationId && item.active);
  const predvolby = (data?.seriesDefaults ?? []).filter((item) => item.organizationId === organizationId);
  const ulozene = new Map(predvolby.map((item) => [item.documentType, item.ciselnyRadId]));
  const ulozenaPokladna = predvolby.find((item) => item.documentType === 'PD')?.pokladnaKod ?? '';
  // Pokladňa sa v POHODE zapisuje ku KAŽDÉMU pokladničnému dokladu (pole „Pokl.").
  // Držíme ju v lokálnom stave, aby sa neukladalo pri každom stlačení klávesy.
  const [pokladna, setPokladna] = useState(ulozenaPokladna);
  useEffect(() => setPokladna(ulozenaPokladna), [ulozenaPokladna]);

  async function uloz(documentType: DocumentType, ciselnyRadId: string, pokladnaKod?: string): Promise<void> {
    setBusy(true);
    try {
      await saveSeriesDefaults(organizationId, [{
        documentType,
        ciselnyRadId: ciselnyRadId || null,
        ...(documentType === 'PD' ? { pokladnaKod: pokladnaKod ?? null } : {}),
      }]);
      showToast(t('toast.ulozene'));
    } catch (cause) {
      showToast(cause instanceof Error && cause.message ? cause.message : t('chyba.vseobecna'), { tone: 'error' });
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="mx-6 border-t border-line-soft">
      <button
        type="button"
        className="flex w-full items-center gap-3 py-3.5 text-left"
        aria-expanded={otvorene}
        onClick={() => setOtvorene((stav) => !stav)}
      >
        <svg
          width="13" height="13" viewBox="0 0 16 16" fill="none" aria-hidden
          className={`shrink-0 text-ink-soft transition-transform ${otvorene ? 'rotate-180' : ''}`}
        >
          <path d="M3.5 6l4.5 4.5L12.5 6" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
        <span className="text-[14.5px] font-semibold">{t('nast.cis.predvoleneRady')}</span>
        <span className="ml-auto text-[12.5px] text-ink-faint">
          {otvorene ? t('nast.cis.radyPocet') : t('nast.cis.radySuhrn')}
        </span>
      </button>
      {otvorene && (
      <div className="pb-5">
      <p className="mb-3 max-w-3xl text-xs text-ink-soft">{t('nast.cis.predvoleneRadyPopis')}</p>
      <div className="grid gap-2 sm:grid-cols-2">
        {(Object.keys(AGENDA_PRE_TYP) as DocumentType[]).map((typ) => {
          const ponuka = rady.filter((item) => item.agenda === AGENDA_PRE_TYP[typ]);
          return (
            <label key={typ} className="flex items-center gap-2 text-sm">
              <span className="w-40 shrink-0 text-ink-soft">{TYP_LABEL[typ]}</span>
              <select
                className="input min-w-0 flex-1"
                value={ulozene.get(typ) ?? ''}
                disabled={busy || ponuka.length === 0}
                onChange={(event) => void uloz(typ, event.target.value, typ === 'PD' ? pokladna : undefined)}
              >
                <option value="">{t('nast.cis.radAutomaticky')}</option>
                {ponuka.map((item) => (
                  <option key={item.id} value={item.id}>{item.kod} · {item.nazov}</option>
                ))}
              </select>
              {/* POHODA má pri pokladničnom doklade okrem radu aj pole „Pokl." —
                  bez neho doklad neprijme. Zapisuje sa ako kód (HP1), lebo
                  číselník pokladní zatiaľ z POHODY nesťahujeme. */}
              {typ === 'PD' && (
                <input
                  className="input w-24 shrink-0"
                  value={pokladna}
                  maxLength={20}
                  disabled={busy}
                  placeholder={t('nast.cis.pokladnaPlaceholder')}
                  aria-label={t('nast.cis.pokladna')}
                  title={t('nast.cis.pokladnaPopis')}
                  onChange={(event) => setPokladna(event.target.value)}
                  onBlur={() => {
                    if (pokladna.trim() === ulozenaPokladna) return;
                    void uloz('PD', ulozene.get('PD') ?? '', pokladna.trim());
                  }}
                />
              )}
            </label>
          );
        })}
      </div>
      </div>
      )}
    </section>
  );
}

export function CodeListsTab() {
  const { data, loading, error } = useDataQuery();
  const organizations = (data?.organizations ?? []).filter((organization) => !organization.archived);
  const codeLists = data?.codeLists ?? {
    predkontacie: [],
    cleneniaDph: [],
    ciselneRady: [],
    strediska: [],
    zakazky: [],
    cinnosti: [],
    projekty: [],
    bankoveUcty: [],
  };
  const { orgId } = useOrgSelection();
  const [preview, setPreview] = useState<CodeListImportPreview>();
  const [busy, setBusy] = useState(false);
  const [mostikBusy, setMostikBusy] = useState(false);
  // Osem číselníkov pod sebou znamenalo, že spodné štyri nikto nevidel bez
  // skrolovania. Navigátor (maketa „Nastavenia 1c") ukáže naraz jeden a zvyšok
  // drží po ruke aj s počtami.
  const [vybranyDruh, setVybranyDruh] = useState<CodeListKind>('predkontacie');
  const fileInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    setPreview(undefined);
  }, [orgId]);

  if (loading) {
    return <p className="text-sm text-ink-soft">{t('stav.nacitavam')}</p>;
  }
  if (error) {
    return <p className="text-sm text-red-700">{t('chyba.vseobecna')}</p>;
  }
  if (organizations.length === 0) {
    return <p className="text-sm text-ink-soft">{t('stav.ziadneData')}</p>;
  }

  const organization = organizations.find((item) => item.id === orgId);

  function downloadRequest(): void {
    if (!organization) return;
    downloadXml(
      buildCodeListRequestXml(organization),
      buildCodeListRequestFileName(organization),
    );
  }

  async function readResponse(file: File): Promise<void> {
    if (!organization) return;
    setBusy(true);
    try {
      const xml = decodePohodaXml(await file.arrayBuffer());
      setPreview(parseCodeListResponse(xml, organization.id, codeLists));
    } catch (cause) {
      // Parser vracia konkrétne hlášky (napr. zlý typ súboru) — ukážeme ich
      // používateľovi, generický text je len záloha.
      const message = cause instanceof Error && cause.message ? cause.message : t('nast.cis.importChyba');
      showToast(message, { tone: 'error' });
    } finally {
      setBusy(false);
      if (fileInputRef.current) fileInputRef.current.value = '';
    }
  }

  async function syncViaMostik(): Promise<void> {
    if (!organization) return;
    setMostikBusy(true);
    try {
      await requestMostikCodeListSync(organization.id);
      showToast(t('nast.cis.mostikSyncOdoslane'));
    } catch (cause) {
      showToast(cause instanceof Error && cause.message ? cause.message : t('chyba.vseobecna'), { tone: 'error' });
    } finally {
      setMostikBusy(false);
    }
  }

  async function confirmImport(): Promise<void> {
    if (!preview || !organization) return;
    setBusy(true);
    try {
      const result = await importPohodaCodeLists(organization.id, preview);
      const totals = KINDS.reduce(
        (summary, { kind }) => ({
          nove: summary.nove + result.perKind[kind].nove,
          aktualizovane:
            summary.aktualizovane + result.perKind[kind].aktualizovane,
          vyradene: summary.vyradene + result.perKind[kind].vyradene,
        }),
        { nove: 0, aktualizovane: 0, vyradene: 0 },
      );
      showToast(
        `${t('toast.ciselnikyImportovane')} ${t('nast.cis.nove')}: ${totals.nove} · ${t('nast.cis.aktualizovane')}: ${totals.aktualizovane} · ${t('nast.cis.vyradene')}: ${totals.vyradene}`,
      );
      setPreview(undefined);
    } catch {
      showToast(t('nast.cis.importChyba'), { tone: 'error' });
    } finally {
      setBusy(false);
    }
  }

  const vsetkyPolozky = KINDS.reduce(
    (sucet, { kind }) => sucet + codeLists[kind].filter((item) => item.orgId === orgId && item.active).length, 0);
  // Posledná synchronizácia je najnovší syncedAt spomedzi položiek — samostatné
  // pole neexistuje a účtovník potrebuje vedieť, či pozerá na čerstvé číselníky.
  const poslednySync = KINDS
    .flatMap(({ kind }) => codeLists[kind].filter((item) => item.orgId === orgId))
    .reduce<string | undefined>((najnovsi, item) =>
      item.syncedAt && (!najnovsi || item.syncedAt > najnovsi) ? item.syncedAt : najnovsi, undefined);

  return (
    <div className="card overflow-hidden">
      {/* Jedna hlavička s akciami (maketa „Nastavenia 2a"): predtým boli názov,
          firma, banner a tri tlačidlá v štyroch samostatných blokoch nad sebou
          a obsah číselníkov začínal až pod ohybom. */}
      <div className="flex flex-wrap items-start justify-between gap-5 px-6 pb-4 pt-5">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2.5">
            <h2 className="text-[19px] font-semibold tracking-[-.01em]">{t('nast.cis.titulok')}</h2>
            {organization && (
              <span className="inline-flex items-center gap-1.5 rounded-full bg-tint px-2.5 py-1 text-[12.5px] font-semibold text-accent-hover">
                <OrgDot org={organization} size={6} />
                {organization.nazov}
              </span>
            )}
          </div>
          <p className="mt-1.5 text-[13px] text-ink-soft">
            {poslednySync
              ? `${t('nast.cis.poslednySync')} ${formatDateTime(poslednySync)} · `
              : ''}
            <span className="tnum">{vsetkyPolozky}</span> {t('nast.cis.poloziek')}
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <button
            type="button"
            className="btn btn-primary"
            disabled={!organization || mostikBusy}
            onClick={() => void syncViaMostik()}
          >
            {mostikBusy ? t('stav.nacitavam') : t('nast.cis.syncMostikom')}
          </button>
          <label className={`btn ${busy ? 'pointer-events-none opacity-50' : 'cursor-pointer'}`}>
            {t('nast.cis.importXml')}
            <input
              ref={fileInputRef}
              type="file"
              className="sr-only"
              accept=".xml,application/xml,text/xml"
              disabled={!organization || busy}
              onChange={(event) => {
                const file = event.target.files?.[0];
                if (file) void readResponse(file);
              }}
            />
          </label>
          {/* Stiahnutie requestu je krok pre ručný XML import — patrí k nemu, nie
              medzi dve hlavné akcie, ktoré účtovník používa denne. */}
          <button
            type="button"
            className="btn px-2.5"
            title={t('nast.cis.stiahnutRequest')}
            aria-label={t('nast.cis.stiahnutRequest')}
            disabled={!organization || busy}
            onClick={downloadRequest}
          >
            <svg width="15" height="15" viewBox="0 0 16 16" fill="currentColor" aria-hidden>
              <circle cx="8" cy="3.2" r="1.35" /><circle cx="8" cy="8" r="1.35" /><circle cx="8" cy="12.8" r="1.35" />
            </svg>
          </button>
        </div>
      </div>

      {organization && <PredvoleneRady organizationId={organization.id} />}

      <div className="grid grid-cols-1 border-t border-line-soft md:grid-cols-[248px_1fr]">
        <nav className="flex flex-col gap-0.5 border-b border-line-soft bg-[#FBFCFA] p-3 md:border-b-0 md:border-r" aria-label={t('nast.cis.titulok')}>
          <div className="px-3 pb-1.5 pt-1 text-[11px] font-semibold uppercase tracking-[.06em] text-ink-mute">
            {t('nast.cis.titulok')}
          </div>
          {KINDS.map(({ kind, label }) => {
            const pocet = codeLists[kind].filter((item) => item.orgId === orgId && item.active).length;
            const aktivny = kind === vybranyDruh;
            return (
              <button
                key={kind}
                type="button"
                aria-current={aktivny}
                className={`flex items-center gap-2.5 rounded-[10px] px-3 py-2.5 text-left text-[13.5px] transition ${
                  aktivny ? 'bg-tint font-semibold text-accent-hover' : 'text-ink hover:bg-app'
                }`}
                onClick={() => setVybranyDruh(kind)}
              >
                <span className={`h-4 w-[3px] shrink-0 rounded-[3px] ${aktivny ? 'bg-accent' : 'bg-transparent'}`} aria-hidden />
                <span className="flex-1 truncate">{label}</span>
                {/* Prázdny číselník sa nemá tváriť rovnako dôležito ako plný. */}
                <span className={`tnum text-xs ${pocet === 0 ? 'text-line' : 'text-ink-faint'}`}>{pocet}</span>
              </button>
            );
          })}
          <p className="mt-auto border-t border-line-soft px-3 pb-1 pt-3 text-[12px] leading-relaxed text-ink-faint">
            {t('nast.cis.pohodaNavod')}
          </p>
        </nav>
        <CodeListEditor
          key={vybranyDruh}
          kind={vybranyDruh}
          label={KINDS.find(({ kind }) => kind === vybranyDruh)!.label}
          orgId={orgId}
          items={codeLists[vybranyDruh].filter((item) => item.orgId === orgId)}
        />
      </div>

      {preview && (
        <ImportPreviewModal
          preview={preview}
          busy={busy}
          onConfirm={() => void confirmImport()}
          onClose={() => {
            if (!busy) setPreview(undefined);
          }}
        />
      )}
    </div>
  );
}

function ImportPreviewModal({
  preview,
  busy,
  onConfirm,
  onClose,
}: {
  preview: CodeListImportPreview;
  busy: boolean;
  onConfirm: () => void;
  onClose: () => void;
}) {
  return (
    <Modal title={t('nast.cis.previewTitulok')} onClose={onClose} wide>
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-line text-left text-xs text-ink-soft">
              <th className="px-2 py-2 font-medium">{t('nast.tab.ciselniky')}</th>
              <th className="px-2 py-2 text-right font-medium">{t('nast.cis.nove')}</th>
              <th className="px-2 py-2 text-right font-medium">
                {t('nast.cis.aktualizovane')}
              </th>
              <th className="px-2 py-2 text-right font-medium">{t('nast.cis.vyradene')}</th>
              <th className="px-2 py-2 text-right font-medium">{t('nast.cis.bezZmeny')}</th>
            </tr>
          </thead>
          <tbody>
            {KINDS.map(({ kind, label }) => {
              const summary = preview.perKind[kind];
              return (
                <tr key={kind} className="border-b border-line last:border-0">
                  <td className="px-2 py-2 font-medium">{label}</td>
                  <td className="tnum px-2 py-2 text-right">{summary.nove.length}</td>
                  <td className="tnum px-2 py-2 text-right">
                    {summary.aktualizovane.length}
                  </td>
                  <td className="tnum px-2 py-2 text-right">{summary.vyradene.length}</td>
                  <td className="tnum px-2 py-2 text-right">{summary.bezZmeny}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      {preview.warnings.length > 0 && (
        <div className="mt-4 rounded border border-amber-200 bg-amber-50 p-3 text-sm text-amber-900">
          <p className="font-semibold">{t('nast.cis.upozornenia')}</p>
          <ul className="mt-1 list-disc space-y-1 pl-5">
            {preview.warnings.map((warning, index) => (
              <li key={`${index}-${warning}`}>{warning}</li>
            ))}
          </ul>
        </div>
      )}

      <div className="mt-5 flex justify-end gap-2">
        <button type="button" className="btn" disabled={busy} onClick={onClose}>
          {t('akcia.zrusit')}
        </button>
        <button type="button" className="btn btn-primary" disabled={busy} onClick={onConfirm}>
          {t('nast.cis.importovat')}
        </button>
      </div>
    </Modal>
  );
}

function CodeListEditor({
  kind,
  label,
  orgId,
  items,
}: {
  kind: CodeListKind;
  label: string;
  orgId: string;
  items: CodeListItem[];
}) {
  const [kod, setKod] = useState('');
  const [nazov, setNazov] = useState('');
  const [hladane, setHladane] = useState('');
  const activeItems = items.filter((item) => item.active);
  const inactiveItems = items.filter((item) => !item.active);
  // Predkontácií je vyše tisíc — bez hľadania sa v nich konkrétny účet nedá nájsť.
  const dopyt = hladane.trim().toLocaleLowerCase('sk');
  const najdene = dopyt
    ? activeItems.filter((item) =>
        `${item.kod} ${item.nazov}`.toLocaleLowerCase('sk').includes(dopyt))
    : activeItems;

  async function updateItem(
    item: CodeListItem,
    patch: Partial<Pick<CodeListItem, 'kod' | 'nazov'>>,
  ): Promise<void> {
    try {
      await updateCodeListItem(kind, item.id, patch);
    } catch {
      showToast(t('nast.cis.upravaChyba'), { tone: 'error' });
    }
  }

  async function deactivate(item: CodeListItem): Promise<void> {
    try {
      await deactivateCodeListItem(kind, item.id);
    } catch {
      showToast(t('nast.cis.deaktivaciaChyba'), { tone: 'error' });
    }
  }

  return (
    <section className="min-w-0 p-5">
      <div className="mb-3 flex flex-wrap items-center gap-2.5">
        <h3 className="text-[15px] font-semibold">{label}</h3>
        <span className="tnum rounded-full bg-tint px-2.5 py-0.5 text-xs font-semibold text-accent-hover">
          {activeItems.length}
        </span>
        <input
          className="input ml-auto w-full max-w-[250px] px-3 py-1.5 text-[13px]"
          placeholder={t('nast.cis.hladat')}
          value={hladane}
          onChange={(event) => setHladane(event.target.value)}
          aria-label={`${label} — ${t('nast.cis.hladat')}`}
        />
      </div>
      {activeItems.length === 0 ? (
        // Prázdny číselník bez vysvetlenia vyzerá ako chyba appky.
        <div className="flex flex-col items-center gap-2 py-14 text-center">
          <span className="grid h-11 w-11 place-items-center rounded-[12px] bg-app text-ink-mute" aria-hidden>
            <svg width="20" height="20" viewBox="0 0 20 20" fill="none">
              <path d="M4 5.5h12M4 10h12M4 14.5h8" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" />
            </svg>
          </span>
          <span className="text-sm font-semibold">{t('nast.cis.prazdneTitulok')}</span>
          <span className="max-w-[340px] text-[13px] leading-relaxed text-ink-soft">{t('nast.cis.prazdnePopis')}</span>
        </div>
      ) : (
        <>
          <CodeListTable
            label={label}
            kind={kind}
            items={najdene}
            onUpdate={updateItem}
            onDeactivate={deactivate}
          />
          {dopyt && (
            <p className="mt-2 text-[12.5px] text-ink-faint">
              {t('nast.cis.zobrazenych')} <span className="tnum">{najdene.length}</span> z{' '}
              <span className="tnum">{activeItems.length}</span>
            </p>
          )}
        </>
      )}
      <form
        className="mt-2 flex gap-2"
        onSubmit={(event) => {
          event.preventDefault();
          if (!kod.trim() || !nazov.trim()) return;
          void addCodeListItem(kind, orgId, kod.trim(), nazov.trim())
            .then(() => {
              setKod('');
              setNazov('');
            })
            .catch(() => showToast(t('nast.cis.pridanieChyba'), { tone: 'error' }));
        }}
      >
        <input
          className="input w-28 px-1.5 py-1 text-xs"
          placeholder={t('nast.cis.kod')}
          value={kod}
          onChange={(event) => setKod(event.target.value)}
          aria-label={`${label} — ${t('nast.cis.kod')}`}
        />
        <input
          className="input px-1.5 py-1 text-xs"
          placeholder={t('nast.cis.nazov')}
          value={nazov}
          onChange={(event) => setNazov(event.target.value)}
          aria-label={`${label} — ${t('nast.cis.nazov')}`}
        />
        <button type="submit" className="btn px-2 py-1 text-xs">
          {t('akcia.pridat')}
        </button>
      </form>

      {inactiveItems.length > 0 && (
        <details className="mt-3 border-t border-line pt-2">
          <summary className="cursor-pointer text-sm font-medium text-ink-soft">
            {t('nast.cis.vyradene')} ({inactiveItems.length})
          </summary>
          <div className="mt-2 overflow-x-auto">
            <table className="w-full text-sm">
              <tbody>
                {inactiveItems.map((item) => (
                  <tr key={item.id} className="border-t border-line first:border-0 text-ink-soft">
                    <td className="tnum py-1 pr-2 text-xs">{item.kod}</td>
                    <td className="py-1 text-xs">
                      {item.nazov}
                      {item.source === 'pohoda' && (
                        <span className="ml-2 rounded bg-sky-100 px-1.5 py-0.5 text-[10px] font-medium text-sky-800">
                          {t('nast.cis.zPohody')}
                        </span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </details>
      )}
    </section>
  );
}

function CodeListTable({
  label,
  kind,
  items,
  onUpdate,
  onDeactivate,
}: {
  label: string;
  kind: CodeListKind;
  items: CodeListItem[];
  onUpdate: (
    item: CodeListItem,
    patch: Partial<Pick<CodeListItem, 'kod' | 'nazov'>>,
  ) => Promise<void>;
  onDeactivate: (item: CodeListItem) => Promise<void>;
}) {
  const showSeries = kind === 'ciselneRady';
  const showBank = kind === 'bankoveUcty';
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-sm">
        <thead>
          <tr className="text-left text-xs text-ink-soft">
            <th className="w-28 py-1 pr-2 font-medium">{t('nast.cis.kod')}</th>
            <th className="py-1 pr-2 font-medium">{t('nast.cis.nazov')}</th>
            {showSeries && (
              <>
                <th className="py-1 pr-2 font-medium">{t('nast.cis.agenda')}</th>
                <th className="py-1 pr-2 text-right font-medium">{t('nast.cis.posledneCislo')}</th>
                <th className="py-1 pr-2 text-right font-medium">{t('nast.cis.dalsieCislo')}</th>
              </>
            )}
            {showBank && (
              <>
                <th className="py-1 pr-2 font-medium">IBAN</th>
                <th className="py-1 pr-2 font-medium">{t('nast.cis.mena')}</th>
              </>
            )}
            <th className="w-24" />
          </tr>
        </thead>
        <tbody>
          {items.length === 0 && (
            <tr>
              <td colSpan={showSeries ? 6 : showBank ? 5 : 3} className="py-2 text-xs text-ink-soft">
                {t('stav.ziadneData')}
              </td>
            </tr>
          )}
          {items.map((item) => {
            const synchronized = item.source === 'pohoda';
            const tooltip = synchronized ? t('nast.cis.synchronizovana') : undefined;
            return (
              <tr
                key={`${item.id}-${item.kod}-${item.nazov}`}
                className="border-t border-line"
              >
                <td className="py-1 pr-2">
                  <input
                    className={`input tnum px-1.5 py-1 text-xs ${synchronized ? 'bg-app' : ''}`}
                    defaultValue={item.kod}
                    readOnly={synchronized}
                    title={tooltip}
                    aria-label={`${label} ${t('nast.cis.kod')}`}
                    onBlur={(event) => {
                      if (!synchronized && event.target.value !== item.kod) {
                        void onUpdate(item, { kod: event.target.value });
                      }
                    }}
                  />
                </td>
                <td className="py-1 pr-2">
                  <input
                    className={`input px-1.5 py-1 text-xs ${synchronized ? 'bg-app' : ''}`}
                    defaultValue={item.nazov}
                    readOnly={synchronized}
                    title={tooltip}
                    aria-label={`${label} ${t('nast.cis.nazov')}`}
                    onBlur={(event) => {
                      if (!synchronized && event.target.value !== item.nazov) {
                        void onUpdate(item, { nazov: event.target.value });
                      }
                    }}
                  />
                  {synchronized && (
                    <span className="mt-1 inline-block rounded bg-sky-100 px-1.5 py-0.5 text-[10px] font-medium text-sky-800">
                      {t('nast.cis.zPohody')}
                    </span>
                  )}
                </td>
                {showSeries && (
                  <>
                    <td className="py-1 pr-2 text-xs text-ink-soft align-middle">
                      {agendaLabel(item.agenda)}
                    </td>
                    <td className="tnum py-1 pr-2 text-right text-xs align-middle">
                      {item.posledneCislo ?? '—'}
                    </td>
                    <td className="tnum py-1 pr-2 text-right text-xs font-medium align-middle">
                      {nextNumberInSeries(item.posledneCislo) ?? '—'}
                    </td>
                  </>
                )}
                {showBank && (
                  <>
                    <td className="tnum py-1 pr-2 text-xs align-middle">{item.iban ?? '—'}</td>
                    {/* Prázdna mena = domáci účet (EUR). */}
                    <td className="py-1 pr-2 text-xs text-ink-soft align-middle">{item.mena ?? 'EUR'}</td>
                  </>
                )}
                <td className="py-1 text-right align-top">
                  <button
                    type="button"
                    className="rounded px-1.5 py-1 text-xs text-ink-soft hover:text-red-700"
                    onClick={() => void onDeactivate(item)}
                    aria-label={`${t('nast.cis.deaktivovat')} ${item.kod}`}
                  >
                    {t('nast.cis.deaktivovat')}
                  </button>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

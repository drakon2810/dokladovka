// Číselníky per organizácia — SPEC §6.6, POHODA SPEC §4.6.
import { useEffect, useRef, useState } from 'react';
import {
  addCodeListItem,
  deactivateCodeListItem,
  importPohodaCodeLists,
  updateCodeListItem,
} from '../../data/api';
import { useDataQuery } from '../../data/query';
import type { CodeListItem, CodeListKind } from '../../data/types';
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
import { Modal } from '../../components/ui';
import { showToast } from '../../components/toast';
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
  };
  const [orgId, setOrgId] = useState('');
  const [preview, setPreview] = useState<CodeListImportPreview>();
  const [busy, setBusy] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (organizations.length === 0) {
      if (orgId) setOrgId('');
      return;
    }
    if (!organizations.some((organization) => organization.id === orgId)) {
      setOrgId(organizations[0].id);
    }
  }, [orgId, organizations]);

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

  return (
    <div>
      <div className="mb-3 rounded border border-sky-200 bg-sky-50 px-3 py-2 text-sm text-sky-900">
        {t('nast.cis.banner')}
      </div>
      <label className="label" htmlFor="cis-org">
        {t('detail.organizacia')}
      </label>
      <select
        id="cis-org"
        className="input mb-4 max-w-xs"
        value={orgId}
        disabled={busy}
        onChange={(event) => setOrgId(event.target.value)}
      >
        {organizations.map((item) => (
          <option key={item.id} value={item.id}>
            {item.nazov}
          </option>
        ))}
      </select>

      <section className="card mb-4 p-4">
        <div className="flex flex-wrap gap-2">
          <button
            type="button"
            className="btn"
            disabled={!organization || busy}
            onClick={downloadRequest}
          >
            {t('nast.cis.stiahnutRequest')}
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
        </div>
        <p className="mt-2 text-xs text-ink-soft">{t('nast.cis.pohodaNavod')}</p>
      </section>

      <div className="grid grid-cols-1 gap-4 xl:grid-cols-2">
        {KINDS.map(({ kind, label }) => (
          <CodeListEditor
            key={kind}
            kind={kind}
            label={label}
            orgId={orgId}
            items={codeLists[kind].filter((item) => item.orgId === orgId)}
          />
        ))}
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
  const activeItems = items.filter((item) => item.active);
  const inactiveItems = items.filter((item) => !item.active);

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
    <section className="card p-3">
      <h3 className="mb-2 text-sm font-semibold">{label}</h3>
      <CodeListTable
        label={label}
        kind={kind}
        items={activeItems}
        onUpdate={updateItem}
        onDeactivate={deactivate}
      />
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
            <th className="w-24" />
          </tr>
        </thead>
        <tbody>
          {items.length === 0 && (
            <tr>
              <td colSpan={showSeries ? 6 : 3} className="py-2 text-xs text-ink-soft">
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

import { useEffect, useMemo, useState } from 'react';
import {
  generateExport,
  getBatchXml,
  type GenerateExportResult,
} from '../../data/api';
import { useDataQuery } from '../../data/query';
import type { CodeListItem, DocumentItem } from '../../data/types';
import { EmptyState, OrgChip, TypBadge } from '../../components/ui';
import { showToast } from '../../components/toast';
import { t } from '../../i18n/sk';
import { formatDate, formatDateTime, formatMoney } from '../../lib/format';
import { useAuth } from '../../auth/AuthContext';
import {
  createMostikExportJob,
  getOrganizationMostikStatus,
  type OrganizationMostikStatus,
} from '../../data/mostik/mostikService';

type ExportTab = 'novy' | 'historia';

/** Konkrétna hláška zo servera (restRequest ju prenáša z body.message), inak generická. */
function exportErrorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message.trim() : '';
  return message || t('chyba.vseobecna');
}

function downloadXml(xml: string, fileName: string): void {
  // buildDataPack emituje iba ASCII + numeric entities; deklarácia
  // Windows-1250 je preto byte-safe aj pri vytvorení Blob-u v prehliadači.
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

type ExportUnavailableReason = 'bankovy-vypis' | 'mzdy' | 'ciselny-rad' | 'ucto-nekompletne';

function exportUnavailableReason(
  document: DocumentItem,
  codeLists: { predkontacie: CodeListItem[]; cleneniaDph: CodeListItem[]; ciselneRady: CodeListItem[] },
): ExportUnavailableReason | undefined {
  if (document.typ === 'BV') return 'bankovy-vypis';
  if (document.typ === 'MZDY') return 'mzdy';
  // Export používa schválený snapshot; ak ešte neexistuje, aktuálne účtovanie.
  const ucto = document.approvedSnapshot ? document.approvedSnapshot.ucto : document.ucto;
  const hasActiveCode = (list: CodeListItem[], id: string | undefined): boolean =>
    Boolean(
      id &&
        list.some(
          (item) =>
            item.id === id &&
            item.tenantId === document.tenantId &&
            item.orgId === document.orgId &&
            item.active,
        ),
    );
  // Server vyžaduje všetky tri aktívne číselníky (server/pohodaXml.ts), preto ich
  // musíme skontrolovať aj v UI — inak doklad vyzerá exportovateľný a padne na 500.
  if (!hasActiveCode(codeLists.ciselneRady, ucto.ciselnyRadId)) return 'ciselny-rad';
  if (
    !hasActiveCode(codeLists.predkontacie, ucto.predkontaciaId) ||
    !hasActiveCode(codeLists.cleneniaDph, ucto.clenenieDphId)
  ) {
    return 'ucto-nekompletne';
  }
  return undefined;
}

export function ExportPage() {
  const { session } = useAuth();
  const { data, loading, error } = useDataQuery();
  const [tab, setTab] = useState<ExportTab>('novy');
  const [organizationId, setOrganizationId] = useState('');
  const [selected, setSelected] = useState<Set<string>>(() => new Set());
  const [busy, setBusy] = useState(false);
  const [lastExport, setLastExport] = useState<GenerateExportResult>();
  const [mostikStatus, setMostikStatus] = useState<OrganizationMostikStatus>();

  const organizations = useMemo(
    () => (data?.organizations ?? []).filter((organization) => !organization.archived),
    [data?.organizations],
  );

  useEffect(() => {
    if (!data || organizationId) return;
    if (
      data.currentOrgId !== 'all' &&
      organizations.some((organization) => organization.id === data.currentOrgId)
    ) {
      setOrganizationId(data.currentOrgId);
    }
  }, [data, organizationId, organizations]);

  useEffect(() => {
    setSelected(new Set());
    setLastExport(undefined);
  }, [organizationId]);

  useEffect(() => {
    let active = true;
    if (!organizationId) {
      setMostikStatus(undefined);
      return undefined;
    }
    void getOrganizationMostikStatus(organizationId)
      .then((status) => { if (active) setMostikStatus(status); })
      .catch(() => { if (active) setMostikStatus({ enabled: false, connected: false, matched: false, available: false }); });
    return () => { active = false; };
  }, [organizationId]);

  if (loading) return <p className="text-sm text-ink-soft">{t('stav.nacitavam')}</p>;
  if (error || !data) return <p className="text-sm text-red-700">{t('chyba.vseobecna')}</p>;

  const organizationMap = new Map(
    data.organizations.map((organization) => [organization.id, organization]),
  );
  const approvedDocuments = data.documents
    .filter(
      (document) =>
        document.orgId === organizationId && document.status === 'schvaleny',
    )
    .sort((left, right) => right.prijateDna.localeCompare(left.prijateDna));
  const unavailableReasons = new Map(
    approvedDocuments.map((document) => [
      document.id,
      exportUnavailableReason(document, data.codeLists),
    ]),
  );
  const selectableDocuments = approvedDocuments.filter(
    (document) => !unavailableReasons.get(document.id),
  );
  const missingSeriesCount = approvedDocuments.filter(
    (document) => unavailableReasons.get(document.id) === 'ciselny-rad',
  ).length;
  const selectableIds = new Set(selectableDocuments.map((document) => document.id));
  const allSelected =
    selectableDocuments.length > 0 &&
    selectableDocuments.every((document) => selected.has(document.id));
  const selectedIds = [...selected].filter((id) => selectableIds.has(id));
  const batches = [...data.exportBatches].sort(
    (left, right) => Date.parse(right.createdAt) - Date.parse(left.createdAt),
  );
  const preview = lastExport?.xml.split('\n').slice(0, 40).join('\n');

  async function createExport() {
    if (!organizationId || selectedIds.length === 0) return;
    setBusy(true);
    try {
      const result = await generateExport(organizationId, selectedIds);
      setLastExport(result);
      setSelected(new Set());
      downloadXml(result.xml, result.batch.xmlFileName);
      showToast(t('toast.exportHotovy'));
    } catch (error) {
      showToast(exportErrorMessage(error), { tone: 'error' });
    } finally {
      setBusy(false);
    }
  }

  async function downloadBatch(batchId: string) {
    setBusy(true);
    try {
      const result = await getBatchXml(batchId);
      downloadXml(result.xml, result.fileName);
    } catch (error) {
      showToast(exportErrorMessage(error), { tone: 'error' });
    } finally {
      setBusy(false);
    }
  }

  async function sendToPohoda() {
    if (!organizationId || selectedIds.length === 0 || !mostikStatus?.available) return;
    setBusy(true);
    try {
      await createMostikExportJob(organizationId, selectedIds, session?.csrfToken);
      setSelected(new Set());
      showToast(t('mostik.prenosVytvoreny'));
    } catch (error) {
      showToast(exportErrorMessage(error), { tone: 'error' });
    } finally {
      setBusy(false);
    }
  }

  return (
    <div>
      <h1 className="mb-4 text-xl font-semibold">{t('export.titulok')}</h1>

      <div className="mb-4 flex gap-1 border-b border-line" role="tablist">
        {(
          [
            ['novy', t('export.tab.novy')],
            ['historia', t('export.tab.historia')],
          ] as const
        ).map(([id, label]) => (
          <button
            key={id}
            type="button"
            role="tab"
            aria-selected={tab === id}
            className={`-mb-px rounded-t border-b-2 px-3 py-2 text-sm font-medium ${
              tab === id
                ? 'border-accent text-accent'
                : 'border-transparent text-ink-soft hover:text-ink'
            }`}
            onClick={() => setTab(id)}
          >
            {label}
          </button>
        ))}
      </div>

      {tab === 'novy' ? (
        <div className="space-y-4">
          <section className="card p-4">
            <label className="label" htmlFor="export-organization">
              {t('export.vyberOrg')}
            </label>
            <select
              id="export-organization"
              className="input max-w-md"
              value={organizationId}
              onChange={(event) => setOrganizationId(event.target.value)}
            >
              <option value="">{t('export.vyberOrg')}</option>
              {organizations.map((organization) => (
                <option key={organization.id} value={organization.id}>
                  {organization.nazov}
                </option>
              ))}
            </select>
            <p className="mt-1 text-xs text-ink-soft">{t('export.vyberOrgPopis')}</p>
          </section>

          {missingSeriesCount > 0 && (
            <div className="rounded border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-900">
              {t('export.chybajuciCiselnyRad')}
            </div>
          )}

          {!organizationId || approvedDocuments.length === 0 ? (
            <EmptyState>
              <p>{t('export.ziadneSchvalene')}</p>
            </EmptyState>
          ) : (
            <section className="card overflow-x-auto">
              <table className="w-full min-w-[800px] text-sm">
                <thead>
                  <tr className="border-b border-line text-left text-xs text-ink-soft">
                    <th className="w-10 px-3 py-2">
                      <input
                        type="checkbox"
                        checked={allSelected}
                        aria-label={t('doklady.bulk.vybranych')}
                        onChange={() =>
                          setSelected(
                            allSelected
                              ? new Set()
                              : new Set(selectableDocuments.map((document) => document.id)),
                          )
                        }
                      />
                    </th>
                    <th className="px-3 py-2 font-medium">{t('doklady.st.typ')}</th>
                    <th className="px-3 py-2 font-medium">{t('doklady.st.dodavatel')}</th>
                    <th className="px-3 py-2 font-medium">{t('doklady.st.cislo')}</th>
                    <th className="px-3 py-2 font-medium">{t('doklady.st.datumDodania')}</th>
                    <th className="px-3 py-2 text-right font-medium">{t('doklady.st.suma')}</th>
                  </tr>
                </thead>
                <tbody>
                  {approvedDocuments.map((document) => {
                    const reason = unavailableReasons.get(document.id);
                    const supported = !reason;
                    const tooltip =
                      reason === 'bankovy-vypis'
                        ? t('export.bvTooltip')
                        : reason === 'mzdy'
                          ? t('export.mzdyTooltip')
                          : reason === 'ciselny-rad'
                            ? t('export.ciselnyRadTooltip')
                            : reason === 'ucto-nekompletne'
                              ? t('export.uctoNekompletneTooltip')
                              : undefined;
                    return (
                      <tr
                        key={document.id}
                        className={`border-b border-line last:border-0 ${
                          supported ? '' : 'bg-app text-ink-soft'
                        }`}
                        title={tooltip}
                      >
                        <td className="px-3 py-2.5">
                          <input
                            type="checkbox"
                            disabled={!supported}
                            checked={supported && selected.has(document.id)}
                            aria-label={`${t('doklady.bulk.vybranych')}: ${document.extracted.cisloFaktury}`}
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
                        <td className="px-3 py-2.5">
                          <TypBadge typ={document.typ} />
                        </td>
                        <td className="px-3 py-2.5 font-medium">
                          {document.extracted.dodavatel.nazov}
                        </td>
                        <td className="tnum px-3 py-2.5">
                          {document.extracted.cisloFaktury}
                        </td>
                        <td className="tnum px-3 py-2.5">
                          {formatDate(document.extracted.datumDodania)}
                        </td>
                        <td className="tnum px-3 py-2.5 text-right font-medium">
                          {formatMoney(document.extracted.sumaSpolu, document.extracted.mena)}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
              <div className="flex items-center justify-between gap-3 border-t border-line px-4 py-3">
                <span className="tnum text-sm text-ink-soft">
                  {selectedIds.length} {t('doklady.bulk.vybranych')}
                </span>
                <div className="flex flex-wrap justify-end gap-2">
                  <button
                    type="button"
                    className="btn"
                    disabled={busy || data.role === 'schvalovatel' || selectedIds.length === 0}
                    onClick={() => void createExport()}
                  >
                    {t('export.generovat')}
                  </button>
                  <button
                    type="button"
                    className="btn btn-primary"
                    disabled={busy || data.role === 'schvalovatel' || selectedIds.length === 0 || !mostikStatus?.available}
                    title={!mostikStatus?.available ? t('mostik.nepripojenyTooltip') : undefined}
                    onClick={() => void sendToPohoda()}
                  >
                    {t('mostik.odoslat')}
                  </button>
                </div>
              </div>
            </section>
          )}

          {lastExport && preview && (
            <section className="card p-4">
              <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
                <h2 className="text-sm font-semibold">{t('export.nahladXml')}</h2>
                <button
                  type="button"
                  className="btn"
                  onClick={() => downloadXml(lastExport.xml, lastExport.batch.xmlFileName)}
                >
                  {t('export.stiahnut')}
                </button>
              </div>
              <pre className="max-h-96 overflow-auto rounded border border-line bg-slate-950 p-3 text-xs text-slate-100">
                {preview}
              </pre>
            </section>
          )}
        </div>
      ) : batches.length === 0 ? (
        <EmptyState>{t('export.hist.prazdne')}</EmptyState>
      ) : (
        <section className="card overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-line text-left text-xs text-ink-soft">
                <th className="px-3 py-2 font-medium">{t('export.hist.datum')}</th>
                <th className="px-3 py-2 font-medium">{t('export.hist.organizacia')}</th>
                <th className="px-3 py-2 text-right font-medium">{t('export.hist.pocet')}</th>
                <th className="px-3 py-2 font-medium">{t('export.hist.pouzivatel')}</th>
                <th className="px-3 py-2 text-right" />
              </tr>
            </thead>
            <tbody>
              {batches.map((batch) => {
                const organization = organizationMap.get(batch.orgId);
                return (
                  <tr key={batch.id} className="border-b border-line last:border-0">
                    <td className="tnum px-3 py-2.5">{formatDateTime(batch.createdAt)}</td>
                    <td className="px-3 py-2.5">
                      {organization ? <OrgChip org={organization} /> : '—'}
                    </td>
                    <td className="tnum px-3 py-2.5 text-right">
                      {batch.documentIds.length}
                    </td>
                    <td className="px-3 py-2.5">{batch.user}</td>
                    <td className="px-3 py-2.5 text-right">
                      <button
                        type="button"
                        className="btn"
                        disabled={busy}
                        onClick={() => void downloadBatch(batch.id)}
                      >
                        {t('export.hist.stiahnutZnova')}
                      </button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </section>
      )}
    </div>
  );
}

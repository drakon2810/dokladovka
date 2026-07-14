import { useMemo, useState } from 'react';
import {
  archiveQueue,
  createQueue,
  updateQueue,
} from '../../data/api';
import { useDataQuery } from '../../data/query';
import type {
  DocumentQueue,
  DocumentType,
  Organization,
  QueueKind,
} from '../../data/types';
import { ConfirmDialog, CopyButton, Modal, OrgDot } from '../../components/ui';
import { showToast } from '../../components/toast';
import { t, type SkKey } from '../../i18n/sk';

const QUEUE_KINDS: QueueKind[] = [
  'received_invoices',
  'issued_invoices',
  'cash_documents',
  'bank_statements',
  'payroll',
  'other',
];

const DEFAULT_DOCUMENT_TYPES: Record<QueueKind, DocumentType[]> = {
  received_invoices: ['FP', 'OZ'],
  issued_invoices: ['FV'],
  cash_documents: ['PD'],
  bank_statements: ['BV'],
  payroll: ['MZDY'],
  other: ['OZ'],
};

type QueueFeature = keyof DocumentQueue['features'];

const FEATURE_LABELS: Array<{ key: QueueFeature; label: SkKey }> = [
  { key: 'extraction', label: 'nast.fronty.funkcie.extrakcia' },
  { key: 'approval', label: 'nast.fronty.funkcie.schvalovanie' },
  { key: 'validation', label: 'nast.fronty.funkcie.validacia' },
  { key: 'spamDetection', label: 'nast.fronty.funkcie.spam' },
  { key: 'requireApprovalNote', label: 'nast.fronty.funkcie.povinnaPoznamka' },
  { key: 'autoAttachEmailAttachments', label: 'nast.fronty.funkcie.automatickePrilohy' },
];

function queueT(key: SkKey): string {
  return t(key);
}

function queueKindLabel(kind: QueueKind): string {
  return queueT(`nast.fronty.druh.${kind}` as SkKey);
}

function queueActionLabel(action: DocumentQueue['automation']['action']): string {
  if (action === 'move_to_validation') return queueT('nast.fronty.akcia.validacia');
  if (action === 'send_to_erp') return queueT('nast.fronty.akcia.erp');
  return queueT('nast.fronty.akcia.ziadna');
}

function errorMessage(cause: unknown, fallbackKey: SkKey): string {
  return cause instanceof Error && cause.message
    ? cause.message
    : queueT(fallbackKey);
}

export function QueuesTab() {
  const query = useDataQuery();
  const organizations = query.data?.organizations ?? [];
  const queues = query.data?.queues ?? [];
  const activeOrganizations = organizations.filter((organization) => !organization.archived);
  const [createOpen, setCreateOpen] = useState(false);
  const [editTarget, setEditTarget] = useState<DocumentQueue>();
  const [archiveTarget, setArchiveTarget] = useState<DocumentQueue>();
  const [actionError, setActionError] = useState('');

  const groups = useMemo(
    () =>
      organizations
        .map((organization) => ({
          organization,
          queues: queues
            .filter((queue) => queue.organizationId === organization.id)
            .sort((left, right) => {
              if (left.active !== right.active) return left.active ? -1 : 1;
              return left.name.localeCompare(right.name, 'sk');
            }),
        }))
        .sort((left, right) => left.organization.nazov.localeCompare(right.organization.nazov, 'sk')),
    [organizations, queues],
  );

  async function confirmArchive(queue: DocumentQueue) {
    setActionError('');
    try {
      await archiveQueue(queue.id);
      showToast(queueT('toast.frontaArchivovana'));
    } catch (cause) {
      const message = errorMessage(cause, 'nast.fronty.chybaArchivacie');
      setActionError(message);
      showToast(message, { tone: 'error' });
    }
  }

  if (query.loading) {
    return <p className="text-sm text-ink-soft">{t('stav.nacitavam')}</p>;
  }

  if (query.error) {
    return (
      <p className="rounded border border-red-200 bg-red-50 p-3 text-sm text-red-700" role="alert">
        {t('chyba.vseobecna')}
      </p>
    );
  }

  return (
    <div>
      <div className="mb-3 flex items-center justify-between gap-3">
        <p className="text-sm text-ink-soft">{queueT('nast.fronty.popis')}</p>
        <button
          type="button"
          className="btn btn-primary shrink-0"
          disabled={activeOrganizations.length === 0}
          onClick={() => {
            setActionError('');
            setCreateOpen(true);
          }}
        >
          + {queueT('nast.fronty.nova')}
        </button>
      </div>

      {actionError && (
        <p className="mb-3 rounded border border-red-200 bg-red-50 p-3 text-sm text-red-700" role="alert">
          {actionError}
        </p>
      )}

      <div className="space-y-4">
        {groups.map(({ organization, queues: organizationQueues }) => (
          <section key={organization.id} className="card overflow-hidden">
            <div className="flex items-center justify-between border-b border-line bg-app px-4 py-3">
              <h2 className="flex items-center gap-2 text-sm font-semibold">
                <OrgDot org={organization} />
                {organization.nazov}
              </h2>
              <span className="tnum text-xs text-ink-soft">{organizationQueues.length}</span>
            </div>

            {organizationQueues.length === 0 ? (
              <p className="px-4 py-6 text-center text-sm text-ink-soft">
                {queueT('nast.fronty.ziadne')}
              </p>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b border-line text-left text-xs text-ink-soft">
                      <th className="px-4 py-2 font-medium">{queueT('nast.fronty.nazov')}</th>
                      <th className="px-3 py-2 font-medium">{queueT('nast.fronty.druh')}</th>
                      <th className="px-3 py-2 font-medium">{queueT('nast.fronty.typyDokladov')}</th>
                      <th className="px-3 py-2 font-medium">{queueT('nast.fronty.importEmail')}</th>
                      <th className="px-3 py-2 font-medium">{queueT('nast.fronty.automatizacia')}</th>
                      <th className="px-3 py-2" />
                    </tr>
                  </thead>
                  <tbody>
                    {organizationQueues.map((queue) => (
                      <tr key={queue.id} className="border-b border-line last:border-0">
                        <td className="px-4 py-3">
                          <span className="font-medium">{queue.name}</span>
                          {!queue.active && (
                            <span className="ml-2 rounded border border-line bg-app px-1.5 py-0.5 text-xs text-ink-soft">
                              {queueT('nast.fronty.archivovana')}
                            </span>
                          )}
                          <div className="mt-1 flex max-w-xs flex-wrap gap-1">
                            {FEATURE_LABELS.filter(({ key }) => queue.features[key]).map(({ key, label }) => (
                              <span
                                key={key}
                                className="rounded bg-accent/10 px-1.5 py-0.5 text-[11px] text-accent"
                              >
                                {queueT(label)}
                              </span>
                            ))}
                          </div>
                        </td>
                        <td className="px-3 py-3">{queueKindLabel(queue.kind)}</td>
                        <td className="px-3 py-3">
                          <span className="flex flex-wrap gap-1">
                            {queue.documentTypes.map((documentType) => (
                              <span
                                key={documentType}
                                className="tnum rounded border border-line bg-app px-1.5 py-0.5 text-xs"
                              >
                                {documentType}
                              </span>
                            ))}
                          </span>
                        </td>
                        <td className="px-3 py-3">
                          {queue.importAlias ? (
                            <span className="flex min-w-max items-center gap-1">
                              <code className="tnum text-xs">{queue.importAlias}</code>
                              <CopyButton value={queue.importAlias} />
                            </span>
                          ) : (
                            '—'
                          )}
                        </td>
                        <td className="px-3 py-3 text-xs text-ink-soft">
                          {queueActionLabel(queue.automation.action)}
                          {queue.automation.action && queue.automation.minConfidence !== undefined && (
                            <span className="tnum ml-1">
                              ≥ {Math.round(queue.automation.minConfidence * 100)} %
                            </span>
                          )}
                        </td>
                        <td className="px-3 py-3 text-right whitespace-nowrap">
                          {queue.active && (
                            <>
                              <button
                                type="button"
                                className="btn mr-1 px-2 py-1 text-xs"
                                onClick={() => {
                                  setActionError('');
                                  setEditTarget(queue);
                                }}
                              >
                                {t('akcia.upravit')}
                              </button>
                              <button
                                type="button"
                                className="btn btn-danger px-2 py-1 text-xs"
                                onClick={() => {
                                  setActionError('');
                                  setArchiveTarget(queue);
                                }}
                              >
                                {queueT('nast.fronty.archivovat')}
                              </button>
                            </>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </section>
        ))}
      </div>

      {createOpen && (
        <CreateQueueModal
          organizations={activeOrganizations}
          onClose={() => setCreateOpen(false)}
          onSaved={() => {
            setCreateOpen(false);
            showToast(queueT('toast.frontaUlozena'));
          }}
        />
      )}

      {editTarget && (
        <EditQueueModal
          queue={editTarget}
          onClose={() => setEditTarget(undefined)}
          onSaved={() => {
            setEditTarget(undefined);
            showToast(queueT('toast.frontaUlozena'));
          }}
        />
      )}

      {archiveTarget && (
        <ConfirmDialog
          title={`${queueT('nast.fronty.archivovat')}: ${archiveTarget.name}`}
          text={queueT('nast.fronty.archivovatPotvrdenie')}
          confirmLabel={queueT('nast.fronty.archivovat')}
          danger
          onConfirm={() => void confirmArchive(archiveTarget)}
          onClose={() => setArchiveTarget(undefined)}
        />
      )}
    </div>
  );
}

function CreateQueueModal({
  organizations,
  onClose,
  onSaved,
}: {
  organizations: Organization[];
  onClose: () => void;
  onSaved: () => void;
}) {
  const [organizationId, setOrganizationId] = useState(organizations[0]?.id ?? '');
  const [name, setName] = useState('');
  const [kind, setKind] = useState<QueueKind>('received_invoices');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setSaving(true);
    setError('');
    try {
      await createQueue({
        organizationId,
        name,
        kind,
        documentTypes: DEFAULT_DOCUMENT_TYPES[kind],
      });
      onSaved();
    } catch (cause) {
      setError(errorMessage(cause, 'nast.fronty.chybaUlozenia'));
    } finally {
      setSaving(false);
    }
  }

  return (
    <Modal title={queueT('nast.fronty.nova')} onClose={onClose}>
      <form className="space-y-3" onSubmit={submit}>
        <label className="block">
          <span className="label">{queueT('nast.fronty.organizacia')}</span>
          <select
            className="input"
            required
            value={organizationId}
            onChange={(event) => setOrganizationId(event.target.value)}
          >
            {organizations.map((organization) => (
              <option key={organization.id} value={organization.id}>
                {organization.nazov}
              </option>
            ))}
          </select>
        </label>

        <label className="block">
          <span className="label">{queueT('nast.fronty.nazov')}</span>
          <input
            className="input"
            required
            value={name}
            onChange={(event) => setName(event.target.value)}
          />
        </label>

        <label className="block">
          <span className="label">{queueT('nast.fronty.druh')}</span>
          <select
            className="input"
            value={kind}
            onChange={(event) => setKind(event.target.value as QueueKind)}
          >
            {QUEUE_KINDS.map((queueKind) => (
              <option key={queueKind} value={queueKind}>
                {queueKindLabel(queueKind)}
              </option>
            ))}
          </select>
        </label>

        <div className="rounded border border-line bg-app p-3 text-sm">
          <span className="text-ink-soft">{queueT('nast.fronty.typyDokladov')}: </span>
          <span className="tnum">{DEFAULT_DOCUMENT_TYPES[kind].join(', ')}</span>
        </div>

        {error && (
          <p className="rounded border border-red-200 bg-red-50 p-2 text-sm text-red-700" role="alert">
            {error}
          </p>
        )}

        <div className="flex justify-end gap-2 pt-2">
          <button type="button" className="btn" onClick={onClose}>
            {t('akcia.zrusit')}
          </button>
          <button type="submit" className="btn btn-primary" disabled={saving || !organizationId}>
            {saving ? t('stav.nacitavam') : queueT('nast.fronty.nova')}
          </button>
        </div>
      </form>
    </Modal>
  );
}

function EditQueueModal({
  queue,
  onClose,
  onSaved,
}: {
  queue: DocumentQueue;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [name, setName] = useState(queue.name);
  const [features, setFeatures] = useState({ ...queue.features });
  const [warningThreshold, setWarningThreshold] = useState(
    String(Math.round((queue.warningThreshold ?? 0.8) * 100)),
  );
  const [automationAction, setAutomationAction] = useState<
    DocumentQueue['automation']['action'] | ''
  >(queue.automation.action ?? '');
  const [minConfidence, setMinConfidence] = useState(
    String(Math.round((queue.automation.minConfidence ?? 0.9) * 100)),
  );
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  function toggleFeature(feature: QueueFeature) {
    setFeatures((current) => ({ ...current, [feature]: !current[feature] }));
  }

  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const warning = Number(warningThreshold);
    const confidence = Number(minConfidence);
    if (
      !Number.isFinite(warning) ||
      warning < 0 ||
      warning > 100 ||
      (automationAction && (!Number.isFinite(confidence) || confidence < 0 || confidence > 100))
    ) {
      setError(queueT('nast.fronty.prahChyba'));
      return;
    }

    setSaving(true);
    setError('');
    try {
      await updateQueue(queue.id, {
        name,
        features,
        warningThreshold: warning / 100,
        automation: automationAction
          ? { action: automationAction, minConfidence: confidence / 100 }
          : {},
      });
      onSaved();
    } catch (cause) {
      setError(errorMessage(cause, 'nast.fronty.chybaUlozenia'));
    } finally {
      setSaving(false);
    }
  }

  return (
    <Modal title={`${t('akcia.upravit')}: ${queue.name}`} onClose={onClose} wide>
      <form className="space-y-5" onSubmit={submit}>
        <label className="block">
          <span className="label">{queueT('nast.fronty.nazov')}</span>
          <input
            className="input"
            required
            value={name}
            onChange={(event) => setName(event.target.value)}
          />
        </label>

        <fieldset>
          <legend className="mb-2 text-sm font-semibold">{queueT('nast.fronty.funkcie')}</legend>
          <div className="grid gap-2 sm:grid-cols-2">
            {FEATURE_LABELS.map(({ key, label }) => (
              <label
                key={key}
                className="flex items-start gap-2 rounded border border-line bg-app px-3 py-2 text-sm"
              >
                <input
                  className="mt-0.5"
                  type="checkbox"
                  checked={features[key]}
                  onChange={() => toggleFeature(key)}
                />
                <span>{queueT(label)}</span>
              </label>
            ))}
          </div>
        </fieldset>

        <label className="block">
          <span className="label">{queueT('nast.fronty.prahUpozornenia')}</span>
          <span className="flex items-center gap-2">
            <input
              className="input tnum max-w-28"
              type="number"
              min="0"
              max="100"
              step="1"
              required
              value={warningThreshold}
              onChange={(event) => setWarningThreshold(event.target.value)}
            />
            <span className="text-sm text-ink-soft">%</span>
          </span>
        </label>

        <fieldset className="rounded border border-line p-3">
          <legend className="px-1 text-sm font-semibold">{queueT('nast.fronty.automatizacia')}</legend>
          <div className="grid gap-3 sm:grid-cols-2">
            <label>
              <span className="label">{queueT('nast.fronty.akcia')}</span>
              <select
                className="input"
                value={automationAction}
                onChange={(event) =>
                  setAutomationAction(
                    event.target.value as DocumentQueue['automation']['action'] | '',
                  )
                }
              >
                <option value="">{queueT('nast.fronty.akcia.ziadna')}</option>
                <option value="move_to_validation">{queueT('nast.fronty.akcia.validacia')}</option>
                <option value="send_to_erp" disabled>
                  {queueT('nast.fronty.akcia.erpNedostupne')}
                </option>
              </select>
            </label>
            <label>
              <span className="label">{queueT('nast.fronty.minIstota')}</span>
              <span className="flex items-center gap-2">
                <input
                  className="input tnum"
                  type="number"
                  min="0"
                  max="100"
                  step="1"
                  required={Boolean(automationAction)}
                  disabled={!automationAction}
                  value={minConfidence}
                  onChange={(event) => setMinConfidence(event.target.value)}
                />
                <span className="text-sm text-ink-soft">%</span>
              </span>
            </label>
          </div>
        </fieldset>

        {error && (
          <p className="rounded border border-red-200 bg-red-50 p-2 text-sm text-red-700" role="alert">
            {error}
          </p>
        )}

        <div className="flex justify-end gap-2">
          <button type="button" className="btn" onClick={onClose}>
            {t('akcia.zrusit')}
          </button>
          <button type="submit" className="btn btn-primary" disabled={saving}>
            {saving ? t('stav.nacitavam') : t('akcia.ulozit')}
          </button>
        </div>
      </form>
    </Modal>
  );
}

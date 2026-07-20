// E-mailové schránky — SPEC §6.6, §11.19 a §11.20.
// Komponent číta dáta iba cez async query boundary a všetky mutácie deleguje
// servisnej vrstve, aby sa mock dal neskôr nahradiť REST API bez zmeny UI.
import { useMemo, useState, type FormEvent } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  assignInboundEmailToOrg,
  disableAlias,
  regenerateAlias,
  simulateInboundEmail,
} from '../../data/api';
import { useDataQuery } from '../../data/query';
import type {
  AliasStatus,
  AttachmentStatus,
  InboundEmail,
  InboundEmailStatus,
  Organization,
  OrganizationEmailAlias,
  SimulateInboundEmailResult,
  SimulationScenario,
} from '../../data/types';
import { t, type SkKey } from '../../i18n/sk';
import { ConfirmDialog, CopyButton, Modal, OrgDot } from '../../components/ui';
import { showToast } from '../../components/toast';

const ALIAS_STATUS_KEYS: Record<AliasStatus, SkKey> = {
  active: 'schranky.alias.active',
  grace_period: 'schranky.alias.grace_period',
  disabled: 'schranky.alias.disabled',
};

const INBOUND_STATUS_KEYS: Record<InboundEmailStatus, SkKey> = {
  received: 'inbound.received',
  queued: 'inbound.queued',
  processed: 'inbound.processed',
  partially_processed: 'inbound.partially_processed',
  quarantine: 'inbound.quarantine',
  failed: 'inbound.failed',
};

const ATTACHMENT_STATUS_KEYS: Record<AttachmentStatus, SkKey> = {
  received: 'inbound.priloha.received',
  ignored_inline: 'inbound.priloha.ignored_inline',
  stored: 'inbound.priloha.stored',
  queued: 'inbound.priloha.queued',
  processing: 'inbound.priloha.processing',
  document_created: 'inbound.priloha.document_created',
  duplicate: 'inbound.priloha.duplicate',
  quarantine: 'inbound.priloha.quarantine',
  failed: 'inbound.priloha.failed',
};

const SCENARIOS: Array<{ value: SimulationScenario; label: SkKey }> = [
  { value: 'uspech', label: 'sim.scenar.uspech' },
  { value: 'nizka_istota', label: 'sim.scenar.nizka_istota' },
  { value: 'duplicita', label: 'sim.scenar.duplicita' },
  { value: 'ico_mismatch', label: 'sim.scenar.ico_mismatch' },
  { value: 'poskodeny_subor', label: 'sim.scenar.poskodeny_subor' },
  { value: 'password_protected_pdf', label: 'sim.scenar.password_protected_pdf' },
  { value: 'ambiguous_recipient', label: 'sim.scenar.ambiguous_recipient' },
  { value: 'nepodporovany_typ', label: 'sim.scenar.nepodporovany_typ' },
];

const QUARANTINE_REASON_KEYS: Record<string, SkKey> = {
  unknown_alias: 'detail.karantena.unknown_alias',
  sender_not_whitelisted: 'detail.karantena.sender_not_whitelisted',
  alias_disabled: 'detail.karantena.alias_disabled',
  ambiguous_recipient: 'detail.karantena.ambiguous_recipient',
  organization_archived: 'detail.karantena.organization_archived',
  buyer_ico_mismatch: 'detail.karantena.buyer_ico_mismatch',
  corrupted_file: 'detail.karantena.corrupted_file',
  password_protected_pdf: 'detail.karantena.password_protected_pdf',
  no_supported_attachment: 'detail.karantena.no_supported_attachment',
  unsupported_type: 'detail.karantena.unsupported_type',
};

function quarantineReasonLabel(reason: string | undefined): string | undefined {
  return reason ? t(QUARANTINE_REASON_KEYS[reason] ?? 'detail.karantena.banner') : undefined;
}

const CUSTOM_ALIAS = '__custom_alias__';
const THIRTY_DAYS_MS = 30 * 24 * 60 * 60 * 1000;
const DATE_TIME = new Intl.DateTimeFormat('sk-SK', {
  dateStyle: 'short',
  timeStyle: 'short',
});

function formatDate(value?: string): string {
  if (!value) return '—';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? '—' : DATE_TIME.format(date);
}

function AliasBadge({ status }: { status: AliasStatus }) {
  const style =
    status === 'active'
      ? 'border-green-200 bg-green-50 text-green-800'
      : status === 'grace_period'
        ? 'border-amber-200 bg-amber-50 text-amber-800'
        : 'border-line bg-app text-ink-soft';
  return (
    <span className={`inline-flex rounded border px-1.5 py-0.5 text-xs font-medium ${style}`}>
      {t(ALIAS_STATUS_KEYS[status])}
    </span>
  );
}

function InboundBadge({ status }: { status: InboundEmailStatus }) {
  const style =
    status === 'failed'
      ? 'border-red-200 bg-red-50 text-red-800'
      : status === 'quarantine'
        ? 'border-amber-200 bg-amber-50 text-amber-800'
        : status === 'processed'
          ? 'border-green-200 bg-green-50 text-green-800'
          : 'border-sky-200 bg-sky-50 text-sky-800';
  return (
    <span className={`inline-flex rounded border px-1.5 py-0.5 text-xs font-medium ${style}`}>
      {t(INBOUND_STATUS_KEYS[status])}
    </span>
  );
}

function AttachmentBadge({ status }: { status: AttachmentStatus }) {
  const problem = status === 'failed' || status === 'quarantine' || status === 'duplicate';
  return (
    <span
      className={`inline-flex rounded border px-1.5 py-0.5 text-xs font-medium ${
        problem
          ? 'border-amber-200 bg-amber-50 text-amber-800'
          : 'border-line bg-app text-ink-soft'
      }`}
    >
      {t(ATTACHMENT_STATUS_KEYS[status])}
    </span>
  );
}

export function MailboxesTab() {
  const { data, loading, error } = useDataQuery();
  const [selectedOrgId, setSelectedOrgId] = useState<string>();
  const [simulationOpen, setSimulationOpen] = useState(false);
  const [regenerateTarget, setRegenerateTarget] = useState<Organization>();
  const [disableTarget, setDisableTarget] = useState<OrganizationEmailAlias>();
  const [assignmentTargets, setAssignmentTargets] = useState<Record<string, string>>({});
  const [assigningEmailId, setAssigningEmailId] = useState<string>();

  const sortedEmails = useMemo(
    () =>
      [...(data?.inboundEmails ?? [])].sort(
        (left, right) => Date.parse(right.receivedAt) - Date.parse(left.receivedAt),
      ),
    [data?.inboundEmails],
  );

  if (loading) return <p className="text-sm text-ink-soft">{t('stav.nacitavam')}</p>;
  if (error || !data) return <p className="text-sm text-red-700">{t('chyba.vseobecna')}</p>;

  const organizations = data.organizations;
  const activeOrganizations = organizations.filter((organization) => !organization.archived);
  const aliases = data.aliases;
  const selectedOrganization = organizations.find(
    (organization) => organization.id === selectedOrgId,
  );
  const activeAliases = aliases.filter(
    (alias) =>
      alias.status !== 'disabled' &&
      activeOrganizations.some((organization) => organization.id === alias.organizationId),
  );
  const unassignedEmails = sortedEmails.filter(
    (email) => !email.organizationId && email.status === 'quarantine',
  );

  const primaryAlias = (organizationId: string) =>
    aliases.find(
      (alias) => alias.organizationId === organizationId && alias.isPrimary,
    ) ?? aliases.find((alias) => alias.organizationId === organizationId && alias.status === 'active');

  const emailsFor = (organizationId: string) =>
    sortedEmails.filter((email) => email.organizationId === organizationId);

  async function assignEmail(email: InboundEmail) {
    const organizationId =
      assignmentTargets[email.id] ?? activeOrganizations[0]?.id ?? '';
    if (!organizationId) return;
    setAssigningEmailId(email.id);
    try {
      await assignInboundEmailToOrg(email.id, organizationId);
      showToast(t('toast.ulozene'));
    } catch {
      showToast(t('chyba.vseobecna'), { tone: 'error' });
    } finally {
      setAssigningEmailId(undefined);
    }
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h2 className="text-lg font-semibold">{t('schranky.titulok')}</h2>
        <button type="button" className="btn btn-primary" onClick={() => setSimulationOpen(true)}>
          {t('schranky.simulovat')}
        </button>
      </div>

      <section className="card p-4" aria-labelledby="mail-system-status">
        <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
          <h3 id="mail-system-status" className="font-semibold">
            {t('schranky.systemStatus')}
          </h3>
          <p className="text-xs text-ink-soft">{t('schranky.status.mock')}</p>
        </div>
        <div className="grid gap-2 sm:grid-cols-2 xl:grid-cols-4">
          <HealthCard label={t('schranky.status.domena')} />
          <HealthCard label={t('schranky.status.mx')} />
          <HealthCard label={t('schranky.status.webhook')} />
          <div className="rounded border border-line bg-app px-3 py-2">
            <p className="text-xs text-ink-soft">{t('schranky.status.posledny')}</p>
            <p className="tnum mt-1 text-sm font-medium">{formatDate(sortedEmails[0]?.receivedAt)}</p>
          </div>
        </div>
      </section>

      <section className="card overflow-x-auto" aria-labelledby="mailbox-table-title">
        <h3 id="mailbox-table-title" className="sr-only">
          {t('schranky.titulok')}
        </h3>
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-line text-left text-xs text-ink-soft">
              <th className="px-3 py-2 font-medium">{t('schranky.st.organizacia')}</th>
              <th className="px-3 py-2 font-medium">{t('schranky.st.email')}</th>
              <th className="px-3 py-2 font-medium">{t('schranky.st.stav')}</th>
              <th className="px-3 py-2 font-medium">{t('schranky.st.posledny')}</th>
              <th className="px-3 py-2 text-right font-medium">{t('schranky.st.spravy30')}</th>
              <th className="px-3 py-2 text-right font-medium">{t('schranky.st.akcie')}</th>
            </tr>
          </thead>
          <tbody>
            {organizations.map((organization) => {
              const alias = primaryAlias(organization.id);
              const messages = emailsFor(organization.id);
              const recentCount = messages.filter(
                (email) => Date.now() - Date.parse(email.receivedAt) <= THIRTY_DAYS_MS,
              ).length;
              return (
                <tr key={organization.id} className="border-b border-line last:border-0">
                  <td className="px-3 py-2.5">
                    <span className="flex items-center gap-2 font-medium">
                      <OrgDot org={organization} />
                      {organization.nazov}
                    </span>
                  </td>
                  <td className="px-3 py-2.5">
                    {alias ? (
                      <span className="flex items-center gap-2">
                        <code className="tnum text-xs">{alias.address}</code>
                        <CopyButton value={alias.address} />
                      </span>
                    ) : (
                      '—'
                    )}
                  </td>
                  <td className="px-3 py-2.5">{alias ? <AliasBadge status={alias.status} /> : '—'}</td>
                  <td className="tnum px-3 py-2.5">{formatDate(messages[0]?.receivedAt)}</td>
                  <td className="tnum px-3 py-2.5 text-right">{recentCount}</td>
                  <td className="px-3 py-2.5 text-right">
                    <button
                      type="button"
                      className="btn px-2 py-1 text-xs"
                      onClick={() =>
                        setSelectedOrgId((current) =>
                          current === organization.id ? undefined : organization.id,
                        )
                      }
                      aria-expanded={selectedOrgId === organization.id}
                    >
                      {t('akcia.detail')}
                    </button>
                  </td>
                </tr>
              );
            })}
            {organizations.length === 0 && (
              <tr>
                <td className="px-3 py-8 text-center text-ink-soft" colSpan={6}>
                  {t('stav.ziadneData')}
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </section>

      {selectedOrganization && (
        <MailboxDetail
          organization={selectedOrganization}
          aliases={aliases.filter((alias) => alias.organizationId === selectedOrganization.id)}
          emails={emailsFor(selectedOrganization.id)}
          onRegenerate={() => setRegenerateTarget(selectedOrganization)}
          onDisable={setDisableTarget}
        />
      )}

      {unassignedEmails.length > 0 && (
        <section className="card overflow-x-auto" aria-labelledby="unassigned-email-title">
          <h3 id="unassigned-email-title" className="border-b border-line px-4 py-3 font-semibold">
            {t('inbound.quarantine')}
          </h3>
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-line text-left text-xs text-ink-soft">
                <th className="px-3 py-2 font-medium">{t('sim.prijemca')}</th>
                <th className="px-3 py-2 font-medium">{t('sim.odosielatel')}</th>
                <th className="px-3 py-2 font-medium">{t('sim.predmet')}</th>
                <th className="px-3 py-2 font-medium">{t('schranky.st.stav')}</th>
                <th className="px-3 py-2 text-right font-medium">{t('schranky.st.akcie')}</th>
              </tr>
            </thead>
            <tbody>
              {unassignedEmails.map((email) => {
                const target =
                  assignmentTargets[email.id] ?? activeOrganizations[0]?.id ?? '';
                return (
                  <tr key={email.id} className="border-b border-line last:border-0">
                    <td className="px-3 py-2.5">
                      <code className="text-xs">{email.envelopeRecipients.join(', ')}</code>
                    </td>
                    <td className="px-3 py-2.5">{email.senderEmail ?? '—'}</td>
                    <td className="px-3 py-2.5">
                      <p>{email.subject ?? '—'}</p>
                      {email.quarantineReason && (
                        <p className="mt-0.5 text-xs text-amber-700">
                          {quarantineReasonLabel(email.quarantineReason)}
                        </p>
                      )}
                    </td>
                    <td className="px-3 py-2.5">
                      <InboundBadge status={email.status} />
                    </td>
                    <td className="px-3 py-2.5">
                      <div className="flex justify-end gap-2">
                        <select
                          className="input w-auto min-w-48"
                          value={target}
                          onChange={(event) =>
                            setAssignmentTargets((current) => ({
                              ...current,
                              [email.id]: event.target.value,
                            }))
                          }
                          aria-label={t('schranky.priraditOrg')}
                        >
                          {activeOrganizations.map((organization) => (
                            <option key={organization.id} value={organization.id}>
                              {organization.nazov}
                            </option>
                          ))}
                        </select>
                        <button
                          type="button"
                          className="btn btn-primary whitespace-nowrap"
                          disabled={!target || assigningEmailId === email.id}
                          onClick={() => void assignEmail(email)}
                        >
                          {t('schranky.priraditOrg')}
                        </button>
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </section>
      )}

      {simulationOpen && (
        <SimulationModal aliases={activeAliases} onClose={() => setSimulationOpen(false)} />
      )}

      {regenerateTarget && (
        <ConfirmDialog
          title={`${t('schranky.regenerovat')}: ${regenerateTarget.nazov}`}
          text={t('schranky.regenerovatPotvrdenie')}
          confirmLabel={t('schranky.regenerovat')}
          onConfirm={() => {
            void regenerateAlias(regenerateTarget.id)
              .then(() => showToast(t('toast.aliasVygenerovany')))
              .catch(() => showToast(t('chyba.vseobecna'), { tone: 'error' }));
          }}
          onClose={() => setRegenerateTarget(undefined)}
        />
      )}

      {disableTarget && (
        <ConfirmDialog
          title={t('schranky.vypnutAlias')}
          text={t('schranky.vypnutAliasPotvrdenie')}
          confirmLabel={t('schranky.vypnutAlias')}
          danger
          onConfirm={() => {
            void disableAlias(disableTarget.id)
              .then(() => showToast(t('toast.ulozene')))
              .catch(() => showToast(t('chyba.vseobecna'), { tone: 'error' }));
          }}
          onClose={() => setDisableTarget(undefined)}
        />
      )}
    </div>
  );
}

function HealthCard({ label }: { label: string }) {
  return (
    <div className="flex items-center gap-2 rounded border border-line bg-app px-3 py-2">
      <span
        className="flex h-5 w-5 items-center justify-center rounded-full bg-green-100 text-xs font-bold text-green-800"
        aria-hidden
      >
        ✓
      </span>
      <span className="text-sm font-medium">{label}</span>
    </div>
  );
}

function MailboxDetail({
  organization,
  aliases,
  emails,
  onRegenerate,
  onDisable,
}: {
  organization: Organization;
  aliases: OrganizationEmailAlias[];
  emails: InboundEmail[];
  onRegenerate: () => void;
  onDisable: (alias: OrganizationEmailAlias) => void;
}) {
  const sortedAliases = [...aliases].sort(
    (left, right) => Date.parse(right.createdAt) - Date.parse(left.createdAt),
  );
  return (
    <section className="card p-4" aria-labelledby={`mailbox-detail-${organization.id}`}>
      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <h3 id={`mailbox-detail-${organization.id}`} className="flex items-center gap-2 font-semibold">
          <OrgDot org={organization} />
          {organization.nazov}
        </h3>
        <button type="button" className="btn" onClick={onRegenerate}>
          {t('schranky.regenerovat')}
        </button>
      </div>

      <h4 className="mb-2 text-sm font-semibold">{t('schranky.aliasy')}</h4>
      <div className="mb-5 overflow-x-auto rounded border border-line">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-line bg-app text-left text-xs text-ink-soft">
              <th className="px-3 py-2 font-medium">{t('schranky.st.email')}</th>
              <th className="px-3 py-2 font-medium">{t('schranky.st.stav')}</th>
              <th className="px-3 py-2 font-medium">{t('schranky.vytvoreny')}</th>
              <th className="px-3 py-2 font-medium">{t('schranky.grace')}</th>
              <th className="px-3 py-2 font-medium">{t('schranky.vypnuty')}</th>
              <th className="px-3 py-2 font-medium">{t('schranky.status.webhook')}</th>
              <th className="px-3 py-2 text-right font-medium">{t('schranky.st.akcie')}</th>
            </tr>
          </thead>
          <tbody>
            {sortedAliases.map((alias) => (
              <tr key={alias.id} className="border-b border-line last:border-0">
                <td className="px-3 py-2.5">
                  <span className="flex items-center gap-2">
                    <code className="tnum text-xs">{alias.address}</code>
                    {alias.isPrimary && (
                      <span className="rounded border border-line bg-app px-1.5 py-0.5 text-xs text-ink-soft">
                        {t('schranky.primarny')}
                      </span>
                    )}
                  </span>
                </td>
                <td className="px-3 py-2.5">
                  <AliasBadge status={alias.status} />
                </td>
                <td className="tnum px-3 py-2.5">{formatDate(alias.createdAt)}</td>
                <td className="tnum px-3 py-2.5">{formatDate(alias.graceUntil)}</td>
                <td className="tnum px-3 py-2.5">{formatDate(alias.disabledAt)}</td>
                <td className="px-3 py-2.5 text-green-700">
                  {alias.status === 'disabled' ? '—' : '✓'}
                </td>
                <td className="px-3 py-2.5 text-right">
                  <span className="inline-flex gap-1">
                    <CopyButton value={alias.address} />
                    {!alias.isPrimary && alias.status !== 'disabled' && (
                      <button
                        type="button"
                        className="btn btn-danger px-2 py-1 text-xs"
                        onClick={() => onDisable(alias)}
                      >
                        {t('schranky.vypnutAlias')}
                      </button>
                    )}
                  </span>
                </td>
              </tr>
            ))}
            {sortedAliases.length === 0 && (
              <tr>
                <td className="px-3 py-6 text-center text-ink-soft" colSpan={7}>
                  {t('stav.ziadneData')}
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      <h4 className="mb-2 text-sm font-semibold">{t('schranky.posledneSpravy')}</h4>
      {emails.length === 0 ? (
        <p className="rounded border border-line bg-app px-3 py-5 text-center text-sm text-ink-soft">
          {t('schranky.ziadneSpravy')}
        </p>
      ) : (
        <div className="overflow-x-auto rounded border border-line">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-line bg-app text-left text-xs text-ink-soft">
                <th className="px-3 py-2 font-medium">{t('schranky.st.posledny')}</th>
                <th className="px-3 py-2 font-medium">{t('sim.odosielatel')}</th>
                <th className="px-3 py-2 font-medium">{t('sim.predmet')}</th>
                <th className="px-3 py-2 text-right font-medium">{t('sim.prilohy')}</th>
                <th className="px-3 py-2 font-medium">{t('schranky.st.stav')}</th>
              </tr>
            </thead>
            <tbody>
              {emails.map((email) => (
                <tr key={email.id} className="border-b border-line last:border-0">
                  <td className="tnum px-3 py-2.5">{formatDate(email.receivedAt)}</td>
                  <td className="px-3 py-2.5">{email.senderEmail ?? '—'}</td>
                  <td className="px-3 py-2.5">
                    <p>{email.subject ?? '—'}</p>
                    {(email.processingErrorMessage || email.quarantineReason) && (
                      <p className="mt-0.5 text-xs text-amber-700">
                        {email.processingErrorMessage ?? quarantineReasonLabel(email.quarantineReason)}
                      </p>
                    )}
                  </td>
                  <td className="tnum px-3 py-2.5 text-right">{email.attachmentCount}</td>
                  <td className="px-3 py-2.5">
                    <InboundBadge status={email.status} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

interface AttachmentDraft {
  id: number;
  fileName: string;
  contentSeed: string;
}

function makeAttachment(index: number): AttachmentDraft {
  return {
    id: index,
    fileName: `faktura-demo-${index}.pdf`,
    contentSeed: `dokladovka-sample-${index}`,
  };
}

function SimulationModal({
  aliases,
  onClose,
}: {
  aliases: OrganizationEmailAlias[];
  onClose: () => void;
}) {
  const navigate = useNavigate();
  const [recipient, setRecipient] = useState(aliases[0]?.address ?? CUSTOM_ALIAS);
  const [customAlias, setCustomAlias] = useState('');
  const [sender, setSender] = useState('fakturacia@dodavatel.sk');
  const [subject, setSubject] = useState('');
  const [scenario, setScenario] = useState<SimulationScenario>('uspech');
  const [attachments, setAttachments] = useState<AttachmentDraft[]>([makeAttachment(1)]);
  const [nextAttachmentId, setNextAttachmentId] = useState(2);
  const [result, setResult] = useState<SimulateInboundEmailResult>();
  const [saving, setSaving] = useState(false);
  const [failed, setFailed] = useState(false);

  const routedAlias = recipient === CUSTOM_ALIAS ? customAlias.trim() : recipient;

  function addAttachment() {
    if (attachments.length >= 5) return;
    setAttachments((current) => [...current, makeAttachment(nextAttachmentId)]);
    setNextAttachmentId((current) => current + 1);
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setSaving(true);
    setFailed(false);
    setResult(undefined);
    try {
      const unsupported = scenario === 'nepodporovany_typ';
      const simulation = await simulateInboundEmail({
        recipientAlias: routedAlias,
        additionalRecipientAliases:
          scenario === 'ambiguous_recipient'
            ? [
                aliases.find(
                  (alias) =>
                    alias.address !== routedAlias &&
                    alias.organizationId !==
                      aliases.find((item) => item.address === routedAlias)?.organizationId,
                )?.address ?? '',
              ].filter(Boolean)
            : undefined,
        sender,
        subject,
        scenario,
        attachments: attachments.map((attachment) => ({
          fileName: unsupported
            ? attachment.fileName.replace(/\.pdf$/i, '.txt')
            : attachment.fileName,
          mimeType: unsupported ? 'text/plain' : 'application/pdf',
          contentSeed: attachment.contentSeed,
        })),
      });
      setResult(simulation);

      const firstDocumentId = simulation.createdDocumentIds[0];
      const quarantined =
        simulation.inboundEmail.status === 'quarantine' ||
        simulation.attachments.some((attachment) => attachment.status === 'quarantine');
      const duplicated = simulation.attachments.some(
        (attachment) => attachment.status === 'duplicate',
      );
      if (firstDocumentId) {
        showToast(t('sim.toast.vytvorene'), {
          actionLabel: t('sim.toast.zobrazit'),
          onAction: () => navigate(`/doklady/${firstDocumentId}`),
        });
      } else if (duplicated) {
        showToast(t('sim.vysledok.duplicate'), { tone: 'info' });
      } else if (quarantined) {
        showToast(t('sim.vysledok.quarantine'), { tone: 'info' });
      }
    } catch {
      setFailed(true);
      showToast(t('chyba.vseobecna'), { tone: 'error' });
    } finally {
      setSaving(false);
    }
  }

  const quarantined =
    result?.inboundEmail.status === 'quarantine' ||
    result?.attachments.some((attachment) => attachment.status === 'quarantine');
  const duplicated = result?.attachments.some((attachment) => attachment.status === 'duplicate');

  return (
    <Modal title={t('sim.titulok')} onClose={onClose} wide>
      <p className="mb-4 text-sm text-ink-soft">{t('sim.popis')}</p>
      <form className="space-y-4" onSubmit={submit}>
        <div>
          <label className="label" htmlFor="simulation-recipient">
            {t('sim.prijemca')}
          </label>
          <select
            id="simulation-recipient"
            className="input"
            value={recipient}
            onChange={(event) => setRecipient(event.target.value)}
          >
            {aliases.map((alias) => (
              <option key={alias.id} value={alias.address}>
                {alias.address}
              </option>
            ))}
            <option value={CUSTOM_ALIAS}>{t('sim.vlastnyAlias')}</option>
          </select>
          {recipient === CUSTOM_ALIAS && (
            <input
              className="input mt-2"
              type="email"
              value={customAlias}
              onChange={(event) => setCustomAlias(event.target.value)}
              placeholder={t('sim.vlastnyAlias')}
              aria-label={t('sim.vlastnyAlias')}
              required
            />
          )}
        </div>

        <div className="grid gap-3 sm:grid-cols-2">
          <div>
            <label className="label" htmlFor="simulation-sender">
              {t('sim.odosielatel')}
            </label>
            <input
              id="simulation-sender"
              className="input"
              type="email"
              value={sender}
              onChange={(event) => setSender(event.target.value)}
              required
            />
          </div>
          <div>
            <label className="label" htmlFor="simulation-subject">
              {t('sim.predmet')}
            </label>
            <input
              id="simulation-subject"
              className="input"
              value={subject}
              onChange={(event) => setSubject(event.target.value)}
              required
            />
          </div>
        </div>

        <div>
          <label className="label" htmlFor="simulation-scenario">
            {t('sim.scenar')}
          </label>
          <select
            id="simulation-scenario"
            className="input"
            value={scenario}
            onChange={(event) => setScenario(event.target.value as SimulationScenario)}
          >
            {SCENARIOS.map((item) => (
              <option key={item.value} value={item.value}>
                {t(item.label)}
              </option>
            ))}
          </select>
        </div>

        <fieldset>
          <legend className="label">{t('sim.prilohy')}</legend>
          <div className="space-y-2">
            {attachments.map((attachment) => (
              <div key={attachment.id} className="flex items-center gap-2">
                <input
                  className="input"
                  value={attachment.fileName}
                  onChange={(event) =>
                    setAttachments((current) =>
                      current.map((item) =>
                        item.id === attachment.id
                          ? { ...item, fileName: event.target.value }
                          : item,
                      ),
                    )
                  }
                  aria-label={t('sim.prilohy')}
                  required
                />
                <code className="hidden whitespace-nowrap text-xs text-ink-soft sm:block">
                  {scenario === 'nepodporovany_typ' ? 'text/plain' : 'application/pdf'}
                </code>
                {attachments.length > 1 && (
                  <button
                    type="button"
                    className="btn btn-danger px-2 py-1 text-xs"
                    onClick={() =>
                      setAttachments((current) =>
                        current.filter((item) => item.id !== attachment.id),
                      )
                    }
                  >
                    {t('akcia.vymazat')}
                  </button>
                )}
              </div>
            ))}
          </div>
          <button
            type="button"
            className="btn mt-2"
            disabled={attachments.length >= 5}
            onClick={addAttachment}
          >
            + {t('akcia.pridat')}
          </button>
        </fieldset>

        {failed && <p className="text-sm text-red-700">{t('chyba.vseobecna')}</p>}

        {result && (
          <div className="rounded border border-line bg-app p-3" role="status">
            <div className="mb-2 flex items-center gap-2">
              <InboundBadge status={result.inboundEmail.status} />
              <code className="text-xs text-ink-soft">{result.inboundEmail.id}</code>
            </div>
            {quarantined && (
              <p className="mb-2 text-sm text-amber-800">{t('sim.vysledok.quarantine')}</p>
            )}
            {duplicated && (
              <p className="mb-2 text-sm text-amber-800">{t('sim.vysledok.duplicate')}</p>
            )}
            {result.createdDocumentIds.length > 0 && (
              <div className="mb-2">
                <p className="mb-1 text-xs font-medium text-ink-soft">
                  {t('sim.vysledok.dokumenty')}
                </p>
                <div className="flex flex-wrap gap-2">
                  {result.createdDocumentIds.map((documentId) => (
                    <button
                      key={documentId}
                      type="button"
                      className="btn px-2 py-1 text-xs"
                      onClick={() => navigate(`/doklady/${documentId}`)}
                    >
                      {documentId}
                    </button>
                  ))}
                </div>
              </div>
            )}
            <ul className="space-y-1">
              {result.attachments.map((attachment) => (
                <li key={attachment.id} className="flex items-center justify-between gap-3 text-xs">
                  <span className="truncate">{attachment.originalFileName}</span>
                  <AttachmentBadge status={attachment.status} />
                </li>
              ))}
            </ul>
          </div>
        )}

        <div className="flex justify-end gap-2">
          <button type="button" className="btn" onClick={onClose}>
            {t('akcia.zrusit')}
          </button>
          <button type="submit" className="btn btn-primary" disabled={saving || !routedAlias}>
            {t('sim.odoslat')}
          </button>
        </div>
      </form>
    </Modal>
  );
}

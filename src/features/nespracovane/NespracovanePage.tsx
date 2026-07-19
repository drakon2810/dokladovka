import { useState } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import { Link } from 'react-router-dom';
import { assignInboundEmailToOrg } from '../../data/api';
import { useDataQuery } from '../../data/query';
import { useAuth } from '../../auth/AuthContext';
import { showToast } from '../../components/toast';
import { t } from '../../i18n/sk';
import { formatDateTime } from '../../lib/format';

// Nespracované doklady (vzor Doklado): e-maily, z ktorých nevznikol doklad —
// karanténa (neznámy alias, nepodporovaný typ…) alebo zlyhanie. Admin ich
// priradí organizácii; príloha sa potom spracuje štandardným pipeline.

const REASON_KEYS: Record<string, string> = {
  unknown_alias: 'nespracovane.dovod.unknown_alias',
  alias_disabled: 'nespracovane.dovod.alias_disabled',
  organization_archived: 'nespracovane.dovod.organization_archived',
  ambiguous_recipient: 'nespracovane.dovod.ambiguous_recipient',
  no_supported_attachment: 'nespracovane.dovod.no_supported_attachment',
  unsupported_xml: 'nespracovane.dovod.unsupported_xml',
  sepa_statement_not_supported: 'nespracovane.dovod.sepa',
  unsupported_or_corrupted_file: 'nespracovane.dovod.corrupted',
  mime_mismatch: 'nespracovane.dovod.mime_mismatch',
  attachment_too_large: 'nespracovane.dovod.too_large',
};

function reasonLabel(reason?: string): string {
  if (!reason) return t('nespracovane.dovod.neznamy');
  const key = REASON_KEYS[reason];
  return key ? t(key as Parameters<typeof t>[0]) : reason;
}

function formatBytes(value: number): string {
  if (value >= 1024 * 1024) return `${(value / (1024 * 1024)).toFixed(1)} MB`;
  if (value >= 1024) return `${Math.round(value / 1024)} kB`;
  return `${value} B`;
}

export function NespracovanePage() {
  const { session } = useAuth();
  const { data, loading, error } = useDataQuery();
  const [assigning, setAssigning] = useState<string>();
  const [orgChoice, setOrgChoice] = useState<Record<string, string>>({});

  if (loading) return <p className="text-sm text-ink-soft">{t('stav.nacitavam')}</p>;
  if (error || !data) return <p className="text-sm text-red-700">{t('chyba.vseobecna')}</p>;

  const isAdmin = session?.user.role === 'admin';
  const organizations = data.organizations.filter((org) => !org.archived);
  const emails = data.inboundEmails
    .filter((email) => ['quarantine', 'failed'].includes(email.status))
    .sort((a, b) => (b.receivedAt ?? '').localeCompare(a.receivedAt ?? ''));

  async function assign(emailId: string) {
    const organizationId = orgChoice[emailId] || organizations[0]?.id;
    if (!organizationId) return;
    setAssigning(emailId);
    try {
      await assignInboundEmailToOrg(emailId, organizationId);
      showToast(t('nespracovane.priradeneOk'));
    } catch (cause) {
      showToast(cause instanceof Error ? cause.message : t('chyba.vseobecna'));
    } finally {
      setAssigning(undefined);
    }
  }

  return (
    <div className="mx-auto max-w-[1000px] space-y-4">
      <div>
        <h1 className="text-xl font-semibold tracking-tight text-ink">{t('nespracovane.titulok')}</h1>
        <p className="text-sm text-ink-soft">{t('nespracovane.popis')}</p>
      </div>

      <AnimatePresence mode="popLayout" initial={false}>
      {emails.length === 0 ? (
        <motion.div
          key="empty"
          className="card p-8 text-center"
          initial={{ opacity: 0, y: 8 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.25 }}
        >
          <p className="text-2xl" aria-hidden>✓</p>
          <p className="mt-1 text-sm text-ink-soft">{t('nespracovane.prazdne')}</p>
        </motion.div>
      ) : (
        emails.map((email) => {
          const attachments = data.inboundAttachments.filter(
            (attachment) => attachment.inboundEmailId === email.id,
          );
          return (
            <motion.section
              key={email.id}
              layout
              className="card space-y-3 p-4"
              initial={{ opacity: 0, y: 8 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, x: 32, transition: { duration: 0.2 } }}
              transition={{ duration: 0.25 }}
            >
              <div className="flex flex-wrap items-start justify-between gap-2">
                <div className="min-w-0">
                  <p className="truncate font-medium text-ink">{email.subject || t('nespracovane.bezPredmetu')}</p>
                  <p className="text-xs text-ink-soft">
                    {email.senderEmail ?? '—'} · {email.receivedAt ? formatDateTime(email.receivedAt) : '—'}
                  </p>
                </div>
                <span className="inline-flex items-center rounded-full border border-amber-300 bg-amber-50 px-2.5 py-0.5 text-[11px] font-semibold text-amber-800">
                  {reasonLabel(email.quarantineReason ?? email.processingErrorCode)}
                </span>
              </div>

              {attachments.length > 0 && (
                <ul className="space-y-1 border-t border-line/70 pt-2 text-sm">
                  {attachments.map((attachment) => (
                    <li key={attachment.id} className="flex items-center justify-between gap-2">
                      <span className="min-w-0 truncate">
                        📄 {attachment.originalFileName}
                        <span className="tnum ml-2 text-xs text-ink-soft">{formatBytes(attachment.byteSize)}</span>
                      </span>
                      {attachment.documentId ? (
                        <Link className="shrink-0 text-xs text-accent underline-offset-2 hover:underline" to={`/doklady/${attachment.documentId}`}>
                          {t('nespracovane.otvoritDoklad')}
                        </Link>
                      ) : (
                        <span className="shrink-0 text-xs text-ink-soft">{reasonLabel(attachment.quarantineReason)}</span>
                      )}
                    </li>
                  ))}
                </ul>
              )}

              {isAdmin && (
                <div className="flex flex-wrap items-center gap-2 border-t border-line/70 pt-3">
                  <select
                    className="input max-w-64"
                    value={orgChoice[email.id] ?? organizations[0]?.id ?? ''}
                    onChange={(event) => setOrgChoice((current) => ({ ...current, [email.id]: event.target.value }))}
                  >
                    {organizations.map((org) => (
                      <option key={org.id} value={org.id}>{org.nazov}</option>
                    ))}
                  </select>
                  <button
                    type="button"
                    className="btn btn-primary"
                    disabled={assigning === email.id || organizations.length === 0}
                    onClick={() => void assign(email.id)}
                  >
                    {assigning === email.id ? t('stav.nacitavam') : t('nespracovane.priradit')}
                  </button>
                </div>
              )}
            </motion.section>
          );
        })
      )}
      </AnimatePresence>
    </div>
  );
}

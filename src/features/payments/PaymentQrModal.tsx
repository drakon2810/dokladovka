import { useEffect, useMemo, useState } from 'react';
import QRCode from 'qrcode';
import type {
  DocumentItem,
  Organization,
  OrganizationBankAccount,
} from '../../data/types';
import {
  buildPaymentInstruction,
  encodePayBySquare,
  hashQrPayload,
  type PaymentValidationCode,
} from '../../data/payments/paymentService';
import { recordPaymentQrGenerated, updatePaymentStatus } from '../../data/api';
import { Modal, OrgChip, TypBadge } from '../../components/ui';
import { showToast } from '../../components/toast';
import { formatMoney } from '../../lib/format';
import { t, type SkKey } from '../../i18n/sk';

const ISSUE_KEYS: Record<PaymentValidationCode, SkKey> = {
  unsupported_document_type: 'platba.chyba.unsupported_document_type',
  missing_beneficiary: 'platba.chyba.missing_beneficiary',
  missing_bank_account: 'platba.chyba.missing_bank_account',
  invalid_iban: 'platba.chyba.invalid_iban',
  invalid_amount: 'platba.chyba.invalid_amount',
  invalid_variable_symbol: 'platba.chyba.invalid_variable_symbol',
  invalid_constant_symbol: 'platba.chyba.invalid_constant_symbol',
  invalid_specific_symbol: 'platba.chyba.invalid_specific_symbol',
  invalid_due_date: 'platba.chyba.invalid_due_date',
};

export function PaymentQrModal({
  documents,
  organizations,
  bankAccounts,
  initialDocumentId,
  onClose,
  onUpdated,
}: {
  documents: DocumentItem[];
  organizations: Organization[];
  bankAccounts: OrganizationBankAccount[];
  initialDocumentId?: string;
  onClose: () => void;
  onUpdated?: (document: DocumentItem) => void;
}) {
  const initialIndex = Math.max(
    0,
    initialDocumentId ? documents.findIndex((document) => document.id === initialDocumentId) : 0,
  );
  const [index, setIndex] = useState(initialIndex);
  const [executionDate, setExecutionDate] = useState('');
  const [payload, setPayload] = useState('');
  const [qrDataUrl, setQrDataUrl] = useState('');
  const [generationError, setGenerationError] = useState(false);
  const [busy, setBusy] = useState(false);
  const document = documents[index];
  const organization = organizations.find((item) => item.id === document?.orgId);
  const result = useMemo(
    () =>
      document && organization
        ? buildPaymentInstruction(document, organization, bankAccounts)
        : { issues: ['missing_beneficiary' as const] },
    [bankAccounts, document, organization],
  );

  useEffect(() => {
    setExecutionDate(result.instruction?.dueDate ?? new Date().toISOString().slice(0, 10));
  }, [document?.id, result.instruction?.dueDate]);

  useEffect(() => {
    let active = true;
    if (!result.instruction) {
      setPayload('');
      setQrDataUrl('');
      return undefined;
    }
    try {
      const nextPayload = encodePayBySquare(result.instruction, executionDate || undefined);
      setPayload(nextPayload);
      setGenerationError(false);
      void QRCode.toDataURL(nextPayload, {
        errorCorrectionLevel: 'M',
        margin: 2,
        width: 360,
        color: { dark: '#111827', light: '#ffffff' },
      })
        .then((url) => {
          if (active) setQrDataUrl(url);
        })
        .catch(() => {
          if (active) setGenerationError(true);
        });
    } catch {
      setPayload('');
      setQrDataUrl('');
      setGenerationError(true);
    }
    return () => {
      active = false;
    };
  }, [executionDate, result.instruction]);

  if (!document || !organization) return null;

  async function recordQr() {
    if (!payload || !result.instruction) return;
    setBusy(true);
    try {
      const hash = await hashQrPayload(payload);
      const updated = await recordPaymentQrGenerated(
        document.id,
        hash,
        result.instruction.documentVersion,
        executionDate || undefined,
      );
      onUpdated?.(updated);
      showToast(t('toast.platbaEvidovana'));
    } catch {
      showToast(t('chyba.vseobecna'), { tone: 'error' });
    } finally {
      setBusy(false);
    }
  }

  async function markPaid() {
    setBusy(true);
    try {
      const updated = await updatePaymentStatus(document.id, 'paid', { executionDate });
      onUpdated?.(updated);
      showToast(t('toast.platbaUhradena'));
    } catch {
      showToast(t('chyba.vseobecna'), { tone: 'error' });
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal title={t('platba.titulok')} onClose={onClose} wide>
      <div className="grid gap-6 md:grid-cols-[1fr_22rem]">
        <div>
          <div className="mb-4 flex flex-wrap items-center gap-2">
            <OrgChip org={organization} />
            <TypBadge typ={document.typ} />
            <span className="tnum text-sm text-ink-soft">
              {document.extracted.cisloFaktury || document.id}
            </span>
          </div>

          {documents.length > 1 && (
            <div className="mb-4 flex items-center gap-2 rounded border border-line bg-app p-2">
              <button
                type="button"
                className="btn px-2"
                disabled={index === 0}
                aria-label={t('platba.predchadzajuca')}
                onClick={() => setIndex((value) => Math.max(0, value - 1))}
              >
                ←
              </button>
              <span className="tnum flex-1 text-center text-sm">
                {t('platba.pocet')} {index + 1} / {documents.length}
              </span>
              <button
                type="button"
                className="btn px-2"
                disabled={index >= documents.length - 1}
                aria-label={t('platba.nasledujuca')}
                onClick={() => setIndex((value) => Math.min(documents.length - 1, value + 1))}
              >
                →
              </button>
            </div>
          )}

          {result.instruction ? (
            <dl className="divide-y divide-line rounded border border-line px-3 text-sm">
              <PaymentRow label={t('platba.prijemca')} value={result.instruction.beneficiaryName} />
              <PaymentRow label={t('platba.ucet')} value={result.instruction.iban} mono />
              <PaymentRow
                label={t('platba.suma')}
                value={formatMoney(result.instruction.amount, result.instruction.currency)}
                mono
              />
              <PaymentRow label={t('platba.vs')} value={result.instruction.variableSymbol ?? '—'} mono />
            </dl>
          ) : (
            <div className="rounded border border-red-200 bg-red-50 p-3 text-sm text-red-800">
              <p className="font-semibold">{t('platba.nepodporovanyTyp')}</p>
              <ul className="mt-2 list-disc space-y-1 pl-5">
                {result.issues.map((issue) => <li key={issue}>{t(ISSUE_KEYS[issue])}</li>)}
              </ul>
            </div>
          )}

          {result.instruction && (
            <label className="mt-4 block max-w-xs">
              <span className="label">{t('platba.datum')}</span>
              <input
                type="date"
                className="input tnum"
                value={executionDate}
                onChange={(event) => setExecutionDate(event.target.value)}
              />
            </label>
          )}

          <p className="mt-4 rounded border border-sky-200 bg-sky-50 p-3 text-xs text-sky-900">
            {t('platba.bankaInfo')}
          </p>
        </div>

        <div className="flex min-h-80 flex-col items-center justify-center rounded-xl border border-line bg-app p-4">
          <p className="mb-2 font-semibold text-accent">{t('platba.payBySquare')}</p>
          {qrDataUrl && !generationError ? (
            <img src={qrDataUrl} alt={t('platba.payBySquare')} className="h-72 w-72 rounded bg-white" />
          ) : result.instruction ? (
            <p className="text-sm text-ink-soft">{t('stav.nacitavam')}</p>
          ) : (
            <p className="text-center text-sm text-ink-soft">{t('platba.nepodporovanyTyp')}</p>
          )}
        </div>
      </div>

      <div className="mt-5 flex flex-wrap justify-end gap-2 border-t border-line pt-4">
        <button type="button" className="btn" onClick={onClose}>{t('akcia.zatvorit')}</button>
        {qrDataUrl && (
          <a
            className="btn"
            href={qrDataUrl}
            download={`pay-by-square-${document.extracted.cisloFaktury || document.id}.png`}
          >
            {t('platba.stiahnut')}
          </a>
        )}
        <button
          type="button"
          className="btn"
          disabled={busy || !payload}
          onClick={() => void recordQr()}
        >
          {t('platba.evidovat')}
        </button>
        <button
          type="button"
          className="btn btn-primary"
          disabled={busy || !result.instruction}
          onClick={() => void markPaid()}
        >
          {t('platba.oznacitUhradene')}
        </button>
      </div>
    </Modal>
  );
}

function PaymentRow({
  label,
  value,
  mono = false,
}: {
  label: string;
  value: string;
  mono?: boolean;
}) {
  return (
    <div className="grid grid-cols-[9rem_1fr] gap-3 py-2">
      <dt className="text-ink-soft">{label}</dt>
      <dd className={`${mono ? 'tnum' : ''} break-words font-medium`}>{value}</dd>
    </div>
  );
}

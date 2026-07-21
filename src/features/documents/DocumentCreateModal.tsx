import { useEffect, useMemo, useState } from 'react';
import { useDataQuery } from '../../data/query';
import { createDocument, listQueues } from '../../data/api';
import type { DocumentItem, DocumentQueue, DocumentType, VatRate } from '../../data/types';
import { Modal, OrgDot } from '../../components/ui';
import { showToast } from '../../components/toast';
import { t, type SkKey } from '../../i18n/sk';

const DOCUMENT_TYPES: DocumentType[] = ['FP', 'FV', 'BV', 'MZDY', 'OZ', 'PD'];
const VAT_RATES: VatRate[] = [23, 21, 19, 12, 5, 0];
const TYPE_LABELS: Record<DocumentType, SkKey> = {
  FP: 'typ.FP.dlhy',
  FV: 'typ.FV.dlhy',
  BV: 'typ.BV.dlhy',
  MZDY: 'typ.MZDY.dlhy',
  OZ: 'typ.OZ.dlhy',
  PD: 'typ.PD.dlhy',
};

function dateOffset(days: number): string {
  const date = new Date();
  date.setDate(date.getDate() + days);
  return date.toISOString().slice(0, 10);
}

export function DocumentCreateModal({
  initialOrganizationId,
  initialQueueId,
  fixedOrganization = false,
  onClose,
  onCreated,
}: {
  initialOrganizationId?: string;
  initialQueueId?: string;
  fixedOrganization?: boolean;
  onClose: () => void;
  onCreated: (document: DocumentItem) => void;
}) {
  const { data } = useDataQuery();
  const organizations = (data?.organizations ?? []).filter((organization) => !organization.archived);
  const preferredOrganizationId =
    initialOrganizationId && organizations.some((item) => item.id === initialOrganizationId)
      ? initialOrganizationId
      : data?.currentOrgId !== 'all' && organizations.some((item) => item.id === data?.currentOrgId)
        ? data?.currentOrgId
        : organizations[0]?.id ?? '';
  const [organizationId, setOrganizationId] = useState(preferredOrganizationId);
  const [mode, setMode] = useState<'upload' | 'manual'>('upload');
  const [typ, setTyp] = useState<DocumentType>('FP');
  const [queues, setQueues] = useState<DocumentQueue[]>([]);
  const [queueId, setQueueId] = useState(initialQueueId ?? '');
  const [queuesLoading, setQueuesLoading] = useState(false);
  const [supplierName, setSupplierName] = useState('');
  const [invoiceNumber, setInvoiceNumber] = useState('');
  const [issueDate, setIssueDate] = useState(dateOffset(0));
  const [taxDate, setTaxDate] = useState(dateOffset(0));
  const [dueDate, setDueDate] = useState(dateOffset(14));
  const [currency, setCurrency] = useState<'EUR' | 'CZK' | 'USD'>('EUR');
  const [totalAmount, setTotalAmount] = useState('0');
  const [vatRate, setVatRate] = useState<VatRate>(23);
  const [file, setFile] = useState<File>();
  const [fileDropActive, setFileDropActive] = useState(false);
  const [errorText, setErrorText] = useState('');
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!organizationId && preferredOrganizationId) {
      setOrganizationId(preferredOrganizationId);
    }
  }, [organizationId, preferredOrganizationId]);

  useEffect(() => {
    let active = true;
    if (!organizationId) {
      setQueues([]);
      setQueuesLoading(false);
      return undefined;
    }
    setQueues([]);
    setQueuesLoading(true);
    void listQueues(organizationId)
      .then((items) => {
        if (active) setQueues(items.filter((queue) => queue.active));
      })
      .catch(() => {
        if (active) setQueues([]);
      })
      .finally(() => {
        if (active) setQueuesLoading(false);
      });
    return () => {
      active = false;
    };
  }, [data?.queues, organizationId]);

  const compatibleQueues = useMemo(
    () => queues.filter((queue) => queue.documentTypes.includes(typ)),
    [queues, typ],
  );

  useEffect(() => {
    if (compatibleQueues.some((queue) => queue.id === queueId)) return;
    const preferredQueue = compatibleQueues.find((queue) => queue.id === initialQueueId);
    setQueueId(preferredQueue?.id ?? compatibleQueues[0]?.id ?? '');
  }, [compatibleQueues, initialQueueId, queueId]);

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    if (!organizationId) {
      setErrorText(t('doklady.pridat.chybaOrganizacia'));
      return;
    }
    if (!queueId) {
      setErrorText(t('fronta.nedostupna'));
      return;
    }
    if (mode === 'upload' && !file) {
      setErrorText(t('doklady.pridat.chybaSubor'));
      return;
    }
    setErrorText('');
    setSaving(true);
    try {
      const document = await createDocument({
        organizationId,
        queueId,
        typ,
        mode,
        supplierName,
        invoiceNumber,
        issueDate,
        taxDate: taxDate || undefined,
        dueDate: dueDate || undefined,
        currency,
        totalAmount: Number(totalAmount.replace(',', '.')),
        vatRate,
        file: mode === 'upload' ? file : undefined,
      });
      showToast(t(mode === 'upload' ? 'toast.dokladNahraty' : 'toast.dokladVytvoreny'));
      onCreated(document);
    } catch (cause) {
      const code = cause instanceof Error ? cause.message : '';
      setErrorText(
        code === 'invalid_file_size' || code === 'unsupported_file_type'
          ? t('doklady.pridat.chybaFormatSuboru')
          : t('doklady.pridat.chybaVytvorenie'),
      );
    } finally {
      setSaving(false);
    }
  }

  const selectedOrganization = organizations.find((item) => item.id === organizationId);

  const handleFileDrop = (event: React.DragEvent<HTMLLabelElement>) => {
    event.preventDefault();
    setFileDropActive(false);
    const droppedFile = event.dataTransfer.files.item(0);
    if (droppedFile) setFile(droppedFile);
  };

  return (
    <Modal title={t('doklady.pridat.titulok')} onClose={onClose} wide>
      <form onSubmit={submit} className="flex flex-col gap-4">
        <div className="grid grid-cols-2 gap-2 rounded border border-line bg-app p-1" role="tablist">
          <button
            type="button"
            role="tab"
            aria-selected={mode === 'upload'}
            className={`rounded px-3 py-2 text-sm font-medium ${
              mode === 'upload' ? 'bg-surface text-accent shadow-sm' : 'text-ink-soft'
            }`}
            onClick={() => setMode('upload')}
          >
            {t('doklady.pridat.nahrat')}
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={mode === 'manual'}
            className={`rounded px-3 py-2 text-sm font-medium ${
              mode === 'manual' ? 'bg-surface text-accent shadow-sm' : 'text-ink-soft'
            }`}
            onClick={() => setMode('manual')}
          >
            {t('doklady.pridat.manualne')}
          </button>
        </div>

        <p className="text-sm text-ink-soft">
          {t(mode === 'upload' ? 'doklady.pridat.nahratPopis' : 'doklady.pridat.manualnePopis')}
        </p>

        <div className="grid gap-3 md:grid-cols-3">
          <label>
            <span className="label">{t('detail.organizacia')}</span>
            <select
              className="input"
              value={organizationId}
              disabled={fixedOrganization}
              required
              onChange={(event) => setOrganizationId(event.target.value)}
            >
              {!organizationId && <option value="">{t('doklady.pridat.vyberOrganizaciu')}</option>}
              {organizations.map((organization) => (
                <option key={organization.id} value={organization.id}>
                  {organization.nazov}
                </option>
              ))}
            </select>
            {fixedOrganization && selectedOrganization && (
              <span className="mt-1 flex items-center gap-1.5 text-xs text-ink-soft">
                <OrgDot org={selectedOrganization} size={7} />
                {t('doklady.pridat.pevnaOrganizacia')}
              </span>
            )}
          </label>
          <label>
            <span className="label">{t('detail.typDokladu')}</span>
            <select className="input" value={typ} onChange={(event) => setTyp(event.target.value as DocumentType)}>
              {DOCUMENT_TYPES.map((type) => (
                <option key={type} value={type}>
                  {type} — {t(TYPE_LABELS[type])}
                </option>
              ))}
            </select>
          </label>
          <label>
            <span className="label">{t('fronta.label')}</span>
            <select
              className="input"
              value={queueId}
              required
              disabled={queuesLoading || compatibleQueues.length === 0}
              onChange={(event) => setQueueId(event.target.value)}
            >
              {!queueId && <option value="">{t('fronta.vyber')}</option>}
              {compatibleQueues.map((queue) => (
                <option key={queue.id} value={queue.id}>
                  {queue.name}
                </option>
              ))}
            </select>
            {!queuesLoading && compatibleQueues.length === 0 && (
              <span className="mt-1 block text-xs text-red-700">{t('fronta.nedostupna')}</span>
            )}
          </label>
        </div>

        {mode === 'upload' && (
          <label
            className={`rounded border-2 border-dashed p-4 text-center transition-colors ${
              fileDropActive
                ? 'border-accent bg-accent/5'
                : 'border-line bg-app hover:border-accent/50'
            }`}
            onDragEnter={(event) => {
              event.preventDefault();
              setFileDropActive(true);
            }}
            onDragOver={(event) => {
              event.preventDefault();
              event.dataTransfer.dropEffect = 'copy';
              setFileDropActive(true);
            }}
            onDragLeave={(event) => {
              const nextTarget = event.relatedTarget as Node | null;
              if (!nextTarget || !event.currentTarget.contains(nextTarget)) {
                setFileDropActive(false);
              }
            }}
            onDrop={handleFileDrop}
          >
            <span className="block text-sm font-medium">{t('doklady.pridat.subor')}</span>
            <span className="mt-1 block text-xs text-ink-soft">{t('doklady.pridat.povoleneSubory')}</span>
            <input
              className="mx-auto mt-3 block max-w-full text-sm"
              type="file"
              accept="application/pdf,image/jpeg,image/png,image/webp,application/xml,.pdf,.jpg,.jpeg,.png,.webp,.xml"
              aria-required="true"
              onChange={(event) => setFile(event.target.files?.[0])}
            />
            {file && (
              <span className="tnum mt-2 block text-xs text-ink">
                {file.name} · {(file.size / 1024 / 1024).toFixed(2)} MB
              </span>
            )}
          </label>
        )}

        <div className="grid gap-3 md:grid-cols-2">
          <label>
            <span className="label">{t('doklady.pridat.dodavatel')}</span>
            <input className="input" value={supplierName} onChange={(event) => setSupplierName(event.target.value)} />
          </label>
          <label>
            <span className="label">{t('doklady.pridat.cisloDokladu')}</span>
            <input className="input tnum" value={invoiceNumber} onChange={(event) => setInvoiceNumber(event.target.value)} />
          </label>
          <label>
            <span className="label">{t('detail.datumVystavenia')}</span>
            <input className="input tnum" type="date" required value={issueDate} onChange={(event) => setIssueDate(event.target.value)} />
          </label>
          <label>
            <span className="label">{t('detail.datumDodania')}</span>
            <input className="input tnum" type="date" value={taxDate} onChange={(event) => setTaxDate(event.target.value)} />
          </label>
          <label>
            <span className="label">{t('detail.datumSplatnosti')}</span>
            <input className="input tnum" type="date" value={dueDate} onChange={(event) => setDueDate(event.target.value)} />
          </label>
          <label>
            <span className="label">{t('detail.sumaSpolu')}</span>
            <div className="flex gap-2">
              <input
                className="input tnum"
                type="number"
                min="0"
                step="0.01"
                required
                value={totalAmount}
                onChange={(event) => setTotalAmount(event.target.value)}
              />
              <select className="input w-24" value={currency} onChange={(event) => setCurrency(event.target.value as typeof currency)}>
                <option value="EUR">EUR</option>
                <option value="CZK">CZK</option>
                <option value="USD">USD</option>
              </select>
            </div>
          </label>
          <label>
            <span className="label">{t('detail.sadzba')}</span>
            <select className="input" value={vatRate} onChange={(event) => setVatRate(Number(event.target.value) as VatRate)}>
              {VAT_RATES.map((rate) => (
                <option key={rate} value={rate}>{rate} %</option>
              ))}
            </select>
          </label>
        </div>

        {errorText && <p className="rounded border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">{errorText}</p>}

        <div className="flex justify-end gap-2">
          <button type="button" className="btn" onClick={onClose}>{t('akcia.zrusit')}</button>
          <button
            type="submit"
            className="btn btn-primary"
            disabled={saving || queuesLoading || organizations.length === 0 || !queueId}
          >
            {saving ? t('stav.nacitavam') : t('doklady.pridat.vytvorit')}
          </button>
        </div>
      </form>
    </Modal>
  );
}

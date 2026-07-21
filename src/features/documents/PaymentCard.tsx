import { useMemo, useState } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import { addDocumentPayment, removeDocumentPayment } from '../../data/api';
import type { DocumentItem, DocumentPayment } from '../../data/types';
import { showToast } from '../../components/toast';
import { t } from '../../i18n/sk';

// Platobný kontúr dokladu: stav úhrady, zvyšok, splatnosť a (čiastočné) úhrady.
// Automatické úhrady prichádzajú z párovania bankových výpisov podľa VS.

function money(value: number, currency: string): string {
  return `${value.toLocaleString('sk-SK', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} ${currency}`;
}

function skDate(value?: string): string {
  if (!value) return '—';
  const [year, month, day] = value.split('-');
  return `${day}.${month}.${year}`;
}

function round2(value: number): number {
  return Math.round((value + Number.EPSILON) * 100) / 100;
}

export interface PaymentState {
  paid: number;
  remaining: number;
  overdueDays: number;
  daysToDue?: number;
  status: 'uhradena' | 'ciastocna' | 'neuhradena' | 'po_splatnosti';
}

export function paymentStateFor(doklad: DocumentItem, payments: DocumentPayment[]): PaymentState {
  const paid = round2(payments.reduce((sum, payment) => sum + payment.amount, 0));
  const total = round2(doklad.extracted.sumaSpolu ?? 0);
  const remaining = round2(Math.max(0, total - paid));
  const due = doklad.extracted.datumSplatnosti;
  const today = new Date().toISOString().slice(0, 10);
  const dayDiff = due
    ? Math.round((Date.parse(due) - Date.parse(today)) / 86_400_000)
    : undefined;
  const status: PaymentState['status'] = remaining <= 0 && total > 0
    ? 'uhradena'
    : paid > 0
      ? 'ciastocna'
      : due && dayDiff !== undefined && dayDiff < 0
        ? 'po_splatnosti'
        : 'neuhradena';
  return {
    paid,
    remaining,
    overdueDays: dayDiff !== undefined && dayDiff < 0 ? -dayDiff : 0,
    daysToDue: dayDiff,
    status,
  };
}

const STATUS_STYLES: Record<PaymentState['status'], { pill: string; dot: string }> = {
  uhradena: { pill: 'bg-accent/10 text-accent-hover border-accent/30', dot: 'bg-accent' },
  ciastocna: { pill: 'bg-amber-50 text-amber-800 border-amber-300', dot: 'bg-amber-600' },
  neuhradena: { pill: 'bg-app text-ink-soft border-line', dot: 'bg-gray-400' },
  po_splatnosti: { pill: 'bg-red-50 text-red-700 border-red-200', dot: 'bg-red-600' },
};

export function PaymentCard({
  doklad,
  payments,
  readOnly,
}: {
  doklad: DocumentItem;
  payments: DocumentPayment[];
  readOnly: boolean;
}) {
  const [busy, setBusy] = useState(false);
  const [formOpen, setFormOpen] = useState(false);
  const [amount, setAmount] = useState('');
  const [paidOn, setPaidOn] = useState(new Date().toISOString().slice(0, 10));
  const [note, setNote] = useState('');
  const state = useMemo(() => paymentStateFor(doklad, payments), [doklad, payments]);
  const mena = doklad.extracted.mena ?? 'EUR';

  async function run(action: () => Promise<void>) {
    setBusy(true);
    try {
      await action();
    } catch (error) {
      showToast(error instanceof Error ? error.message : t('platby.chyba'));
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="card overflow-hidden">
      <div className="h-1 w-full bg-gradient-to-r from-accent to-accent-hover" aria-hidden />
      <div className="space-y-3 p-4">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h2 className="text-sm font-semibold text-ink">{t('platby.titulok')}</h2>
          <span className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-0.5 text-[11px] font-semibold ${STATUS_STYLES[state.status].pill}`}>
            <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${STATUS_STYLES[state.status].dot}`} aria-hidden />
            {t(`platby.stav.${state.status}`)}
          </span>
        </div>

        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <div>
            <p className="text-xs text-ink-soft">{t('platby.zostava')}</p>
            <p className="tnum text-[22px] font-bold tracking-tight text-ink">{money(state.remaining, mena)}</p>
          </div>
          <div className="text-right">
            <p className="text-xs text-ink-soft">{t('platby.splatnost')}</p>
            <p className="tnum text-sm font-medium">
              {skDate(doklad.extracted.datumSplatnosti)}
              {state.status !== 'uhradena' && state.daysToDue !== undefined && (
                <span className={`ml-1.5 ${state.daysToDue < 0 ? 'text-red-700' : state.daysToDue <= 5 ? 'text-amber-700' : 'text-ink-soft'}`}>
                  {state.daysToDue < 0
                    ? `(${state.overdueDays} ${t('platby.dniPo')})`
                    : `(${t('platby.o')} ${state.daysToDue} ${t('platby.dni')})`}
                </span>
              )}
            </p>
          </div>
        </div>

        {payments.length > 0 && (
          <ul className="space-y-1 border-t border-line/70 pt-2">
            {payments.map((payment) => (
              <li key={payment.id} className="flex items-center justify-between gap-2 text-sm">
                <span className="min-w-0 truncate text-ink-soft" title={payment.note}>
                  <span className="tnum">{skDate(payment.paidOn)}</span>
                  {' · '}
                  {payment.source === 'bank_statement' ? t('platby.zVypisu') : t('platby.manualna')}
                </span>
                <span className="flex shrink-0 items-center gap-2">
                  <span className="tnum font-medium text-ink">{money(payment.amount, payment.currency)}</span>
                  {!readOnly && (
                    <button
                      type="button"
                      className="rounded px-1 text-xs text-red-700 transition hover:bg-red-50"
                      aria-label={t('platby.odstranit')}
                      disabled={busy}
                      onClick={() => void run(() => removeDocumentPayment(doklad.id, payment.id))}
                    >
                      ✕
                    </button>
                  )}
                </span>
              </li>
            ))}
          </ul>
        )}

        {!readOnly && state.remaining > 0 && (
          <div className="space-y-2 border-t border-line/70 pt-3">
            <div className="flex flex-wrap gap-2">
              <button
                type="button"
                className="btn btn-primary flex-1 whitespace-nowrap"
                disabled={busy}
                onClick={() => void run(() => addDocumentPayment(doklad.id))}
              >
                {t('platby.oznacitUhradene')}
              </button>
              <button
                type="button"
                className="btn flex-1 whitespace-nowrap"
                disabled={busy}
                onClick={() => setFormOpen((value) => !value)}
              >
                {t('platby.pridatUhradu')}
              </button>
            </div>
            <AnimatePresence initial={false}>
            {formOpen && (
              <motion.form
                initial={{ opacity: 0, height: 0 }}
                animate={{ opacity: 1, height: 'auto' }}
                exit={{ opacity: 0, height: 0 }}
                transition={{ duration: 0.2 }}
                style={{ overflow: 'hidden' }}
                className="grid grid-cols-2 gap-2"
                onSubmit={(event) => {
                  event.preventDefault();
                  const parsed = Number(amount.replace(',', '.'));
                  if (!Number.isFinite(parsed) || parsed <= 0) {
                    showToast(t('platby.neplatnaSuma'));
                    return;
                  }
                  void run(async () => {
                    await addDocumentPayment(doklad.id, { amount: round2(parsed), paidOn, note: note || undefined });
                    setFormOpen(false);
                    setAmount('');
                    setNote('');
                  });
                }}
              >
                <input
                  className="input tnum"
                  inputMode="decimal"
                  placeholder={`${t('platby.suma')} (${money(state.remaining, mena)})`}
                  value={amount}
                  onChange={(event) => setAmount(event.target.value)}
                />
                <input
                  type="date"
                  className="input tnum"
                  value={paidOn}
                  onChange={(event) => setPaidOn(event.target.value)}
                />
                <input
                  className="input col-span-2"
                  placeholder={t('platby.poznamka')}
                  maxLength={300}
                  value={note}
                  onChange={(event) => setNote(event.target.value)}
                />
                <button type="submit" className="btn btn-primary col-span-2" disabled={busy}>
                  {t('platby.ulozit')}
                </button>
              </motion.form>
            )}
            </AnimatePresence>
          </div>
        )}
      </div>
    </section>
  );
}

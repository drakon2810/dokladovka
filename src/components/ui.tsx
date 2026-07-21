// Zdieľané UI komponenty — редизайн: pill-badges, мягкие тени, скругления.
// API компонентов не менялось — drop-in замена.
import { useEffect, useRef, type ReactNode } from 'react';
import type { DocumentStatus, DocumentType, Organization, PaymentStatus, ProcessingStatus } from '../data/types';
import { t, type SkKey } from '../i18n/sk';
import { dismissToast, useToastStore } from './toast';

// Farby statusov zo SPEC §8 — svetlé pozadie + tmavý text + farebná bodka
// (vzor Claude Design „Detail dokladu“), nie plná výplň.
const STATUS_STYLES: Record<DocumentStatus, { pill: string; dot: string }> = {
  novy: { pill: 'bg-slate-100 text-slate-700 border-slate-200', dot: 'bg-slate-400' },
  extrahovany: { pill: 'bg-sky-50 text-sky-800 border-sky-200', dot: 'bg-sky-600' },
  na_kontrole: { pill: 'bg-amber-50 text-amber-800 border-amber-200', dot: 'bg-amber-600' },
  schvaleny: { pill: 'bg-green-50 text-green-800 border-green-200', dot: 'bg-green-600' },
  exportovany: { pill: 'bg-slate-200 text-slate-800 border-slate-300', dot: 'bg-slate-500' },
  chyba: { pill: 'bg-red-50 text-red-800 border-red-200', dot: 'bg-red-600' },
  karantena: { pill: 'bg-yellow-50 text-yellow-800 border-yellow-300', dot: 'bg-yellow-600' },
  duplicita: { pill: 'bg-red-50 text-red-800 border-red-200', dot: 'bg-red-600' },
  zamietnuty: { pill: 'bg-gray-100 text-gray-600 border-gray-200', dot: 'bg-gray-400' },
};

export function StatusBadge({ status }: { status: DocumentStatus }) {
  const style = STATUS_STYLES[status];
  return (
    <span
      className={`inline-flex items-center gap-1.5 whitespace-nowrap rounded-full border px-2.5 py-0.5 text-xs font-semibold ${style.pill}`}
    >
      <span className={`h-[7px] w-[7px] shrink-0 rounded-full ${style.dot}`} aria-hidden />
      {t(`status.${status}` as SkKey)}
    </span>
  );
}

export function ProcessingBadge({ status, label }: { status: ProcessingStatus; label?: string }) {
  const isError = status.startsWith('failed');
  const isDone = status === 'ready_for_review';
  return (
    <span
      className={`inline-flex items-center gap-1.5 whitespace-nowrap rounded-full border px-2.5 py-0.5 text-xs ${
        isError
          ? 'border-red-200 bg-red-50 text-red-800'
          : isDone
            ? 'border-line bg-app text-ink-soft'
            : 'border-sky-200 bg-sky-50 text-sky-800'
      }`}
    >
      {!isError && !isDone && (
        <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-sky-600" aria-hidden />
      )}
      {label ?? t(`processing.${status}` as SkKey)}
    </span>
  );
}

export function PaymentStatusBadge({ status }: { status: PaymentStatus }) {
  const [pill, dot] =
    status === 'paid'
      ? ['border-green-200 bg-green-50 text-green-800', 'bg-green-600']
      : status === 'partially_paid'
        ? ['border-amber-200 bg-amber-50 text-amber-800', 'bg-amber-600']
        : status === 'payment_order'
          ? ['border-sky-200 bg-sky-50 text-sky-800', 'bg-sky-600']
          : ['border-line bg-app text-ink-soft', 'bg-gray-400'];
  return (
    <span className={`inline-flex items-center gap-1.5 whitespace-nowrap rounded-full border px-2.5 py-0.5 text-xs font-semibold ${pill}`}>
      <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${dot}`} aria-hidden />
      {t(`platba.status.${status}` as SkKey)}
    </span>
  );
}

export function TypBadge({ typ }: { typ: DocumentType }) {
  return (
    <span
      className="tnum inline-flex items-center rounded-md border border-line bg-app px-2 py-0.5 text-xs font-semibold text-ink-soft"
      title={t(`typ.${typ}.dlhy` as SkKey)}
    >
      {typ}
    </span>
  );
}

/** ✓ ≥0.9, ~ 0.7–0.9, ! <0.7 (SPEC §6.3). `showPercent` doplní číselnú istotu. */
export function ConfidenceIndicator({ value, showPercent }: { value: number; showPercent?: boolean }) {
  const [symbol, cls, label] =
    value >= 0.9
      ? ['✓', 'text-green-700', `${Math.round(value * 100)} %`]
      : value >= 0.7
        ? ['~', 'text-amber-600', `${Math.round(value * 100)} %`]
        : ['!', 'text-red-700', `${Math.round(value * 100)} %`];
  return (
    <span
      className={`tnum inline-flex items-center gap-1 font-bold ${cls} ${showPercent ? '' : 'w-5 justify-center'}`}
      title={`${t('detail.confidence')}: ${label}`}
      aria-label={`${t('detail.confidence')} ${label}`}
    >
      {symbol}
      {showPercent && <span className="font-semibold">{label}</span>}
    </span>
  );
}

export function OrgDot({ org, size = 10 }: { org: Organization; size?: number }) {
  return (
    <span
      aria-hidden
      className="inline-block shrink-0 rounded-full"
      style={{ width: size, height: size, backgroundColor: org.farba }}
    />
  );
}

export function OrgChip({ org }: { org: Organization }) {
  return (
    <span className="inline-flex items-center gap-1.5 rounded-full border border-line bg-app px-2.5 py-0.5 text-xs text-ink">
      <OrgDot org={org} size={7} />
      {org.nazov}
    </span>
  );
}

export function CopyButton({ value, label }: { value: string; label?: string }) {
  return (
    <button
      type="button"
      className="btn px-2.5 py-1 text-xs"
      onClick={async (e) => {
        e.stopPropagation();
        await navigator.clipboard.writeText(value);
        const btn = e.currentTarget;
        if (!btn) return;
        const original = btn.textContent;
        btn.textContent = t('akcia.skopirovane');
        window.setTimeout(() => {
          btn.textContent = original;
        }, 1500);
      }}
    >
      {label ?? t('akcia.kopirovat')}
    </button>
  );
}

export function Modal({
  title,
  onClose,
  children,
  wide,
}: {
  title: string;
  onClose: () => void;
  children: ReactNode;
  wide?: boolean;
}) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    ref.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);
  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-ink/30 p-6 backdrop-blur-[2px]"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
      role="dialog"
      aria-modal="true"
      aria-label={title}
    >
      <div
        ref={ref}
        tabIndex={-1}
        className={`mt-8 w-full rounded-2xl border border-line/70 bg-surface shadow-pop ${
          wide ? 'max-w-3xl' : 'max-w-lg'
        } p-6`}
      >
        <div className="mb-4 flex items-center justify-between">
          <h2 className="text-lg font-semibold tracking-tight">{title}</h2>
          <button
            type="button"
            className="grid h-8 w-8 place-items-center rounded-full text-ink-soft transition hover:bg-app hover:text-ink"
            onClick={onClose}
            aria-label={t('akcia.zatvorit')}
          >
            ✕
          </button>
        </div>
        {children}
      </div>
    </div>
  );
}

export function ConfirmDialog({
  title,
  text,
  confirmLabel,
  onConfirm,
  onClose,
  danger,
}: {
  title: string;
  text: string;
  confirmLabel?: string;
  onConfirm: () => void;
  onClose: () => void;
  danger?: boolean;
}) {
  return (
    <Modal title={title} onClose={onClose}>
      <p className="mb-4 text-sm text-ink-soft">{text}</p>
      <div className="flex justify-end gap-2">
        <button type="button" className="btn" onClick={onClose}>
          {t('akcia.zrusit')}
        </button>
        <button
          type="button"
          className={`btn ${danger ? 'btn-danger' : 'btn-primary'}`}
          onClick={() => {
            onConfirm();
            onClose();
          }}
        >
          {confirmLabel ?? t('akcia.potvrdit')}
        </button>
      </div>
    </Modal>
  );
}

export function ToastViewport() {
  const toasts = useToastStore((s) => s.toasts);
  return (
    <div className="pointer-events-none fixed bottom-4 right-4 z-[60] flex w-80 flex-col gap-2">
      {toasts.map((toast) => (
        <div
          key={toast.id}
          className={`pointer-events-auto flex items-center justify-between gap-3 rounded-xl border border-line/70 border-l-4 bg-surface p-3 text-sm shadow-pop ${
            toast.tone === 'error'
              ? 'border-l-red-600'
              : toast.tone === 'info'
                ? 'border-l-sky-600'
                : 'border-l-accent'
          }`}
          role="status"
        >
          <span>{toast.text}</span>
          <span className="flex items-center gap-1">
            {toast.actionLabel && toast.onAction && (
              <button
                type="button"
                className="btn px-2.5 py-1 text-xs"
                onClick={() => {
                  toast.onAction?.();
                  dismissToast(toast.id);
                }}
              >
                {toast.actionLabel}
              </button>
            )}
            <button
              type="button"
              className="rounded px-1 text-ink-soft transition hover:text-ink"
              onClick={() => dismissToast(toast.id)}
              aria-label={t('akcia.zatvorit')}
            >
              ✕
            </button>
          </span>
        </div>
      ))}
    </div>
  );
}

export function EmptyState({ children }: { children: ReactNode }) {
  return (
    <div className="card flex flex-col items-center gap-1 border-dashed p-10 text-center text-sm text-ink-soft">
      {children}
    </div>
  );
}

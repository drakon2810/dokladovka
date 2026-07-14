// Zdieľané UI komponenty — statusové badge, chipy, indikátory, modály, toasty.
import { useEffect, useRef, type ReactNode } from 'react';
import type { DocumentStatus, DocumentType, Organization, PaymentStatus, ProcessingStatus } from '../data/types';
import { t, type SkKey } from '../i18n/sk';
import { dismissToast, useToastStore } from './toast';

// Farby statusov zo SPEC §8 — svetlé pozadie + tmavý text, nie plná výplň.
const STATUS_STYLES: Record<DocumentStatus, string> = {
  novy: 'bg-slate-100 text-slate-700 border-slate-200',
  extrahovany: 'bg-sky-50 text-sky-800 border-sky-200',
  na_kontrole: 'bg-amber-50 text-amber-800 border-amber-200',
  schvaleny: 'bg-green-50 text-green-800 border-green-200',
  exportovany: 'bg-slate-200 text-slate-800 border-slate-300',
  chyba: 'bg-red-50 text-red-800 border-red-200',
  karantena: 'bg-yellow-50 text-yellow-800 border-yellow-300',
  duplicita: 'bg-red-50 text-red-800 border-red-200',
  zamietnuty: 'bg-gray-100 text-gray-600 border-gray-200',
};

export function StatusBadge({ status }: { status: DocumentStatus }) {
  return (
    <span
      className={`inline-flex items-center rounded border px-1.5 py-0.5 text-xs font-medium whitespace-nowrap ${STATUS_STYLES[status]}`}
    >
      {t(`status.${status}` as SkKey)}
    </span>
  );
}

export function ProcessingBadge({ status, label }: { status: ProcessingStatus; label?: string }) {
  const isError = status.startsWith('failed');
  const isDone = status === 'ready_for_review';
  return (
    <span
      className={`inline-flex items-center gap-1 rounded border px-1.5 py-0.5 text-xs whitespace-nowrap ${
        isError
          ? 'border-red-200 bg-red-50 text-red-800'
          : isDone
            ? 'border-line bg-app text-ink-soft'
            : 'border-sky-200 bg-sky-50 text-sky-800'
      }`}
    >
      {label ?? t(`processing.${status}` as SkKey)}
    </span>
  );
}

export function PaymentStatusBadge({ status }: { status: PaymentStatus }) {
  const style =
    status === 'paid'
      ? 'border-green-200 bg-green-50 text-green-800'
      : status === 'partially_paid'
        ? 'border-amber-200 bg-amber-50 text-amber-800'
        : status === 'payment_order'
          ? 'border-sky-200 bg-sky-50 text-sky-800'
          : 'border-line bg-app text-ink-soft';
  return (
    <span className={`inline-flex items-center rounded border px-1.5 py-0.5 text-xs whitespace-nowrap ${style}`}>
      {t(`platba.status.${status}` as SkKey)}
    </span>
  );
}

export function TypBadge({ typ }: { typ: DocumentType }) {
  return (
    <span
      className="tnum inline-flex items-center rounded border border-line bg-app px-1.5 py-0.5 text-xs font-semibold text-ink-soft"
      title={t(`typ.${typ}.dlhy` as SkKey)}
    >
      {typ}
    </span>
  );
}

/** ✓ ≥0.9, ~ 0.7–0.9, ! <0.7 (SPEC §6.3). */
export function ConfidenceIndicator({ value }: { value: number }) {
  const [symbol, cls, label] =
    value >= 0.9
      ? ['✓', 'text-green-700', `${Math.round(value * 100)} %`]
      : value >= 0.7
        ? ['~', 'text-amber-600', `${Math.round(value * 100)} %`]
        : ['!', 'text-red-700', `${Math.round(value * 100)} %`];
  return (
    <span
      className={`tnum inline-block w-5 text-center font-bold ${cls}`}
      title={`${t('detail.confidence')}: ${label}`}
      aria-label={`${t('detail.confidence')} ${label}`}
    >
      {symbol}
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
    <span className="inline-flex items-center gap-1.5 rounded border border-line bg-app px-1.5 py-0.5 text-xs text-ink">
      <OrgDot org={org} size={8} />
      {org.nazov}
    </span>
  );
}

export function CopyButton({ value, label }: { value: string; label?: string }) {
  return (
    <button
      type="button"
      className="btn px-2 py-1 text-xs"
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
      className="fixed inset-0 z-50 flex items-start justify-center bg-black/30 p-6 overflow-y-auto"
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
        className={`card mt-8 w-full ${wide ? 'max-w-3xl' : 'max-w-lg'} p-5`}
      >
        <div className="mb-4 flex items-center justify-between">
          <h2 className="text-lg font-semibold">{title}</h2>
          <button type="button" className="btn px-2 py-1" onClick={onClose} aria-label={t('akcia.zatvorit')}>
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
          className={`pointer-events-auto card flex items-center justify-between gap-3 border-l-4 p-3 text-sm ${
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
                className="btn px-2 py-1 text-xs"
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
              className="rounded px-1 text-ink-soft hover:text-ink"
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
    <div className="card flex flex-col items-center gap-1 p-10 text-center text-sm text-ink-soft">
      {children}
    </div>
  );
}

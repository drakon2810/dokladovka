import { useEffect, useRef, useState } from 'react';
import { uploadDocumentFile } from '../../data/api';
import type { Organization } from '../../data/types';
import { Modal } from '../../components/ui';
import { t } from '../../i18n/sk';

type UploadStatus = 'uploading' | 'done' | 'error';

interface UploadItem {
  id: string;
  name: string;
  size: number;
  progress: number;
  status: UploadStatus;
  error?: string;
}

const ACCEPT =
  'application/pdf,image/jpeg,image/png,image/webp,application/xml,.pdf,.jpg,.jpeg,.png,.webp,.xml';

let counter = 0;
const nextItemId = () => `up-${Date.now().toString(36)}-${(counter += 1)}`;

const svg = { fill: 'none', stroke: 'currentColor', strokeLinecap: 'round', strokeLinejoin: 'round' } as const;
function IconCloud({ size = 20, className = '' }: { size?: number; className?: string }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" {...svg} strokeWidth={1.9} className={className} aria-hidden>
      <path d="M4 14.9A7 7 0 1 1 15.7 8h1.8a4.5 4.5 0 0 1 2.5 8.2" />
      <path d="M12 19v-8" />
      <path d="m8 15 4-4 4 4" />
    </svg>
  );
}
function IconFile() {
  return (
    <svg width="17" height="17" viewBox="0 0 24 24" {...svg} strokeWidth={1.9} aria-hidden>
      <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
      <path d="M14 2v6h6" />
    </svg>
  );
}
function IconCheck() {
  return (
    <svg width="13" height="13" viewBox="0 0 24 24" {...svg} strokeWidth={2.6} aria-hidden>
      <path d="M20 6 9 17l-5-5" />
    </svg>
  );
}
function IconAlert() {
  return (
    <svg width="12" height="12" viewBox="0 0 24 24" {...svg} strokeWidth={2} aria-hidden>
      <path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z" />
      <path d="M12 9v4" /><path d="M12 17h.01" />
    </svg>
  );
}
function IconX() {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" {...svg} strokeWidth={2} aria-hidden>
      <path d="M18 6 6 18M6 6l12 12" />
    </svg>
  );
}
function Spinner() {
  return (
    <svg className="h-[19px] w-[19px] shrink-0 animate-spin text-accent" viewBox="0 0 24 24" aria-hidden>
      <circle cx="12" cy="12" r="9" fill="none" stroke="currentColor" strokeOpacity=".2" strokeWidth="3" />
      <path d="M21 12a9 9 0 0 0-9-9" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" />
    </svg>
  );
}

function mapError(cause: unknown): string {
  const message = cause instanceof Error ? cause.message : '';
  // Mock režim vracia kódy; REST režim hotovú SK hlášku zo servera.
  if (message === 'invalid_file_size' || message === 'unsupported_file_type') {
    return t('doklady.pridat.chybaFormatSuboru');
  }
  return message || t('doklady.pridat.chybaVytvorenie');
}

export function UploadModal({
  organizations,
  currentOrgId,
  onClose,
}: {
  organizations: Organization[];
  currentOrgId: string;
  onClose: () => void;
}) {
  const activeOrgs = organizations.filter((organization) => !organization.archived);
  const defaultOrgId =
    currentOrgId !== 'all' && activeOrgs.some((organization) => organization.id === currentOrgId)
      ? currentOrgId
      : activeOrgs[0]?.id ?? '';
  const [orgId, setOrgId] = useState(defaultOrgId);
  const [items, setItems] = useState<UploadItem[]>([]);
  const [dragActive, setDragActive] = useState(false);
  const timers = useRef<Set<ReturnType<typeof setInterval>>>(new Set());

  useEffect(() => {
    if (!orgId && defaultOrgId) setOrgId(defaultOrgId);
  }, [orgId, defaultOrgId]);

  useEffect(() => {
    const active = timers.current;
    return () => active.forEach((timer) => clearInterval(timer));
  }, []);

  const showOrgSelect = currentOrgId === 'all' && activeOrgs.length > 1;

  // Jeden súbor: sieťový upload + animácia počítadla 0 → 100. Vráti Promise,
  // ktorý sa splní až keď je položka v koncovom stave (hotovo/chyba).
  function uploadItem(itemId: string, file: File): Promise<void> {
    return new Promise((resolve) => {
      let result: 'pending' | 'ok' | 'error' = 'pending';
      let errorText = '';
      void uploadDocumentFile(orgId, file)
        .then((outcome) => {
          if (outcome.status === 'queued') {
            result = 'ok';
          } else {
            result = 'error';
            errorText =
              outcome.status === 'duplicate'
                ? t('doklady.nahrat.duplicita')
                : t('doklady.pridat.chybaFormatSuboru');
          }
        })
        .catch((cause) => {
          result = 'error';
          errorText = mapError(cause);
        });

      let progress = 0;
      const timer = setInterval(() => {
        if (result === 'error') {
          clearInterval(timer);
          timers.current.delete(timer);
          setItems((prev) =>
            prev.map((item) =>
              item.id === itemId ? { ...item, status: 'error', error: errorText } : item,
            ),
          );
          resolve();
          return;
        }
        if (progress < 90) progress = Math.min(90, progress + 6);
        else if (result === 'ok') progress = 100;
        const done = progress === 100;
        setItems((prev) =>
          prev.map((item) =>
            item.id === itemId
              ? { ...item, progress, status: done ? 'done' : 'uploading' }
              : item,
          ),
        );
        if (done) {
          clearInterval(timer);
          timers.current.delete(timer);
          resolve();
        }
      }, 50);
      timers.current.add(timer);
    });
  }

  // Súbory nahrávame POSTUPNE, nie naraz: každý mutačný request si vyžiada nový
  // CSRF token (server ho pri čítaní session rotuje), takže paralelné uploady by
  // si tokeny navzájom zneplatnili a prešiel by len jeden. Všetky riadky sa
  // zobrazia hneď, sieťovo sa spracujú v poradí.
  // ponytail: sekvenčne kvôli rotácii CSRF; dávkový endpoint (files[]) ak by
  // pri mnohých súboroch prekážala rýchlosť.
  async function handleFiles(files: FileList | null) {
    if (!files || !orgId) return;
    const entries = Array.from(files).map((file) => ({ itemId: nextItemId(), file }));
    setItems((prev) => [
      ...prev,
      ...entries.map(({ itemId, file }) => ({
        id: itemId,
        name: file.name,
        size: file.size,
        progress: 0,
        status: 'uploading' as UploadStatus,
      })),
    ]);
    for (const { itemId, file } of entries) {
      await uploadItem(itemId, file);
    }
  }

  const dismiss = (itemId: string) =>
    setItems((prev) => prev.filter((item) => item.id !== itemId));

  const uploading = items.some((item) => item.status === 'uploading');
  const doneCount = items.filter((item) => item.status === 'done').length;
  const errorCount = items.filter((item) => item.status === 'error').length;
  const uploadingCount = items.filter((item) => item.status === 'uploading').length;

  return (
    <Modal title={t('doklady.nahrat.titulok')} onClose={onClose} wide>
      <div className="flex flex-col gap-3.5">
        {activeOrgs.length === 0 ? (
          <p className="text-sm text-ink-soft">{t('doklady.pridat.chybaOrganizacia')}</p>
        ) : (
          <>
            {showOrgSelect && (
              <label className="flex items-center gap-2 text-sm text-ink-soft">
                {t('doklady.nahrat.organizacia')}
                <select
                  className="input w-auto"
                  value={orgId}
                  onChange={(event) => setOrgId(event.target.value)}
                >
                  {activeOrgs.map((organization) => (
                    <option key={organization.id} value={organization.id}>
                      {organization.nazov}
                    </option>
                  ))}
                </select>
              </label>
            )}

            {/* Dropzone — 4a aktívny drag-over / 4b pokojný stav */}
            <label
              className={`relative block cursor-pointer rounded-2xl text-center transition-colors ${
                dragActive
                  ? 'dz-glow border-2 border-accent-bright'
                  : 'border-[1.5px] border-dashed border-[#CDD5CE] bg-[#FAFBFA] hover:border-accent-bright hover:bg-[#F1F8F5]'
              }`}
              style={dragActive ? { background: 'linear-gradient(180deg,#E7F5EF,#F4FAF7)', transform: 'scale(1.008)' } : undefined}
              onDragEnter={(event) => {
                event.preventDefault();
                setDragActive(true);
              }}
              onDragOver={(event) => {
                event.preventDefault();
                event.dataTransfer.dropEffect = 'copy';
                setDragActive(true);
              }}
              onDragLeave={(event) => {
                const nextTarget = event.relatedTarget as Node | null;
                if (!nextTarget || !event.currentTarget.contains(nextTarget)) setDragActive(false);
              }}
              onDrop={(event) => {
                event.preventDefault();
                setDragActive(false);
                handleFiles(event.dataTransfer.files);
              }}
            >
              {dragActive ? (
                <div className="px-5 py-10">
                  <div className="relative mx-auto mb-3.5 h-[58px] w-[58px]">
                    <div
                      className="dz-cloud grid h-[58px] w-[58px] place-items-center rounded-[17px] bg-surface text-accent"
                      style={{ boxShadow: '0 10px 24px -8px rgba(14,122,95,.5)' }}
                    >
                      <IconCloud size={30} />
                    </div>
                    <svg
                      className="dz-arrow absolute -top-3 left-1/2 -ml-2"
                      width="16" height="16" viewBox="0 0 24 24"
                      fill="none" stroke="#0E7A5F" strokeWidth={3} strokeLinecap="round" strokeLinejoin="round"
                      aria-hidden
                    >
                      <path d="M12 19V5M5 12l7-7 7 7" />
                    </svg>
                  </div>
                  <div className="text-[16px] font-bold text-accent-hover">{t('doklady.nahrat.pustite')}</div>
                  <div className="mt-1.5 text-[12.5px] font-medium text-[#5C7A6E]">{t('doklady.nahrat.formaty')}</div>
                </div>
              ) : (
                <div className="px-5 py-7">
                  <div className="inline-flex items-center gap-2 text-[13.5px] font-semibold text-ink">
                    <IconCloud size={17} className="text-accent" />
                    {t('doklady.nahrat.vyzva')}{' '}
                    <span className="text-accent">{t('doklady.nahrat.vybrat')}</span>
                  </div>
                  <div className="mt-1.5 text-xs font-medium text-ink-faint">{t('doklady.nahrat.formaty')}</div>
                </div>
              )}
              <input
                type="file"
                multiple
                accept={ACCEPT}
                className="hidden"
                onChange={(event) => {
                  handleFiles(event.target.files);
                  event.target.value = '';
                }}
              />
            </label>

            {/* Riadky priebehu — 4b */}
            {items.length > 0 && (
              <div className="flex flex-col gap-2.5">
                {items.map((item) => (
                  <div
                    key={item.id}
                    className={`up-row-in flex items-center gap-3 rounded-xl border p-3 ${
                      item.status === 'done'
                        ? 'border-[#BFE0D2] bg-[#F4FBF7]'
                        : item.status === 'error'
                          ? 'border-[#F3CFC9] bg-[#FEF6F5]'
                          : 'border-line bg-surface'
                    }`}
                  >
                    <span
                      className={`grid h-9 w-9 shrink-0 place-items-center rounded-[10px] ${
                        item.status === 'error' ? 'bg-red-50 text-red-700' : 'bg-tint text-accent-hover'
                      }`}
                    >
                      <IconFile />
                    </span>
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center justify-between gap-2.5">
                        <span className="truncate text-[13px] font-semibold text-ink">{item.name}</span>
                        <span
                          className={`tnum shrink-0 text-xs font-semibold ${
                            item.status === 'error'
                              ? 'text-red-700'
                              : item.status === 'done'
                                ? 'text-accent-hover'
                                : 'text-ink-soft'
                          }`}
                        >
                          {item.status === 'error'
                            ? t('doklady.nahrat.chyba')
                            : item.status === 'done'
                              ? t('doklady.nahrat.stavHotovo')
                              : `${item.progress} %`}
                        </span>
                      </div>
                      {item.status === 'error' ? (
                        <div className="mt-1.5 inline-flex items-center gap-1.5 text-[11.5px] font-medium text-red-700">
                          <IconAlert />
                          {item.error ?? t('doklady.nahrat.chyba')}
                        </div>
                      ) : (
                        <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-[#EEF1EE]">
                          <div
                            className="h-full rounded-full bg-gradient-to-r from-accent-bright to-accent transition-[width] duration-100 ease-linear"
                            style={{ width: `${item.progress}%` }}
                          />
                        </div>
                      )}
                    </div>
                    {item.status === 'uploading' ? (
                      <Spinner />
                    ) : item.status === 'done' ? (
                      <span className="grid h-[22px] w-[22px] shrink-0 place-items-center rounded-full bg-accent text-white">
                        <IconCheck />
                      </span>
                    ) : (
                      <button
                        type="button"
                        className="grid h-7 w-7 shrink-0 place-items-center rounded-lg text-red-700 transition hover:bg-red-100"
                        aria-label={t('doklady.nahrat.odstranit')}
                        onClick={() => dismiss(item.id)}
                      >
                        <IconX />
                      </button>
                    )}
                  </div>
                ))}
              </div>
            )}
          </>
        )}

        <div className="mt-1 flex items-center justify-between gap-3">
          {items.length > 0 ? (
            <span className="text-[12.5px] font-medium text-ink-faint">
              <span className="font-semibold text-accent">{uploadingCount}</span> {t('doklady.nahrat.pocetNahrava')} ·{' '}
              <span className="font-semibold text-accent-hover">{doneCount}</span> {t('doklady.nahrat.pocetHotovo')} ·{' '}
              <span className="font-semibold text-red-700">{errorCount}</span> {t('doklady.nahrat.pocetChyba')}
            </span>
          ) : (
            <span />
          )}
          <button type="button" className="btn" disabled={uploading} onClick={onClose}>
            {t('doklady.nahrat.zavriet')}
          </button>
        </div>
      </div>
    </Modal>
  );
}

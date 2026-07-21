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

  return (
    <Modal title={t('doklady.nahrat.titulok')} onClose={onClose} wide>
      <div className="flex flex-col gap-3">
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

            <label
              className={`flex cursor-pointer flex-col items-center gap-1 rounded border-2 border-dashed px-4 py-10 text-center transition-colors ${
                dragActive ? 'border-accent bg-accent/5' : 'border-line bg-app hover:border-accent/50'
              }`}
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
              <span className="text-sm">
                {t('doklady.nahrat.vyzva')}{' '}
                <span className="font-medium text-accent">{t('doklady.nahrat.vybrat')}</span>
              </span>
              <span className="text-xs text-ink-soft">{t('doklady.nahrat.formaty')}</span>
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

            {items.length > 0 && (
              <ul className="flex flex-col gap-2">
                {items.map((item) => (
                  <li key={item.id} className="flex items-center gap-3 text-sm">
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center justify-between gap-2">
                        <span className="truncate">{item.name}</span>
                        <span
                          className={`tnum shrink-0 text-xs ${
                            item.status === 'error' ? 'text-red-700' : 'text-ink-soft'
                          }`}
                        >
                          {item.status === 'error' ? t('doklady.nahrat.chyba') : `${item.progress} %`}
                        </span>
                      </div>
                      <div className="mt-1 h-1.5 overflow-hidden rounded-full bg-line">
                        <div
                          className={`h-full rounded-full transition-[width] duration-100 ease-linear ${
                            item.status === 'error'
                              ? 'bg-red-500'
                              : item.status === 'done'
                                ? 'bg-accent'
                                : 'bg-accent/70'
                          }`}
                          style={{ width: `${item.status === 'error' ? 100 : item.progress}%` }}
                        />
                      </div>
                      {item.status === 'error' && item.error && (
                        <p className="mt-0.5 text-xs text-red-700">{item.error}</p>
                      )}
                    </div>
                    {item.status !== 'uploading' && (
                      <button
                        type="button"
                        className="shrink-0 text-ink-soft hover:text-ink"
                        aria-label={t('doklady.nahrat.odstranit')}
                        onClick={() => dismiss(item.id)}
                      >
                        ✕
                      </button>
                    )}
                  </li>
                ))}
              </ul>
            )}
          </>
        )}

        <div className="flex justify-end">
          <button type="button" className="btn" disabled={uploading} onClick={onClose}>
            {t('doklady.nahrat.zavriet')}
          </button>
        </div>
      </div>
    </Modal>
  );
}

import { useCallback, useEffect, useRef, useState } from 'react';
import { useAuth } from '../../auth/AuthContext';
import { showToast } from '../../components/toast';
import { useDataQuery } from '../../data/query';
import { t } from '../../i18n/sk';

// Schránka organizácie (SPEC: sekcia Dokumenty) — voľné súbory mimo účtovného
// workflow, strikte izolované per-organizácia. Číta priamo backend REST API.

interface OrgDocument {
  id: string;
  organizationId: string;
  fileName: string;
  mimeType: string;
  byteSize: number;
  uploadedByName?: string;
  note?: string;
  createdAt?: string;
}

async function requestJson<T>(path: string, init?: RequestInit): Promise<T> {
  let csrfToken: string | undefined;
  const method = init?.method?.toUpperCase() ?? 'GET';
  if (!['GET', 'HEAD', 'OPTIONS'].includes(method)) {
    const sessionResponse = await fetch('/api/auth/session', { credentials: 'include' });
    if (!sessionResponse.ok) throw new Error(t('auth.nedostupne'));
    csrfToken = ((await sessionResponse.json()) as { csrfToken?: string }).csrfToken;
  }
  const response = await fetch(path, {
    credentials: 'include',
    ...init,
    headers: {
      ...(init?.body ? { 'Content-Type': 'application/json' } : {}),
      ...(csrfToken ? { 'X-CSRF-Token': csrfToken } : {}),
      ...init?.headers,
    },
  });
  if (!response.ok) {
    const body = (await response.json().catch(() => undefined)) as { message?: string } | undefined;
    throw new Error(body?.message || t('dokumenty.chyba'));
  }
  if (response.status === 204) return undefined as T;
  return response.json() as Promise<T>;
}

function formatBytes(value: number): string {
  if (value >= 1024 * 1024) return `${(value / (1024 * 1024)).toFixed(1)} MB`;
  if (value >= 1024) return `${Math.round(value / 1024)} kB`;
  return `${value} B`;
}

function formatDate(value?: string): string {
  if (!value) return '—';
  const date = new Date(value);
  return `${String(date.getDate()).padStart(2, '0')}.${String(date.getMonth() + 1).padStart(2, '0')}.${date.getFullYear()}`;
}

export function DokumentyPage() {
  const { session } = useAuth();
  const { data } = useDataQuery();
  const organizations = (data?.organizations ?? []).filter((org) => !org.archived);
  const [organizationId, setOrganizationId] = useState('');
  const [documents, setDocuments] = useState<OrgDocument[]>([]);
  const [loading, setLoading] = useState(false);
  const [uploading, setUploading] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const canManage = session?.user.role === 'admin' || session?.user.role === 'uctovnik';
  const selectedOrgId = organizationId || organizations[0]?.id || '';

  const refresh = useCallback(async (orgId: string) => {
    if (!orgId) return;
    setLoading(true);
    try {
      setDocuments(await requestJson<OrgDocument[]>(`/api/organizations/${orgId}/documents`));
    } catch (error) {
      showToast(error instanceof Error ? error.message : t('dokumenty.chyba'));
      setDocuments([]);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh(selectedOrgId);
  }, [selectedOrgId, refresh]);

  async function upload(file: File) {
    setUploading(true);
    try {
      const buffer = await file.arrayBuffer();
      let binary = '';
      const bytes = new Uint8Array(buffer);
      const chunk = 0x8000;
      for (let index = 0; index < bytes.length; index += chunk) {
        binary += String.fromCharCode(...bytes.subarray(index, index + chunk));
      }
      await requestJson(`/api/organizations/${selectedOrgId}/documents`, {
        method: 'POST',
        body: JSON.stringify({
          fileName: file.name,
          mimeType: file.type || 'application/octet-stream',
          contentBase64: btoa(binary),
        }),
      });
      showToast(t('dokumenty.nahrateOk'));
      await refresh(selectedOrgId);
    } catch (error) {
      showToast(error instanceof Error ? error.message : t('dokumenty.chyba'));
    } finally {
      setUploading(false);
      if (fileInputRef.current) fileInputRef.current.value = '';
    }
  }

  async function remove(documentId: string, fileName: string) {
    if (!window.confirm(`${t('dokumenty.vymazatPotvrdenie')} ${fileName}?`)) return;
    try {
      await requestJson(`/api/organizations/${selectedOrgId}/documents/${documentId}`, { method: 'DELETE' });
      showToast(t('dokumenty.vymazaneOk'));
      await refresh(selectedOrgId);
    } catch (error) {
      showToast(error instanceof Error ? error.message : t('dokumenty.chyba'));
    }
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold tracking-tight text-ink">{t('dokumenty.titulok')}</h1>
          <p className="text-sm text-ink-soft">{t('dokumenty.popis')}</p>
        </div>
        {canManage && (
          <div>
            <input
              ref={fileInputRef}
              type="file"
              accept="application/pdf,image/jpeg,image/png,image/webp,text/xml,application/xml"
              className="hidden"
              onChange={(event) => {
                const file = event.target.files?.[0];
                if (file) void upload(file);
              }}
            />
            <button
              type="button"
              className="btn btn-primary"
              disabled={!selectedOrgId || uploading}
              onClick={() => fileInputRef.current?.click()}
            >
              {uploading ? t('dokumenty.nahravam') : `+ ${t('dokumenty.nahrat')}`}
            </button>
          </div>
        )}
      </div>

      <div className="card p-4">
        <label className="mb-1 block text-xs font-medium text-ink-soft" htmlFor="dokumenty-org">
          {t('dokumenty.organizacia')}
        </label>
        <select
          id="dokumenty-org"
          className="input max-w-sm"
          value={selectedOrgId}
          onChange={(event) => setOrganizationId(event.target.value)}
        >
          {organizations.map((org) => (
            <option key={org.id} value={org.id}>{org.nazov}</option>
          ))}
        </select>
      </div>

      <div className="card overflow-hidden">
        {loading ? (
          <p className="p-6 text-sm text-ink-soft">{t('stav.nacitavam')}</p>
        ) : documents.length === 0 ? (
          <p className="p-6 text-sm text-ink-soft">{t('dokumenty.ziadne')}</p>
        ) : (
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-line text-left text-[11px] font-semibold uppercase tracking-wide text-ink-soft">
                <th className="px-4 py-2.5">{t('dokumenty.subor')}</th>
                <th className="tnum px-3 py-2.5 text-right">{t('dokumenty.velkost')}</th>
                <th className="px-3 py-2.5">{t('dokumenty.nahral')}</th>
                <th className="tnum px-3 py-2.5">{t('dokumenty.datum')}</th>
                <th className="px-3 py-2.5 text-right">{t('dokumenty.akcie')}</th>
              </tr>
            </thead>
            <tbody>
              {documents.map((doc) => (
                <tr key={doc.id} className="border-b border-line/60">
                  <td className="px-4 py-2.5 font-medium text-ink">{doc.fileName}</td>
                  <td className="tnum px-3 py-2.5 text-right">{formatBytes(doc.byteSize)}</td>
                  <td className="px-3 py-2.5 text-ink-soft">{doc.uploadedByName ?? '—'}</td>
                  <td className="tnum px-3 py-2.5">{formatDate(doc.createdAt)}</td>
                  <td className="px-3 py-2.5 text-right">
                    <a
                      className="btn mr-2 px-2.5 py-1 text-xs"
                      href={`/api/organizations/${doc.organizationId}/documents/${doc.id}/file`}
                      target="_blank"
                      rel="noreferrer"
                    >
                      {t('dokumenty.stiahnut')}
                    </a>
                    {canManage && (
                      <button
                        type="button"
                        className="btn px-2.5 py-1 text-xs text-red-700"
                        onClick={() => void remove(doc.id, doc.fileName)}
                      >
                        {t('dokumenty.vymazat')}
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}

// Detail „iného dokladu" — voľného firemného súboru mimo účtovného workflow.
// Zámerne bez editácie: dá sa iba pozrieť, stiahnuť a nechať si ho vysvetliť AI.
import { useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import {
  deleteOrgDocument,
  orgDocumentFileUrl,
  summarizeOrgDocument,
} from '../../data/api';
import { useDataQuery } from '../../data/query';
import { useAuth } from '../../auth/AuthContext';
import { showToast } from '../../components/toast';
import { ConfirmDialog } from '../../components/ui';
import { t } from '../../i18n/sk';
import { formatDateTime } from '../../lib/format';

function formatBytes(value: number): string {
  if (value >= 1024 * 1024) return `${(value / (1024 * 1024)).toFixed(1)} MB`;
  if (value >= 1024) return `${Math.round(value / 1024)} kB`;
  return `${value} B`;
}

export function OtherDocumentPage() {
  const { id = '' } = useParams();
  const navigate = useNavigate();
  const { session } = useAuth();
  const { data, loading, error } = useDataQuery();
  const [busy, setBusy] = useState(false);
  const [summary, setSummary] = useState<{ nadpis: string; body: string[] }>();
  const [deleteOpen, setDeleteOpen] = useState(false);

  if (loading) return <p className="text-sm text-ink-soft">{t('stav.nacitavam')}</p>;
  if (error || !data) return <p className="text-sm text-red-700">{t('chyba.vseobecna')}</p>;

  const document = (data.organizationDocuments ?? []).find((item) => item.id === id);
  if (!document) return <p className="text-sm text-ink-soft">{t('ine.neexistuje')}</p>;

  const organization = data.organizations.find((org) => org.id === document.organizationId);
  const fileUrl = orgDocumentFileUrl(document.organizationId, document.id);
  const shown = summary ?? document.aiSummary;
  const canDelete = session?.user.role === 'admin' || session?.user.role === 'uctovnik';

  async function vysvetlit() {
    if (!document) return;
    setBusy(true);
    try {
      setSummary(await summarizeOrgDocument(document.organizationId, document.id));
    } catch (cause) {
      showToast(cause instanceof Error ? cause.message : t('chyba.vseobecna'), { tone: 'error' });
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="mx-auto max-w-[1100px]">
      <div className="mb-4 flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <Link to="/doklady" className="text-[13px] text-accent underline-offset-2 hover:underline">
            ← {t('doklady.titulok')}
          </Link>
          <h1 className="mt-1 truncate text-xl font-semibold tracking-tight">{document.fileName}</h1>
          <p className="text-[13px] text-ink-soft">
            <span className="mr-2 inline-flex items-center rounded-md border border-violet-200 bg-violet-50 px-2 py-0.5 text-[11px] font-semibold text-violet-700">
              {t('ine.znacka')}
            </span>
            {organization?.nazov ?? '—'} · {formatBytes(document.byteSize)}
            {document.createdAt ? ` · ${formatDateTime(document.createdAt)}` : ''}
          </p>
        </div>
        <div className="flex items-center gap-2">
          <button type="button" className="btn btn-primary" disabled={busy} onClick={() => void vysvetlit()}>
            {busy ? t('ine.vysvetlujem') : t('ine.vysvetlit')}
          </button>
          <a className="btn" href={fileUrl} download={document.fileName}>
            {t('ine.stiahnut')}
          </a>
          {canDelete && (
            <button type="button" className="btn btn-danger" onClick={() => setDeleteOpen(true)}>
              {t('akcia.vymazat')}
            </button>
          )}
        </div>
      </div>

      {shown && (
        <section className="card mb-4 border-accent/30 bg-accent/5 p-4">
          <h2 className="text-sm font-bold text-accent-hover">{shown.nadpis}</h2>
          <ul className="mt-2 list-disc space-y-1 pl-5 text-sm text-ink">
            {shown.body.map((point, index) => (
              <li key={index}>{point}</li>
            ))}
          </ul>
          <p className="mt-2 text-[11.5px] text-ink-faint">{t('ine.aiPoznamka')}</p>
        </section>
      )}

      <section className="card overflow-hidden">
        {document.mimeType.startsWith('image/') ? (
          <img src={fileUrl} alt={document.fileName} className="mx-auto max-h-[70vh] w-auto" />
        ) : (
          // Náhľad je iba na čítanie — súbor sa nikdy neposiela späť na server.
          <iframe src={fileUrl} title={document.fileName} className="h-[70vh] w-full border-0" />
        )}
      </section>

      {deleteOpen && (
        <ConfirmDialog
          title={`${t('akcia.vymazat')}: ${document.fileName}`}
          text={t('ine.zmazatPotvrdenie')}
          danger
          onConfirm={() => {
            void deleteOrgDocument(document.organizationId, document.id)
              .then(() => {
                showToast(t('dokumenty.vymazaneOk'));
                navigate('/doklady');
              })
              .catch(() => showToast(t('chyba.vseobecna'), { tone: 'error' }));
          }}
          onClose={() => setDeleteOpen(false)}
        />
      )}
    </div>
  );
}

// CRUD organizácií — SPEC §6.6 + §11.19.
// emailAlias generuje systém po uložení; zobrazuje sa read-only s tlačidlom
// Kopírovať a NIKDY sa neprijíma z formulára ako voľný text.
import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  archiveOrganization,
  createOrganization,
  updateOrganization,
  type CreateOrganizationResult,
} from '../../data/api';
import { useDataQuery } from '../../data/query';
import { organizationInputSchema } from '../../data/schemas';
import type { Organization } from '../../data/types';
import { t } from '../../i18n/sk';
import { ConfirmDialog, CopyButton, Modal, OrgDot } from '../../components/ui';
import { showToast } from '../../components/toast';
import { DocumentCreateModal } from '../documents/DocumentCreateModal';
import { BankAccountsModal } from './BankAccountsModal';

const DEFAULT_COLORS = ['#0E7A5F', '#B45309', '#4338CA', '#0369A1', '#B91C1C', '#334155'];

interface FormState {
  nazov: string;
  ico: string;
  dic: string;
  icDph: string;
  farba: string;
  slugSuggestion: string;
}

const EMPTY_FORM: FormState = {
  nazov: '',
  ico: '',
  dic: '',
  icDph: '',
  farba: DEFAULT_COLORS[0],
  slugSuggestion: '',
};

export function OrganizationsTab() {
  const navigate = useNavigate();
  const organizations = useDataQuery().data?.organizations ?? [];
  const [modal, setModal] = useState<'new' | Organization | null>(null);
  const [documentOrganization, setDocumentOrganization] = useState<Organization | null>(null);
  const [bankOrganization, setBankOrganization] = useState<Organization | null>(null);
  const [archiveTarget, setArchiveTarget] = useState<Organization | null>(null);
  const [created, setCreated] = useState<CreateOrganizationResult | null>(null);

  return (
    <div>
      <div className="mb-3 flex justify-end">
        <button type="button" className="btn btn-primary" onClick={() => setModal('new')}>
          + {t('nast.org.nova')}
        </button>
      </div>

      {/* Success panel po vytvorení (SPEC §11.19) */}
      {created && (
        <div className="card mb-4 border-accent/40 bg-accent/5 p-4">
          <p className="font-medium text-accent">{t('nast.org.vytvorena')}</p>
          <p className="mt-1 text-sm text-ink-soft">{t('nast.org.emailAlias')}:</p>
          <div className="mt-1 flex items-center gap-2">
            <code className="tnum rounded border border-line bg-surface px-2 py-1 text-sm">
              {created.primaryEmailAlias.address}
            </code>
            <CopyButton value={created.primaryEmailAlias.address} label={t('nast.org.kopirovatAdresu')} />
            <button
              type="button"
              className="btn btn-primary"
              onClick={() => setDocumentOrganization(created.organization)}
            >
              {t('doklady.pridatPrvy')}
            </button>
            <button
              type="button"
              className="ml-auto rounded px-1 text-ink-soft hover:text-ink"
              onClick={() => setCreated(null)}
              aria-label={t('akcia.zatvorit')}
            >
              ✕
            </button>
          </div>
        </div>
      )}

      <div className="card overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-line text-left text-xs text-ink-soft">
              <th className="px-3 py-2 font-medium">{t('nast.org.nazov')}</th>
              <th className="px-3 py-2 font-medium">{t('nast.org.ico')}</th>
              <th className="px-3 py-2 font-medium">{t('nast.org.dic')}</th>
              <th className="px-3 py-2 font-medium">{t('nast.org.icDph')}</th>
              <th className="px-3 py-2 font-medium">{t('nast.org.emailAlias')}</th>
              <th className="px-3 py-2" />
            </tr>
          </thead>
          <tbody>
            {organizations.map((org) => (
              <tr key={org.id} className="border-b border-line last:border-0">
                <td className="px-3 py-2.5">
                  <span className="flex items-center gap-2 font-medium">
                    <OrgDot org={org} />
                    {org.nazov}
                    {org.archived && (
                      <span className="rounded border border-line bg-app px-1.5 py-0.5 text-xs text-ink-soft">
                        {t('nast.org.archivovana')}
                      </span>
                    )}
                  </span>
                </td>
                <td className="tnum px-3 py-2.5">{org.ico}</td>
                <td className="tnum px-3 py-2.5">{org.dic}</td>
                <td className="tnum px-3 py-2.5">{org.icDph ?? '—'}</td>
                <td className="px-3 py-2.5">
                  <span className="flex items-center gap-2">
                    <code className="tnum text-xs">{org.emailAlias}</code>
                    <CopyButton value={org.emailAlias} />
                  </span>
                </td>
                <td className="px-3 py-2.5 text-right whitespace-nowrap">
                  {!org.archived && (
                    <>
                      <button
                        type="button"
                        className="btn mr-1 px-2 py-1 text-xs"
                        onClick={() => setBankOrganization(org)}
                      >
                        {t('nast.org.bankoveUcty')}
                      </button>
                      <button
                        type="button"
                        className="btn mr-1 px-2 py-1 text-xs"
                        onClick={() => setDocumentOrganization(org)}
                      >
                        + {t('nast.org.pridatDoklad')}
                      </button>
                    </>
                  )}
                  <button type="button" className="btn mr-1 px-2 py-1 text-xs" onClick={() => setModal(org)}>
                    {t('akcia.upravit')}
                  </button>
                  {!org.archived && (
                    <button
                      type="button"
                      className="btn btn-danger px-2 py-1 text-xs"
                      onClick={() => setArchiveTarget(org)}
                    >
                      {t('nast.org.archivovat')}
                    </button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {modal && (
        <OrganizationFormModal
          existing={modal === 'new' ? undefined : modal}
          onClose={() => setModal(null)}
          onCreated={(result) => {
            setCreated(result);
            setModal(null);
          }}
        />
      )}

      {archiveTarget && (
        <ConfirmDialog
          title={`${t('nast.org.archivovat')}: ${archiveTarget.nazov}`}
          text={t('nast.org.archivovatPotvrdenie')}
          danger
          onConfirm={() => void archiveOrganization(archiveTarget.id)}
          onClose={() => setArchiveTarget(null)}
        />
      )}

      {documentOrganization && (
        <DocumentCreateModal
          initialOrganizationId={documentOrganization.id}
          fixedOrganization
          onClose={() => setDocumentOrganization(null)}
          onCreated={(document) => {
            setDocumentOrganization(null);
            navigate(`/doklady/${document.id}`);
          }}
        />
      )}

      {bankOrganization && (
        <BankAccountsModal
          organization={bankOrganization}
          onClose={() => setBankOrganization(null)}
        />
      )}
    </div>
  );
}

export function OrganizationFormModal({
  existing,
  onClose,
  onCreated,
}: {
  existing?: Organization;
  onClose: () => void;
  onCreated: (result: CreateOrganizationResult) => void;
}) {
  const [form, setForm] = useState<FormState>(
    existing
      ? {
          nazov: existing.nazov,
          ico: existing.ico,
          dic: existing.dic,
          icDph: existing.icDph ?? '',
          farba: existing.farba,
          slugSuggestion: '',
        }
      : EMPTY_FORM,
  );
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState(false);

  const set = (key: keyof FormState) => (e: React.ChangeEvent<HTMLInputElement>) =>
    setForm((f) => ({ ...f, [key]: e.target.value }));

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    const parsed = organizationInputSchema.safeParse({
      ...form,
      icDph: form.icDph || undefined,
      slugSuggestion: form.slugSuggestion || undefined,
    });
    if (!parsed.success) {
      const map: Record<string, string> = {};
      for (const issue of parsed.error.issues) {
        map[String(issue.path[0])] = issue.message;
      }
      setErrors(map);
      return;
    }
    setErrors({});
    setSaving(true);
    try {
      if (existing) {
        await updateOrganization(existing.id, {
          nazov: parsed.data.nazov,
          ico: parsed.data.ico,
          dic: parsed.data.dic,
          icDph: parsed.data.icDph,
          farba: parsed.data.farba,
        });
        showToast(t('toast.ulozene'));
        onClose();
      } else {
        // Adresa sa NEzobrazuje pred úspešnou odpoveďou mock API (SPEC §11.19)
        const result = await createOrganization(parsed.data);
        onCreated(result);
      }
    } finally {
      setSaving(false);
    }
  }

  return (
    <Modal title={existing ? t('akcia.upravit') : t('nast.org.nova')} onClose={onClose}>
      <form onSubmit={submit} className="flex flex-col gap-3">
        <div>
          <label className="label" htmlFor="org-nazov">
            {t('nast.org.nazov')}
          </label>
          <input id="org-nazov" className="input" value={form.nazov} onChange={set('nazov')} />
          {errors.nazov && <p className="mt-1 text-xs text-red-700">{errors.nazov}</p>}
        </div>
        <div className="grid grid-cols-2 gap-3">
          <div>
            <label className="label" htmlFor="org-ico">
              {t('nast.org.ico')}
            </label>
            <input id="org-ico" className="input tnum" value={form.ico} onChange={set('ico')} />
            {errors.ico && <p className="mt-1 text-xs text-red-700">{errors.ico}</p>}
          </div>
          <div>
            <label className="label" htmlFor="org-dic">
              {t('nast.org.dic')}
            </label>
            <input id="org-dic" className="input tnum" value={form.dic} onChange={set('dic')} />
            {errors.dic && <p className="mt-1 text-xs text-red-700">{errors.dic}</p>}
          </div>
        </div>
        <div>
          <label className="label" htmlFor="org-icdph">
            {t('nast.org.icDph')}
          </label>
          <input id="org-icdph" className="input tnum" value={form.icDph} onChange={set('icDph')} placeholder="SK2020123456" />
          {errors.icDph && <p className="mt-1 text-xs text-red-700">{errors.icDph}</p>}
        </div>
        <div>
          <span className="label">{t('nast.org.farba')}</span>
          <div className="flex items-center gap-2">
            {DEFAULT_COLORS.map((color) => (
              <button
                key={color}
                type="button"
                className={`h-7 w-7 rounded-full border-2 ${
                  form.farba === color ? 'border-ink' : 'border-transparent'
                }`}
                style={{ backgroundColor: color }}
                onClick={() => setForm((f) => ({ ...f, farba: color }))}
                aria-label={`${t('nast.org.farba')} ${color}`}
              />
            ))}
            <input
              type="color"
              className="h-7 w-9 cursor-pointer rounded border border-line"
              value={form.farba}
              onChange={set('farba')}
              aria-label={t('nast.org.farba')}
            />
          </div>
        </div>

        {existing ? (
          <div>
            <span className="label">{t('nast.org.emailAlias')}</span>
            <div className="flex items-center gap-2">
              <code className="tnum flex-1 rounded border border-line bg-app px-2 py-1.5 text-xs">
                {existing.emailAlias}
              </code>
              <CopyButton value={existing.emailAlias} />
            </div>
            <p className="mt-1 text-xs text-ink-soft">{t('nast.org.aliasPopis')}</p>
          </div>
        ) : (
          <div>
            <label className="label" htmlFor="org-slug">
              {t('nast.org.prefix')}
            </label>
            <input
              id="org-slug"
              className="input"
              value={form.slugSuggestion}
              onChange={set('slugSuggestion')}
              placeholder={t('nast.org.prefixPlaceholder')}
            />
            <p className="mt-1 text-xs text-ink-soft">{t('nast.org.prefixPopis')}</p>
          </div>
        )}

        <div className="mt-2 flex justify-end gap-2">
          <button type="button" className="btn" onClick={onClose}>
            {t('akcia.zrusit')}
          </button>
          <button type="submit" className="btn btn-primary" disabled={saving}>
            {t('akcia.ulozit')}
          </button>
        </div>
      </form>
    </Modal>
  );
}

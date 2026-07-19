import { useMemo, useState } from 'react';
import { archivePartner, createPartner, updatePartner } from '../../data/api';
import { useDataQuery } from '../../data/query';
import type { Partner, PartnerInput } from '../../data/types';
import { ConfirmDialog, EmptyState, Modal, OrgDot } from '../../components/ui';
import { showToast } from '../../components/toast';
import { t } from '../../i18n/sk';

// Partneri — adresár kontrahentov. Záznamy vznikajú automaticky z dokladov;
// tu sa dopĺňajú kontakty a predvolené zaúčtovanie (zdroj návrhu
// 'partner_default' pri ďalších dokladoch toho istého dodávateľa).

interface FormState {
  nazov: string;
  ico: string;
  dic: string;
  icDph: string;
  iban: string;
  adresa: string;
  email: string;
  telefon: string;
  predvolenaPredkontaciaId: string;
  predvoleneClenenieDphId: string;
  predvoleneStrediskoId: string;
  poznamka: string;
}

function formFromPartner(partner?: Partner): FormState {
  return {
    nazov: partner?.nazov ?? '',
    ico: partner?.ico ?? '',
    dic: partner?.dic ?? '',
    icDph: partner?.icDph ?? '',
    iban: partner?.iban ?? '',
    adresa: partner?.adresa ?? '',
    email: partner?.email ?? '',
    telefon: partner?.telefon ?? '',
    predvolenaPredkontaciaId: partner?.predvolenaPredkontaciaId ?? '',
    predvoleneClenenieDphId: partner?.predvoleneClenenieDphId ?? '',
    predvoleneStrediskoId: partner?.predvoleneStrediskoId ?? '',
    poznamka: partner?.poznamka ?? '',
  };
}

function toInput(form: FormState): PartnerInput {
  const opt = (value: string) => value.trim() || undefined;
  return {
    nazov: form.nazov.trim(),
    ico: opt(form.ico),
    dic: opt(form.dic),
    icDph: opt(form.icDph),
    iban: opt(form.iban),
    adresa: opt(form.adresa),
    email: opt(form.email),
    telefon: opt(form.telefon),
    predvolenaPredkontaciaId: opt(form.predvolenaPredkontaciaId),
    predvoleneClenenieDphId: opt(form.predvoleneClenenieDphId),
    predvoleneStrediskoId: opt(form.predvoleneStrediskoId),
    poznamka: opt(form.poznamka),
  };
}

export function PartnersPage() {
  const { data, loading, error } = useDataQuery();
  const [search, setSearch] = useState('');
  const [showArchived, setShowArchived] = useState(false);
  const [editing, setEditing] = useState<{ partner?: Partner; orgId: string }>();
  const [archiving, setArchiving] = useState<Partner>();

  const partners = useMemo(() => {
    if (!data) return [];
    const needle = search.trim().toLocaleLowerCase('sk');
    return (data.partners ?? [])
      .filter((partner) => data.currentOrgId === 'all' || partner.organizationId === data.currentOrgId)
      .filter((partner) => showArchived || partner.active)
      .filter((partner) => {
        if (!needle) return true;
        return [partner.nazov, partner.ico, partner.icDph, partner.iban]
          .filter(Boolean).join(' ').toLocaleLowerCase('sk').includes(needle);
      })
      .sort((a, b) => a.nazov.localeCompare(b.nazov, 'sk'));
  }, [data, search, showArchived]);

  if (loading) return <p className="text-sm text-ink-soft">{t('stav.nacitavam')}</p>;
  if (error || !data) return <p className="text-sm text-red-700">{t('chyba.vseobecna')}</p>;

  const organizations = data.organizations.filter((organization) => !organization.archived);
  const organizationsById = new Map(organizations.map((organization) => [organization.id, organization]));
  const readOnly = data.role === 'schvalovatel';
  const defaultOrgId = data.currentOrgId !== 'all' ? data.currentOrgId : organizations[0]?.id;

  return (
    <div>
      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-xl font-semibold">{t('partneri.titulok')}</h1>
        <div className="flex flex-wrap items-center gap-2">
          <input
            className="input w-64"
            type="search"
            placeholder={t('partneri.hladat')}
            value={search}
            onChange={(event) => setSearch(event.target.value)}
          />
          <label className="flex items-center gap-2 text-sm text-ink-soft">
            <input
              type="checkbox"
              checked={showArchived}
              onChange={(event) => setShowArchived(event.target.checked)}
            />
            {t('partneri.zobrazitArchivovanych')}
          </label>
          {!readOnly && defaultOrgId && (
            <button type="button" className="btn btn-primary" onClick={() => setEditing({ orgId: defaultOrgId })}>
              {t('partneri.novy')}
            </button>
          )}
        </div>
      </div>

      {partners.length === 0 ? (
        <EmptyState>
          <p>{t('partneri.ziadni')}</p>
        </EmptyState>
      ) : (
        <section className="card overflow-x-auto">
          <table className="w-full min-w-[860px] text-sm">
            <thead>
              <tr className="border-b border-line text-left text-xs text-ink-soft">
                <th className="px-3 py-2 font-medium">{t('partneri.st.nazov')}</th>
                <th className="px-3 py-2 font-medium">{t('partneri.st.organizacia')}</th>
                <th className="px-3 py-2 font-medium">IČO</th>
                <th className="px-3 py-2 font-medium">IČ DPH</th>
                <th className="px-3 py-2 font-medium">IBAN</th>
                <th className="px-3 py-2 font-medium">{t('partneri.st.predvolby')}</th>
                <th className="px-3 py-2 font-medium">{t('partneri.st.zdroj')}</th>
                <th className="px-3 py-2" />
              </tr>
            </thead>
            <tbody>
              {partners.map((partner) => {
                const organization = organizationsById.get(partner.organizationId);
                const maPredvolby = Boolean(
                  partner.predvolenaPredkontaciaId || partner.predvoleneClenenieDphId || partner.predvoleneStrediskoId,
                );
                return (
                  <tr key={partner.id} className={`border-b border-line/60 last:border-0 ${partner.active ? '' : 'opacity-50'}`}>
                    <td className="px-3 py-2 font-medium text-ink">{partner.nazov}</td>
                    <td className="px-3 py-2">
                      {organization && (
                        <span className="flex items-center gap-1.5">
                          <OrgDot org={organization} />
                          {organization.nazov}
                        </span>
                      )}
                    </td>
                    <td className="tnum px-3 py-2">{partner.ico ?? ''}</td>
                    <td className="tnum px-3 py-2">{partner.icDph ?? ''}</td>
                    <td className="tnum max-w-44 truncate px-3 py-2">{partner.iban ?? ''}</td>
                    <td className="px-3 py-2">
                      {maPredvolby ? (
                        <span className="rounded-full bg-accent/10 px-2 py-0.5 text-xs text-accent-hover">
                          {t('partneri.predvolbyNastavene')}
                        </span>
                      ) : (
                        <span className="text-xs text-ink-soft">—</span>
                      )}
                    </td>
                    <td className="px-3 py-2 text-xs text-ink-soft">{t(`partneri.zdroj.${partner.source}`)}</td>
                    <td className="px-3 py-2 text-right">
                      {!readOnly && (
                        <span className="flex justify-end gap-1">
                          <button
                            type="button"
                            className="btn px-2 py-1 text-xs"
                            onClick={() => setEditing({ partner, orgId: partner.organizationId })}
                          >
                            {t('partneri.upravit')}
                          </button>
                          {partner.active && (
                            <button
                              type="button"
                              className="btn px-2 py-1 text-xs"
                              onClick={() => setArchiving(partner)}
                            >
                              {t('partneri.archivovat')}
                            </button>
                          )}
                        </span>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </section>
      )}

      {editing && (
        <PartnerFormModal
          partner={editing.partner}
          orgId={editing.orgId}
          organizations={organizations}
          onClose={() => setEditing(undefined)}
        />
      )}
      {archiving && (
        <ConfirmDialog
          title={t('partneri.archivovat')}
          text={t('partneri.archivovatPotvrdenie')}
          danger
          onConfirm={() => {
            void archivePartner(archiving.id)
              .then(() => showToast(t('toast.ulozene')))
              .catch((cause) => showToast(cause instanceof Error ? cause.message : t('chyba.vseobecna'), { tone: 'error' }));
          }}
          onClose={() => setArchiving(undefined)}
        />
      )}
    </div>
  );
}

function PartnerFormModal({
  partner,
  orgId,
  organizations,
  onClose,
}: {
  partner?: Partner;
  orgId: string;
  organizations: Array<{ id: string; nazov: string }>;
  onClose: () => void;
}) {
  const { data } = useDataQuery();
  const [form, setForm] = useState<FormState>(formFromPartner(partner));
  const [selectedOrgId, setSelectedOrgId] = useState(orgId);
  const [saving, setSaving] = useState(false);

  const codeLists = data?.codeLists;
  const forOrg = (items: Array<{ id: string; orgId: string; kod: string; nazov: string; active: boolean }> | undefined) =>
    (items ?? []).filter((item) => item.orgId === selectedOrgId && item.active);

  const set = (key: keyof FormState) => (event: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) =>
    setForm((current) => ({ ...current, [key]: event.target.value }));

  async function save() {
    if (!form.nazov.trim()) {
      showToast(t('partneri.nazovPovinny'), { tone: 'error' });
      return;
    }
    setSaving(true);
    try {
      if (partner) await updatePartner(partner.id, toInput(form));
      else await createPartner(selectedOrgId, toInput(form));
      showToast(t('toast.ulozene'));
      onClose();
    } catch (cause) {
      showToast(cause instanceof Error ? cause.message : t('chyba.vseobecna'), { tone: 'error' });
    } finally {
      setSaving(false);
    }
  }

  const defaultSelect = (
    labelKey: 'partneri.predvolenaPredkontacia' | 'partneri.predvoleneClenenie' | 'partneri.predvoleneStredisko',
    key: 'predvolenaPredkontaciaId' | 'predvoleneClenenieDphId' | 'predvoleneStrediskoId',
    items: Array<{ id: string; kod: string; nazov: string }>,
  ) => (
    <label className="block">
      <span className="label">{t(labelKey)}</span>
      <select className="input w-full" value={form[key]} onChange={set(key)}>
        <option value="">{t('nast.dph.bezVyberu')}</option>
        {items.map((item) => (
          <option key={item.id} value={item.id}>{item.kod} — {item.nazov}</option>
        ))}
      </select>
    </label>
  );

  return (
    <Modal title={partner ? t('partneri.upravit') : t('partneri.novy')} onClose={onClose} wide>
      <div className="grid gap-3 md:grid-cols-2">
        {!partner && organizations.length > 1 && (
          <label className="block md:col-span-2">
            <span className="label">{t('partneri.st.organizacia')}</span>
            <select
              className="input w-full"
              value={selectedOrgId}
              onChange={(event) => setSelectedOrgId(event.target.value)}
            >
              {organizations.map((organization) => (
                <option key={organization.id} value={organization.id}>{organization.nazov}</option>
              ))}
            </select>
          </label>
        )}
        <label className="block md:col-span-2">
          <span className="label">{t('partneri.st.nazov')}</span>
          <input className="input w-full" value={form.nazov} onChange={set('nazov')} />
        </label>
        <label className="block">
          <span className="label">IČO</span>
          <input className="input tnum w-full" value={form.ico} onChange={set('ico')} />
        </label>
        <label className="block">
          <span className="label">DIČ</span>
          <input className="input tnum w-full" value={form.dic} onChange={set('dic')} />
        </label>
        <label className="block">
          <span className="label">IČ DPH</span>
          <input className="input tnum w-full" value={form.icDph} onChange={set('icDph')} />
        </label>
        <label className="block">
          <span className="label">IBAN</span>
          <input className="input tnum w-full" value={form.iban} onChange={set('iban')} />
        </label>
        <label className="block md:col-span-2">
          <span className="label">{t('partneri.adresa')}</span>
          <input className="input w-full" value={form.adresa} onChange={set('adresa')} />
        </label>
        <label className="block">
          <span className="label">E-mail</span>
          <input className="input w-full" type="email" value={form.email} onChange={set('email')} />
        </label>
        <label className="block">
          <span className="label">{t('partneri.telefon')}</span>
          <input className="input w-full" value={form.telefon} onChange={set('telefon')} />
        </label>
        {defaultSelect('partneri.predvolenaPredkontacia', 'predvolenaPredkontaciaId', forOrg(codeLists?.predkontacie))}
        {defaultSelect('partneri.predvoleneClenenie', 'predvoleneClenenieDphId', forOrg(codeLists?.cleneniaDph))}
        {defaultSelect('partneri.predvoleneStredisko', 'predvoleneStrediskoId', forOrg(codeLists?.strediska))}
        <label className="block md:col-span-2">
          <span className="label">{t('partneri.poznamka')}</span>
          <input className="input w-full" value={form.poznamka} onChange={set('poznamka')} />
        </label>
      </div>
      <div className="mt-4 flex justify-end gap-2">
        <button type="button" className="btn" onClick={onClose}>{t('akcia.zrusit')}</button>
        <button type="button" className="btn btn-primary" disabled={saving} onClick={() => void save()}>
          {saving ? t('stav.nacitavam') : t('akcia.ulozit')}
        </button>
      </div>
    </Modal>
  );
}

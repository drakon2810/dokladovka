import { useMemo, useState } from 'react';
import { saveEmailTemplates, saveNoteTemplates } from '../../data/api';
import { useDataQuery } from '../../data/query';
import { showToast } from '../../components/toast';
import { t } from '../../i18n/sk';

// Šablóny — preddefinované poznámky (vkladajú sa do poľa „poznámka“ na
// doklade) a e-mailové šablóny organizácie. Zoznamy sa ukladajú celé naraz.

interface SablonaDraft {
  nazov: string;
  predmet: string;
  telo: string;
}

export function TemplatesTab() {
  const { data, loading, error } = useDataQuery();
  const [selectedOrgId, setSelectedOrgId] = useState<string>();
  const [drafts, setDrafts] = useState<Record<string, { poznamky: string[]; sablony: SablonaDraft[] }>>({});
  const [busy, setBusy] = useState<'poznamky' | 'sablony'>();

  const organizations = useMemo(
    () => (data?.organizations ?? []).filter((org) => !org.archived),
    [data?.organizations],
  );
  const orgId = selectedOrgId ?? organizations[0]?.id;

  if (loading) return <p className="text-sm text-ink-soft">{t('stav.nacitavam')}</p>;
  if (error || !data) return <p className="text-sm text-red-700">{t('chyba.vseobecna')}</p>;
  if (!orgId) return <p className="text-sm text-ink-soft">{t('nast.dph.ziadnaOrganizacia')}</p>;

  const draft = drafts[orgId] ?? {
    poznamky: (data.noteTemplates ?? [])
      .filter((template) => template.organizationId === orgId)
      .map((template) => template.text),
    sablony: (data.emailTemplates ?? [])
      .filter((template) => template.organizationId === orgId)
      .map((template) => ({ nazov: template.nazov, predmet: template.predmet, telo: template.telo })),
  };

  function update(next: Partial<typeof draft>) {
    setDrafts((current) => ({ ...current, [orgId!]: { ...draft, ...next } }));
  }

  async function ulozPoznamky() {
    const poznamky = draft.poznamky.map((text) => text.trim()).filter(Boolean);
    setBusy('poznamky');
    try {
      await saveNoteTemplates(orgId!, poznamky);
      showToast(t('toast.ulozene'));
    } catch (cause) {
      showToast(cause instanceof Error ? cause.message : t('chyba.vseobecna'), { tone: 'error' });
    } finally {
      setBusy(undefined);
    }
  }

  async function ulozSablony() {
    const sablony = draft.sablony
      .map((sablona) => ({ nazov: sablona.nazov.trim(), predmet: sablona.predmet.trim(), telo: sablona.telo.trim() }))
      .filter((sablona) => sablona.nazov || sablona.predmet || sablona.telo);
    if (sablony.some((sablona) => !sablona.nazov || !sablona.predmet || !sablona.telo)) {
      showToast(t('nast.sablony.neuplna'), { tone: 'error' });
      return;
    }
    setBusy('sablony');
    try {
      await saveEmailTemplates(orgId!, sablony);
      showToast(t('toast.ulozene'));
    } catch (cause) {
      showToast(cause instanceof Error ? cause.message : t('chyba.vseobecna'), { tone: 'error' });
    } finally {
      setBusy(undefined);
    }
  }

  return (
    <div className="space-y-4">
      <label className="block max-w-md">
        <span className="label">{t('nast.dph.organizacia')}</span>
        <select className="input w-full" value={orgId} onChange={(event) => setSelectedOrgId(event.target.value)}>
          {organizations.map((org) => (
            <option key={org.id} value={org.id}>{org.nazov}</option>
          ))}
        </select>
      </label>

      <section className="card space-y-3 p-4">
        <h2 className="font-semibold text-ink">{t('nast.sablony.poznamky')}</h2>
        <p className="text-sm text-ink-soft">{t('nast.sablony.poznamkyPopis')}</p>
        {draft.poznamky.map((text, index) => (
          <div key={index} className="flex items-center gap-2">
            <input
              className="input flex-1"
              value={text}
              onChange={(event) => update({
                poznamky: draft.poznamky.map((item, i) => (i === index ? event.target.value : item)),
              })}
            />
            <button
              type="button"
              className="btn"
              onClick={() => update({ poznamky: draft.poznamky.filter((_, i) => i !== index) })}
            >
              {t('nast.dph.odstranit')}
            </button>
          </div>
        ))}
        <div className="flex gap-2">
          <button type="button" className="btn" onClick={() => update({ poznamky: [...draft.poznamky, ''] })}>
            {t('nast.dph.pridatRiadok')}
          </button>
          <button
            type="button"
            className="btn btn-primary"
            disabled={busy === 'poznamky'}
            onClick={() => void ulozPoznamky()}
          >
            {busy === 'poznamky' ? t('stav.nacitavam') : t('akcia.ulozit')}
          </button>
        </div>
      </section>

      <section className="card space-y-3 p-4">
        <h2 className="font-semibold text-ink">{t('nast.sablony.emaily')}</h2>
        <p className="text-sm text-ink-soft">{t('nast.sablony.emailyPopis')}</p>
        {draft.sablony.map((sablona, index) => (
          <div key={index} className="rounded border border-line p-3">
            <div className="grid gap-2 md:grid-cols-2">
              <input
                className="input"
                placeholder={t('nast.sablony.nazov')}
                value={sablona.nazov}
                onChange={(event) => update({
                  sablony: draft.sablony.map((item, i) => (i === index ? { ...item, nazov: event.target.value } : item)),
                })}
              />
              <input
                className="input"
                placeholder={t('nast.sablony.predmet')}
                value={sablona.predmet}
                onChange={(event) => update({
                  sablony: draft.sablony.map((item, i) => (i === index ? { ...item, predmet: event.target.value } : item)),
                })}
              />
            </div>
            <textarea
              className="input mt-2 min-h-24 w-full"
              placeholder={t('nast.sablony.telo')}
              value={sablona.telo}
              onChange={(event) => update({
                sablony: draft.sablony.map((item, i) => (i === index ? { ...item, telo: event.target.value } : item)),
              })}
            />
            <button
              type="button"
              className="btn mt-2"
              onClick={() => update({ sablony: draft.sablony.filter((_, i) => i !== index) })}
            >
              {t('nast.dph.odstranit')}
            </button>
          </div>
        ))}
        <div className="flex gap-2">
          <button
            type="button"
            className="btn"
            onClick={() => update({ sablony: [...draft.sablony, { nazov: '', predmet: '', telo: '' }] })}
          >
            {t('nast.dph.pridatRiadok')}
          </button>
          <button
            type="button"
            className="btn btn-primary"
            disabled={busy === 'sablony'}
            onClick={() => void ulozSablony()}
          >
            {busy === 'sablony' ? t('stav.nacitavam') : t('akcia.ulozit')}
          </button>
        </div>
      </section>
    </div>
  );
}

import { useMemo, useState } from 'react';
import { saveDphProfile } from '../../data/api';
import { useDataQuery } from '../../data/query';
import { CLENENIE_KV_KODY, type DphProfil } from '../../data/types';
import { showToast } from '../../components/toast';
import { t } from '../../i18n/sk';

// Profil klienta — sekcia DPH. Profil je inštrukcia pre AI návrhy a zároveň
// zdroj deterministických kontrol (dphAdvisor) pri prijatí a schvaľovaní.

interface KoeficientDraft {
  rok: string;
  typ: 'zalohovy' | 'rocny';
  hodnota: string;
}

interface PravidloDraft {
  kategoria: string;
  percento: string;
  klucoveSlova: string;
}

interface BezNarokuDraft {
  kategoria: string;
  klucoveSlova: string;
}

interface ProfilDraft {
  platitelDph: DphProfil['platitelDph'];
  obdobieDph: DphProfil['obdobieDph'];
  uzavreteDo: string;
  rezim: DphProfil['rezim'];
  nakupyZEu: boolean;
  sluzbyZEu: boolean;
  prenesenieDp: boolean;
  koeficient: KoeficientDraft[];
  pomerneOdpocitanie: PravidloDraft[];
  pravidlaAut: PravidloDraft[];
  bezNaroku: BezNarokuDraft[];
  samozdanenieAktivne: boolean;
  samozdanenieClenenieDphId: string;
  samozdanenieClenenieKvKod: string;
  clenenieBezOdpoctuId: string;
}

function slova(value: string): string[] {
  return value.split(',').map((item) => item.trim()).filter(Boolean);
}

function draftFromProfile(profil?: DphProfil): ProfilDraft {
  return {
    platitelDph: profil?.platitelDph ?? 'platitel',
    obdobieDph: profil?.obdobieDph ?? 'mesacne',
    uzavreteDo: profil?.uzavreteDo ?? '',
    rezim: profil?.rezim ?? 'tuzemsky',
    nakupyZEu: profil?.nakupyZEu ?? false,
    sluzbyZEu: profil?.sluzbyZEu ?? false,
    prenesenieDp: profil?.prenesenieDp ?? false,
    koeficient: (profil?.koeficient ?? []).map((zaznam) => ({
      rok: String(zaznam.rok),
      typ: zaznam.typ,
      hodnota: String(zaznam.hodnota),
    })),
    pomerneOdpocitanie: (profil?.pomerneOdpocitanie ?? []).map((pravidlo) => ({
      kategoria: pravidlo.kategoria,
      percento: String(pravidlo.percento),
      klucoveSlova: pravidlo.klucoveSlova.join(', '),
    })),
    pravidlaAut: (profil?.pravidlaAut ?? []).map((pravidlo) => ({
      kategoria: pravidlo.kategoria,
      percento: String(pravidlo.percento),
      klucoveSlova: pravidlo.klucoveSlova.join(', '),
    })),
    bezNaroku: (profil?.bezNaroku ?? []).map((kategoria) => ({
      kategoria: kategoria.kategoria,
      klucoveSlova: kategoria.klucoveSlova.join(', '),
    })),
    samozdanenieAktivne: profil?.samozdanenieAktivne ?? false,
    samozdanenieClenenieDphId: profil?.samozdanenieClenenieDphId ?? '',
    samozdanenieClenenieKvKod: profil?.samozdanenieClenenieKvKod ?? '',
    clenenieBezOdpoctuId: profil?.clenenieBezOdpoctuId ?? '',
  };
}

export function ClientProfileTab() {
  const { data, loading, error } = useDataQuery();
  const [selectedOrgId, setSelectedOrgId] = useState<string>();
  const [drafts, setDrafts] = useState<Record<string, ProfilDraft>>({});
  const [busy, setBusy] = useState(false);

  const organizations = useMemo(
    () => (data?.organizations ?? []).filter((org) => !org.archived),
    [data?.organizations],
  );
  const orgId = selectedOrgId ?? organizations[0]?.id;

  if (loading) return <p className="text-sm text-ink-soft">{t('stav.nacitavam')}</p>;
  if (error || !data) return <p className="text-sm text-red-700">{t('chyba.vseobecna')}</p>;
  if (!orgId) return <p className="text-sm text-ink-soft">{t('nast.dph.ziadnaOrganizacia')}</p>;

  const draft = drafts[orgId]
    ?? draftFromProfile(data.dphProfiles?.find((profil) => profil.organizationId === orgId));
  const cleneniaDph = data.codeLists.cleneniaDph
    .filter((item) => item.orgId === orgId && item.active);

  function update(next: Partial<ProfilDraft>) {
    setDrafts((current) => ({ ...current, [orgId!]: { ...draft, ...next } }));
  }

  async function save() {
    const koeficient = draft.koeficient.map((zaznam) => ({
      rok: Number(zaznam.rok),
      typ: zaznam.typ,
      hodnota: Number(zaznam.hodnota.replace(',', '.')),
    }));
    const pravidla = (rows: PravidloDraft[]) => rows.map((pravidlo) => ({
      kategoria: pravidlo.kategoria.trim(),
      percento: Number(pravidlo.percento.replace(',', '.')),
      klucoveSlova: slova(pravidlo.klucoveSlova),
    }));
    const pomerneOdpocitanie = pravidla(draft.pomerneOdpocitanie);
    const pravidlaAut = pravidla(draft.pravidlaAut);
    const bezNaroku = draft.bezNaroku.map((kategoria) => ({
      kategoria: kategoria.kategoria.trim(),
      klucoveSlova: slova(kategoria.klucoveSlova),
    }));
    const zle = koeficient.some((zaznam) => !Number.isFinite(zaznam.hodnota) || zaznam.hodnota < 0 || zaznam.hodnota > 1
        || !Number.isInteger(zaznam.rok) || zaznam.rok < 2000 || zaznam.rok > 2100)
      || [...pomerneOdpocitanie, ...pravidlaAut].some((pravidlo) => !pravidlo.kategoria
        || !Number.isFinite(pravidlo.percento) || pravidlo.percento < 0 || pravidlo.percento > 100)
      || bezNaroku.some((kategoria) => !kategoria.kategoria);
    if (zle) {
      showToast(t('nast.dph.neplatnaHodnota'), { tone: 'error' });
      return;
    }
    setBusy(true);
    try {
      await saveDphProfile(orgId!, {
        platitelDph: draft.platitelDph,
        obdobieDph: draft.obdobieDph,
        uzavreteDo: draft.uzavreteDo || undefined,
        koeficient,
        pomerneOdpocitanie,
        rezim: draft.rezim,
        nakupyZEu: draft.nakupyZEu,
        sluzbyZEu: draft.sluzbyZEu,
        prenesenieDp: draft.prenesenieDp,
        pravidlaAut,
        bezNaroku,
        samozdanenieAktivne: draft.samozdanenieAktivne,
        samozdanenieClenenieDphId: draft.samozdanenieClenenieDphId || undefined,
        samozdanenieClenenieKvKod: draft.samozdanenieClenenieKvKod || undefined,
        clenenieBezOdpoctuId: draft.clenenieBezOdpoctuId || undefined,
      });
      showToast(t('nast.dph.ulozeneOk'));
    } catch (cause) {
      showToast(cause instanceof Error ? cause.message : t('chyba.vseobecna'), { tone: 'error' });
    } finally {
      setBusy(false);
    }
  }

  const clenenieSelect = (
    value: string,
    onChange: (next: string) => void,
    labelKey: 'nast.dph.samozdanenieClenenie' | 'nast.dph.clenenieBezOdpoctu',
  ) => (
    <label className="block">
      <span className="label">{t(labelKey)}</span>
      <select className="input w-full" value={value} onChange={(event) => onChange(event.target.value)}>
        <option value="">{t('nast.dph.bezVyberu')}</option>
        {cleneniaDph.map((item) => (
          <option key={item.id} value={item.id}>{item.kod} — {item.nazov}</option>
        ))}
      </select>
    </label>
  );

  return (
    <div className="space-y-4">
      <p className="text-sm text-ink-soft">{t('nast.dph.popis')}</p>

      <label className="block max-w-md">
        <span className="label">{t('nast.dph.organizacia')}</span>
        <select
          className="input w-full"
          value={orgId}
          onChange={(event) => setSelectedOrgId(event.target.value)}
        >
          {organizations.map((org) => (
            <option key={org.id} value={org.id}>{org.nazov}</option>
          ))}
        </select>
      </label>

      <section className="card space-y-4 p-4">
        <h2 className="font-semibold text-ink">{t('nast.dph.sekcia')}</h2>

        <div className="grid gap-3 md:grid-cols-3">
          <label className="block">
            <span className="label">{t('nast.dph.platitel')}</span>
            <select
              className="input w-full"
              value={draft.platitelDph}
              onChange={(event) => update({ platitelDph: event.target.value as DphProfil['platitelDph'] })}
            >
              <option value="platitel">{t('nast.dph.platitel.platitel')}</option>
              <option value="neplatitel">{t('nast.dph.platitel.neplatitel')}</option>
              <option value="registracia_7a">{t('nast.dph.platitel.registracia_7a')}</option>
            </select>
          </label>
          <label className="block">
            <span className="label">{t('nast.dph.obdobie')}</span>
            <select
              className="input w-full"
              value={draft.obdobieDph}
              onChange={(event) => update({ obdobieDph: event.target.value as DphProfil['obdobieDph'] })}
            >
              <option value="mesacne">{t('nast.dph.obdobie.mesacne')}</option>
              <option value="stvrtrocne">{t('nast.dph.obdobie.stvrtrocne')}</option>
            </select>
          </label>
          <label className="block">
            <span className="label">{t('nast.dph.uzavreteDo')}</span>
            <input
              type="date"
              className="input w-full"
              value={draft.uzavreteDo}
              onChange={(event) => update({ uzavreteDo: event.target.value })}
            />
            <span className="mt-1 block text-xs text-ink-soft">{t('nast.dph.uzavreteDoPopis')}</span>
          </label>
        </div>

        <div className="grid gap-3 md:grid-cols-4">
          <label className="block">
            <span className="label">{t('nast.dph.rezim')}</span>
            <select
              className="input w-full"
              value={draft.rezim}
              onChange={(event) => update({ rezim: event.target.value as DphProfil['rezim'] })}
            >
              <option value="tuzemsky">{t('nast.dph.rezim.tuzemsky')}</option>
              <option value="zahranicny">{t('nast.dph.rezim.zahranicny')}</option>
            </select>
          </label>
          {([
            ['nakupyZEu', t('nast.dph.nakupyZEu')],
            ['sluzbyZEu', t('nast.dph.sluzbyZEu')],
            ['prenesenieDp', t('nast.dph.prenesenieDp')],
          ] as const).map(([key, label]) => (
            <label key={key} className="flex items-end gap-2 pb-2">
              <input
                type="checkbox"
                className="h-5 w-5"
                checked={draft[key]}
                onChange={(event) => update({ [key]: event.target.checked } as Partial<ProfilDraft>)}
              />
              <span className="text-sm text-ink">{label}</span>
            </label>
          ))}
        </div>

        <div>
          <p className="label">{t('nast.dph.koeficient')}</p>
          {draft.koeficient.map((zaznam, index) => (
            <div key={index} className="mt-2 flex flex-wrap items-center gap-2">
              <input
                className="input tnum w-24"
                inputMode="numeric"
                placeholder={t('nast.dph.koeficient.rok')}
                value={zaznam.rok}
                onChange={(event) => update({
                  koeficient: draft.koeficient.map((item, i) => (i === index ? { ...item, rok: event.target.value } : item)),
                })}
              />
              <select
                className="input w-32"
                value={zaznam.typ}
                onChange={(event) => update({
                  koeficient: draft.koeficient.map((item, i) => (i === index ? { ...item, typ: event.target.value as KoeficientDraft['typ'] } : item)),
                })}
              >
                <option value="zalohovy">{t('nast.dph.koeficient.typ.zalohovy')}</option>
                <option value="rocny">{t('nast.dph.koeficient.typ.rocny')}</option>
              </select>
              <input
                className="input tnum w-28"
                inputMode="decimal"
                placeholder={t('nast.dph.koeficient.hodnota')}
                value={zaznam.hodnota}
                onChange={(event) => update({
                  koeficient: draft.koeficient.map((item, i) => (i === index ? { ...item, hodnota: event.target.value } : item)),
                })}
              />
              <button
                type="button"
                className="btn"
                onClick={() => update({ koeficient: draft.koeficient.filter((_, i) => i !== index) })}
              >
                {t('nast.dph.odstranit')}
              </button>
            </div>
          ))}
          <button
            type="button"
            className="btn mt-2"
            onClick={() => update({ koeficient: [...draft.koeficient, { rok: '', typ: 'zalohovy', hodnota: '' }] })}
          >
            {t('nast.dph.pridatRiadok')}
          </button>
        </div>

        {([
          ['pravidlaAut', t('nast.dph.pravidlaAut')],
          ['pomerneOdpocitanie', t('nast.dph.pomerne')],
        ] as const).map(([key, title]) => (
          <div key={key}>
            <p className="label">{title}</p>
            {draft[key].map((pravidlo, index) => (
              <div key={index} className="mt-2 flex flex-wrap items-center gap-2">
                <input
                  className="input w-48"
                  placeholder={t('nast.dph.kategoria')}
                  value={pravidlo.kategoria}
                  onChange={(event) => update({
                    [key]: draft[key].map((item, i) => (i === index ? { ...item, kategoria: event.target.value } : item)),
                  } as Partial<ProfilDraft>)}
                />
                <input
                  className="input tnum w-24"
                  inputMode="decimal"
                  placeholder={t('nast.dph.percento')}
                  value={pravidlo.percento}
                  onChange={(event) => update({
                    [key]: draft[key].map((item, i) => (i === index ? { ...item, percento: event.target.value } : item)),
                  } as Partial<ProfilDraft>)}
                />
                <input
                  className="input min-w-64 flex-1"
                  placeholder={t('nast.dph.klucoveSlovaPlaceholder')}
                  value={pravidlo.klucoveSlova}
                  onChange={(event) => update({
                    [key]: draft[key].map((item, i) => (i === index ? { ...item, klucoveSlova: event.target.value } : item)),
                  } as Partial<ProfilDraft>)}
                />
                <button
                  type="button"
                  className="btn"
                  onClick={() => update({ [key]: draft[key].filter((_, i) => i !== index) } as Partial<ProfilDraft>)}
                >
                  {t('nast.dph.odstranit')}
                </button>
              </div>
            ))}
            <button
              type="button"
              className="btn mt-2"
              onClick={() => update({ [key]: [...draft[key], { kategoria: '', percento: '100', klucoveSlova: '' }] } as Partial<ProfilDraft>)}
            >
              {t('nast.dph.pridatRiadok')}
            </button>
          </div>
        ))}

        <div>
          <p className="label">{t('nast.dph.bezNaroku')}</p>
          {draft.bezNaroku.map((kategoria, index) => (
            <div key={index} className="mt-2 flex flex-wrap items-center gap-2">
              <input
                className="input w-48"
                placeholder={t('nast.dph.kategoria')}
                value={kategoria.kategoria}
                onChange={(event) => update({
                  bezNaroku: draft.bezNaroku.map((item, i) => (i === index ? { ...item, kategoria: event.target.value } : item)),
                })}
              />
              <input
                className="input min-w-64 flex-1"
                placeholder={t('nast.dph.klucoveSlovaPlaceholder')}
                value={kategoria.klucoveSlova}
                onChange={(event) => update({
                  bezNaroku: draft.bezNaroku.map((item, i) => (i === index ? { ...item, klucoveSlova: event.target.value } : item)),
                })}
              />
              <button
                type="button"
                className="btn"
                onClick={() => update({ bezNaroku: draft.bezNaroku.filter((_, i) => i !== index) })}
              >
                {t('nast.dph.odstranit')}
              </button>
            </div>
          ))}
          <button
            type="button"
            className="btn mt-2"
            onClick={() => update({ bezNaroku: [...draft.bezNaroku, { kategoria: '', klucoveSlova: '' }] })}
          >
            {t('nast.dph.pridatRiadok')}
          </button>
        </div>

        <div className="grid gap-3 md:grid-cols-3">
          <label className="flex items-end gap-2 pb-2">
            <input
              type="checkbox"
              className="h-5 w-5"
              checked={draft.samozdanenieAktivne}
              onChange={(event) => update({ samozdanenieAktivne: event.target.checked })}
            />
            <span className="text-sm text-ink">{t('nast.dph.samozdanenieAktivne')}</span>
          </label>
          {clenenieSelect(
            draft.samozdanenieClenenieDphId,
            (next) => update({ samozdanenieClenenieDphId: next }),
            'nast.dph.samozdanenieClenenie',
          )}
          <label className="block">
            <span className="label">{t('nast.dph.samozdanenieKv')}</span>
            <select
              className="input w-full"
              value={draft.samozdanenieClenenieKvKod}
              onChange={(event) => update({ samozdanenieClenenieKvKod: event.target.value })}
            >
              <option value="">{t('nast.dph.bezVyberu')}</option>
              {CLENENIE_KV_KODY.map((kod) => (
                <option key={kod} value={kod}>{kod}</option>
              ))}
            </select>
          </label>
        </div>

        <div className="grid gap-3 md:grid-cols-3">
          {clenenieSelect(
            draft.clenenieBezOdpoctuId,
            (next) => update({ clenenieBezOdpoctuId: next }),
            'nast.dph.clenenieBezOdpoctu',
          )}
        </div>

        <div>
          <button type="button" className="btn btn-primary" disabled={busy} onClick={() => void save()}>
            {busy ? t('stav.nacitavam') : t('nast.dph.ulozit')}
          </button>
        </div>
      </section>
    </div>
  );
}

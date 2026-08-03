import { useEffect, useState } from 'react';
import {
  createAiPokyn, deleteAiPokyn, listAiPokyny, updateAiPokyn,
  type AiPokyn, type AiPokynVstup,
} from '../../data/api';
import { showToast } from '../../components/toast';
import { t } from '../../i18n/sk';

// Editor textových pravidiel pre AI. Jeden komponent pre obe úrovne — rozdiel
// je len v tom, či dostane organizationId (pravidlá firmy) alebo nie (globálne).

const TYPY = ['FP', 'FV', 'BV', 'MZDY', 'OZ', 'PD'] as const;

const PRAZDNY: AiPokynVstup = {
  nazov: '',
  text: '',
  faza: 'both',
  typyDokladov: [],
  klucoveSlova: [],
  priorita: 100,
  active: true,
};

export function PravidlaEditor({ organizationId }: { organizationId?: string }) {
  const [pravidla, setPravidla] = useState<AiPokyn[]>();
  const [draft, setDraft] = useState<AiPokynVstup>(PRAZDNY);
  const [slovaText, setSlovaText] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let active = true;
    setPravidla(undefined);
    void listAiPokyny(organizationId)
      .then((next) => {
        if (active) setPravidla(next);
      })
      .catch(() => {
        if (active) setPravidla([]);
      });
    return () => {
      active = false;
    };
  }, [organizationId]);

  async function obnov() {
    setPravidla(await listAiPokyny(organizationId).catch(() => []));
  }

  async function pridaj() {
    if (!draft.nazov.trim() || !draft.text.trim()) {
      showToast(t('pravidla.chybaPovinne'), { tone: 'error' });
      return;
    }
    setBusy(true);
    try {
      await createAiPokyn({
        ...draft,
        klucoveSlova: slovaText.split(',').map((slovo) => slovo.trim()).filter(Boolean),
      }, organizationId);
      setDraft(PRAZDNY);
      setSlovaText('');
      await obnov();
      showToast(t('pravidla.ulozene'));
    } catch (cause) {
      showToast(cause instanceof Error ? cause.message : t('chyba.vseobecna'), { tone: 'error' });
    } finally {
      setBusy(false);
    }
  }

  async function prepni(pravidlo: AiPokyn) {
    try {
      await updateAiPokyn(pravidlo.id, { active: !pravidlo.active }, organizationId);
      await obnov();
    } catch (cause) {
      showToast(cause instanceof Error ? cause.message : t('chyba.vseobecna'), { tone: 'error' });
    }
  }

  async function zmaz(pravidlo: AiPokyn) {
    if (!window.confirm(t('pravidla.zmazatPotvrdenie'))) return;
    try {
      await deleteAiPokyn(pravidlo.id, organizationId);
      await obnov();
      showToast(t('pravidla.zmazane'));
    } catch (cause) {
      showToast(cause instanceof Error ? cause.message : t('chyba.vseobecna'), { tone: 'error' });
    }
  }

  return (
    <div className="space-y-4">
      <section className="card space-y-3 p-4">
        <p className="font-medium text-ink">{t('pravidla.nove')}</p>
        <label className="block">
          <span className="label">{t('pravidla.nazov')}</span>
          <input
            className="input w-full"
            value={draft.nazov}
            maxLength={120}
            placeholder={t('pravidla.nazovPriklad')}
            onChange={(event) => setDraft({ ...draft, nazov: event.target.value })}
          />
        </label>
        <label className="block">
          <span className="label">{t('pravidla.text')}</span>
          <textarea
            className="input h-36 w-full"
            value={draft.text}
            maxLength={8000}
            placeholder={t('pravidla.textPriklad')}
            onChange={(event) => setDraft({ ...draft, text: event.target.value })}
          />
        </label>
        <div className="flex flex-wrap items-end gap-3">
          <label className="block">
            <span className="label">{t('pravidla.faza')}</span>
            <select
              className="input w-56"
              value={draft.faza}
              onChange={(event) => setDraft({ ...draft, faza: event.target.value as AiPokyn['faza'] })}
            >
              <option value="both">{t('pravidla.faza.both')}</option>
              <option value="extraction">{t('pravidla.faza.extraction')}</option>
              <option value="accounting">{t('pravidla.faza.accounting')}</option>
            </select>
          </label>
          <label className="block flex-1">
            <span className="label">{t('pravidla.klucoveSlova')}</span>
            <input
              className="input w-full"
              value={slovaText}
              placeholder={t('pravidla.klucoveSlovaPriklad')}
              onChange={(event) => setSlovaText(event.target.value)}
            />
          </label>
        </div>
        <div>
          <span className="label">{t('pravidla.typy')}</span>
          <div className="mt-1 flex flex-wrap gap-2">
            {TYPY.map((typ) => {
              const zvolene = draft.typyDokladov.includes(typ);
              return (
                <button
                  key={typ}
                  type="button"
                  className={`btn px-2.5 py-1 text-xs ${zvolene ? 'border-accent bg-tint text-accent-hover' : ''}`}
                  onClick={() => setDraft({
                    ...draft,
                    typyDokladov: zvolene
                      ? draft.typyDokladov.filter((item) => item !== typ)
                      : [...draft.typyDokladov, typ],
                  })}
                >
                  {typ}
                </button>
              );
            })}
          </div>
          <p className="mt-1 text-xs text-ink-faint">{t('pravidla.typyHint')}</p>
        </div>
        <button type="button" className="btn btn-primary" disabled={busy} onClick={() => void pridaj()}>
          {busy ? t('stav.nacitavam') : t('pravidla.pridat')}
        </button>
      </section>

      {pravidla === undefined ? (
        <p className="text-sm text-ink-soft">{t('stav.nacitavam')}</p>
      ) : pravidla.length === 0 ? (
        <p className="text-sm text-ink-soft">{t('pravidla.prazdne')}</p>
      ) : (
        pravidla.map((pravidlo) => (
          <section key={pravidlo.id} className={`card space-y-2 p-4 ${pravidlo.active ? '' : 'opacity-60'}`}>
            <div className="flex flex-wrap items-center gap-2">
              <p className="flex-1 font-medium text-ink">{pravidlo.nazov}</p>
              <span className="rounded-md bg-app px-2 py-0.5 text-[11px] font-semibold text-ink-soft">
                {t(`pravidla.faza.${pravidlo.faza}`)}
              </span>
              {pravidlo.typyDokladov.map((typ) => (
                <span key={typ} className="rounded-md border border-line px-1.5 py-0.5 text-[11px] font-semibold text-ink-soft">
                  {typ}
                </span>
              ))}
              <button type="button" className="btn px-2.5 py-1 text-xs" onClick={() => void prepni(pravidlo)}>
                {pravidlo.active ? t('pravidla.vypnut') : t('pravidla.zapnut')}
              </button>
              <button type="button" className="btn px-2.5 py-1 text-xs" onClick={() => void zmaz(pravidlo)}>
                {t('pravidla.zmazat')}
              </button>
            </div>
            <p className="whitespace-pre-wrap text-sm text-ink-soft">{pravidlo.text}</p>
            {pravidlo.klucoveSlova.length > 0 && (
              <p className="text-xs text-ink-faint">
                {t('pravidla.klucoveSlova')}: {pravidlo.klucoveSlova.join(', ')}
              </p>
            )}
          </section>
        ))
      )}
    </div>
  );
}

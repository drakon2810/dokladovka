import { useEffect, useRef, useState } from 'react';
import {
  createAiPokyn, deleteAiPokyn, improveAiPokyn, listAiPokyny, updateAiPokyn,
  type AiPokyn, type AiPokynVstup,
} from '../../data/api';
import { showToast } from '../../components/toast';
import { t, type SkKey } from '../../i18n/sk';

// Editor textových pravidiel pre AI. Jeden komponent pre obe úrovne — rozdiel
// je len v tom, či dostane organizationId (pravidlá firmy) alebo nie (globálne).

const TYPY = ['FP', 'FV', 'BV', 'MZDY', 'OZ', 'PD'] as const;
/** Musí sedieť so serverom (aiInstructionRoutes) — tam je strop autoritatívny. */
const MAX_SUBOROV = 6;
const MAX_SUBOR_BAJTOV = 20 * 1024 * 1024;
/** Súčet bajtov: base64 dávku nafúkne o tretinu a telo požiadavky má 30 MB. */
const MAX_SPOLU_BAJTOV = 20 * 1024 * 1024;

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
  // Vzorové doklady pre „Vylepšiť pomocou AI" — nikam sa neukladajú, poslúžia
  // len ako príklad, z ktorého AI napíše čitateľné pravidlo. Viac naraz má
  // zmysel: samotný doklad plus snímky z POHODY, ako sa zaúčtoval.
  const [subory, setSubory] = useState<File[]>([]);
  const [vylepsujem, setVylepsujem] = useState(false);
  const suborRef = useRef<HTMLInputElement>(null);

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
      // Prílohy patrili k práve uloženému pravidlu — bez vyčistenia by sa ticho
      // priložili aj k nasledujúcemu a AI by písala pravidlo z cudzieho dokladu.
      setSubory([]);
      await obnov();
      showToast(t('pravidla.ulozene'));
    } catch (cause) {
      showToast(cause instanceof Error ? cause.message : t('chyba.vseobecna'), { tone: 'error' });
    } finally {
      setBusy(false);
    }
  }

  async function vylepsi() {
    if (!draft.text.trim() && subory.length === 0) {
      showToast(t('pravidla.vylepsit.prazdne'), { tone: 'error' });
      return;
    }
    setVylepsujem(true);
    try {
      const navrh = await improveAiPokyn(
        { nazov: draft.nazov, text: draft.text, subory },
        organizationId,
      );
      // Návrh AI predvyplní formulár; účtovník ho môže ďalej upraviť a až
      // „Pridať pravidlo" ho uloží. Fáza a typy sa preberajú tiež — AI ich
      // odvodila z obsahu pravidla.
      setDraft({
        ...draft,
        nazov: navrh.nazov,
        text: navrh.text,
        faza: navrh.faza,
        typyDokladov: navrh.typyDokladov.filter((typ): typ is (typeof TYPY)[number] => (TYPY as readonly string[]).includes(typ)),
      });
      // Kľúčové slová sa zlučujú, neprepisujú: AI ich odvodila z textu pravidla,
      // ale tie, ktoré účtovník napísal sám, pozná z praxe a nesmú zmiznúť.
      const rucne = slovaText.split(',').map((slovo) => slovo.trim()).filter(Boolean);
      const spojene = [...new Set([...rucne, ...navrh.klucoveSlova])].slice(0, 10);
      setSlovaText(spojene.join(', '));
      showToast(t('pravidla.vylepsit.hotovo'));
    } catch (cause) {
      showToast(cause instanceof Error ? cause.message : t('chyba.vseobecna'), { tone: 'error' });
    } finally {
      setVylepsujem(false);
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
                  {t(`typ.${typ}`)}
                </button>
              );
            })}
          </div>
          <p className="mt-1 text-xs text-ink-faint">{t('pravidla.typyHint')}</p>
        </div>
        {/* Vzorový doklad + vylepšenie AI: účtovník napíše koncept po svojom,
            priloží príklad (PDF/fotografiu) a AI z toho spraví pravidlo, ktorému
            bude AI účtovanie rozumieť — vrátane konkrétnych predkontácií firmy. */}
        <div className="rounded-xl border border-dashed border-line bg-app/40 p-3">
          <div className="flex flex-wrap items-center gap-2">
            <input
              ref={suborRef}
              type="file"
              multiple
              accept=".pdf,.jpg,.jpeg,.png,.webp,application/pdf,image/jpeg,image/png,image/webp"
              className="hidden"
              onChange={(event) => {
                const pridane = [...(event.target.files ?? [])];
                // Rovnaký input sa používa opakovane — hodnotu zahodíme, inak by
                // sa ten istý súbor nedal pridať druhýkrát po odobratí.
                if (suborRef.current) suborRef.current.value = '';
                // Ten istý súbor druhýkrát je vždy omyl — poslal by sa (a platil) dvakrát.
                const nove = pridane.filter((file) => !subory.some(
                  (uz) => uz.name === file.name && uz.size === file.size,
                ));
                const velky = nove.find((file) => file.size > MAX_SUBOR_BAJTOV);
                if (velky) {
                  showToast(`${velky.name}: ${t('pravidla.vylepsit.velkySubor')}`, { tone: 'error' });
                  return;
                }
                const spolu = [...subory, ...nove];
                if (spolu.length > MAX_SUBOROV) {
                  showToast(t('pravidla.vylepsit.privelaSuborov'), { tone: 'error' });
                  return;
                }
                // Strop na súčet drží požiadavku pod limitom tela — server by
                // väčšiu dávku odmietol skôr, než by sa dostala k obsluhe.
                if (spolu.reduce((sucet, file) => sucet + file.size, 0) > MAX_SPOLU_BAJTOV) {
                  showToast(t('pravidla.vylepsit.velkeSpolu'), { tone: 'error' });
                  return;
                }
                setSubory(spolu);
              }}
            />
            <button
              type="button"
              className="btn"
              disabled={vylepsujem || subory.length >= MAX_SUBOROV}
              onClick={() => suborRef.current?.click()}
            >
              {t('pravidla.vylepsit.prilozit')}
            </button>
            <button
              type="button"
              className="btn ml-auto"
              disabled={vylepsujem || busy || (!draft.text.trim() && subory.length === 0)}
              onClick={() => void vylepsi()}
            >
              {vylepsujem ? t('pravidla.vylepsit.pracujem') : t('pravidla.vylepsit')}
            </button>
          </div>
          {subory.length > 0 && (
            <div className="mt-2 flex flex-wrap gap-2">
              {subory.map((file, index) => (
                <span
                  key={`${file.name}-${index}`}
                  className="inline-flex items-center gap-1.5 rounded-full border border-line bg-white px-2.5 py-1 text-xs text-ink-soft"
                >
                  {file.name}
                  <button
                    type="button"
                    className="text-ink-faint hover:text-red-700"
                    aria-label={`${t('pravidla.vylepsit.odobratSubor')}: ${file.name}`}
                    disabled={vylepsujem}
                    onClick={() => setSubory((doterajsie) => doterajsie.filter((_, poradie) => poradie !== index))}
                  >
                    ×
                  </button>
                </span>
              ))}
            </div>
          )}
          <p className="mt-2 text-xs text-ink-faint">{t('pravidla.vylepsit.hint')}</p>
        </div>
        <button type="button" className="btn btn-primary" disabled={busy || vylepsujem} onClick={() => void pridaj()}>
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
                  {t(`typ.${typ}` as SkKey)}
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

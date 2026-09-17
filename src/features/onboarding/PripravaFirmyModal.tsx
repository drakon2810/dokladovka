import { useEffect, useMemo, useState } from 'react';
import { create } from 'zustand';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '../../auth/AuthContext';
import type { Organization, PripravaFirmy, PripravenostFirmy, SignalPripravenosti } from '../../data/types';
import { Modal } from '../../components/ui';
import { analyzeUctoProfil, backfillUctoHistory, nacitajPripravenost } from '../../data/api';
import { requestMostikCodeListSync, requestMostikTrainingSync } from '../../data/mostik/mostikService';
import { showToast } from '../../components/toast';
import { t, tv, type SkKey } from '../../i18n/sk';
import './pripravaFirmy.css';

/**
 * Sprievodca prípravou novej firmy — maketa „Onboarding sprievodca.dc.html",
 * variant B: všetkých päť krokov naraz.
 *
 * Účtovník po založení firmy dostal prázdnu appku a jedenásť záložiek
 * v Nastaveniach. Najhoršie bol na tom Tréning AI: Excel, .mdb, „Synchronizovať
 * mostíkom", „Analyzovať pamäť" — a z obrazovky sa nedalo zistiť, čo z toho
 * treba a v akom poradí.
 *
 * Stav krokov sa NEUKLADÁ. Číta sa zo skutočných dát — z pripravenosti firmy
 * na serveri (manifest histórie, job analýzy, živý agent), a keď nie je, zo
 * snapshotu — takže sprievodca nemôže tvrdiť „hotové" o niečom, čo v systéme
 * nie je. Keď účtovník krok spraví inde, sprievodca to vidí tiež.
 */

/** Ktorej firme je sprievodca otvorený a ktorý krok práve beží. Zdieľané,
 *  lebo firmu sa dá založiť z ľavého panela aj z Nastavení — a okno
 *  vykresľuje Layout.
 *
 *  Bežiaci krok je tu, nie v komponente: analýza trvá minúty a účtovník
 *  okno medzitým zavrie. Po otvorení musí vidieť, že sa stále pracuje.
 *  `kedy` je čas chyby kroku pri spustení (viď krokDobehol). */
const usePripravaStore = create<{ orgId: string | null; bezi: { orgId: string; krok: number; kedy?: string } | null }>(
  () => ({ orgId: null, bezi: null }),
);
export const usePripravaOrgId = () => usePripravaStore((s) => s.orgId);
export function otvorPripravu(orgId: string): void { usePripravaStore.setState({ orgId }); }
export function zavriPripravu(): void { usePripravaStore.setState({ orgId: null }); }

export type StavKroku = 'hotovy' | 'naRade' | 'zamknuty';

interface Krok {
  cislo: number;
  nazov: string;
  popis: string;
  /** Kam krok vedie. Prázdne pri kroku, ktorý sa spraví na mieste. */
  cesta?: string;
  akcia: string;
  /** Krok, ktorý sa dá spustiť rovno v okne. */
  spustit?: (organizationId: string) => Promise<unknown>;
  /** Práca beží na pozadí (agent) — točí sa, kým krok nie je splnený. */
  beziKymNeHotovy?: boolean;
  /** Spustí sa sám, len čo príde na rad — nie je čo klikať. */
  automaticky?: boolean;
  /** i18n kľúč hlášky počas behu. */
  bezimText?: Parameters<typeof t>[0];
  /** Čo sa ukáže, keď je hotový — konkrétne číslo, nie „OK". */
  hotovo: (priprava: PripravaFirmy, organizacia: Organization, pripravenost?: PripravenostFirmy | null) => string;
  /** Signály pripravenosti, ktoré krok uzatvárajú. Keď ich server nevráti, platí `splneny`. */
  signaly?: Array<keyof PripravenostFirmy['signaly']>;
  splneny: (priprava: PripravaFirmy, organizacia: Organization) => boolean;
  /** Kroky 1-4 na sebe závisia; schránka vzniká automaticky, tak nečaká. */
  zavisly: boolean;
}

export const KROKY: readonly Krok[] = [
  {
    cislo: 1,
    nazov: 'E-mailová schránka',
    popis: 'Adresa, na ktorú budete faktúry preposielať. Vznikla automaticky pri založení firmy.',
    akcia: 'Skopírovať adresu',
    hotovo: (_priprava, organizacia) => organizacia.emailAlias || 'adresa je pripravená',
    splneny: (priprava, organizacia) => priprava.schranka || Boolean(organizacia.emailAlias),
    zavisly: false,
  },
  {
    cislo: 2,
    nazov: 'Pripojiť Mostík',
    popis: 'Agent na vašom počítači spojí Dokladovku s POHODOU. Bez neho sa nedá stiahnuť nič ďalšie.',
    cesta: '/nastavenia?tab=mostik',
    akcia: 'Otvoriť Mostík',
    // Účtovník vidí, s ktorou databázou a rokom sa firma spárovala — pri
    // prechode na nový rok je to prvé, čo treba skontrolovať.
    hotovo: (_priprava, _organizacia, pripravenost) => {
      const detail = pripravenost?.signaly.firma.detail as { dbName?: string; uctovnyRok?: string | null } | undefined;
      return detail?.dbName
        ? tv('priprava.sparovaneS', { databaza: detail.dbName, rok: detail.uctovnyRok ?? '—' })
        : 'Firma je spárovaná s účtovnou jednotkou v POHODE';
    },
    signaly: ['mostik', 'firma'],
    splneny: (priprava) => priprava.mostik,
    zavisly: true,
  },
  {
    cislo: 3,
    nazov: 'Stiahnuť číselníky z POHODY',
    popis: 'Predkontácie, členenia DPH, číselné rady, strediská a bankové účty.',
    // Agent číselníky ťahá sám (hodinový cyklus). Žiadosť ho len zobudí, aby
    // to bolo do ~30 s namiesto do hodiny — účtovník nemá čo klikať, len čaká.
    akcia: '',
    spustit: (organizationId) => requestMostikCodeListSync(organizationId),
    automaticky: true,
    beziKymNeHotovy: true,
    bezimText: 'priprava.ciselnikyBezia',
    hotovo: (priprava) => `${priprava.ciselniky} položiek číselníkov`,
    signaly: ['ciselniky'],
    splneny: (priprava) => priprava.ciselniky > 0,
    zavisly: true,
  },
  {
    cislo: 4,
    nazov: 'Naučiť pamäť z histórie',
    popis: 'Mostík stiahne vaše doklady z POHODY a systém si zapamätá, ako ste ich účtovali.',
    akcia: 'Naučiť pamäť',
    // Beží na mieste — účtovník nemá dôvod odchádzať do Nastavení a hľadať
    // tam medzi Excelom, .mdb a dvoma tlačidlami to správne.
    // Požiadavka sa agentovi len zapíše; sťahuje ju na pozadí. Krok preto
    // beží ďalej, kým server nepotvrdí publikovanú históriu.
    spustit: (organizationId) => requestMostikTrainingSync(organizationId),
    beziKymNeHotovy: true,
    bezimText: 'priprava.stahujem',
    hotovo: (priprava) => `${priprava.pamat} zapamätaných rozhodnutí`,
    signaly: ['historia'],
    splneny: (priprava) => priprava.pamat > 0,
    zavisly: true,
  },
  {
    cislo: 5,
    nazov: 'Spustiť analýzu (účtovný profil)',
    popis: 'Z histórie sa vytvoria kategórie plnení — čo firma nakupuje a ako to účtuje.',
    akcia: 'Spustiť analýzu',
    // Mostík plní pamäť (ucto_decisions), analýza číta korpus histórie
    // (ucto_historia). Že sú to dve tabuľky, nie je problém účtovníka —
    // preklopenie je idempotentné, tak ho spraví analýza sama. Bez neho
    // padala na 409 „v histórii je primálo riadkov".
    //
    // Analýza sa len postaví do fronty — beží vo workeri desiatky minút a
    // spojenie prehliadača toľko nevydrží. Krok preto dobieha rovnako ako
    // mostík nad ním: beží ďalej, kým server nehlási dokončený job. Že model
    // nevrátil nič použiteľné, tak povie „splneny", nie návratová hodnota;
    // dôvod zlyhania ukáže obrazovka účtovného profilu.
    spustit: async (organizationId) => {
      await backfillUctoHistory(organizationId);
      await analyzeUctoProfil(organizationId);
    },
    beziKymNeHotovy: true,
    bezimText: 'priprava.analyzujem',
    hotovo: (priprava) => `${priprava.kategorie} kategórií plnení`,
    signaly: ['profil'],
    splneny: (priprava) => priprava.kategorie > 0,
    zavisly: true,
  },
];

/** Krok s výhradou („overiť") je hotový — výhrada sa ukáže pod ním, neblokuje ďalší. */
function splnenyKrok(krok: Krok, priprava: PripravaFirmy, organizacia: Organization, pripravenost?: PripravenostFirmy | null): boolean {
  if (pripravenost && krok.signaly) {
    return krok.signaly.every((nazov) => ['ok', 'overit'].includes(pripravenost.signaly[nazov].stav));
  }
  return krok.splneny(priprava, organizacia);
}

export function stavKrokov(priprava: PripravaFirmy, organizacia: Organization, pripravenost?: PripravenostFirmy | null): StavKroku[] {
  const splnene = KROKY.map((krok) => splnenyKrok(krok, priprava, organizacia, pripravenost));
  return KROKY.map((krok, index) => {
    if (splnene[index]) return 'hotovy';
    // Zamknutý ostáva, kým nie je hotový ktorýkoľvek predchádzajúci závislý
    // krok — kódom z histórie nie je kam sadnúť, kým nie sú číselníky.
    if (krok.zavisly && KROKY.slice(0, index).some((p, i) => p.zavisly && !splnene[i])) return 'zamknuty';
    return 'naRade';
  });
}

/** Koľko krokov je hotových. Používa aj ľavý panel pre prstenec pri firme. */
export function hotovychKrokov(priprava: PripravaFirmy, organizacia: Organization, pripravenost?: PripravenostFirmy | null): number {
  return stavKrokov(priprava, organizacia, pripravenost).filter((stav) => stav === 'hotovy').length;
}

/** Text dôvodu signálu; textový detail (chyba agenta, druh číselníka) ide do zátvorky. */
export function dovodPripravenosti(signal: SignalPripravenosti): string {
  const text = t(`pripravenost.${signal.dovod}` as SkKey) ?? signal.dovod;
  return typeof signal.detail === 'string' ? `${text} (${signal.detail})` : text;
}

/** Prvý dôvod, prečo firma nie je pripravená; undefined, keď je — alebo keď sa to nevie. */
export function upozorneniePripravenosti(pripravenost: PripravenostFirmy | null | undefined): string | undefined {
  if (!pripravenost || pripravenost.stav === 'pripravena') return undefined;
  const problem = Object.values(pripravenost.signaly).find((signal) => signal.stav !== 'ok');
  return problem && dovodPripravenosti(problem);
}

/**
 * Riadok nad návrhom v detaile dokladu — len keď firma naozaj nie je pripravená.
 * „Overiť" (starší profil po opätovnom stiahnutí histórie, otvorené otázky,
 * meranie) patrí do prípravy firmy: nad každým dokladom bol len šum.
 */
export function upozornenieNavrhu(pripravenost: PripravenostFirmy | null | undefined): string | undefined {
  const dovod = upozorneniePripravenosti(pripravenost);
  if (pripravenost?.stav !== 'nepripravena' || !dovod) return undefined;
  return `${t('pripravenost.navrhUpozornenie')} ${dovod}`;
}

/** Päta tvrdí „pripravená" len podľa servera — päť hotových krokov na to nestačí. */
export function poznamkaPaty(vsetkoHotove: boolean, pripravenost: PripravenostFirmy | null | undefined): string {
  if (!vsetkoHotove) return t('priprava.zavriPoznamka');
  if (pripravenost?.stav === 'pripravena') return t('priprava.hotovoPoznamka');
  return tv('priprava.overitPoznamka', { dovod: upozorneniePripravenosti(pripravenost) ?? t('pripravenost.nenacitana') });
}

/**
 * Krok, ktorý sa rozbehne sám. Sťahovať číselníky, kým server nepotvrdí živého
 * agenta a databázu firmy, znamená spinner nad požiadavkou, ktorú nikto nevybaví.
 * undefined = pripravenosť sa ešte načítava; null = nie je, platí snapshot.
 */
export function automatickyKrok(stavy: StavKroku[], pripravenost: PripravenostFirmy | null | undefined): Krok | undefined {
  if (pripravenost === undefined) return undefined;
  if (pripravenost && (pripravenost.signaly.mostik.stav !== 'ok' || pripravenost.signaly.firma.stav !== 'ok')) return undefined;
  // Sám len krok, z ktorého ešte nič neprišlo. Po chybe by každé otvorenie okna
  // poslalo novú požiadavku; agent číselníky aj tak ťahá každú hodinu.
  return KROKY.find((krok, i) => krok.automaticky && stavy[i] === 'naRade'
    && (!pripravenost || Boolean(krok.signaly?.every((nazov) => pripravenost.signaly[nazov].stav === 'caka'))));
}

/** Chyba, ktorú server pri kroku hlási (napr. číselník, ktorý POHODA nevrátila). */
function chybaKroku(krok: Krok, pripravenost: PripravenostFirmy | null | undefined): SignalPripravenosti | undefined {
  if (!pripravenost) return undefined;
  return krok.signaly?.map((nazov) => pripravenost.signaly[nazov]).find((signal) => signal.stav === 'chyba');
}

/**
 * Bežiaci krok dobehol: je hotový, alebo server hlási inú chybu, než mal krok
 * pri spustení — agent odpovedal, len nie úspechom. Spinner by inak čakal na
 * „hotovo", ktoré nepríde; dôvod ostane v riadku pod krokom.
 */
export function krokDobehol(
  krok: Krok, stav: StavKroku, pripravenost: PripravenostFirmy | null | undefined, kedyPriSpusteni: string | undefined,
): boolean {
  const chyba = chybaKroku(krok, pripravenost);
  return stav === 'hotovy' || Boolean(chyba && chyba.kedy !== kedyPriSpusteni);
}

/**
 * Pripravenosť firmy zo servera: undefined, kým sa načítava; null, keď nie je
 * (mock, výpadok). Kým je obrazovka otvorená, obnovuje sa po minúte — krok na
 * pozadí (agent, analýza) medzitým dobehne.
 */
export function usePripravenost(orgId: string | undefined): PripravenostFirmy | null | undefined {
  const [nacitana, setNacitana] = useState<{ orgId: string; hodnota: PripravenostFirmy | null }>();
  useEffect(() => {
    if (!orgId) return undefined;
    let zive = true;
    const nacitaj = () => void nacitajPripravenost(orgId).then((hodnota) => { if (zive) setNacitana({ orgId, hodnota }); });
    nacitaj();
    const casovac = setInterval(nacitaj, 60_000);
    return () => { zive = false; clearInterval(casovac); };
  }, [orgId]);
  return orgId && nacitana?.orgId === orgId ? nacitana.hodnota : undefined;
}

function IkonaFajka() {
  return (
    <svg viewBox="0 0 12 12" width="9" height="9" aria-hidden="true">
      <path d="M1.5 6.4 4.3 9.2 10.5 3" fill="none" stroke="#fff" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function IkonaBezi() {
  return <span className="pf-spinner" aria-hidden="true" />;
}

function IkonaZamok() {
  return (
    <svg viewBox="0 0 12 12" width="9" height="9" aria-hidden="true">
      <path d="M3 5.4V4a3 3 0 0 1 6 0v1.4M2.6 5.4h6.8v4.2H2.6z" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinejoin="round" />
    </svg>
  );
}

interface Props {
  organizacia: Organization;
  priprava: PripravaFirmy;
  onClose: () => void;
  onKopirovat?: (adresa: string) => void;
}

export function PripravaFirmyModal({ organizacia, priprava, onClose, onKopirovat }: Props) {
  const navigate = useNavigate();
  // Profil klienta otvára len ten, kto účtuje — schvaľovateľa by route vrátila na úvod.
  const role = useAuth().session?.user.role;
  const mozeDoProfilu = role === 'admin' || role === 'uctovnik';
  const beziZaznam = usePripravaStore((stav) => stav.bezi);
  const pripravenost = usePripravenost(organizacia.id);
  const stavy = useMemo(() => stavKrokov(priprava, organizacia, pripravenost), [priprava, organizacia, pripravenost]);
  const bezi = beziZaznam?.orgId === organizacia.id ? beziZaznam.krok : null;
  // Krok na pozadí dobehol — spinner zhasne, len čo to vidno v dátach.
  const beziciDobehol = bezi !== null && krokDobehol(KROKY[bezi - 1], stavy[bezi - 1], pripravenost, beziZaznam?.kedy);
  useEffect(() => {
    if (beziciDobehol) usePripravaStore.setState({ bezi: null });
  }, [beziciDobehol]);
  const spusti = (krok: Krok) => {
    usePripravaStore.setState({ bezi: { orgId: organizacia.id, krok: krok.cislo, kedy: chybaKroku(krok, pripravenost)?.kedy } });
    void krok.spustit!(organizacia.id)
      .then(() => {
        // Agent pracuje na pozadí; spinner zhasne až keď je výsledok v dátach.
        if (!krok.beziKymNeHotovy) usePripravaStore.setState({ bezi: null });
      })
      .catch((chyba) => {
        usePripravaStore.setState({ bezi: null });
        showToast(chyba instanceof Error ? chyba.message : t('chyba.vseobecna'), { tone: 'error' });
      });
  };

  // Krok, ktorý si účtovník neklikáva, sa rozbehne sám, len čo príde na rad.
  const automaticky = automatickyKrok(stavy, pripravenost);
  const cakaAutomaticky = Boolean(automaticky) && beziZaznam === null;
  useEffect(() => {
    if (cakaAutomaticky && automaticky) spusti(automaticky);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cakaAutomaticky, automaticky?.cislo]);

  const hotove = stavy.filter((stav) => stav === 'hotovy').length;
  const vsetkoHotove = hotove === KROKY.length;
  const pripravena = vsetkoHotove && pripravenost?.stav === 'pripravena';

  return (
    <Modal title={t('priprava.titulok')} onClose={onClose}>
      <div className="pf-hlava">
        <div className="pf-firma">
          {organizacia.nazov}
          {organizacia.ico ? ` · IČO ${organizacia.ico}` : ''}
        </div>
        <div className="pf-priebeh">
          <div className="pf-pas"><div className="pf-pas-vypln" style={{ width: `${(hotove / KROKY.length) * 100}%` }} /></div>
          <span className="pf-pocet tnum">{hotove} z {KROKY.length}</span>
        </div>
      </div>

      <div className="pf-kroky">
        {KROKY.map((krok, index) => {
          const stav = stavy[index];
          const blokujuci = KROKY.slice(0, index).filter((p, i) => p.zavisly && stavy[i] !== 'hotovy').pop();
          // Výhrada alebo chyba servera pri kroku — „hotové" nesmie zakryť, čo treba overiť.
          const vyhrada = pripravenost && krok.signaly
            ?.map((nazov) => pripravenost.signaly[nazov])
            .find((signal) => signal.stav === 'overit' || signal.stav === 'chyba');
          return (
            <div key={krok.cislo} className={`pf-krok pf-krok-${stav}`}>
              <span className={`pf-znak pf-znak-${stav}`}>
                {stav === 'hotovy' ? <IkonaFajka />
                  : bezi === krok.cislo ? <IkonaBezi />
                  : stav === 'zamknuty' ? <IkonaZamok /> : krok.cislo}
              </span>
              <div className="pf-telo">
                <div className="pf-riadok">
                  <span className="pf-nazov">{krok.nazov}</span>
                  <span className={`pf-stav pf-stav-${bezi === krok.cislo ? 'bezi' : stav}`}>
                    {bezi === krok.cislo ? 'Pracujem'
                      : stav === 'hotovy' ? 'Hotové' : stav === 'zamknuty' ? 'Zamknuté' : 'Na rade'}
                  </span>
                </div>
                <div className="pf-popis">{krok.popis}</div>
                {stav === 'hotovy' && <div className="pf-hotovo">{krok.hotovo(priprava, organizacia, pripravenost)}</div>}
                {vyhrada && <div className="pf-zamknute">{dovodPripravenosti(vyhrada)}</div>}
                {stav === 'zamknuty' && blokujuci && (
                  <div className="pf-zamknute">Najprv dokončite krok {blokujuci.cislo} — {blokujuci.nazov.toLowerCase()}.</div>
                )}
                {stav === 'naRade' && (bezi === krok.cislo || !krok.automaticky) && (
                  <div>
                    {bezi === krok.cislo ? (
                      <div className="pf-bezi">
                        <span className="pf-spinner" aria-hidden="true" />
                        {t(krok.bezimText ?? 'priprava.bezi')}
                      </div>
                    ) : (
                      <button
                        type="button"
                        className="pf-akcia"
                        disabled={bezi !== null}
                        onClick={() => {
                          // Krok, ktorý vie bežať sám, sa spustí tu — účtovník
                          // neodchádza do Nastavení hľadať to správne tlačidlo.
                          if (krok.spustit) return spusti(krok);
                          if (krok.cesta) {
                            onClose();
                            navigate(krok.cesta);
                            return;
                          }
                          if (organizacia.emailAlias) onKopirovat?.(organizacia.emailAlias);
                        }}
                      >
                        {krok.akcia}
                      </button>
                    )}
                  </div>
                )}
              </div>
            </div>
          );
        })}
      </div>

      {/* Otázky profilu klienta nie sú krok — pripravenosť neblokujú (ako meranie),
          len pripomenú, že bez odpovedí sa DPH niektorých dokladov určí zle. */}
      {pripravenost?.signaly.otazky && pripravenost.signaly.otazky.stav !== 'ok' && (
        <div className="mt-3 flex flex-wrap items-center justify-between gap-2 rounded-[10px] border border-amber-200 bg-amber-50 px-3 py-2.5 text-[13px] text-amber-900">
          <span>{dovodPripravenosti(pripravenost.signaly.otazky)}</span>
          {mozeDoProfilu && <button
            type="button"
            className="btn px-2.5 py-1 text-xs"
            onClick={() => {
              onClose();
              navigate('/profil-klienta');
            }}
          >
            {t('priprava.otvoritProfil')}
          </button>}
        </div>
      )}

      <div className="pf-pata">
        <span className="pf-poznamka">{poznamkaPaty(vsetkoHotove, pripravenost)}</span>
        <button type="button" className={pripravena ? 'btn btn-primary' : 'btn'} onClick={onClose}>
          {pripravena ? t('priprava.hotovo') : t('akcia.zavriet')}
        </button>
      </div>
    </Modal>
  );
}

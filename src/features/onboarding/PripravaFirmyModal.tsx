import { useMemo, useState } from 'react';
import { create } from 'zustand';
import { useNavigate } from 'react-router-dom';
import type { Organization, PripravaFirmy } from '../../data/types';
import { Modal } from '../../components/ui';
import { analyzeUctoProfil } from '../../data/api';
import { requestMostikTrainingSync } from '../../data/mostik/mostikService';
import { showToast } from '../../components/toast';
import { t } from '../../i18n/sk';
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
 * Stav krokov sa NEUKLADÁ. Číta sa zo skutočných dát (pripravaFiriem
 * v snapshote), takže sprievodca nemôže tvrdiť „hotové" o niečom, čo v systéme
 * nie je — a keď účtovník krok spraví inde, sprievodca to vidí tiež.
 */

/** Ktorej firme je sprievodca otvorený. Zdieľané, lebo firmu sa dá založiť
 *  z ľavého panela aj z Nastavení — a okno vykresľuje Layout. */
const usePripravaStore = create<{ orgId: string | null }>(() => ({ orgId: null }));
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
  /** Krok, ktorý sa dá spustiť rovno v okne. Vracia hlášku pre účtovníka. */
  spustit?: (organizationId: string) => Promise<string>;
  /** Čo sa ukáže, keď je hotový — konkrétne číslo, nie „OK". */
  hotovo: (priprava: PripravaFirmy, organizacia: Organization) => string;
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
    hotovo: () => 'Firma je spárovaná s účtovnou jednotkou v POHODE',
    splneny: (priprava) => priprava.mostik,
    zavisly: true,
  },
  {
    cislo: 3,
    nazov: 'Stiahnuť číselníky z POHODY',
    popis: 'Predkontácie, členenia DPH, číselné rady, strediská a bankové účty.',
    cesta: '/nastavenia?tab=ciselniky',
    akcia: 'Otvoriť číselníky',
    hotovo: (priprava) => `${priprava.ciselniky} položiek číselníkov`,
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
    spustit: async (organizationId) => {
      await requestMostikTrainingSync(organizationId);
      return 'Mostík sťahuje históriu z POHODY — potrvá to chvíľu.';
    },
    hotovo: (priprava) => `${priprava.pamat} zapamätaných rozhodnutí`,
    splneny: (priprava) => priprava.pamat > 0,
    zavisly: true,
  },
  {
    cislo: 5,
    nazov: 'Spustiť analýzu (účtovný profil)',
    popis: 'Z histórie sa vytvoria kategórie plnení — čo firma nakupuje a ako to účtuje.',
    akcia: 'Spustiť analýzu',
    spustit: async (organizationId) => {
      const vysledok = await analyzeUctoProfil(organizationId);
      return `Hotovo — ${vysledok.kategorii} kategórií plnení.`;
    },
    hotovo: (priprava) => `${priprava.kategorie} kategórií plnení`,
    splneny: (priprava) => priprava.kategorie > 0,
    zavisly: true,
  },
];

export function stavKrokov(priprava: PripravaFirmy, organizacia: Organization): StavKroku[] {
  const splnene = KROKY.map((krok) => krok.splneny(priprava, organizacia));
  return KROKY.map((krok, index) => {
    if (splnene[index]) return 'hotovy';
    // Zamknutý ostáva, kým nie je hotový ktorýkoľvek predchádzajúci závislý
    // krok — kódom z histórie nie je kam sadnúť, kým nie sú číselníky.
    if (krok.zavisly && KROKY.slice(0, index).some((p, i) => p.zavisly && !splnene[i])) return 'zamknuty';
    return 'naRade';
  });
}

/** Koľko krokov je hotových. Používa aj ľavý panel pre prstenec pri firme. */
export function hotovychKrokov(priprava: PripravaFirmy, organizacia: Organization): number {
  return stavKrokov(priprava, organizacia).filter((stav) => stav === 'hotovy').length;
}

function IkonaFajka() {
  return (
    <svg viewBox="0 0 12 12" width="9" height="9" aria-hidden="true">
      <path d="M1.5 6.4 4.3 9.2 10.5 3" fill="none" stroke="#fff" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
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
  const [bezi, setBezi] = useState<number | null>(null);
  const stavy = useMemo(() => stavKrokov(priprava, organizacia), [priprava, organizacia]);
  const hotove = stavy.filter((stav) => stav === 'hotovy').length;
  const vsetkoHotove = hotove === KROKY.length;

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
          return (
            <div key={krok.cislo} className={`pf-krok pf-krok-${stav}`}>
              <span className={`pf-znak pf-znak-${stav}`}>
                {stav === 'hotovy' ? <IkonaFajka /> : stav === 'zamknuty' ? <IkonaZamok /> : krok.cislo}
              </span>
              <div className="pf-telo">
                <div className="pf-riadok">
                  <span className="pf-nazov">{krok.nazov}</span>
                  <span className={`pf-stav pf-stav-${stav}`}>
                    {stav === 'hotovy' ? 'Hotové' : stav === 'zamknuty' ? 'Zamknuté' : 'Na rade'}
                  </span>
                </div>
                <div className="pf-popis">{krok.popis}</div>
                {stav === 'hotovy' && <div className="pf-hotovo">{krok.hotovo(priprava, organizacia)}</div>}
                {stav === 'zamknuty' && blokujuci && (
                  <div className="pf-zamknute">Najprv dokončite krok {blokujuci.cislo} — {blokujuci.nazov.toLowerCase()}.</div>
                )}
                {stav === 'naRade' && (
                  <div>
                    <button
                      type="button"
                      className="dk-btn dk-btn-ai"
                      disabled={bezi !== null}
                      onClick={() => {
                        // Krok, ktorý vie bežať sám, sa spustí tu — účtovník
                        // neodchádza do Nastavení hľadať to správne tlačidlo.
                        if (krok.spustit) {
                          setBezi(krok.cislo);
                          void krok.spustit(organizacia.id)
                            .then((sprava) => showToast(sprava))
                            .catch((chyba) => showToast(chyba instanceof Error ? chyba.message : t('chyba.vseobecna'), { tone: 'error' }))
                            .finally(() => setBezi(null));
                          return;
                        }
                        if (krok.cesta) {
                          onClose();
                          navigate(krok.cesta);
                          return;
                        }
                        if (organizacia.emailAlias) onKopirovat?.(organizacia.emailAlias);
                      }}
                    >
                      {bezi === krok.cislo ? t('priprava.bezi') : krok.akcia}
                    </button>
                  </div>
                )}
              </div>
            </div>
          );
        })}
      </div>

      <div className="pf-pata">
        <span className="pf-poznamka">
          {vsetkoHotove ? t('priprava.hotovoPoznamka') : t('priprava.zavriPoznamka')}
        </span>
        <button type="button" className={vsetkoHotove ? 'dk-btn dk-btn-ai' : 'btn'} onClick={onClose}>
          {vsetkoHotove ? t('priprava.hotovo') : t('akcia.zavriet')}
        </button>
      </div>
    </Modal>
  );
}

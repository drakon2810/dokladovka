// Editor dokladu — maketa „Detail dokladu.dc.html" z Claude Design: účtovný
// zápis tak, ako ho uvidí POHODA. Karty Základné informácie · Dodávateľ ·
// Text dokladu · Položky dokladu · Rozpis DPH · Platba a zaokrúhlenie,
// všetko s inline editáciou (DcCell / DcPick) napojenou na draft.extracted
// a draft.ucto. Panel „Prečo?" (pôvod zaúčtovania) ostáva pri poliach
// predkontácie, členenia DPH a kontrolného výkazu.
import { useEffect, useMemo, useState, type ReactNode } from 'react';
import type { AccountingSuggestion, DocumentPodtyp, DphAudit, DphZistenie, CodeListItem, DocumentExtractedData, DocumentItem, DocumentLineItem, DocumentPreco, DocumentType, DocumentUcto, VatBreakdownRow, VatRate } from '../../data/types';
import { CLENENIE_KV_KODY, FORMY_UHRADY } from '../../data/types';
import { getDocumentPreco, getPrecoVysvetlenie, saveRuleDovod, type PrecoVysvetlenie } from '../../data/api';
import { requestMostikCodeListSync } from '../../data/mostik/mostikService';
import { nextNumberInSeries } from '../../data/pohoda/numbering';
import { druh, kvKodyPreTyp, predkontaciePreTyp, radyPreTyp } from '../../data/pohoda/agendas';
import { lineItemEffective, round2 } from '../../lib/validate';
import { isForeignSupplier } from '../../data/validation/documentValidation';
import { supplierAddressParts } from '../../data/xml/pohodaDataPack';
import { showToast } from '../../components/toast';
import { DcCell, DcPick, formatDateSk, type DcOption } from './DcInline';
import { ItemsSection, fmtMoney, parseNum, parseOpt, rozpisZPoloziek, type ItemsCodeLists } from './ItemsSection';
import { ITEMS_PATH, type SourceMap } from './sourceHighlight';
import './invoicePanel.css';
import './sourceHighlight.css';

// „Prečo?" — pôvod zaúčtovania pre tri polia: predkontácia, členenie DPH, KV.
type PrecoField = 'predkontacia' | 'dph' | 'kv';
const SOURCE_LABEL: Record<string, string> = {
  manual_rule: 'Pravidlo firmy',
  partner_default: 'Predvoľba partnera',
  decision_memory: 'Pamäť rozhodnutí',
  supplier_history: 'História dodávateľa',
  organization_default: 'Predvoľba organizácie',
  ai: 'Návrh AI',
  none: 'Bez návrhu',
};

interface InvoicePanelProps {
  draft: DocumentItem;
  readOnly: boolean;
  codeLists: ItemsCodeLists & { ciselneRady: CodeListItem[]; bankoveUcty?: CodeListItem[] };
  suggestion?: AccountingSuggestion;
  /** Verdikt právnej kontroly členenia DPH; chýba, kým kontrola nebežala. */
  dphAudit?: DphAudit;
  /** Prijatie odporúčania kontroly — nastaví členenie aj sekciu KV naraz. */
  onPrijatOdporucanie?: (clenenieDphId: string | undefined, kvKod: string | undefined) => void;
  /** Návrhy DPH poradcu podľa profilu klienta. Bývali pásom nad dokladom;
   *  patria k poľu, ktorého sa týkajú, a nie nad celú obrazovku. */
  dphNavrhy?: readonly DphZistenie[];
  autoFilled: boolean;
  /** Zvýraznenie zdroja údajov — mapa polí, ktoré vyplnila AI. */
  src?: SourceMap;
  srcEdited?: ReadonlySet<string>;
  srcOn?: boolean;
  /** Práve zvýraznené pole (`cesta`) alebo celá sekcia (`sec:N`). */
  activeSrc?: string;
  onHoverSrc?: (anchor?: string) => void;
  /** „Export do POHODA" v hlavičke — dialóg otvára detail dokladu. */
  onExport?: () => void;
  exportDisabledReason?: string;
  /** „Rozdeliť doklad“ v ponuke položiek — dialóg otvára detail dokladu. */
  onSplit?: () => void;
  /** Koľko ďalších dokladov ešte čaká na číslo z toho istého radu. Kým čaká
   *  aspoň jeden, konkrétne číslo sa sľúbiť nedá — rozhodne poradie prenosu. */
  cakajuceVRade?: number;
  /** Kód pokladne z predvolieb firmy — doplní sa pri prepnutí na pokladničný doklad. */
  predvolenaPokladna?: string;
  /** Druh dokladu vždy naraz: podtyp bez typu nemá zmysel a naopak. */
  setTyp: (typ: DocumentType, podtyp: DocumentPodtyp) => void;
  updateUcto: (patch: Partial<DocumentUcto>) => void;
  updateExtracted: <K extends keyof DocumentExtractedData>(key: K, value: DocumentExtractedData[K]) => void;
  /** Editovaná strana dokladu: dodávateľ (prijaté) alebo odberateľ (vydaná faktúra). */
  updateParty: (strana: 'dodavatel' | 'odberatel', key: string, value: string) => void;
  updatePartyAddress: (strana: 'dodavatel' | 'odberatel', patch: { ulica?: string; psc?: string; obec?: string; krajina?: string }) => void;
}

/**
 * Typ dokladu vrátane smeru pokladne a druhu faktúry — POHODA ich rozlišuje
 * ako samostatné agendy, resp. ako hodnoty poľa „Typ" v tom istom okne.
 * Jeden zoznam, presne ako v POHODE: dobropis nie je druhé pole, je to iný typ.
 */
export const TYP_OPTIONS: Array<{
  value: string; label: string; typ: DocumentType;
  pokladnaTyp?: 'receipt' | 'expense'; podtyp?: DocumentPodtyp;
}> = [
  { value: 'PD:expense', label: 'Výdajový pokladničný doklad', typ: 'PD', pokladnaTyp: 'expense' },
  { value: 'PD:receipt', label: 'Príjmový pokladničný doklad', typ: 'PD', pokladnaTyp: 'receipt' },
  { value: 'FP', label: 'Faktúra prijatá', typ: 'FP', podtyp: 'bezna' },
  { value: 'FP:dobropis', label: 'Dobropis prijatý', typ: 'FP', podtyp: 'dobropis' },
  { value: 'FP:tarchopis', label: 'Ťarchopis prijatý', typ: 'FP', podtyp: 'tarchopis' },
  { value: 'FP:zalohova', label: 'Zálohová faktúra prijatá', typ: 'FP', podtyp: 'zalohova' },
  { value: 'FV', label: 'Faktúra vydaná', typ: 'FV', podtyp: 'bezna' },
  { value: 'FV:dobropis', label: 'Dobropis vydaný', typ: 'FV', podtyp: 'dobropis' },
  { value: 'FV:tarchopis', label: 'Ťarchopis vydaný', typ: 'FV', podtyp: 'tarchopis' },
  { value: 'FV:zalohova', label: 'Zálohová faktúra vydaná', typ: 'FV', podtyp: 'zalohova' },
  { value: 'OZ', label: 'Ostatný záväzok', typ: 'OZ' },
  { value: 'MZDY', label: 'Interný doklad (INT)', typ: 'MZDY' },
  { value: 'BV', label: 'Bankový výpis', typ: 'BV' },
];

const KV_LABEL: Record<string, string> = {
  A1: 'A1 – Dodanie tovaru a služby', A2: 'A2 – Samozdanenie príjemcom',
  B1: 'B1 – Prenesenie daňovej povinnosti', B2: 'B2 – Prijaté faktúry s odpočtom',
  B3: 'B3 – Zjednodušené faktúry', C1: 'C1 – Opravy odpočítanej dane',
  C2: 'C2 – Opravy základu dane', D1: 'D1 – Obrat cez ERP', D2: 'D2 – Ostatné plnenia',
  KN: 'KN – Nezahŕňať do KV',
};

const VAT_RATES: VatRate[] = [23, 19, 5, 0];

const IcoCheck = ({ s = 11, w = 2 }: { s?: number; w?: number }) => (
  <svg width={s} height={s} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={w} strokeLinecap="round" strokeLinejoin="round"><path d="M20 6L9 17l-5-5" /></svg>
);
const IcoLines = () => (
  <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round"><path d="M4 7h16M4 12h16M4 17h10" /></svg>
);
const IcoWarn = ({ s = 13 }: { s?: number }) => (
  <svg width={s} height={s} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round"><path d="M12 9v4M12 17h.01" /><path d="M10.3 3.9L2 18a2 2 0 0 0 1.7 3h16.6A2 2 0 0 0 22 18L13.7 3.9a2 2 0 0 0-3.4 0z" /></svg>
);
const IcoSpark = () => (
  <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M12 3l1.6 5.2L19 10l-5.4 1.8L12 17l-1.6-5.2L5 10l5.4-1.8z" /></svg>
);
const IcoExternal = () => (
  <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round"><path d="M7 17L17 7M9 7h8v8" /></svg>
);
const IcoQuestion = ({ s = 12 }: { s?: number }) => (
  <svg width={s} height={s} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="9" /><path d="M9.5 9a2.5 2.5 0 0 1 5 .3c0 1.6-2.5 2.2-2.5 3.7" /><path d="M12 17h.01" /></svg>
);
const IcoPencil = () => (
  <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round"><path d="M12 20h9" /><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z" /></svg>
);
const Shimmer = ({ w }: { w: string }) => <span className="dv-skel" style={{ width: w }} />;

/** Farba istoty podľa makety: od 80 % zelená, od 50 % jantárová, inak šedá. */
const confColor = (confidence: number) => (confidence >= 0.8 ? '#0E7A5F' : confidence >= 0.5 ? '#B45309' : '#8A928C');

/** Pruh istoty — po otvorení panelu dorastie z 0 % na cieľovú hodnotu. */
function PrecoIstota({ confidence }: { confidence: number }) {
  const [grown, setGrown] = useState(false);
  useEffect(() => {
    const timer = setTimeout(() => setGrown(true), 40);
    return () => clearTimeout(timer);
  }, []);
  const pct = Math.round(confidence * 100);
  const color = confColor(confidence);
  return (
    <div className="dv-preco-conf">
      <span className="dv-preco-conf-label">istota</span>
      <span className="dv-preco-conf-track">
        <span className="dv-preco-conf-bar" style={{ width: grown ? `${pct}%` : '0%', background: color }} />
      </span>
      <span className="dv-preco-conf-pct" style={{ color }}>{pct} %</span>
    </div>
  );
}

/**
 * Priebeh prípravy AI vysvetlenia. Server vracia odpoveď jednou požiadavkou bez
 * streamu, takže skutočné percento neexistuje — krivka sa zámerne spomaľuje a
 * zastaví na 95 %, aby nikdy netvrdila „hotovo" pred odpoveďou.
 * ponytail: odhadované percento; nahradiť skutočným priebehom, ak server začne streamovať
 */
function VysvetlenieProgress() {
  const [pct, setPct] = useState(8);
  useEffect(() => {
    const timer = setInterval(
      () => setPct((current) => (current >= 95 ? 95 : current + Math.max(0.5, (95 - current) / 14))),
      220,
    );
    return () => clearInterval(timer);
  }, []);
  return (
    <div className="dv-preco-vys-load">
      <div className="dv-preco-vys-head">
        <span className="dv-preco-vys-badge"><IcoSpark />vysvetlenie AI</span>
        <span className="dv-preco-vys-pct">{Math.round(pct)} %</span>
      </div>
      <Shimmer w="96%" />
      <Shimmer w="68%" />
    </div>
  );
}

/** Pod touto istotou pole dostane prerušovaný rám a odznak s percentom. */
const LOW_CONFIDENCE = 0.5;

export function InvoicePanel({
  draft, readOnly, codeLists, suggestion, dphAudit, onPrijatOdporucanie, dphNavrhy, autoFilled,
  src, srcEdited, srcOn, activeSrc, onHoverSrc, onExport, exportDisabledReason, onSplit, cakajuceVRade = 0,
  predvolenaPokladna,
  setTyp, updateUcto, updateExtracted, updateParty, updatePartyAddress,
}: InvoicePanelProps) {
  const ex = draft.extracted;
  const dod = ex.dodavatel;
  // Na vydanej faktúre je dodávateľom vlastná firma a protistranou zákazník —
  // edituje sa teda odberateľ a práve ten ide do POHODY ako partner dokladu.
  const vydana = draft.typ === 'FV';
  const strana: 'dodavatel' | 'odberatel' = vydana ? 'odberatel' : 'dodavatel';
  const partner: Record<string, string | undefined> = (vydana ? ex.odberatel : ex.dodavatel) ?? {};
  const pole = (nazov: string) => `${strana}.${nazov}`;
  const updateStranu = (key: string, value: string) => updateParty(strana, key, value);
  const updateStranuAdresu = (patch: { ulica?: string; psc?: string; obec?: string; krajina?: string }) =>
    updatePartyAddress(strana, patch);
  // Ulica/PSČ/obec/krajina ako v POHODE. Kým ich účtovník neupravil, odvodia sa
  // z voľnej adresy z extrakcie — presne tak, ako ich uvidí export do POHODY.
  const adr = supplierAddressParts(partner);
  const ucto = draft.ucto;

  const [itemsOn, setItemsOn] = useState((ex.polozky ?? []).length > 0);
  // Položky odložené vypnutým prepínačom — aby ich omylom prepnutý prepínač
  // nezmazal nenávratne skôr, než sa doklad uloží.
  const [odlozene, setOdlozene] = useState<DocumentLineItem[]>([]);
  const [aiApplied, setAiApplied] = useState(false);

  // „Prečo?" — jeden zdieľaný stav: dáta sa načítajú raz na doklad, panel sa
  // otvára pod polom, na ktorom bol klik.
  const [precoOpen, setPrecoOpen] = useState<PrecoField | null>(null);
  // Dôvod právnej kontroly je zbalený za „prečo?" a rozbalí sa na mieste.
  // V pokoji tak návrh zaberie jeden riadok mriežky namiesto celého panelu.
  const [dovodOpen, setDovodOpen] = useState<'dph' | 'kv' | null>(null);
  const [preco, setPreco] = useState<DocumentPreco | null>(null);
  const [precoState, setPrecoState] = useState<'idle' | 'loading' | 'ready' | 'error'>('idle');
  const [dovodDraft, setDovodDraft] = useState('');
  const [dovodEditing, setDovodEditing] = useState(false);
  const [dovodSaving, setDovodSaving] = useState(false);
  // Druhá rýchlosť panelu: fakty prídu okamžite, AI vysvetlenie sa dotiahne
  // následne — zvlášť pre každé pole (iné zdroje), server ho kešuje.
  const [vysMap, setVysMap] = useState<Partial<Record<PrecoField, { stav: 'loading' | 'done'; data: PrecoVysvetlenie | null }>>>({});

  const nacitajVysvetlenie = (field: PrecoField) => {
    setVysMap((current) => (current[field] ? current : { ...current, [field]: { stav: 'loading', data: null } }));
    getPrecoVysvetlenie(draft.id, field)
      .then((data) => setVysMap((current) => ({ ...current, [field]: { stav: 'done', data } })))
      .catch(() => setVysMap((current) => ({ ...current, [field]: { stav: 'done', data: null } })));
  };

  const togglePreco = (field: PrecoField) => {
    if (precoOpen === field) { setPrecoOpen(null); return; }
    setPrecoOpen(field);
    setDovodEditing(false);
    if (precoState === 'ready') {
      if (preco && preco.source !== 'none' && !vysMap[field]) nacitajVysvetlenie(field);
      return;
    }
    if (precoState === 'idle' || precoState === 'error') {
      setPrecoState('loading');
      getDocumentPreco(draft.id)
        .then((data) => {
          if (data) {
            setPreco(data);
            setPrecoState('ready');
            if (data.source !== 'none') nacitajVysvetlenie(field);
          } else { setPrecoState('error'); }
        })
        .catch(() => setPrecoState('error'));
    }
  };

  const ulozDovod = async () => {
    if (!preco?.pravidlo || !dovodDraft.trim() || dovodSaving) return;
    setDovodSaving(true);
    try {
      await saveRuleDovod(preco.organizationId, preco.pravidlo.id, dovodDraft.trim());
      setPreco({ ...preco, pravidlo: { ...preco.pravidlo, dovod: dovodDraft.trim(), dovodSource: 'human' } });
      setDovodEditing(false);
    } catch {
      // Uloženie zlyhalo — editor ostáva otvorený, text sa nestratí.
    }
    setDovodSaving(false);
  };

  const precoHead = (chip?: ReactNode) => (
    <div className="dv-preco-head">
      <span className="dv-preco-head-label">Pôvod zaúčtovania</span>
      {chip}
    </div>
  );

  /**
   * Návrh DPH poradcu pri poli, ktorého sa týka. Predtým to bol modrý pás nad
   * celým dokladom — zaberal výšku aj tam, kde s ním účtovník nemal čo robiť.
   * Návrh bez členenia aj bez sekcie KV je všeobecná poznámka a patrí k členeniu.
   */
  const navrhyPreField = (field: PrecoField) => {
    const patri = (zistenie: DphZistenie) => (zistenie.clenenieKvKod && !zistenie.clenenieDphId
      ? field === 'kv' : field === 'dph');
    const zoznam = (dphNavrhy ?? []).filter(patri);
    if (zoznam.length === 0) return null;
    return (
      <div className="dv-preco-navrhy">
        {zoznam.map((zistenie) => {
          const menilByNieco = Boolean(zistenie.clenenieDphId || zistenie.clenenieKvKod)
            && (ucto.clenenieDphId !== zistenie.clenenieDphId
              || (zistenie.clenenieKvKod && ucto.clenenieKvKod !== zistenie.clenenieKvKod));
          return (
            <div key={`${zistenie.kod}-${zistenie.sprava}`} className="dv-preco-navrh">
              <span>{zistenie.sprava}</span>
              {!readOnly && menilByNieco && (
                <button
                  type="button"
                  className="dv-preco-navrh-btn"
                  onClick={() => updateUcto({
                    ...(zistenie.clenenieDphId ? { clenenieDphId: zistenie.clenenieDphId } : {}),
                    ...(zistenie.clenenieKvKod ? { clenenieKvKod: zistenie.clenenieKvKod } : {}),
                  })}
                >
                  Použiť
                </button>
              )}
            </div>
          );
        })}
      </div>
    );
  };

  const renderPreco = (field: PrecoField) => {
    if (precoState !== 'ready' || !preco) {
      return (
        <div className="dv-preco-panel">
          {precoHead()}
          {precoState === 'error' ? (
            <div className="dv-preco-body dv-preco-muted">Pôvod zaúčtovania sa nepodarilo načítať.</div>
          ) : (
            <div className="dv-preco-skel">
              <Shimmer w="58%" />
              <Shimmer w="92%" />
              <Shimmer w="74%" />
            </div>
          )}
        </div>
      );
    }
    if (preco.source === 'none') {
      return (
        <div className="dv-preco-panel">
          {precoHead()}
          <div className="dv-preco-body dv-preco-muted">Pre tento doklad nevznikol žiadny návrh — hodnotu vybral účtovník ručne.</div>
          <div className="dv-preco-body">{navrhyPreField(field)}</div>
        </div>
      );
    }
    // Porovnáva sa so ŽIVOU hodnotou na obrazovke (ucto.*), nie so snapshotom
    // z času fetchu — inak by poznámka „zmenil účtovník" po úprave poľa klamala.
    const navrhId = field === 'kv' ? preco.navrh.clenenieKvKod
      : field === 'predkontacia' ? preco.navrh.predkontaciaId : preco.navrh.clenenieDphId;
    const aktualneId = field === 'kv' ? ucto.clenenieKvKod
      : field === 'predkontacia' ? ucto.predkontaciaId : ucto.clenenieDphId;
    const lisiSa = Boolean(navrhId) && navrhId !== aktualneId;
    const navrhVal = navrhId ? (field === 'kv' ? navrhId : preco.polozky[navrhId]?.kod ?? navrhId) : undefined;
    const pravidlo = preco.pravidlo;
    const zdroj = SOURCE_LABEL[preco.source] ?? preco.source;
    const vysvetlenie = vysMap[field];
    return (
      <div className="dv-preco-panel">
        {precoHead(<span className="dv-preco-src">{zdroj}</span>)}
        <div className="dv-preco-body">
          <PrecoIstota confidence={preco.confidence} />
          <div className="dv-preco-chips">
            {pravidlo != null && (
              <span className="dv-preco-chip"><IcoCheck />{pravidlo.navrhnutePre}× použité</span>
            )}
            <span className="dv-preco-chip"><IcoLines />{zdroj}</span>
          </div>
          {preco.reason && <div className="dv-preco-reason">{preco.reason}</div>}
          {lisiSa && (
            <div className="dv-preco-note">
              <IcoWarn />
              <span>Návrh bol „{navrhVal}" — aktuálnu hodnotu zmenil účtovník.</span>
            </div>
          )}
          {navrhyPreField(field)}
          {vysvetlenie?.stav === 'loading' && <VysvetlenieProgress />}
          {vysvetlenie?.stav === 'done' && vysvetlenie.data && (
            <div className="dv-preco-vys">
              <span className="dv-preco-vys-badge"><IcoSpark />vysvetlenie AI</span>
              <div className="dv-preco-vys-text">{vysvetlenie.data.vysvetlenie}</div>
              {vysvetlenie.data.zdroje.length > 0 && (
                <div className="dv-preco-zdroje">
                  {vysvetlenie.data.zdroje.map((odkaz, index) => (
                    <a
                      key={odkaz.url}
                      href={odkaz.url}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="dv-preco-zdroj"
                      style={{ animationDelay: `${index * 50}ms` }}
                    >
                      {odkaz.nazov}
                      <IcoExternal />
                    </a>
                  ))}
                </div>
              )}
            </div>
          )}
          {pravidlo != null && (dovodEditing ? (
            <div className="dv-preco-edit">
              <textarea
                className="dv-preco-ta" value={dovodDraft} maxLength={500}
                onChange={(e) => setDovodDraft(e.target.value)}
                placeholder="Prečo firma účtuje tohto dodávateľa takto? Jedna–dve vety…"
              />
              <div className="dv-preco-actions">
                <div className="dv-preco-actions-left">
                  <button type="button" className="dv-preco-save" disabled={dovodSaving || !dovodDraft.trim()} onClick={ulozDovod}>Uložiť dôvod</button>
                  <button type="button" className="dv-preco-cancel" onClick={() => setDovodEditing(false)}>Zrušiť</button>
                </div>
                <span className="dv-preco-count">{dovodDraft.length} / 500</span>
              </div>
            </div>
          ) : pravidlo.dovod && pravidlo.dovodSource === 'human' ? (
            <div className="dv-preco-quote">
              <div className="dv-preco-quote-head"><IcoCheck s={12} w={2.6} />dôvod potvrdený účtovníkom</div>
              <div className="dv-preco-quote-text">„{pravidlo.dovod}"</div>
              {!readOnly && (
                <button type="button" className="dv-preco-link" onClick={() => { setDovodDraft(pravidlo.dovod ?? ''); setDovodEditing(true); }}>Upraviť</button>
              )}
            </div>
          ) : pravidlo.dovod ? (
            <div className="dv-preco-draft">
              <span className="dv-preco-draft-badge">návrh AI — nepotvrdené</span>
              <div className="dv-preco-draft-text">„{pravidlo.dovod}"</div>
              {!readOnly && (
                <button type="button" className="dv-preco-link" onClick={() => { setDovodDraft(pravidlo.dovod ?? ''); setDovodEditing(true); }}>Upraviť a potvrdiť</button>
              )}
            </div>
          ) : (
            <div className="dv-preco-missing">
              <IcoQuestion s={14} />
              <div>
                <div className="dv-preco-missing-text">Dôvod firmy zatiaľ nie je zapísaný — doplň ho raz a zobrazí sa pri každom ďalšom doklade tohto pravidla.</div>
                {!readOnly && (
                  <button type="button" className="dv-preco-link" onClick={() => { setDovodDraft(''); setDovodEditing(true); }}>Doplniť dôvod</button>
                )}
              </div>
            </div>
          ))}
        </div>
      </div>
    );
  };

  // Zámerne span, nie <button>: čítanie pôvodu má fungovať aj pri readOnly.
  /** Kód, ktorý na doklade naozaj STOJÍ — nie ten, čo doň svieti ako návrh. */
  const kodVPoli = codeLists.cleneniaDph.find((item) => item.id === ucto.clenenieDphId)?.kod;

  // Kým účtovník nič nevybral, v poli svieti sivý návrh pamäte a doklad nie je
  // zaúčtovaný. Hádať sa s návrhom, ktorý sám ešte nikto neprijal, je predčasné
  // — kontrola sa ozve až keď v poli niečo naozaj stojí, teda po Automatickom
  // účtovaní alebo po ručnom výbere.
  //
  // Verdikt navyše platí pre členenie, ktoré sa posudzovalo. Keď ho účtovník
  // medzitým prepol, návrh zmizne: radiť k inému kódu, než aký kontrola videla,
  // by bolo horšie než mlčať.
  const navrhKontroly = dphAudit && dphAudit.verdikt !== 'suhlasi'
    && kodVPoli
    && (!dphAudit.posudeneClenenieKod || dphAudit.posudeneClenenieKod === kodVPoli)
    ? {
      // Po rozhodnutí návrh nezmizne bez stopy. Doteraz sa po stlačení
      // „Ponechať" zavrela celá panel aj s odôvodnením a na doklade nezostalo
      // nič — nedalo sa zistiť, či kontrola vôbec bežala a čo hovorila.
      rozhodnutie: dphAudit.rozhodnutie ?? undefined,
      /** Čo kontrola radila — po prijatí sa to už od poľa nelíši, ale patrí do záznamu. */
      radila: dphAudit.odporucaneClenenieKod ?? undefined,
      // Ponúkame len to, čo sa naozaj líši od toho, čo na doklade stojí.
      clenenie: dphAudit.odporucaneClenenieKod && dphAudit.odporucaneClenenieKod !== kodVPoli
        ? dphAudit.odporucaneClenenieKod
        : undefined,
      // Sekcia KV má vlastné pole, takže aj vlastnú podmienku: kým je prázdne,
      // mlčíme o nej rovnako ako o členení.
      kvSekcia: ucto.clenenieKvKod && dphAudit.odporucanaKvSekcia
        && dphAudit.odporucanaKvSekcia !== ucto.clenenieKvKod
        ? dphAudit.odporucanaKvSekcia
        : undefined,
      // Kontrola nemala čo povedať iba vtedy, keď NEPONÚKLA vôbec nič. Keď
      // niečo navrhla a zhoduje sa to s poľom, je to tichý súhlas — nie
      // „neposúdila". Bez tohto rozlíšenia svietilo na doklade, kde kontrola
      // súhlasila s PN, hlásenie, že ho vôbec neposúdila.
      bezNalezu: !dphAudit.odporucaneClenenieKod && !dphAudit.odporucanaKvSekcia,
      dovod: dphAudit.dovod,
    }
    : undefined;

  /**
   * Návrh právnej kontroly ako jeden riadok mriežky pod poľom, ktorého sa týka.
   * Bez rámu a bez prekrytia: v pokoji zaberie riadok namiesto celého panelu,
   * dôvod sa rozbalí až za „prečo?". Nič sa neprepisuje — účtovník rozhoduje.
   */
  const riadokNavrhu = (field: 'dph' | 'kv', kod: string | undefined, pouzit: () => void) => (
    <>
      <span />
      <div className="dk-navrh">
        <div className="dk-navrh-riadok">
          {/* Tri stavy. Rozhodnutý spor je tichý záznam, čo kontrola radila —
              po stlačení „Ponechať" dovtedy nezostalo na doklade nič a nedalo
              sa zistiť, či vôbec bežala. Bez kódu kontrola nemá čo ponúknuť,
              a to tiež nie je výstraha. Jantárová ostáva len živá rada. */}
          <span className={kod && !navrhKontroly?.rozhodnutie ? 'dk-navrh-kod' : 'dk-navrh-ticho'}>
            {navrhKontroly?.rozhodnutie
              ? `Kontrola navrhovala ${kod ?? '—'} · ${navrhKontroly.rozhodnutie === 'prijate' ? 'prijaté' : 'ponechané'}`
              : kod ? <><IcoWarn s={11} />Kontrola navrhuje {kod}</> : 'Kontrola doklad neposúdila'}
          </span>
          {!readOnly && kod && !navrhKontroly?.rozhodnutie && onPrijatOdporucanie && (
            <>
              <button type="button" className="dk-navrh-pouzit" onClick={pouzit}>Použiť</button>
              <span className="dk-navrh-sep">·</span>
              <button type="button" className="dk-navrh-ponechat" onClick={() => onPrijatOdporucanie(undefined, undefined)}>Ponechať</button>
              <span className="dk-navrh-sep">·</span>
            </>
          )}
          <button
            type="button" className="dk-navrh-preco"
            onClick={() => setDovodOpen(dovodOpen === field ? null : field)}
          >
            {dovodOpen === field ? 'skryť dôvod' : 'prečo?'}
          </button>
        </div>
        {dovodOpen === field && <p className="dk-navrh-dovod">{navrhKontroly?.dovod}</p>}
      </div>
    </>
  );

  const precoWrap = (field: PrecoField, control: ReactNode, navrh = false) => {
    // Bodka na „?" — návrh DPH poradcu už nie je pásom nad dokladom, takže bez
    // nej by účtovník nemal ako vedieť, že je tam čo čítať.
    const maNavrh = ((dphNavrhy ?? []).some((zistenie) => (zistenie.clenenieKvKod && !zistenie.clenenieDphId
      ? field === 'kv' : field === 'dph')));
    return (
    <div className={`dv-preco-field dk-with-preco${navrh ? ' dk-pole-navrh' : ''}`}>
      {control}
      <span
        role="button" tabIndex={0}
        title={maNavrh ? 'Návrh DPH poradcu — kliknutím zobrazíte' : 'Prečo práve táto hodnota?'}
        className={`dv-preco-btn${precoOpen === field ? ' dv-open' : ''}${maNavrh ? ' dv-preco-ma-navrh' : ''}`}
        onClick={() => togglePreco(field)}
        onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); togglePreco(field); } }}
      >
        ?
      </span>
      {precoOpen === field && renderPreco(field)}
    </div>
    );
  };

  // ---- Zvýraznenie zdroja údajov -------------------------------------------
  const srcField = (path: string) => (srcOn ? src?.[path] : undefined);
  const isEdited = (path: string) => srcEdited?.has(path) ?? false;
  const isLow = (path: string) => {
    const field = srcField(path);
    return Boolean(field && !isEdited(path) && field.confidence !== undefined && field.confidence < LOW_CONFIDENCE);
  };
  const srcCls = (path: string) => {
    const field = srcField(path);
    if (!field) return '';
    const focused = activeSrc === path || activeSrc === `sec:${field.section}`;
    const state = focused ? ' dv-src-on' : activeSrc ? ' dv-src-off' : '';
    return ` dv-src dv-src-${isEdited(path) ? 'edited' : field.section}${isLow(path) ? ' dv-src-low' : ''}${state}`;
  };
  const srcHover = (path: string) => (srcField(path)
    ? { onMouseEnter: () => onHoverSrc?.(path), onMouseLeave: () => onHoverSrc?.(undefined) }
    : {});
  // Bez číselného chipu pri popise — posúval text a sekciu aj tak nesie
  // farebný pásik hodnoty; čísla sekcií ostávajú na nadpisoch kariet.
  const srcLabel = (path: string, text: string) => {
    const field = srcField(path);
    return (
      <span className="dk-lbl" {...srcHover(path)}>
        {text}
        {isEdited(path) && <span className="dv-src-upravene" title="Hodnotu prepísal účtovník"><IcoPencil /></span>}
        {isLow(path) && field?.confidence !== undefined && (
          <span className="dv-src-warn" title={field.quote ? `Zdroj hodnoty: „${field.quote}"` : undefined}>
            <IcoWarn s={10} />{Math.round(field.confidence * 100)} %
          </span>
        )}
      </span>
    );
  };
  const secChip = (section: number) => (srcOn && src && Object.values(src).some((field) => field.section === section)
    ? <span className={`dv-src-sec dv-src-${section} dv-src-chip`} onMouseEnter={() => onHoverSrc?.(`sec:${section}`)} onMouseLeave={() => onHoverSrc?.(undefined)}>{section}</span>
    : null);

  // ---- číselníky ------------------------------------------------------------
  const syncMostik = readOnly ? undefined : () => {
    requestMostikCodeListSync(draft.orgId)
      .then(() => showToast('Synchronizácia číselníkov cez Mostík je vyžiadaná — zoznam sa obnoví do minúty.'))
      .catch((cause: unknown) => showToast(cause instanceof Error && cause.message ? cause.message : 'Synchronizáciu sa nepodarilo vyžiadať.', { tone: 'error' }));
  };

  const toOpts = (items: CodeListItem[]): DcOption[] =>
    items.map((item) => ({ value: item.id, label: `${item.kod} · ${item.nazov}`, title: `${item.kod} · ${item.nazov}` }));

  // Rad musí sedieť s agendou dokladu — pokladničný doklad nesmie dostať rad
  // prijatých faktúr. Už zvolený rad ostáva v ponuke, nech sa hodnota nestratí.
  const druhDokladu = druh(draft);
  const ponukaRadov = radyPreTyp(codeLists.ciselneRady, druhDokladu);
  // POHODA má pre každú agendu vlastné predkontácie — na vydanú faktúru nepatrí nákupová.
  //
  // Značka agendy z POHODY ale hovorí, kde bola predkontácia ZALOŽENÁ, nie kde
  // sa smie použiť: „PHM" je označená ako internalDocument a firma ju má na 229
  // prijatých faktúrach. Bez tejto výnimky návrh AI z ponuky vypadol, pole
  // ukázalo „—" a účtovník ten účet nevedel vybrať ani ručne.
  const predkontacieProDoklad = useMemo(() => {
    const podlaAgendy = predkontaciePreTyp(codeLists.predkontacie, druhDokladu);
    const chybajuce = [suggestion?.predkontaciaId, ucto.predkontaciaId]
      .filter((id): id is string => Boolean(id) && !podlaAgendy.some((item) => item.id === id))
      .map((id) => codeLists.predkontacie.find((item) => item.id === id))
      .filter((item): item is CodeListItem => Boolean(item));
    return chybajuce.length > 0 ? [...chybajuce, ...podlaAgendy] : podlaAgendy;
  }, [codeLists.predkontacie, druhDokladu.typ, druhDokladu.podtyp, suggestion?.predkontaciaId, ucto.predkontaciaId]);
  const radOpts = ponukaRadov.some((item) => item.id === ucto.ciselnyRadId) || !ucto.ciselnyRadId
    ? ponukaRadov
    : [...ponukaRadov, ...codeLists.ciselneRady.filter((item) => item.id === ucto.ciselnyRadId)];
  const vybranyRad = codeLists.ciselneRady.find((item) => item.id === ucto.ciselnyRadId);
  // Prvé voľné číslo radu. Keď naň čakajú aj iné doklady, je to spodná hranica,
  // nie sľub — POHODA pridelí najbližšie voľné až v okamihu prenosu.
  const dalsieCislo = nextNumberInSeries(vybranyRad?.posledneCislo);
  const cisloJeIste = cakajuceVRade === 0;
  const cisloTitle = cisloJeIste
    ? 'Odhad z posledného čísla číselného radu v POHODE. Skutočné číslo pridelí POHODA až pri prenose.'
    : `Na tento rad čaká ešte ${cakajuceVRade} ${cakajuceVRade === 1 ? 'ďalší doklad' : 'ďalších dokladov'}. POHODA prideľuje najbližšie voľné číslo v okamihu prenosu, takže o poradí rozhoduje to, ktorý doklad prenesiete skôr.`;

  // Sekcia KV musí sedieť so stranou dokladu — prijatá faktúra do A1 („dodanie
  // tovaru a služby") nepatrí. Už zvolená hodnota ostáva v ponuke, nech sa
  // nestratí a účtovník ju vidí aj vtedy, keď ju treba prepísať.
  const ponukaKv = kvKodyPreTyp(CLENENIE_KV_KODY, druhDokladu);
  const kvOpts: DcOption[] = (ucto.clenenieKvKod && !ponukaKv.includes(ucto.clenenieKvKod)
    ? [...ponukaKv, ucto.clenenieKvKod]
    : ponukaKv
  ).map((kod) => ({ value: kod, label: KV_LABEL[kod] ?? kod, title: KV_LABEL[kod] ?? kod }));
  const menaOpts: DcOption[] = [
    { value: 'EUR', label: 'EUR' }, { value: 'CZK', label: 'CZK' }, { value: 'USD', label: 'USD' },
  ];
  const rateOpts: DcOption[] = VAT_RATES.map((rate) => ({ value: String(rate), label: `${rate} %` }));

  // ---- sumy -----------------------------------------------------------------
  const polozky = ex.polozky ?? [];
  const rozpis = ex.rozpisDph;
  const totalZaklad = round2(rozpis.reduce((sum, row) => sum + (row.zaklad || 0), 0));
  const totalDph = round2(rozpis.reduce((sum, row) => sum + (row.dph || 0), 0));
  const rozpisSpolu = round2(totalZaklad + totalDph);
  const sumaSpolu = ex.sumaSpolu ?? 0;
  const zaokruhlenie = round2(sumaSpolu - rozpisSpolu);

  /**
   * Položky sú zdrojom pravdy pre rozpis DPH — inak sa doklad nedá schváliť.
   * Rozpis sa však prepíše len vtedy, keď položky naozaj nesú sumy: prázdny
   * zoznam ani čerstvo pridaný prázdny riadok nesmú zmazať rozpis, ktorý
   * vytiahla AI (bez neho by doklad prišiel o DPH a už by sa nedal opraviť,
   * lebo pri zapnutých položkách je rozpis zamknutý).
   */
  const setPolozky = (next: DocumentLineItem[]) => {
    updateExtracted('polozky', next);
    const derived = rozpisZPoloziek(next);
    if (derived.some((row) => row.zaklad || row.dph)) updateExtracted('rozpisDph', derived);
  };
  const toggleItems = (next: boolean) => {
    setItemsOn(next);
    if (next) {
      // Späť zapnutý rozpis vráti položky, ktoré prepínač odložil.
      if (odlozene.length > 0) { setPolozky(odlozene); setOdlozene([]); return; }
      if (polozky.length > 0) updateExtracted('rozpisDph', rozpisZPoloziek(polozky));
      return;
    }
    // Vypnutý rozpis znamená „účtuj jednou sumou" — položky musia z dokladu
    // naozaj zmiznúť, inak by ich POHODA aj tak naimportovala a rozpor s ručne
    // upraveným rozpisom DPH by sa ukázal až v účtovníctve. Rozpis DPH a celková
    // suma ostávajú nedotknuté, takže peňažný obsah dokladu sa nestráca.
    if (polozky.length > 0) {
      setOdlozene(polozky);
      updateExtracted('polozky', []);
      showToast(`Rozpis na položky je vypnutý — ${polozky.length} položiek sa do POHODY neprenesie. Prepínačom ich vrátiš späť.`);
    }
  };
  const setVatRow = (index: number, patch: Partial<VatBreakdownRow>) => {
    updateExtracted('rozpisDph', rozpis.map((row, rowIndex) => (rowIndex === index ? { ...row, ...patch } : row)));
  };
  const addVatRow = () => {
    const used = new Set(rozpis.map((row) => row.sadzba));
    const sadzba = VAT_RATES.find((rate) => !used.has(rate)) ?? 0;
    updateExtracted('rozpisDph', [...rozpis, { sadzba, zaklad: 0, dph: 0 }]);
  };
  const removeVatRow = (index: number) => updateExtracted('rozpisDph', rozpis.filter((_, rowIndex) => rowIndex !== index));

  // ---- typ dokladu a režim zaúčtovania --------------------------------------
  const typValue = draft.typ === 'PD' ? `PD:${ucto.pokladnaTyp ?? 'expense'}`
    : (draft.typ === 'FP' || draft.typ === 'FV') && draft.podtyp && draft.podtyp !== 'bezna'
      ? `${draft.typ}:${draft.podtyp}` : draft.typ;
  const typLabel = TYP_OPTIONS.find((option) => option.value === typValue)?.label ?? draft.typ;
  const setTypValue = (value: string) => {
    const option = TYP_OPTIONS.find((item) => item.value === value);
    if (!option) return;
    if (option.typ !== draft.typ || (option.podtyp ?? 'bezna') !== (draft.podtyp ?? 'bezna')) {
      setTyp(option.typ, option.podtyp ?? 'bezna');
    }
    // Smer pokladne je vlastnosť dokladu, nie číselníka — pri inej agende ho
    // necháme tak, POHODA ho pre faktúry ignoruje.
    const patch: Partial<DocumentUcto> = {};
    if (option.pokladnaTyp && option.pokladnaTyp !== ucto.pokladnaTyp) patch.pokladnaTyp = option.pokladnaTyp;
    // Pokladňa z predvoľby firmy — POHODA bez nej doklad neprijme a účtovník ju
    // inak píše ručne na každom doklade. Už vyplnenú hodnotu neprepisujeme.
    if (option.typ === 'PD' && !ucto.pokladnaKod?.trim() && predvolenaPokladna) {
      patch.pokladnaKod = predvolenaPokladna;
    }
    if (Object.keys(patch).length > 0) updateUcto(patch);
  };
  // Zálohová faktúra sa neúčtuje: POHODA ju vedie s predkontáciou „Bez" a bez
  // členenia DPH — daňový moment nastane až pri úhrade alebo pri zúčtovacej
  // faktúre. Polia sú preto len na čítanie; vyplniť ich by znamenalo priznať
  // daň dvakrát, raz zo zálohy a raz zo zúčtovania.
  const zalohova = druhDokladu.podtyp === 'zalohova';
  const jePokladna = draft.typ === 'PD';
  const chybaPokladna = jePokladna && (!ucto.pokladnaKod?.trim() || !ucto.pokladnaTyp);
  const rezim = `${typLabel}${vybranyRad?.kod ? ` (${vybranyRad.kod})` : ''}`;

  const predkConfidence = suggestion && suggestion.source !== 'none' && suggestion.predkontaciaId && suggestion.predkontaciaId === ucto.predkontaciaId
    ? Math.round(suggestion.confidence * 100) : undefined;
  const canAi = !readOnly && suggestion != null && suggestion.source !== 'none' && Boolean(suggestion.predkontaciaId);
  /**
   * Návrh, ktorý ešte nikto nepoužil, sa ukáže v prázdnom poli ako bledá
   * predloha. Sám sa doklad predvyplní až od istoty 90 % — dovtedy účtovník
   * videl len „—" a nevedel, že návrh vôbec existuje.
   */
  const navrhDo = (pole: 'predkontaciaId' | 'clenenieDphId' | 'clenenieKvKod'): string | undefined => {
    if (!suggestion || suggestion.source === 'none' || ucto[pole]) return undefined;
    const hodnota = suggestion[pole];
    if (!hodnota) return undefined;
    if (pole === 'clenenieKvKod') return `${hodnota} · návrh`;
    const zoznam = pole === 'predkontaciaId' ? codeLists.predkontacie : codeLists.cleneniaDph;
    const kod = zoznam.find((item) => item.id === hodnota)?.kod;
    return kod ? `${kod} · návrh` : undefined;
  };
  const applyAi = () => {
    if (!suggestion) return;
    // KV chýbajúce v návrhu sa odvodí zo sekcie KV zvoleného členenia DPH —
    // rovnaká logika ako pri ručnom výbere členenia nižšie.
    const kvKod = suggestion.clenenieKvKod
      ?? codeLists.cleneniaDph.find((item) => item.id === suggestion.clenenieDphId)?.kvSekcia;
    updateUcto({
      predkontaciaId: suggestion.predkontaciaId,
      clenenieDphId: suggestion.clenenieDphId,
      ciselnyRadId: suggestion.ciselnyRadId,
      strediskoId: suggestion.strediskoId,
      clenenieKvKod: kvKod,
    });
    setAiApplied(true);
  };

  const itemsCodeLists = useMemo<ItemsCodeLists>(() => ({
    predkontacie: predkontacieProDoklad,
    cleneniaDph: codeLists.cleneniaDph,
    strediska: codeLists.strediska,
    cinnosti: codeLists.cinnosti,
    zakazky: codeLists.zakazky,
  }), [codeLists, predkontacieProDoklad]);

  const cisloErr = !String(ex.cisloFaktury || '').trim();
  // Osemmiestne IČO je slovenské pravidlo — zahraničný dodávateľ ho nespĺňa
  // a validácia dokladu ho pri ňom tiež preskakuje.
  const icoErr = Boolean(partner.ico) && !isForeignSupplier(partner) && !/^\d{8}$/.test(String(partner.ico || '').trim());

  /** Peňažná bunka: edituje sa surové číslo, v pokoji sa ukazuje naformátované. */
  const money = (value: number | undefined, onCommit: (raw: string) => void, path?: string) => (
    <div className="dk-r">
      <DcCell
        align="right" inputMode="decimal" disabled={readOnly}
        srcClass={path ? srcCls(path) : ''}
        value={value === undefined ? '' : String(value)}
        display={value === undefined ? '' : fmtMoney(value, ex.mena)}
        onCommit={onCommit}
      />
    </div>
  );

  return (
    <div className="dk-doc">
      {/* Zaúčtovanie dokladu (účtovný zápis pre POHODU) */}
      <div className="dk-head">
        <span className="dk-head-mark">P</span>
        <span className="dk-head-title">Zaúčtovanie dokladu</span>
        <div className="dk-head-actions">
          <button type="button" className="dk-btn dk-btn-ai" disabled={!canAi} onClick={applyAi} title="Vyplniť zaúčtovanie podľa pravidiel firmy a pamäte rozhodnutí">
            <IcoSpark />
            Automatické účtovanie
          </button>
          {onExport && (
            <button type="button" className="dk-btn" disabled={Boolean(exportDisabledReason)} title={exportDisabledReason} onClick={onExport}>
              Export do POHODA
              <IcoExternal />
            </button>
          )}
        </div>
      </div>

      <div className={`dk-mode${chybaPokladna ? ' dk-mode-warn' : ''}`}>
        {chybaPokladna ? <IcoWarn s={16} /> : (
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#0E7A5F" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="9" /><path d="M8.5 12.5l2.5 2.5 4.5-5" /></svg>
        )}
        {chybaPokladna
          ? <span>Pokladničný doklad potrebuje <strong>číslo pokladne</strong> a smer dokladu — bez nich ho POHODA neprijme.</span>
          : (
            <span className="dk-mode-text">
              Doklad bude zaúčtovaný do POHODY v režime <strong>{rezim}</strong>
              {/* Číslo sa dá prepísať: prázdne pole nechá číslovanie na POHODE
                  (ukáže sa odhad z posledného čísla radu), vyplnené sa pošle ako
                  numberRequested a doklad vznikne presne s ním. */}
              {' '}a dostane číslo{' '}
              <DcCell
                value={ucto.cisloVPohode ?? ''}
                placeholder={dalsieCislo ?? 'pridelí POHODA'}
                disabled={readOnly}
                title={ucto.cisloVPohode
                  ? 'Doklad vznikne v POHODE presne s týmto číslom. Prázdne pole = číslo pridelí POHODA z radu.'
                  : cisloTitle}
                onCommit={(raw) => updateUcto({ cisloVPohode: raw.trim() || undefined })}
              />
            </span>
          )}
      </div>

      <div className="dk-two">
        {/* Základné informácie */}
        <div className="dk-card">
          <div className="dk-card-title">Základné informácie {secChip(1)}</div>
          <div className="dk-grid dk-grid-main">
            <span className="dk-lbl">Typ dokladu</span>
            <DcPick value={typValue} options={TYP_OPTIONS} disabled={readOnly} onChange={setTypValue} />

            {/* Číselný rad a pokladňa sú krátke kódy — na jednom riadku ušetria
                výšku, ktorú editor potrebuje, aby sa zmestil bez skrolovania.
                Predikcia ďalšieho čísla ide do tooltipu, nie na vlastný riadok. */}
            <span className="dk-lbl">Číselný rad</span>
            <div className="dk-pairline">
              <DcPick
                value={ucto.ciselnyRadId} options={toOpts(radOpts)} disabled={readOnly} onMostikSync={syncMostik}
                title={dalsieCislo ? `${cisloJeIste ? 'Ďalšie číslo v POHODE' : 'Prvé voľné číslo v POHODE'}: ${dalsieCislo}` : undefined}
                onChange={(value) => updateUcto({ ciselnyRadId: value })}
              />
              {jePokladna && (
                <>
                  <span className="dk-lbl">Pokladňa</span>
                  <DcCell
                    value={ucto.pokladnaKod ?? ''} disabled={readOnly} placeholder="HP1"
                    tone={!ucto.pokladnaKod?.trim() ? 'err' : undefined}
                    onCommit={(raw) => updateUcto({ pokladnaKod: raw || undefined })}
                  />
                </>
              )}
            </div>

            {srcLabel('cisloFaktury', 'Číslo dokladu')}
            <DcCell
              value={ex.cisloFaktury ?? ''} disabled={readOnly} tone={cisloErr ? 'err' : undefined}
              title={cisloErr ? 'Zadajte číslo dokladu' : undefined}
              srcClass={srcCls('cisloFaktury')}
              onCommit={(raw) => updateExtracted('cisloFaktury', raw)}
            />

            {srcLabel('datumVystavenia', 'Dátum vystavenia')}
            <DcCell type="date" value={ex.datumVystavenia ?? ''} display={formatDateSk(ex.datumVystavenia)} disabled={readOnly} srcClass={srcCls('datumVystavenia')} onCommit={(raw) => updateExtracted('datumVystavenia', raw)} />

            {srcLabel('datumSplatnosti', jePokladna ? 'Dátum platby' : 'Dátum splatnosti')}
            <DcCell type="date" value={ex.datumSplatnosti ?? ''} display={formatDateSk(ex.datumSplatnosti)} disabled={readOnly} srcClass={srcCls('datumSplatnosti')} onCommit={(raw) => updateExtracted('datumSplatnosti', raw || undefined)} />

            {srcLabel('datumDodania', 'Dátum daň. povinnosti')}
            <DcCell type="date" value={ex.datumDodania ?? ''} display={formatDateSk(ex.datumDodania)} disabled={readOnly} srcClass={srcCls('datumDodania')} onCommit={(raw) => updateExtracted('datumDodania', raw || undefined)} />

            <span className="dk-lbl">Predkontácia</span>
            {precoWrap('predkontacia',
              <DcPick value={ucto.predkontaciaId} options={toOpts(predkontacieProDoklad)}
                disabled={readOnly || zalohova} onMostikSync={syncMostik}
                placeholder={zalohova ? 'Bez' : navrhDo('predkontaciaId')}
                title={predkConfidence != null ? `Návrh AI · istota ${predkConfidence} %`
                  : navrhDo('predkontaciaId') ? 'Návrh AI — prevezmete ho tlačidlom Automatické účtovanie' : undefined}
                onChange={(value) => updateUcto({ predkontaciaId: value })} />)}

            <span className="dk-lbl">Členenie DPH</span>
            {precoWrap('dph',
              <DcPick value={ucto.clenenieDphId} options={toOpts(codeLists.cleneniaDph)}
                disabled={readOnly || zalohova} onMostikSync={syncMostik}
                placeholder={zalohova ? 'Zálohová faktúra — bez členenia' : navrhDo('clenenieDphId')}
                onChange={(value) => {
                  const picked = codeLists.cleneniaDph.find((item) => item.id === value);
                  updateUcto({ clenenieDphId: value, ...(picked?.kvSekcia && !ucto.clenenieKvKod ? { clenenieKvKod: picked.kvSekcia } : {}) });
                }} />, Boolean(navrhKontroly?.clenenie && !navrhKontroly.rozhodnutie))}

            {/* Neistý verdikt sa ukáže tiež — bez kódu a bez tlačidiel, len
                s dôvodom. Pochybnosť kontroly je informácia, mlčať o nej
                znamená tváriť sa, že je všetko preverené. Rozhodnutý spor
                zostáva ako tichý záznam, aby bolo vidieť, čo kontrola radila. */}
            {navrhKontroly && (navrhKontroly.clenenie || navrhKontroly.bezNalezu || navrhKontroly.rozhodnutie)
              && riadokNavrhu('dph', navrhKontroly.clenenie ?? navrhKontroly.radila, () => onPrijatOdporucanie?.(
                codeLists.cleneniaDph.find((item) => item.kod === navrhKontroly.clenenie)?.id,
                navrhKontroly.kvSekcia,
              ))}

            <span className="dk-lbl">Členenie KV DPH</span>
            {precoWrap('kv',
              <DcPick value={ucto.clenenieKvKod} options={kvOpts} disabled={readOnly || zalohova}
                placeholder={zalohova ? 'Nevstupuje do KV' : navrhDo('clenenieKvKod')}
                onChange={(value) => updateUcto({ clenenieKvKod: value })} />, Boolean(navrhKontroly?.kvSekcia && !navrhKontroly.rozhodnutie))}

            {navrhKontroly?.kvSekcia && riadokNavrhu('kv', navrhKontroly.kvSekcia,
              () => onPrijatOdporucanie?.(undefined, navrhKontroly.kvSekcia))}
          </div>
        </div>

        {/* Protistrana dokladu — na vydanej faktúre je ňou odberateľ */}
        <div className="dk-card">
          <div className="dk-card-title">{vydana ? 'Odberateľ' : 'Dodávateľ'} {secChip(2)}</div>
          <div className="dk-grid dk-grid-sup">
            {srcLabel(pole('ico'), 'IČO')}
            <DcCell value={partner.ico ?? ''} disabled={readOnly} tone={icoErr ? 'warn' : undefined} title={icoErr ? 'IČO má mať 8 číslic' : undefined} srcClass={srcCls(pole('ico'))} onCommit={(raw) => updateStranu('ico', raw)} />
            {srcLabel(pole('dic'), 'DIČ')}
            <DcCell value={partner.dic ?? ''} disabled={readOnly} srcClass={srcCls(pole('dic'))} onCommit={(raw) => updateStranu('dic', raw)} />
            {srcLabel(pole('icDph'), 'IČ DPH')}
            <DcCell value={partner.icDph ?? ''} disabled={readOnly} srcClass={srcCls(pole('icDph'))} onCommit={(raw) => updateStranu('icDph', raw)} />
            {srcLabel(pole('nazov'), 'Firma')}
            <DcCell
              value={partner.nazov ?? ''} disabled={readOnly}
              tone={vydana && !partner.nazov?.trim() ? 'err' : undefined}
              title={vydana && !partner.nazov?.trim() ? 'Zadajte odberateľa — ide do POHODY ako partner dokladu' : undefined}
              srcClass={srcCls(pole('nazov'))} onCommit={(raw) => updateStranu('nazov', raw)}
            />
            {srcLabel(pole('adresa'), 'Ulica')}
            <DcCell value={adr.ulica ?? ''} placeholder="Ulica a číslo" disabled={readOnly} srcClass={srcCls(pole('adresa'))} onCommit={(raw) => updateStranuAdresu({ ulica: raw })} />
            {/* PSČ, obec a krajina na jednom riadku ako v POHODE — karta by inak
                prerástla susednú „Základné informácie" o tri riadky. */}
            {srcLabel(pole('adresa'), 'PSČ, Obec, krajina')}
            <div className="dk-addrline">
              <DcCell value={adr.psc ?? ''} placeholder="PSČ" disabled={readOnly} title="PSČ" srcClass={srcCls(pole('adresa'))} onCommit={(raw) => updateStranuAdresu({ psc: raw })} />
              <DcCell value={adr.obec ?? ''} placeholder="Obec" disabled={readOnly} title="Obec" srcClass={srcCls(pole('adresa'))} onCommit={(raw) => updateStranuAdresu({ obec: raw })} />
              <DcCell value={adr.krajina ?? ''} placeholder="SK" disabled={readOnly} title="Kód krajiny pre číselník POHODY (SK, CZ, IE…)" onCommit={(raw) => updateStranuAdresu({ krajina: raw })} />
            </div>
          </div>
          {/* Vystavovateľ vydanej faktúry je vlastná firma — do POHODY ako partner
              nejde, ostáva len na kontrolu, či AI prečítala správnu stranu. */}
          {vydana && (
            <div className="dk-vystavovatel" title="Vydanú faktúru vystavila vaša firma; partnerom dokladu je odberateľ">
              Fakturuje <strong>{dod.nazov || '—'}</strong>{dod.ico ? ` · IČO ${dod.ico}` : ''}
            </div>
          )}
          <div className="dk-sep" />
          <div className="dk-grid dk-grid-pair">
            {srcLabel('variabilnySymbol', 'Pár. symbol')}
            <DcCell value={ex.variabilnySymbol ?? ''} disabled={readOnly} srcClass={srcCls('variabilnySymbol')} onCommit={(raw) => updateExtracted('variabilnySymbol', raw || undefined)} />
            {srcLabel('mena', 'Mena')}
            <DcPick value={ex.mena} options={menaOpts} disabled={readOnly} srcClass={srcCls('mena')} onChange={(value) => updateExtracted('mena', value as DocumentExtractedData['mena'])} />
            {/* Stredisko stojí tu, nie v Základných informáciách: tá karta je
                vyššia a o výške dvojice rozhoduje práve tá vyššia z nich. */}
            <span className="dk-lbl">Stredisko</span>
            <DcPick value={ucto.strediskoId} options={[{ value: '', label: '—' }, ...toOpts(codeLists.strediska)]} disabled={readOnly} onMostikSync={syncMostik} onChange={(value) => updateUcto({ strediskoId: value || undefined })} />
            <span /><span />
          </div>
          {!jePokladna && (
            <div className="dk-grid dk-grid-sup" style={{ marginTop: 3 }}>
              {/* Vydaná faktúra je pohľadávka: POHODA na nej nemá IBAN dodávateľa,
                  ale formu úhrady a účet, na ktorý má zaplatiť zákazník. */}
              {vydana ? (
                <>
                  <span className="dk-lbl">Forma úhrady</span>
                  <DcPick
                    value={ucto.formaUhrady ?? 'draft'} disabled={readOnly}
                    options={FORMY_UHRADY.map((forma) => ({ value: forma.kod, label: forma.nazov }))}
                    onChange={(value) => updateUcto({ formaUhrady: value as DocumentUcto['formaUhrady'] })}
                  />
                  <span className="dk-lbl">Účet</span>
                  <DcPick
                    value={ucto.bankUcetKod} disabled={readOnly} onMostikSync={syncMostik} placeholder="—"
                    title="Účet, na ktorý má zákazník zaplatiť (číselník Bankové účty)"
                    options={(codeLists.bankoveUcty ?? []).map((item) => ({
                      value: item.kod,
                      label: `${item.kod} · ${item.nazov}`,
                      title: item.iban ? `IBAN ${item.iban}` : item.nazov,
                    }))}
                    onChange={(value) => updateUcto({ bankUcetKod: value || undefined })}
                  />
                </>
              ) : (
                <>
                  {srcLabel('dodavatel.iban', 'IBAN')}
                  <DcCell value={dod.iban ?? ''} disabled={readOnly} srcClass={srcCls('dodavatel.iban')} onCommit={(raw) => updateParty('dodavatel', 'iban', raw)} />
                </>
              )}
              {srcLabel('konstantnySymbol', 'Konšt. symbol')}
              <DcCell value={ex.konstantnySymbol ?? ''} disabled={readOnly} srcClass={srcCls('konstantnySymbol')} onCommit={(raw) => updateExtracted('konstantnySymbol', raw || undefined)} />
            </div>
          )}
        </div>
      </div>

      {/* Text dokladu — ide do POHODY ako text zápisu, poznámka ako <note>. */}
      <div className="dk-card">
        <div className="dk-card-title">Text dokladu</div>
        <DcCell
          value={ex.textPolozky ?? ''} disabled={readOnly}
          placeholder="Popis plnenia, ktorý uvidíš v POHODE…"
          onCommit={(raw) => updateExtracted('textPolozky', raw || undefined)}
        />
        <div className="dk-grid dk-grid-pair" style={{ marginTop: 6 }}>
          <span className="dk-lbl">Poznámka</span>
          <DcCell
            value={ucto.poznamka ?? ''} disabled={readOnly} placeholder="Interná poznámka…"
            onCommit={(raw) => updateUcto({ poznamka: raw || undefined })}
          />
          <span className="dk-lbl">Interné číslo</span>
          <DcCell
            value={ex.interneCislo ?? ''} disabled={readOnly} placeholder="napr. INT-2026-014"
            onCommit={(raw) => updateExtracted('interneCislo', raw || undefined)}
          />
        </div>
      </div>

      <ItemsSection
        polozky={polozky}
        rozpisDph={rozpis}
        mena={ex.mena}
        readOnly={readOnly}
        enabled={itemsOn}
        onToggle={toggleItems}
        codeLists={itemsCodeLists}
        headerUcto={{
          predkontacia: codeLists.predkontacie.find((item) => item.id === ucto.predkontaciaId)?.kod,
          clenenieDph: codeLists.cleneniaDph.find((item) => item.id === ucto.clenenieDphId)?.kod,
          clenenieKv: ucto.clenenieKvKod,
          stredisko: codeLists.strediska.find((item) => item.id === ucto.strediskoId)?.kod,
          cinnost: codeLists.cinnosti.find((item) => item.id === ucto.cinnostId)?.kod,
          zakazka: codeLists.zakazky.find((item) => item.id === ucto.zakazkaId)?.kod,
        }}
        onChange={setPolozky}
        onSplit={readOnly ? undefined : onSplit}
        srcSection={srcOn && src?.[ITEMS_PATH] ? 5 : undefined}
        onHoverSrc={onHoverSrc}
      />

      <div className="dk-two">
        {/* Rozpis DPH */}
        <div className="dk-card">
          <div className="dk-card-title" style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <span>Rozpis DPH</span>
            {secChip(3)}
            <span className={`dk-tag${itemsOn ? '' : ' dk-tag-warn'}`}>{itemsOn ? 'počíta sa z položiek' : 'upravuje sa ručne'}</span>
          </div>
          <div className="dk-vat dk-vat-head">
            <span>Sadzba</span><span className="dk-r">Základ</span><span className="dk-r">DPH</span><span className="dk-r">Spolu</span><span />
          </div>
          {rozpis.map((row, index) => (
            <div className="dk-vat dk-vat-row" key={`${row.sadzba}-${index}`}>
              {itemsOn ? (
                <>
                  <span>{row.sadzba} %</span>
                  <span className="dk-r">{fmtMoney(row.zaklad || 0, ex.mena)}</span>
                  <span className="dk-r">{fmtMoney(row.dph || 0, ex.mena)}</span>
                  <span className="dk-r">{fmtMoney((row.zaklad || 0) + (row.dph || 0), ex.mena)}</span>
                  <span />
                </>
              ) : (
                <>
                  <DcPick value={String(row.sadzba)} options={rateOpts} disabled={readOnly} onChange={(value) => setVatRow(index, { sadzba: Number(value) as VatRate })} />
                  {money(row.zaklad, (raw) => setVatRow(index, { zaklad: parseNum(raw) }))}
                  {money(row.dph, (raw) => setVatRow(index, { dph: parseNum(raw) }))}
                  <span className="dk-r">{fmtMoney((row.zaklad || 0) + (row.dph || 0), ex.mena)}</span>
                  <button type="button" className="dk-vat-del" title="Odstrániť sadzbu" disabled={readOnly || rozpis.length <= 1} onClick={() => removeVatRow(index)}>×</button>
                </>
              )}
            </div>
          ))}
          {!itemsOn && (
            <button type="button" className="dk-add" disabled={readOnly} onClick={addVatRow}>
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round"><path d="M12 5v14M5 12h14" /></svg>
              Pridať sadzbu
            </button>
          )}
          <div className="dk-vat dk-vat-total">
            <span>Celkom</span>
            <span className="dk-r">{fmtMoney(totalZaklad, ex.mena)}</span>
            <span className="dk-r">{fmtMoney(totalDph, ex.mena)}</span>
            <span className="dk-r">{fmtMoney(rozpisSpolu, ex.mena)}</span>
            <span />
          </div>
        </div>

        {/* Platba a zaokrúhlenie */}
        <div className="dk-card">
          <div className="dk-card-title">Platba a zaokrúhlenie</div>
          <div className="dk-grid dk-grid-pay">
            {srcLabel('sumaSpolu', jePokladna ? 'Uhradená suma' : 'Celková suma')}
            {money(ex.sumaSpolu, (raw) => updateExtracted('sumaSpolu', parseNum(raw)), 'sumaSpolu')}
            {/* Kým rozpis DPH nemá sumy, nie je od čoho zaokrúhľovať: riadok by
                ukazoval celú sumu dokladu ako „zaokrúhlenie" a jeho úprava by
                celkovú sumu dokladu prepísala natvrdo. Kontroluje sa súčet, nie
                počet riadkov — prázdny riadok 0/0 je rovnako bezcenný. */}
            {rozpisSpolu !== 0 && (
              <>
                <span className="dk-lbl" title="Rozdiel medzi rozpisom DPH a celkovou sumou dokladu">Zaokrúhlenie</span>
                <div className="dk-r">
                  <DcCell
                    align="right" inputMode="decimal" disabled={readOnly}
                    value={String(zaokruhlenie)}
                    display={fmtMoney(zaokruhlenie, ex.mena)}
                    onCommit={(raw) => updateExtracted('sumaSpolu', round2(rozpisSpolu + (parseOpt(raw) ?? 0)))}
                  />
                </div>
              </>
            )}
          </div>
          <div className="dk-sep" />
          <div className="dk-pay-total">
            <span>Zaplatiť celkom</span>
            <span>{fmtMoney(sumaSpolu, ex.mena)}</span>
          </div>
          {(autoFilled || aiApplied) && (
            <div className="dk-note" style={{ display: 'flex', alignItems: 'center', gap: 6, color: '#0A6650' }}>
              <IcoCheck s={12} w={2.6} />
              {/* Zdroj sa nesmie zamlčať: „z pamäte" tu svietilo aj nad
                  návrhom modelu, takže účtovník nevedel, či číslo pochádza
                  z jeho vlastnej histórie, alebo si ho AI odvodila. */}
              Zaúčtované — {SOURCE_LABEL[suggestion?.source ?? 'none'] ?? suggestion?.source}
              {predkConfidence != null ? ` · istota ${predkConfidence} %` : ''}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

// Panel úpravy faktúry — dizajn 1b (karty) z Claude Design, napojený na reálne
// dáta dokladu (draft.extracted + draft.ucto + číselníky + návrh AI). Sekcie:
// Základné údaje · Čiastka a DPH · Dodávateľ · Platobné údaje.
import { useEffect, useState, type ReactNode } from 'react';
import type { AccountingSuggestion, CodeListItem, DocumentExtractedData, DocumentItem, DocumentPreco, DocumentType, DocumentUcto } from '../../data/types';
import { CLENENIE_KV_KODY } from '../../data/types';
import { getDocumentPreco, getPrecoVysvetlenie, saveRuleDovod, type PrecoVysvetlenie } from '../../data/api';
import { requestMostikCodeListSync } from '../../data/mostik/mostikService';
import { showToast } from '../../components/toast';
import { DcDropdown, type DcOption } from './DcDropdown';
import { ItemsSection } from './ItemsSection';
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
  codeLists: {
    predkontacie: CodeListItem[];
    cleneniaDph: CodeListItem[];
    ciselneRady: CodeListItem[];
    strediska: CodeListItem[];
  };
  suggestion?: AccountingSuggestion;
  autoFilled: boolean;
  /** Zvýraznenie zdroja údajov — mapa polí, ktoré vyplnila AI. */
  src?: SourceMap;
  srcEdited?: ReadonlySet<string>;
  srcOn?: boolean;
  /** Práve zvýraznené pole (`cesta`) alebo celá sekcia (`sec:N`). */
  activeSrc?: string;
  onHoverSrc?: (anchor?: string) => void;
  setTyp: (typ: DocumentType) => void;
  updateUcto: (patch: Partial<DocumentUcto>) => void;
  updateExtracted: <K extends keyof DocumentExtractedData>(key: K, value: DocumentExtractedData[K]) => void;
  updateSupplier: (key: keyof DocumentExtractedData['dodavatel'], value: string) => void;
}

const round2 = (n: number) => Math.round((n + Number.EPSILON) * 100) / 100;
const parseNum = (v: string) => { const n = Number(v.replace(',', '.')); return Number.isFinite(n) ? n : 0; };

// Farba syntetického účtu (badge na karte predkontácie) podľa prvej triedy účtu.
const SYNT_COLOR: Record<string, string> = { '501': '#B45309', '502': '#0369A1', '504': '#7C3AED', '511': '#4338CA', '518': '#0E7A5F', '343': '#0369A1' };
function syntOf(kod: string): string { const m = kod.match(/(\d{3})/); return m ? m[1] : kod.slice(0, 3).toUpperCase(); }
function syntColor(synt: string): string { return SYNT_COLOR[synt] ?? '#5C645F'; }

const TYP_META: Record<DocumentType, { label: string; color: string }> = {
  FP: { label: 'Prijatá faktúra', color: '#0E7A5F' },
  FV: { label: 'Vystavená faktúra', color: '#0369A1' },
  OZ: { label: 'Ostatný záväzok', color: '#B45309' },
  PD: { label: 'Pokladničný doklad', color: '#4338CA' },
  BV: { label: 'Bankový výpis', color: '#7C3AED' },
  MZDY: { label: 'Mzdy', color: '#166534' },
};
const KV_LABEL: Record<string, string> = {
  A1: 'A1 – Dodanie tovaru a služby', A2: 'A2 – Samozdanenie príjemcom',
  B1: 'B1 – Prenesenie daňovej povinnosti', B2: 'B2 – Prijaté faktúry s odpočtom',
  B3: 'B3 – Zjednodušené faktúry', C1: 'C1 – Opravy odpočítanej dane',
  C2: 'C2 – Opravy základu dane', D1: 'D1 – Obrat cez ERP', D2: 'D2 – Ostatné plnenia',
  KN: 'KN – Nezahŕňať do KV',
};

const CaretIcon = () => (
  <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M6 9l6 6 6-6" /></svg>
);
const AiIcon = () => (
  <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor"><path d="M12 2l1.7 5.6L19.4 9l-5.7 1.4L12 16l-1.7-5.6L4.6 9l5.7-1.4z" /><path d="M19 13.5l.9 2.9 2.9.9-2.9.9-.9 2.9-.9-2.9-2.9-.9 2.9-.9z" /></svg>
);

// Ikony panelu „Prečo?" podľa makety — malé, dedia currentColor.
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
 * zastaví na 95 %, aby nikdy netvrdila „hotovo" pred odpoveďou. Po dorazení
 * odpovede sa komponent odmontuje a pruh zmizne.
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

const IcoPencil = () => (
  <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round"><path d="M12 20h9" /><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z" /></svg>
);

/** Pod touto istotou pole dostane prerušovaný rám a odznak s percentom. */
const LOW_CONFIDENCE = 0.5;

export function InvoicePanel({
  draft, readOnly, codeLists, suggestion, autoFilled,
  src, srcEdited, srcOn, activeSrc, onHoverSrc,
  setTyp, updateUcto, updateExtracted, updateSupplier,
}: InvoicePanelProps) {
  const [rozOpen, setRozOpen] = useState(false);
  const [rozDodOpen, setRozDodOpen] = useState(false);
  const [fyzickaOsoba, setFyzickaOsoba] = useState(false);
  const [aiApplied, setAiApplied] = useState(false);

  // „Prečo?" — jeden zdieľaný stav: dáta sa načítajú raz na doklad, panel sa
  // otvára pod polom, na ktorom bol klik.
  const [precoOpen, setPrecoOpen] = useState<PrecoField | null>(null);
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

  // Hlavička panelu je rovnaká vo všetkých stavoch (maketa „Prečo - redesign").
  const precoHead = (chip?: ReactNode) => (
    <div className="dv-preco-head">
      <span className="dv-preco-head-label">Pôvod zaúčtovania</span>
      {chip}
    </div>
  );

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

  // Zámerne span, nie <button>: InvoicePanel býva vnútri <fieldset disabled>
  // (readOnly pre schvaľovateľa/exportované doklady) a disabled fieldset by
  // form control umŕtvil — pritom čítanie pôvodu má fungovať aj read-only.
  const precoWrap = (field: PrecoField, dropdown: ReactNode) => (
    <div className="dv-preco-field">
      {dropdown}
      <span
        role="button" tabIndex={0}
        className={`dv-preco-btn${precoOpen === field ? ' dv-open' : ''}`}
        onClick={() => togglePreco(field)}
        onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); togglePreco(field); } }}
      >
        <IcoQuestion />
        Prečo?
      </span>
      {precoOpen === field && renderPreco(field)}
    </div>
  );

  // ---- Zvýraznenie zdroja údajov -------------------------------------------
  // Farba = sekcia, v ktorej pole žije; ten istý odtieň má obdĺžnik nad zdrojom
  // v náhľade dokladu. Keď je prepínač vypnutý, všetky pomocníky vrátia prázdno
  // a panel vyzerá presne ako predtým.
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
  const srcChip = (path: string) => {
    const field = srcField(path);
    return field && !isEdited(path) ? <span className="dv-src-chip">{field.section}</span> : null;
  };
  const srcLabel = (path: string, text: string) => {
    const field = srcField(path);
    return (
      <>
        {srcChip(path)}
        {text}
        {isLow(path) && field?.confidence !== undefined && (
          <span className="dv-src-warn"><IcoWarn s={10} />{Math.round(field.confidence * 100)} %</span>
        )}
      </>
    );
  };
  /** Pod poľom: buď plaketa „Upravené", alebo citát z dokladu pri nízkej istote. */
  const srcFoot = (path: string) => {
    const field = srcField(path);
    if (!field) return null;
    if (isEdited(path)) return <span className="dv-src-upravene"><IcoPencil />Upravené</span>;
    if (isLow(path) && field.quote) return <div className="dv-src-note">Zdroj hodnoty: „{field.quote}"</div>;
    return null;
  };
  const secCls = (section: number) => (srcOn && src && Object.values(src).some((field) => field.section === section)
    ? ` dv-src-sec dv-src-${section}` : '');
  const secChip = (section: number) => (secCls(section) ? <span className="dv-src-chip">{section}</span> : null);
  const secHover = (section: number) => (secCls(section)
    ? { onMouseEnter: () => onHoverSrc?.(`sec:${section}`), onMouseLeave: () => onHoverSrc?.(undefined) }
    : {});

  const ex = draft.extracted;
  const dod = ex.dodavatel;
  const ucto = draft.ucto;
  const typDokladu = TYP_META[draft.typ]?.label ?? 'Faktúra';

  // „Synchronizovať mostíkom" v pätičke číselníkových dropdownov — agent stiahne
  // číselníky z POHODY do ~1 minúty, zoznam sa obnoví sám (snapshot poller).
  const syncMostik = readOnly ? undefined : () => {
    requestMostikCodeListSync(draft.orgId)
      .then(() => showToast('Synchronizácia číselníkov cez Mostík je vyžiadaná — zoznam sa obnoví do minúty.'))
      .catch((cause: unknown) => showToast(cause instanceof Error && cause.message ? cause.message : 'Synchronizáciu sa nepodarilo vyžiadať.', { tone: 'error' }));
  };

  const toOpts = (items: CodeListItem[]): DcOption[] =>
    items.map((item) => ({ value: item.id, label: `${item.kod} · ${item.nazov}`, title: `${item.kod} · ${item.nazov}` }));

  const predkOpts: DcOption[] = codeLists.predkontacie.map((item) => {
    const synt = syntOf(item.kod);
    return { value: item.id, title: item.nazov || item.kod, label: item.nazov || item.kod, synt, predk: item.kod, agenda: 'Faktúry', typDokladu, color: syntColor(synt) };
  });
  const typOpts: DcOption[] = (Object.keys(TYP_META) as DocumentType[]).map((t) => ({ value: t, label: TYP_META[t].label, badge: t, color: TYP_META[t].color }));
  const kvOpts: DcOption[] = CLENENIE_KV_KODY.map((kod) => ({ value: kod, label: KV_LABEL[kod] ?? kod, title: KV_LABEL[kod] ?? kod }));
  const menaOpts: DcOption[] = [
    { value: 'EUR', label: 'EUR – Euro' }, { value: 'CZK', label: 'CZK – Česká koruna' }, { value: 'USD', label: 'USD – Americký dolár' },
  ];

  // Rozpis DPH po sadzbách (23/19/5/0) — mapované na pole rozpisDph.
  const rowFor = (rate: number) => ex.rozpisDph.find((r) => r.sadzba === rate);
  const setVat = (rate: number, patch: { zaklad?: number; dph?: number }) => {
    const idx = ex.rozpisDph.findIndex((r) => r.sadzba === rate);
    const next = idx >= 0
      ? ex.rozpisDph.map((r, i) => (i === idx ? { ...r, ...patch } : r))
      : [...ex.rozpisDph, { sadzba: rate, zaklad: 0, dph: 0, ...patch }];
    updateExtracted('rozpisDph', next);
  };

  const base = ex.rozpisDph.reduce((s, r) => s + (r.zaklad || 0), 0);
  const dan = ex.rozpisDph.reduce((s, r) => s + (r.dph || 0), 0);
  const expected = round2(base + dan);
  const total = ex.sumaSpolu || 0;
  const dphValid = Math.abs(expected - total) < 0.005 && total > 0;
  // Bez DPH = celková suma mínus daň z rozpisu. Keď rozpis chýba (nulová daň),
  // vyjde rovnaká suma ako s DPH — čo je pri neplatiteľovi správne.
  const sumaBezDph = round2(total - dan);
  const cisloErr = !String(ex.cisloFaktury || '').trim();
  const icoErr = !fyzickaOsoba && Boolean(dod.ico) && !/^\d{8}$/.test(String(dod.ico || '').trim());

  const predkConfidence = suggestion && suggestion.source !== 'none' && suggestion.predkontaciaId && suggestion.predkontaciaId === ucto.predkontaciaId
    ? Math.round(suggestion.confidence * 100) : undefined;
  const canAi = !readOnly && suggestion != null && suggestion.source !== 'none' && Boolean(suggestion.predkontaciaId);
  const applyAi = () => {
    if (!suggestion) return;
    updateUcto({
      predkontaciaId: suggestion.predkontaciaId,
      clenenieDphId: suggestion.clenenieDphId,
      ciselnyRadId: suggestion.ciselnyRadId,
      strediskoId: suggestion.strediskoId,
      clenenieKvKod: suggestion.clenenieKvKod,
    });
    setAiApplied(true);
  };

  const numField = (label: string, value: number | undefined, onChange: (n: number) => void, dim?: boolean) => (
    <div className="dv-field">
      <label className="dv-label">{label}</label>
      <input className={`dv-input${dim ? ' dv-dim' : ''}`} value={value === undefined ? '' : String(value)} disabled={readOnly}
        onChange={(e) => onChange(parseNum(e.target.value))} inputMode="decimal" />
    </div>
  );

  return (
    <div className="dv-panel">
      <div className="dv-body">

        {/* Základné údaje */}
        <section className="dv-section">
          <div className="dv-h3-row">
            <div className={`dv-h3-left${secCls(1)}`} {...secHover(1)}><span className="dv-accent-bar" /><h3 className="dv-h3">Základné údaje</h3>{secChip(1)}</div>
            {/* Automatické zaúčtovanie patrí k poliam, ktoré vypĺňa — dole pod
                položkami sa naň muselo skrolovať. */}
            <button type="button" className="dv-btn-ai dv-btn-ai-inline" disabled={!canAi} onClick={applyAi}>
              <AiIcon />
              Použiť automatické účtovanie
            </button>
          </div>
          {/* Dva stĺpce: vľavo identifikácia dokladu a dátumy, vpravo zaúčtovanie
              a suma. Všetko podstatné je na jednej obrazovke bez skrolovania. */}
          <div className="dv-cols">
            <div className="dv-fields">
              <DcDropdown label="Typ faktúry" mode="simple" value={draft.typ} options={typOpts} disabled={readOnly} onChange={(v) => setTyp(v as DocumentType)} />
              <DcDropdown label="Číselný rad / Pokladňa" mode="simple" searchable onMostikSync={syncMostik} value={ucto.ciselnyRadId} options={toOpts(codeLists.ciselneRady)} disabled={readOnly} onChange={(v) => updateUcto({ ciselnyRadId: v })} />
              <div className={`dv-field${cisloErr ? ' dv-field-err' : ''}${srcCls('cisloFaktury')}`} {...srcHover('cisloFaktury')}>
                <label className="dv-label">{srcLabel('cisloFaktury', 'Číslo faktúry')}</label>
                <input className="dv-input dv-has-icon" value={ex.cisloFaktury ?? ''} disabled={readOnly} onChange={(e) => updateExtracted('cisloFaktury', e.target.value)} />
                <svg className="dv-field-icon" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="M4 9h16M4 15h16M10 3L8 21M16 3l-2 18" /></svg>
                {cisloErr && <div className="dv-err-msg">Zadajte číslo faktúry</div>}
                {srcFoot('cisloFaktury')}
              </div>
              <div className={`dv-field${srcCls('datumVystavenia')}`} {...srcHover('datumVystavenia')}>
                <label className="dv-label">{srcLabel('datumVystavenia', 'Dátum vydania')}</label>
                <input type="date" className="dv-input" value={ex.datumVystavenia ?? ''} disabled={readOnly} onChange={(e) => updateExtracted('datumVystavenia', e.target.value)} />
                {srcFoot('datumVystavenia')}
              </div>
              <div className={`dv-field${srcCls('datumDodania')}`} {...srcHover('datumDodania')}>
                <label className="dv-label">{srcLabel('datumDodania', 'Dátum dodania (DUZP)')}</label>
                <input type="date" className="dv-input" value={ex.datumDodania ?? ''} disabled={readOnly} onChange={(e) => updateExtracted('datumDodania', e.target.value || undefined)} />
                {srcFoot('datumDodania')}
              </div>
              <div className={`dv-field${srcCls('datumSplatnosti')}`} {...srcHover('datumSplatnosti')}>
                <label className="dv-label">{srcLabel('datumSplatnosti', 'Dátum splatnosti')}</label>
                <input type="date" className="dv-input" value={ex.datumSplatnosti ?? ''} disabled={readOnly} onChange={(e) => updateExtracted('datumSplatnosti', e.target.value || undefined)} />
                {srcFoot('datumSplatnosti')}
              </div>
            </div>

            <div className="dv-fields">
              {precoWrap('predkontacia',
                <DcDropdown label="Účtovná položka" mode="account" searchable confidence={predkConfidence} onMostikSync={syncMostik} value={ucto.predkontaciaId} options={predkOpts} disabled={readOnly} onChange={(v) => updateUcto({ predkontaciaId: v })} />)}
              {precoWrap('dph',
                <DcDropdown label="Členenie DPH" mode="simple" searchable onMostikSync={syncMostik} value={ucto.clenenieDphId} options={toOpts(codeLists.cleneniaDph)} disabled={readOnly}
                  onChange={(v) => {
                    const picked = codeLists.cleneniaDph.find((item) => item.id === v);
                    updateUcto({ clenenieDphId: v, ...(picked?.kvSekcia && !ucto.clenenieKvKod ? { clenenieKvKod: picked.kvSekcia } : {}) });
                  }} />)}
              {precoWrap('kv',
                <DcDropdown label="Členenie kontrolný výkaz" mode="simple" searchable value={ucto.clenenieKvKod} options={kvOpts} disabled={readOnly} onChange={(v) => updateUcto({ clenenieKvKod: v })} />)}
              {/* Základ dane sa nezadáva — dopočíta sa z rozpisu DPH, takže sa
                  nedá omylom rozísť s celkovou sumou. */}
              <div className="dv-field">
                <label className="dv-label">Celková suma bez DPH</label>
                <span className="dv-money-sign">€</span>
                <input className="dv-input dv-money dv-dim" value={sumaBezDph.toFixed(2)} readOnly tabIndex={-1} />
              </div>
              <div className={`dv-field${dphValid ? '' : ' dv-field-err'}${srcCls('sumaSpolu')}`} {...srcHover('sumaSpolu')}>
                <label className="dv-label">{srcLabel('sumaSpolu', 'Celková suma s DPH')}</label>
                <span className="dv-money-sign">€</span>
                <input className="dv-input dv-money" value={ex.sumaSpolu === undefined ? '' : String(ex.sumaSpolu)} disabled={readOnly} inputMode="decimal" onChange={(e) => updateExtracted('sumaSpolu', parseNum(e.target.value))} />
                {srcFoot('sumaSpolu')}
              </div>
              <div className={`dv-field${srcCls('dodavatel.nazov')}`} {...srcHover('dodavatel.nazov')}>
                <label className="dv-label">{srcLabel('dodavatel.nazov', 'Názov spoločnosti')}</label>
                <input className="dv-input" value={dod.nazov ?? ''} disabled={readOnly} onChange={(e) => updateSupplier('nazov', e.target.value)} />
                {srcFoot('dodavatel.nazov')}
              </div>
            </div>
          </div>

          <div className="dv-fields" style={{ marginTop: 18 }}>
            <div className={`dv-expand${rozOpen ? ' dv-open' : ''}`}>
              <div className="dv-expand-inner">
                <DcDropdown label="Nákladové stredisko" mode="simple" searchable onMostikSync={syncMostik} value={ucto.strediskoId} options={toOpts(codeLists.strediska)} disabled={readOnly} onChange={(v) => updateUcto({ strediskoId: v })} />
                <div className="dv-field">
                  <label className="dv-label">Interné číslo</label>
                  <input className="dv-input" value={ex.interneCislo ?? ''} disabled={readOnly} onChange={(e) => updateExtracted('interneCislo', e.target.value || undefined)} placeholder="napr. INT-2026-014" />
                </div>
                <div className="dv-field">
                  <label className="dv-label">Poznámka</label>
                  <textarea className="dv-textarea" value={ucto.poznamka ?? ''} disabled={readOnly} onChange={(e) => updateUcto({ poznamka: e.target.value || undefined })} placeholder="Interná poznámka k dokladu…" />
                </div>
              </div>
            </div>
            <button type="button" className="dv-toggle" onClick={() => setRozOpen((o) => !o)}>
              Rozšírené položky <span className={`dv-caret${rozOpen ? ' dv-up' : ''}`}><CaretIcon /></span>
            </button>
          </div>
        </section>

        <div className="dv-divider" />

        {/* Dodávateľ */}
        <section className="dv-section">
          <div className="dv-h3-row"><div className={`dv-h3-left${secCls(2)}`} {...secHover(2)}><span className="dv-accent-bar" /><h3 className="dv-h3">Dodávateľ</h3>{secChip(2)}</div></div>
          <div className="dv-fields">
            <label className="dv-check">
              <input type="checkbox" checked={fyzickaOsoba} disabled={readOnly} onChange={(e) => setFyzickaOsoba(e.target.checked)} />
              <span>Fyzická osoba nepodnikateľ</span>
            </label>
            {/* Názov spoločnosti je hore v Základných údajoch — tu už len IČO
                a daňové identifikátory, nech sa pole needituje na dvoch miestach. */}
            <div className={`dv-field${icoErr ? ' dv-field-warn' : ''}${srcCls('dodavatel.ico')}`} {...srcHover('dodavatel.ico')}>
              <label className="dv-label">{srcLabel('dodavatel.ico', 'IČO')}</label>
              <input className="dv-input" value={dod.ico ?? ''} disabled={readOnly} onChange={(e) => updateSupplier('ico', e.target.value)} />
              {icoErr && <div className="dv-warn-msg">IČO má mať 8 číslic</div>}
              {srcFoot('dodavatel.ico')}
            </div>
            <div className={`dv-field${srcCls('dodavatel.icDph')}`} {...srcHover('dodavatel.icDph')}>
              <label className="dv-label">{srcLabel('dodavatel.icDph', 'IČ DPH (voliteľné)')}</label>
              <input className="dv-input" style={{ paddingRight: 78 }} value={dod.icDph ?? ''} disabled={readOnly} onChange={(e) => updateSupplier('icDph', e.target.value)} />
              {Boolean(dod.icDph) && (
                <span className="dv-vies"><svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round"><path d="M20 6L9 17l-5-5" /></svg>VIES</span>
              )}
            </div>
            <div className={`dv-expand${rozDodOpen ? ' dv-open' : ''}`}>
              <div className="dv-expand-inner">
                <div className={`dv-field${srcCls('dodavatel.dic')}`} {...srcHover('dodavatel.dic')}>
                  <label className="dv-label">{srcLabel('dodavatel.dic', 'DIČ')}</label>
                  <input className="dv-input" value={dod.dic ?? ''} disabled={readOnly} onChange={(e) => updateSupplier('dic', e.target.value)} />
                  {srcFoot('dodavatel.dic')}
                </div>
                <div className={`dv-field${srcCls('dodavatel.adresa')}`} {...srcHover('dodavatel.adresa')}>
                  <label className="dv-label">{srcLabel('dodavatel.adresa', 'Adresa')}</label>
                  <input className="dv-input" value={dod.adresa ?? ''} disabled={readOnly} onChange={(e) => updateSupplier('adresa', e.target.value)} />
                  {srcFoot('dodavatel.adresa')}
                </div>
              </div>
            </div>
            <button type="button" className="dv-toggle" onClick={() => setRozDodOpen((o) => !o)}>
              Rozšírené položky <span className={`dv-caret${rozDodOpen ? ' dv-up' : ''}`}><CaretIcon /></span>
            </button>
          </div>
        </section>

        <div className="dv-divider" />

        {/* Čiastka a DPH */}
        <section className="dv-section">
          <div className="dv-h3-row">
            <div className={`dv-h3-left${secCls(3)}`} {...secHover(3)}><span className="dv-accent-bar" /><h3 className="dv-h3">Čiastka a DPH</h3>{secChip(3)}</div>
            {dphValid
              ? <span className="dv-dph-ok"><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round"><path d="M20 6L9 17l-5-5" /></svg></span>
              : <span className="dv-dph-warn"><svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round"><path d="M12 9v4M12 17h.01" /><path d="M10.3 3.9L2 18a2 2 0 0 0 1.7 3h16.6A2 2 0 0 0 22 18L13.7 3.9a2 2 0 0 0-3.4 0z" /></svg></span>}
          </div>
          {/* Celková suma je hore v Základných údajoch — tu ostáva len rozpis. */}
          <div className="dv-grid-2">
            {/* Rozpis DPH po sadzbách sa nezvýrazňuje — evidencia AI ho vracia po
                riadkoch bez väzby na konkrétne pole; sekciu nesie Mena. */}
            <div className={srcCls('mena').trimStart()} {...srcHover('mena')}>
              <DcDropdown label="Mena" chip={srcChip('mena')} mode="simple" value={ex.mena} options={menaOpts} disabled={readOnly} onChange={(v) => updateExtracted('mena', v as DocumentExtractedData['mena'])} />
            </div>
            <div />

            {numField('Základ dane 23 %', rowFor(23)?.zaklad, (n) => setVat(23, { zaklad: n }))}
            {numField('Daň 23 %', rowFor(23)?.dph, (n) => setVat(23, { dph: n }))}
            {numField('Základ dane 19 %', rowFor(19)?.zaklad, (n) => setVat(19, { zaklad: n }), true)}
            {numField('Daň 19 %', rowFor(19)?.dph, (n) => setVat(19, { dph: n }), true)}
            {numField('Základ dane 5 %', rowFor(5)?.zaklad, (n) => setVat(5, { zaklad: n }), true)}
            {numField('Daň 5 %', rowFor(5)?.dph, (n) => setVat(5, { dph: n }), true)}
            {numField('Základ dane 0 %', rowFor(0)?.zaklad, (n) => setVat(0, { zaklad: n }), true)}
          </div>
          {!dphValid && (
            <div className="dv-dph-msg">
              <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink: 0, marginTop: 1 }}><circle cx="12" cy="12" r="9" /><path d="M12 8v4M12 16h.01" /></svg>
              Rozpis DPH ({expected.toFixed(2)} €) sa nezhoduje s celkovou sumou ({total.toFixed(2)} €).
            </div>
          )}
        </section>

        <div className="dv-divider" />

        {/* Platobné údaje */}
        <section className="dv-section">
          <div className="dv-h3-row"><div className={`dv-h3-left${secCls(4)}`} {...secHover(4)}><span className="dv-accent-bar" /><h3 className="dv-h3">Platobné údaje</h3>{secChip(4)}</div></div>
          <div className="dv-fields">
            <div className={`dv-field${srcCls('variabilnySymbol')}`} {...srcHover('variabilnySymbol')}>
              <label className="dv-label">{srcLabel('variabilnySymbol', 'Variabilný symbol')}</label>
              <input className="dv-input" value={ex.variabilnySymbol ?? ''} disabled={readOnly} onChange={(e) => updateExtracted('variabilnySymbol', e.target.value || undefined)} />
              {srcFoot('variabilnySymbol')}
            </div>
            <div className={`dv-field${srcCls('dodavatel.iban')}`} {...srcHover('dodavatel.iban')}>
              <label className="dv-label">{srcLabel('dodavatel.iban', 'IBAN')}</label>
              <input className="dv-input" style={{ letterSpacing: '.02em' }} value={dod.iban ?? ''} disabled={readOnly} onChange={(e) => updateSupplier('iban', e.target.value)} />
              {srcFoot('dodavatel.iban')}
            </div>
            <div className={`dv-field${srcCls('konstantnySymbol')}`} {...srcHover('konstantnySymbol')}>
              <label className="dv-label">{srcLabel('konstantnySymbol', 'Konštantný symbol')}</label>
              <input className="dv-input" value={ex.konstantnySymbol ?? ''} disabled={readOnly} onChange={(e) => updateExtracted('konstantnySymbol', e.target.value || undefined)} />
              {srcFoot('konstantnySymbol')}
            </div>
          </div>
        </section>

        <div className="dv-divider" />

        {/* Položky (rozpis na položky) — dizajn 1b */}
        <ItemsSection
          polozky={ex.polozky ?? []}
          rozpisDph={ex.rozpisDph}
          celkovaSuma={ex.sumaSpolu ?? 0}
          mena={ex.mena}
          readOnly={readOnly}
          srcSection={srcOn && src?.[ITEMS_PATH] ? 5 : undefined}
          onHoverSrc={onHoverSrc}
          codeLists={{
            predkontacie: codeLists.predkontacie,
            cleneniaDph: codeLists.cleneniaDph,
            strediska: codeLists.strediska,
          }}
          onChange={(polozky) => updateExtracted('polozky', polozky)}
        />

        {/* Akcie — „Uložiť" je len v spodnej lište detailu, nie duplicitne tu. */}
        {(autoFilled || aiApplied) && (
          <div className="dv-actions">
            <div className="dv-ai-done">
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round"><path d="M20 6L9 17l-5-5" /></svg>
              Zaúčtované z pamäte{predkConfidence != null ? ` · istota ${predkConfidence} %` : ''}
            </div>
          </div>
        )}

      </div>
    </div>
  );
}

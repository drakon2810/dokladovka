// Panel úpravy faktúry — dizajn 1b (karty) z Claude Design, napojený na reálne
// dáta dokladu (draft.extracted + draft.ucto + číselníky + návrh AI). Sekcie:
// Základné údaje · Čiastka a DPH · Dodávateľ · Platobné údaje.
import { useState } from 'react';
import type { AccountingSuggestion, CodeListItem, DocumentExtractedData, DocumentItem, DocumentType, DocumentUcto } from '../../data/types';
import { CLENENIE_KV_KODY } from '../../data/types';
import { DcDropdown, type DcOption } from './DcDropdown';
import { ItemsSection } from './ItemsSection';
import './invoicePanel.css';

interface InvoicePanelProps {
  draft: DocumentItem;
  readOnly: boolean;
  busy: boolean;
  codeLists: {
    predkontacie: CodeListItem[];
    cleneniaDph: CodeListItem[];
    ciselneRady: CodeListItem[];
    strediska: CodeListItem[];
  };
  suggestion?: AccountingSuggestion;
  autoFilled: boolean;
  setTyp: (typ: DocumentType) => void;
  updateUcto: (patch: Partial<DocumentUcto>) => void;
  updateExtracted: <K extends keyof DocumentExtractedData>(key: K, value: DocumentExtractedData[K]) => void;
  updateSupplier: (key: keyof DocumentExtractedData['dodavatel'], value: string) => void;
  onSave: () => void;
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
const CalIcon = () => (
  <svg className="dv-field-icon" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><rect x="3" y="4" width="18" height="18" rx="3" /><path d="M16 2v4M8 2v4M3 10h18" /></svg>
);

export function InvoicePanel({
  draft, readOnly, busy, codeLists, suggestion, autoFilled,
  setTyp, updateUcto, updateExtracted, updateSupplier, onSave,
}: InvoicePanelProps) {
  const [rozOpen, setRozOpen] = useState(false);
  const [rozDodOpen, setRozDodOpen] = useState(false);
  const [fyzickaOsoba, setFyzickaOsoba] = useState(false);
  const [aiApplied, setAiApplied] = useState(false);

  const ex = draft.extracted;
  const dod = ex.dodavatel;
  const ucto = draft.ucto;
  const typDokladu = TYP_META[draft.typ]?.label ?? 'Faktúra';

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
          <div className="dv-h3-row"><div className="dv-h3-left"><span className="dv-accent-bar" /><h3 className="dv-h3">Základné údaje</h3></div></div>
          <div className="dv-fields">
            <DcDropdown label="Typ faktúry" mode="simple" value={draft.typ} options={typOpts} disabled={readOnly} onChange={(v) => setTyp(v as DocumentType)} />
            <DcDropdown label="Účtovná položka" mode="account" searchable confidence={predkConfidence} value={ucto.predkontaciaId} options={predkOpts} disabled={readOnly} onChange={(v) => updateUcto({ predkontaciaId: v })} />
            <DcDropdown label="Číselný rad / Pokladňa" mode="simple" searchable value={ucto.ciselnyRadId} options={toOpts(codeLists.ciselneRady)} disabled={readOnly} onChange={(v) => updateUcto({ ciselnyRadId: v })} />
            <DcDropdown label="Nákladové stredisko" mode="simple" searchable value={ucto.strediskoId} options={toOpts(codeLists.strediska)} disabled={readOnly} onChange={(v) => updateUcto({ strediskoId: v })} />
            <DcDropdown label="Členenie DPH" mode="simple" searchable value={ucto.clenenieDphId} options={toOpts(codeLists.cleneniaDph)} disabled={readOnly}
              onChange={(v) => {
                const picked = codeLists.cleneniaDph.find((item) => item.id === v);
                updateUcto({ clenenieDphId: v, ...(picked?.kvSekcia && !ucto.clenenieKvKod ? { clenenieKvKod: picked.kvSekcia } : {}) });
              }} />
            <DcDropdown label="Členenie kontrolný výkaz" mode="simple" searchable value={ucto.clenenieKvKod} options={kvOpts} disabled={readOnly} onChange={(v) => updateUcto({ clenenieKvKod: v })} />

            <div className={`dv-field${cisloErr ? ' dv-field-err' : ''}`}>
              <label className="dv-label">Číslo faktúry</label>
              <input className="dv-input dv-has-icon" value={ex.cisloFaktury ?? ''} disabled={readOnly} onChange={(e) => updateExtracted('cisloFaktury', e.target.value)} />
              <svg className="dv-field-icon" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="M4 9h16M4 15h16M10 3L8 21M16 3l-2 18" /></svg>
              {cisloErr && <div className="dv-err-msg">Zadajte číslo faktúry</div>}
            </div>

            <div className="dv-grid-2">
              <div className="dv-field">
                <label className="dv-label">Dátum vydania</label>
                <input className="dv-input dv-has-icon" value={ex.datumVystavenia ?? ''} disabled={readOnly} onChange={(e) => updateExtracted('datumVystavenia', e.target.value)} placeholder="RRRR-MM-DD" />
                <CalIcon />
              </div>
              <div className="dv-field">
                <label className="dv-label">Dátum splatnosti</label>
                <input className="dv-input dv-has-icon" value={ex.datumSplatnosti ?? ''} disabled={readOnly} onChange={(e) => updateExtracted('datumSplatnosti', e.target.value || undefined)} placeholder="RRRR-MM-DD" />
                <CalIcon />
              </div>
            </div>
            <div className="dv-field">
              <label className="dv-label">Dátum dodania (DUZP)</label>
              <input className="dv-input dv-has-icon" value={ex.datumDodania ?? ''} disabled={readOnly} onChange={(e) => updateExtracted('datumDodania', e.target.value || undefined)} placeholder="RRRR-MM-DD" />
              <CalIcon />
            </div>

            <div className={`dv-expand${rozOpen ? ' dv-open' : ''}`}>
              <div className="dv-expand-inner">
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

        {/* Čiastka a DPH */}
        <section className="dv-section">
          <div className="dv-h3-row">
            <div className="dv-h3-left"><span className="dv-accent-bar" /><h3 className="dv-h3">Čiastka a DPH</h3></div>
            {dphValid
              ? <span className="dv-dph-ok"><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round"><path d="M20 6L9 17l-5-5" /></svg></span>
              : <span className="dv-dph-warn"><svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round"><path d="M12 9v4M12 17h.01" /><path d="M10.3 3.9L2 18a2 2 0 0 0 1.7 3h16.6A2 2 0 0 0 22 18L13.7 3.9a2 2 0 0 0-3.4 0z" /></svg></span>}
          </div>
          <div className="dv-grid-2">
            <div className={`dv-field${dphValid ? '' : ' dv-field-err'}`}>
              <label className="dv-label">Celková suma</label>
              <span className="dv-money-sign">€</span>
              <input className="dv-input dv-money" value={ex.sumaSpolu === undefined ? '' : String(ex.sumaSpolu)} disabled={readOnly} inputMode="decimal" onChange={(e) => updateExtracted('sumaSpolu', parseNum(e.target.value))} />
            </div>
            <DcDropdown label="Mena" mode="simple" value={ex.mena} options={menaOpts} disabled={readOnly} onChange={(v) => updateExtracted('mena', v as DocumentExtractedData['mena'])} />

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

        {/* Dodávateľ */}
        <section className="dv-section">
          <div className="dv-h3-row"><div className="dv-h3-left"><span className="dv-accent-bar" /><h3 className="dv-h3">Dodávateľ</h3></div></div>
          <div className="dv-fields">
            <label className="dv-check">
              <input type="checkbox" checked={fyzickaOsoba} disabled={readOnly} onChange={(e) => setFyzickaOsoba(e.target.checked)} />
              <span>Fyzická osoba nepodnikateľ</span>
            </label>
            <div className="dv-field">
              <label className="dv-label">Názov spoločnosti</label>
              <input className="dv-input" value={dod.nazov ?? ''} disabled={readOnly} onChange={(e) => updateSupplier('nazov', e.target.value)} />
            </div>
            <div className={`dv-field${icoErr ? ' dv-field-warn' : ''}`}>
              <label className="dv-label">IČO</label>
              <input className="dv-input" value={dod.ico ?? ''} disabled={readOnly} onChange={(e) => updateSupplier('ico', e.target.value)} />
              {icoErr && <div className="dv-warn-msg">IČO má mať 8 číslic</div>}
            </div>
            <div className="dv-field">
              <label className="dv-label">IČ DPH (voliteľné)</label>
              <input className="dv-input" style={{ paddingRight: 78 }} value={dod.icDph ?? ''} disabled={readOnly} onChange={(e) => updateSupplier('icDph', e.target.value)} />
              {Boolean(dod.icDph) && (
                <span className="dv-vies"><svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round"><path d="M20 6L9 17l-5-5" /></svg>VIES</span>
              )}
            </div>
            <div className={`dv-expand${rozDodOpen ? ' dv-open' : ''}`}>
              <div className="dv-expand-inner">
                <div className="dv-field">
                  <label className="dv-label">DIČ</label>
                  <input className="dv-input" value={dod.dic ?? ''} disabled={readOnly} onChange={(e) => updateSupplier('dic', e.target.value)} />
                </div>
                <div className="dv-field">
                  <label className="dv-label">Adresa</label>
                  <input className="dv-input" value={dod.adresa ?? ''} disabled={readOnly} onChange={(e) => updateSupplier('adresa', e.target.value)} />
                </div>
              </div>
            </div>
            <button type="button" className="dv-toggle" onClick={() => setRozDodOpen((o) => !o)}>
              Rozšírené položky <span className={`dv-caret${rozDodOpen ? ' dv-up' : ''}`}><CaretIcon /></span>
            </button>
          </div>
        </section>

        <div className="dv-divider" />

        {/* Platobné údaje */}
        <section className="dv-section">
          <div className="dv-h3-row"><div className="dv-h3-left"><span className="dv-accent-bar" /><h3 className="dv-h3">Platobné údaje</h3></div></div>
          <div className="dv-fields">
            <div className="dv-field">
              <label className="dv-label">Variabilný symbol</label>
              <input className="dv-input" value={ex.variabilnySymbol ?? ''} disabled={readOnly} onChange={(e) => updateExtracted('variabilnySymbol', e.target.value || undefined)} />
            </div>
            <div className="dv-field">
              <label className="dv-label">IBAN</label>
              <input className="dv-input" style={{ letterSpacing: '.02em' }} value={dod.iban ?? ''} disabled={readOnly} onChange={(e) => updateSupplier('iban', e.target.value)} />
            </div>
            <div className="dv-field">
              <label className="dv-label">Konštantný symbol</label>
              <input className="dv-input" value={ex.konstantnySymbol ?? ''} disabled={readOnly} onChange={(e) => updateExtracted('konstantnySymbol', e.target.value || undefined)} />
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
          codeLists={{
            predkontacie: codeLists.predkontacie,
            cleneniaDph: codeLists.cleneniaDph,
            strediska: codeLists.strediska,
          }}
          onChange={(polozky) => updateExtracted('polozky', polozky)}
        />

        {/* Akcie */}
        <div className="dv-actions">
          {(autoFilled || aiApplied) && (
            <div className="dv-ai-done">
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round"><path d="M20 6L9 17l-5-5" /></svg>
              Zaúčtované z pamäte{predkConfidence != null ? ` · istota ${predkConfidence} %` : ''}
            </div>
          )}
          <button type="button" className="dv-btn-ai" disabled={!canAi} onClick={applyAi}>
            <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor"><path d="M12 2l1.7 5.6L19.4 9l-5.7 1.4L12 16l-1.7-5.6L4.6 9l5.7-1.4z" /><path d="M19 13.5l.9 2.9 2.9.9-2.9.9-.9 2.9-.9-2.9-2.9-.9 2.9-.9z" /></svg>
            Použiť automatické účtovanie
          </button>
          <button type="button" className="dv-btn-primary" disabled={busy || readOnly} onClick={onSave}>Uložiť</button>
        </div>

      </div>
    </div>
  );
}

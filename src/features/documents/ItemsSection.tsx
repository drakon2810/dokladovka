// Sekcia Položky (rozpis na položky) — dizajn 1b „karty" (ItemsSection.dc.html)
// z Claude Design, napojená na reálne draft.extracted.polozky + rozpisDph +
// číselníky. Karta na položku: názov, počet, jedn. cena, DPH %, daň, spolu,
// jednotka a pozičné zaúčtovanie (účtovná položka / členenie DPH / stredisko).
// Prepínač zapnutia, pridanie/odstránenie, „Ďalšie" (záloha, z rozpisu DPH,
// vymazať) a kontrolná tabuľka Celkovo / Na položkách / Rozdiel po sadzbách.
import { useEffect, useMemo, useRef, useState } from 'react';
import type { CodeListItem, DocumentLineItem, VatBreakdownRow, VatRate } from '../../data/types';
import { lineItemEffective, round2 } from '../../lib/validate';
import { DcDropdown, type DcOption } from './DcDropdown';

const VAT_RATES: VatRate[] = [23, 21, 19, 12, 5, 0];
const BASE_UNITS = ['ks', 'hod', 'kg', 'l', 'm', 'bal'];

const parseNum = (v: string): number => {
  const n = Number(String(v).replace(',', '.'));
  return Number.isFinite(n) ? n : 0;
};
const parseOpt = (v: string): number | undefined => (v.trim() ? parseNum(v) : undefined);
const fmtMoney = (n: number, mena: string): string =>
  `${round2(n).toLocaleString('sk-SK', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} ${mena === 'EUR' ? '€' : mena}`;

interface ItemsSectionProps {
  polozky: DocumentLineItem[];
  rozpisDph: VatBreakdownRow[];
  celkovaSuma: number;
  mena: string;
  readOnly: boolean;
  codeLists: {
    predkontacie: CodeListItem[];
    cleneniaDph: CodeListItem[];
    strediska: CodeListItem[];
  };
  onChange: (polozky: DocumentLineItem[]) => void;
}

const PlusIcon = () => (
  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round"><path d="M12 5v14M5 12h14" /></svg>
);
const TrashIcon = () => (
  <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="M3 6h18M8 6V4a1 1 0 0 1 1-1h6a1 1 0 0 1 1 1v2M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6" /></svg>
);
const WarnIcon = () => (
  <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink: 0 }}><path d="M10.3 3.9L2 18a2 2 0 0 0 1.7 3h16.6A2 2 0 0 0 22 18L13.7 3.9a2 2 0 0 0-3.4 0z" /><path d="M12 9v4M12 17h.01" /></svg>
);

export function ItemsSection({
  polozky, rozpisDph, celkovaSuma, mena, readOnly, codeLists, onChange,
}: ItemsSectionProps) {
  const [enabled, setEnabled] = useState(polozky.length > 0);
  const [dalsieOpen, setDalsieOpen] = useState(false);
  const dalsieRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!dalsieOpen) return undefined;
    const onDoc = (event: MouseEvent) => {
      if (dalsieRef.current && !dalsieRef.current.contains(event.target as Node)) setDalsieOpen(false);
    };
    document.addEventListener('mousedown', onDoc);
    return () => document.removeEventListener('mousedown', onDoc);
  }, [dalsieOpen]);

  const toOpts = (items: CodeListItem[]): DcOption[] =>
    items.map((item) => ({ value: item.id, label: `${item.kod} · ${item.nazov}`, title: `${item.kod} · ${item.nazov}` }));
  const accountOpts = useMemo(() => toOpts(codeLists.predkontacie), [codeLists.predkontacie]);
  const clDphOpts = useMemo(() => toOpts(codeLists.cleneniaDph), [codeLists.cleneniaDph]);
  const strediskoOpts = useMemo(() => toOpts(codeLists.strediska), [codeLists.strediska]);
  const rateOpts: DcOption[] = VAT_RATES.map((rate) => ({ value: String(rate), label: `${rate} %` }));
  const unitOpts = (current?: string): DcOption[] => {
    const units = current && !BASE_UNITS.includes(current) ? [current, ...BASE_UNITS] : BASE_UNITS;
    return units.map((unit) => ({ value: unit, label: unit }));
  };

  const blank = (): DocumentLineItem => ({ id: crypto.randomUUID(), popis: '' });

  const addItem = () => { onChange([...polozky, blank()]); setDalsieOpen(false); };
  const removeItem = (id: string) => onChange(polozky.filter((item) => item.id !== id));
  const clearAll = () => { onChange([]); setDalsieOpen(false); };
  const addZaloha = () => { onChange([...polozky, { ...blank(), popis: 'Uhradená záloha' }]); setDalsieOpen(false); };
  const fromRozpis = () => {
    const items = rozpisDph
      .filter((row) => (row.zaklad || 0) !== 0 || (row.dph || 0) !== 0)
      .map<DocumentLineItem>((row) => ({
        id: crypto.randomUUID(),
        popis: `Položka ${row.sadzba} %`,
        mnozstvo: 1,
        sadzbaDph: row.sadzba,
        jednotkovaCenaBezDph: round2(row.zaklad),
        sumaBezDph: round2(row.zaklad),
        sumaDph: round2(row.dph),
        sumaSpolu: round2(row.zaklad + row.dph),
      }));
    onChange(items.length ? items : [blank()]);
    setDalsieOpen(false);
  };

  const patchItem = (id: string, patch: Partial<DocumentLineItem>) => {
    onChange(polozky.map((item) => {
      if (item.id !== id) return item;
      const next = { ...item, ...patch };
      // Zmena ceny/počtu/sadzby dopočíta daň aj sumu spolu (priama úprava dane
      // alebo sumy spolu sa neprepisuje).
      if ('jednotkovaCenaBezDph' in patch || 'mnozstvo' in patch || 'sadzbaDph' in patch) {
        if (next.jednotkovaCenaBezDph !== undefined) {
          const base = round2(next.jednotkovaCenaBezDph * (next.mnozstvo ?? 0));
          const dan = round2((base * (next.sadzbaDph ?? 0)) / 100);
          next.sumaBezDph = base;
          next.sumaDph = dan;
          next.sumaSpolu = round2(base + dan);
        }
      }
      return next;
    }));
  };
  const patchUcto = (id: string, patch: Partial<NonNullable<DocumentLineItem['ucto']>>) => {
    const item = polozky.find((candidate) => candidate.id === id);
    patchItem(id, { ucto: { ...item?.ucto, ...patch } });
  };

  // Kontrola súčtov po sadzbách: rozpis DPH vs. súčet položiek (efektívne sumy).
  const { tableRows, mismatch } = useMemo(() => {
    const baseByRate = new Map<number, number>();
    const danByRate = new Map<number, number>();
    let itemsSum = 0;
    for (const item of polozky) {
      const eff = lineItemEffective(item);
      const rate = item.sadzbaDph ?? 0;
      baseByRate.set(rate, (baseByRate.get(rate) ?? 0) + (eff.bezDph ?? 0));
      danByRate.set(rate, (danByRate.get(rate) ?? 0) + (eff.dph ?? 0));
      itemsSum += eff.spolu ?? 0;
    }
    let bad = false;
    const rows: Array<{
      rate: string; label: string; celkovo: string; naPolozkach: string;
      rozdiel: string; rozBad: boolean; strong?: boolean; top?: boolean;
    }> = [];
    for (const row of rozpisDph) {
      const bDiff = round2((row.zaklad || 0) - (baseByRate.get(row.sadzba) ?? 0));
      const dDiff = round2((row.dph || 0) - (danByRate.get(row.sadzba) ?? 0));
      if (Math.abs(bDiff) > 0.005 || Math.abs(dDiff) > 0.005) bad = true;
      rows.push({ rate: `${row.sadzba} %`, label: 'Základ', celkovo: fmtMoney(row.zaklad || 0, mena), naPolozkach: fmtMoney(baseByRate.get(row.sadzba) ?? 0, mena), rozdiel: fmtMoney(bDiff, mena), rozBad: Math.abs(bDiff) > 0.005 });
      rows.push({ rate: '', label: 'Daň', celkovo: fmtMoney(row.dph || 0, mena), naPolozkach: fmtMoney(danByRate.get(row.sadzba) ?? 0, mena), rozdiel: fmtMoney(dDiff, mena), rozBad: Math.abs(dDiff) > 0.005 });
    }
    const sumDiff = round2(celkovaSuma - itemsSum);
    if (Math.abs(sumDiff) > 0.005) bad = true;
    rows.push({ rate: '', label: 'Celková suma', celkovo: fmtMoney(celkovaSuma, mena), naPolozkach: fmtMoney(itemsSum, mena), rozdiel: fmtMoney(sumDiff, mena), rozBad: Math.abs(sumDiff) > 0.005, strong: true, top: true });
    return { tableRows: rows, mismatch: bad };
  }, [polozky, rozpisDph, celkovaSuma, mena]);

  const err = (value: unknown) => !String(value ?? '').trim();
  const showTable = enabled && mismatch && rozpisDph.length > 0;

  return (
    <div className="dv-items">
      <div className="dv-items-head">
        <span className="dv-accent-bar" />
        <h3 className="dv-h3">Položky</h3>
        <button
          type="button"
          role="switch"
          aria-checked={enabled}
          className={`dv-switch${enabled ? ' dv-on' : ''}`}
          disabled={readOnly}
          onClick={() => setEnabled((value) => !value)}
        >
          <span className="dv-switch-knob" />
        </button>
        <div className="dv-items-spacer" />
        <button type="button" className="dv-icon-btn" title="Pridať položku" disabled={readOnly} onClick={addItem}>
          <PlusIcon />
        </button>
        <div className="dv-dalsie" ref={dalsieRef}>
          <button type="button" className="dv-dalsie-btn" disabled={readOnly} onClick={() => setDalsieOpen((value) => !value)}>
            Ďalšie
            <svg className={`dv-caret${dalsieOpen ? ' dv-up' : ''}`} width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M6 9l6 6 6-6" /></svg>
          </button>
          {dalsieOpen && (
            <div className="dv-dalsie-menu">
              <button type="button" onClick={addZaloha}>Uhradená záloha</button>
              <button type="button" onClick={fromRozpis}>Položky z rozpisu DPH</button>
              <button type="button" className="dv-danger" onClick={clearAll}>Vymazať všetky položky</button>
            </div>
          )}
        </div>
      </div>

      {!enabled ? (
        <div className="dv-items-off">Rozpis na položky je vypnutý. Zapnite ho prepínačom pri nadpise.</div>
      ) : (
        <>
          {showTable && (
            <div className="dv-mismatch">
              <div className="dv-mismatch-head">
                <WarnIcon />
                Niektoré celkové hodnoty sa nezhodujú s hodnotami na položkách.
              </div>
              <table className="dv-mismatch-table">
                <thead>
                  <tr>
                    <th colSpan={2} />
                    <th>Celkovo</th>
                    <th>Na položkách</th>
                    <th>Rozdiel</th>
                  </tr>
                </thead>
                <tbody>
                  {tableRows.map((row, index) => (
                    <tr key={index} className={row.top ? 'dv-mismatch-total' : undefined}>
                      <td className="dv-mismatch-rate">{row.rate}</td>
                      <td className={row.strong ? 'dv-mismatch-strong' : undefined}>{row.label}</td>
                      <td className="tnum">{row.celkovo}</td>
                      <td className="tnum">{row.naPolozkach}</td>
                      <td className={`tnum${row.rozBad ? ' dv-mismatch-bad' : ''}${row.strong ? ' dv-mismatch-strong' : ''}`}>{row.rozdiel}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          {polozky.map((item, index) => (
            <div key={item.id} className="dv-item">
              <div className="dv-item-head">
                <span className="dv-item-title">
                  {index + 1}. Položka{item.sadzbaDph != null && item.sadzbaDph > 0 ? ` – ${item.sadzbaDph} %` : ''}
                </span>
                <button type="button" className="dv-item-del" title="Odstrániť položku" disabled={readOnly} onClick={() => removeItem(item.id)}>
                  <TrashIcon />
                </button>
              </div>
              <div className="dv-item-body">
                <div className="dv-item-row" style={{ gridTemplateColumns: '2fr 1fr' }}>
                  <div className={`dv-field${err(item.popis) ? ' dv-field-err' : ''}`}>
                    <label className="dv-label">Názov položky</label>
                    <input className="dv-input" value={item.popis} disabled={readOnly} onChange={(e) => patchItem(item.id, { popis: e.target.value })} />
                  </div>
                  <div className="dv-field">
                    <label className="dv-label">Počet</label>
                    <input className="dv-input" inputMode="decimal" value={item.mnozstvo ?? ''} disabled={readOnly} onChange={(e) => patchItem(item.id, { mnozstvo: parseOpt(e.target.value) })} />
                  </div>
                </div>
                <div className="dv-item-row">
                  <div className="dv-field">
                    <label className="dv-label">Jedn. cena bez DPH</label>
                    <input className="dv-input" inputMode="decimal" value={item.jednotkovaCenaBezDph ?? ''} disabled={readOnly} onChange={(e) => patchItem(item.id, { jednotkovaCenaBezDph: parseOpt(e.target.value) })} />
                  </div>
                  <DcDropdown label="DPH %" mode="simple" value={item.sadzbaDph != null ? String(item.sadzbaDph) : undefined} options={rateOpts} disabled={readOnly} onChange={(v) => patchItem(item.id, { sadzbaDph: Number(v) as VatRate })} />
                </div>
                <div className="dv-item-row">
                  <div className="dv-field">
                    <label className="dv-label">Daň</label>
                    <input className="dv-input" inputMode="decimal" value={item.sumaDph ?? ''} disabled={readOnly} onChange={(e) => patchItem(item.id, { sumaDph: parseOpt(e.target.value) })} />
                  </div>
                  <div className="dv-field">
                    <label className="dv-label">Spolu s DPH</label>
                    <input className="dv-input dv-money-strong" inputMode="decimal" value={item.sumaSpolu ?? ''} disabled={readOnly} onChange={(e) => patchItem(item.id, { sumaSpolu: parseOpt(e.target.value) })} />
                  </div>
                </div>
                <div className="dv-item-row">
                  <DcDropdown label="Jednotka" mode="simple" value={item.jednotka} options={unitOpts(item.jednotka)} disabled={readOnly} onChange={(v) => patchItem(item.id, { jednotka: v || undefined })} />
                  <DcDropdown label="Účtovná položka" mode="simple" searchable value={item.ucto?.predkontaciaId} options={accountOpts} disabled={readOnly} onChange={(v) => patchUcto(item.id, { predkontaciaId: v || undefined })} />
                </div>
                <div className="dv-item-row">
                  <DcDropdown label="Členenie DPH" mode="simple" searchable value={item.ucto?.clenenieDphId} options={clDphOpts} disabled={readOnly} onChange={(v) => patchUcto(item.id, { clenenieDphId: v || undefined })} />
                  <DcDropdown label="Nákladové stredisko" mode="simple" searchable value={item.ucto?.strediskoId} options={strediskoOpts} disabled={readOnly} onChange={(v) => patchUcto(item.id, { strediskoId: v || undefined })} />
                </div>
              </div>
            </div>
          ))}

          {polozky.length === 0 && (
            <div className="dv-items-empty">
              Žiadne položky. Pridajte položku tlačidlom <strong>+</strong> alebo cez <strong>Ďalšie → Položky z rozpisu DPH</strong>.
            </div>
          )}
        </>
      )}
    </div>
  );
}

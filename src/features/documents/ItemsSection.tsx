// Položky dokladu — tabuľka podľa makety „Detail dokladu.dc.html" z Claude
// Design. Jeden riadok = jedna položka (text, sumy, sadzba, členenia,
// predkontácia), rozbalený riadok nesie počet/jednotku/cenu a analytiku
// (stredisko, činnosť, zákazka). Prepínač zapína rozpis na položky; keď je
// vypnutý, doklad sa účtuje jednou sumou a rozpis DPH sa upravuje ručne.
import { useEffect, useMemo, useRef, useState } from 'react';
import type { CodeListItem, DocumentLineItem, VatBreakdownRow, VatRate } from '../../data/types';
import { CLENENIE_KV_KODY } from '../../data/types';
import { lineItemEffective, round2 } from '../../lib/validate';
import { DcCell, DcPick, type DcOption } from './DcInline';

const VAT_RATES: VatRate[] = [23, 19, 5, 0];
const BASE_UNITS = ['ks', 'hod', 'kg', 'l', 'm', 'bal'];
/** Prázdna voľba: „ako v hlavičke dokladu" — nie zmazanie hodnoty. */
const HEADER_OPTION: DcOption = { value: '', label: '— ako doklad' };

export const parseNum = (value: string): number => {
  const parsed = Number(String(value).replace(/\s/g, '').replace(',', '.'));
  return Number.isFinite(parsed) ? parsed : 0;
};
export const parseOpt = (value: string): number | undefined => (value.trim() ? parseNum(value) : undefined);
export const fmtMoney = (value: number, mena: string): string =>
  `${round2(value).toLocaleString('sk-SK', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} ${mena === 'EUR' ? '€' : mena}`;

export interface ItemsCodeLists {
  predkontacie: CodeListItem[];
  cleneniaDph: CodeListItem[];
  strediska: CodeListItem[];
  cinnosti: CodeListItem[];
  zakazky: CodeListItem[];
}

interface ItemsSectionProps {
  polozky: DocumentLineItem[];
  /** Rozpis DPH dokladu — zdroj pre „Položky z rozpisu DPH". */
  rozpisDph: VatBreakdownRow[];
  mena: string;
  readOnly: boolean;
  enabled: boolean;
  onToggle: (enabled: boolean) => void;
  codeLists: ItemsCodeLists;
  onChange: (polozky: DocumentLineItem[]) => void;
  /** „Rozdeliť doklad" — časť položiek pôjde do nového dokladu inej agendy. */
  onSplit?: () => void;
  /**
   * Kódy z hlavičky dokladu (predkontácia, členenie DPH, KV). Položka bez
   * vlastnej hodnoty ich preberá — presne tak ich zdedí aj export do POHODY
   * (pohodaXml.ts) — a tabuľka ich preto ukazuje našedo ako predvolené.
   */
  headerUcto?: {
    predkontacia?: string; clenenieDph?: string; clenenieKv?: string;
    stredisko?: string; cinnost?: string; zakazka?: string;
  };
  /** Číslo sekcie pri zvýraznení zdroja údajov, inak nezafarbené. */
  srcSection?: number;
  onHoverSrc?: (anchor?: string) => void;
}

const PencilIcon = () => (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="M12 20h9" /><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z" /></svg>
);

/** Jednotková cena musí sedieť s množstvom a základom — `validateDocument`
 *  inak riadok označí ako `invalid_line_item` a doklad sa nedá schváliť. */
function withUnitPrice(item: DocumentLineItem): DocumentLineItem {
  if (!item.mnozstvo || item.sumaBezDph === undefined) return item;
  return { ...item, jednotkovaCenaBezDph: round2(item.sumaBezDph / item.mnozstvo) };
}

/**
 * Prepočet položky po zmene jedného poľa. Účtovník zadá ktorúkoľvek sumu a
 * zvyšok dopočítame — inak sa riadok rozíde s rozpisom DPH a doklad sa nedá
 * schváliť. Bez zadanej sadzby sa daň nedopočítava (nulová sadzba by tichý
 * odpočet DPH zmazala), prázdna suma vyprázdni aj odvodené polia.
 */
export function recalcItem(item: DocumentLineItem, changed: keyof DocumentLineItem): DocumentLineItem {
  const next = { ...item };
  const rate = next.sadzbaDph;
  if (changed === 'sumaSpolu') {
    // Z celkovej sumy sa základ odvodzuje späť — bločky nesú len sumu s DPH.
    if (next.sumaSpolu === undefined) return { ...next, sumaBezDph: undefined, sumaDph: undefined };
    if (rate === undefined) return next;
    next.sumaBezDph = round2(next.sumaSpolu / (1 + rate / 100));
    next.sumaDph = round2(next.sumaSpolu - next.sumaBezDph);
    return withUnitPrice(next);
  }
  if (changed === 'sumaDph') {
    next.sumaSpolu = round2((next.sumaBezDph ?? 0) + (next.sumaDph ?? 0));
    return next;
  }
  if (changed === 'mnozstvo' || changed === 'jednotkovaCenaBezDph') {
    if (next.jednotkovaCenaBezDph !== undefined) next.sumaBezDph = round2(next.jednotkovaCenaBezDph * (next.mnozstvo ?? 1));
  }
  if (next.sumaBezDph === undefined) return { ...next, sumaDph: undefined, sumaSpolu: undefined };
  if (rate !== undefined) {
    next.sumaDph = round2((next.sumaBezDph * rate) / 100);
    next.sumaSpolu = round2(next.sumaBezDph + next.sumaDph);
  } else {
    next.sumaSpolu = round2(next.sumaBezDph + (next.sumaDph ?? 0));
  }
  return changed === 'sumaBezDph' ? withUnitPrice(next) : next;
}

/**
 * Základ a daň položky BEZ zaokrúhlenia. Zaokrúhľuje až súčet za sadzbu —
 * dodávateľ počíta daň z celkového základu, nie po riadkoch, a zaokrúhlenie
 * každého riadka sa cez desiatky položiek nazbiera na halier rozdielu oproti
 * faktúre (11 položiek dalo 55,61 namiesto 55,62).
 */
function zakladADan(item: DocumentLineItem): { zaklad: number; dph: number } {
  const efektivne = lineItemEffective(item);
  if (efektivne.bezDph !== undefined) return { zaklad: efektivne.bezDph, dph: efektivne.dph ?? 0 };
  // Dodávateľ počíta základ ako cena × množstvo, nie delením sumy s DPH. Delenie
  // dá o halier iný základ (241,81 namiesto 241,82) a rozpis sa potom rozíde s
  // faktúrou — a s ňou aj kontrolný výkaz.
  if (item.jednotkovaCenaBezDph !== undefined) {
    const zaklad = item.jednotkovaCenaBezDph * (item.mnozstvo ?? 1);
    return { zaklad, dph: (zaklad * (item.sadzbaDph ?? 0)) / 100 };
  }
  const spolu = efektivne.spolu ?? item.sumaSpolu;
  if (spolu === undefined) return { zaklad: 0, dph: 0 };
  const zaklad = spolu / (1 + (item.sadzbaDph ?? 0) / 100);
  return { zaklad, dph: spolu - zaklad };
}

/** Sadzby, na ktoré sa zaokrúhľuje odvodená hodnota — SK aj staršie/české. */
const ZNAME_SADZBY = [23, 21, 20, 19, 15, 12, 10, 5];

/**
 * Sadzba položky. AI ju občas nerozpozná, hoci sumu dane vráti — vtedy ju
 * dopočítame zo základu a dane. Bez toho by taká položka spadla do koša 0 %
 * aj s daňou, riadok rozpisu by bol matematicky nemožný (0 % so sumou dane)
 * a doklad by sa už nedal schváliť.
 */
function sadzbaPolozky(item: DocumentLineItem, zaklad: number, dph: number): number {
  if (item.sadzbaDph !== undefined) return item.sadzbaDph;
  if (!zaklad || !dph) return 0;
  const odvodena = round2((dph / zaklad) * 100);
  return ZNAME_SADZBY.find((rate) => Math.abs(rate - odvodena) <= 0.5) ?? odvodena;
}

/** Rozpis DPH odvodený z položiek — sadzby zostupne, prázdne sadzby vypadnú. */
export function rozpisZPoloziek(polozky: DocumentLineItem[]): VatBreakdownRow[] {
  const byRate = new Map<number, VatBreakdownRow>();
  for (const item of polozky) {
    const { zaklad, dph } = zakladADan(item);
    const sadzba = sadzbaPolozky(item, zaklad, dph);
    const row = byRate.get(sadzba) ?? { sadzba, zaklad: 0, dph: 0 };
    row.zaklad += zaklad;
    row.dph += dph;
    byRate.set(sadzba, row);
  }
  return [...byRate.values()]
    .map((row) => ({ ...row, zaklad: round2(row.zaklad), dph: round2(row.dph) }))
    .sort((left, right) => right.sadzba - left.sadzba);
}

export function ItemsSection({
  polozky, rozpisDph, mena, readOnly, enabled, onToggle, codeLists, onChange, onSplit, headerUcto, srcSection, onHoverSrc,
}: ItemsSectionProps) {
  /** Tooltip stĺpca s dedením: povie, čo položka prevezme z hlavičky. */
  const zdedene = (nazov: string, index: number, kod?: string) =>
    `${nazov} položky ${index + 1}${kod ? ` — bez vlastnej hodnoty platí hlavička dokladu: ${kod}` : ''}`;
  const [open, setOpen] = useState<Record<string, boolean>>({});
  const [menuOpen, setMenuOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!menuOpen) return undefined;
    const onDoc = (event: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(event.target as Node)) setMenuOpen(false);
    };
    document.addEventListener('mousedown', onDoc);
    return () => document.removeEventListener('mousedown', onDoc);
  }, [menuOpen]);

  const toOpts = (items: CodeListItem[]): DcOption[] =>
    [HEADER_OPTION, ...items.map((item) => ({ value: item.id, label: `${item.kod} · ${item.nazov}`, title: `${item.kod} · ${item.nazov}` }))];
  const predkOpts = useMemo(() => toOpts(codeLists.predkontacie), [codeLists.predkontacie]);
  const dphOpts = useMemo(() => toOpts(codeLists.cleneniaDph), [codeLists.cleneniaDph]);
  const strediskoOpts = useMemo(() => toOpts(codeLists.strediska), [codeLists.strediska]);
  const cinnostOpts = useMemo(() => toOpts(codeLists.cinnosti), [codeLists.cinnosti]);
  const zakazkaOpts = useMemo(() => toOpts(codeLists.zakazky), [codeLists.zakazky]);
  // Historická sadzba (21 %, 12 %) sa musí dať znovu vybrať, inak by riadok
  // po prvom otvorení dropdownu ostal bez sadzby.
  const rateOpts = (current?: number): DcOption[] => {
    const rates = current != null && !VAT_RATES.includes(current) ? [current, ...VAT_RATES] : VAT_RATES;
    return rates.map((rate) => ({ value: String(rate), label: `${rate} %` }));
  };
  const kvOpts: DcOption[] = [HEADER_OPTION, ...CLENENIE_KV_KODY.map((kod) => ({ value: kod, label: kod }))];
  const unitOpts = (current?: string): DcOption[] => {
    const units = current && !BASE_UNITS.includes(current) ? [current, ...BASE_UNITS] : BASE_UNITS;
    return [HEADER_OPTION, ...units.map((unit) => ({ value: unit, label: unit }))];
  };

  const blank = (): DocumentLineItem => ({ id: crypto.randomUUID(), popis: '', sadzbaDph: 23 });
  const addItem = () => { onChange([...polozky, blank()]); setMenuOpen(false); };
  const clearAll = () => { onChange([]); setMenuOpen(false); };
  /** Predvyplní položky zo súm, ktoré už doklad má — nič sa neprepisuje ručne. */
  const zRozpisu = () => {
    const items = rozpisDph
      .filter((row) => (row.zaklad || 0) !== 0 || (row.dph || 0) !== 0)
      .map<DocumentLineItem>((row) => ({
        id: crypto.randomUUID(),
        popis: `Plnenie ${row.sadzba} %`,
        mnozstvo: 1,
        sadzbaDph: row.sadzba,
        jednotkovaCenaBezDph: round2(row.zaklad),
        sumaBezDph: round2(row.zaklad),
        sumaDph: round2(row.dph),
        sumaSpolu: round2(row.zaklad + row.dph),
      }));
    if (items.length > 0) onChange([...polozky, ...items]);
    setMenuOpen(false);
  };
  const removeItem = (id: string) => onChange(polozky.filter((item) => item.id !== id));

  const patch = (id: string, changes: Partial<DocumentLineItem>, changed?: keyof DocumentLineItem) => {
    onChange(polozky.map((item) => {
      if (item.id !== id) return item;
      const merged = { ...item, ...changes };
      return changed ? recalcItem(merged, changed) : merged;
    }));
  };
  const patchUcto = (id: string, changes: Partial<NonNullable<DocumentLineItem['ucto']>>) => {
    onChange(polozky.map((item) => (item.id === id
      // Prázdny reťazec = „ako v hlavičke": hodnotu z položky zahodíme.
      ? { ...item, ucto: Object.fromEntries(Object.entries({ ...item.ucto, ...changes }).filter(([, value]) => value)) }
      : item)));
  };

  const totals = polozky.reduce(
    (sum, item) => ({
      spolu: sum.spolu + (item.sumaSpolu ?? 0),
      bez: sum.bez + (item.sumaBezDph ?? 0),
      dph: sum.dph + (item.sumaDph ?? 0),
    }),
    { spolu: 0, bez: 0, dph: 0 },
  );

  const money = (value: number | undefined, onCommit: (raw: string) => void, negative?: boolean) => (
    <div className={`dk-r${negative ? ' dk-neg' : ''}`}>
      <DcCell
        align="right"
        inputMode="decimal"
        disabled={readOnly}
        value={value === undefined ? '' : String(value)}
        display={value === undefined ? '' : fmtMoney(value, mena)}
        onCommit={onCommit}
      />
    </div>
  );

  return (
    // dk-card-grow: voľnú výšku editora dostane práve táto karta — jediná, čo
    // rastie s obsahom. Ostatné karty by z nej mali len prázdne pixely.
    <div className="dk-card dk-card-grow">
      <div
        className={`dk-items-head${srcSection ? ` dv-src-sec dv-src-${srcSection}` : ''}`}
        onMouseEnter={srcSection ? () => onHoverSrc?.(`sec:${srcSection}`) : undefined}
        onMouseLeave={srcSection ? () => onHoverSrc?.(undefined) : undefined}
      >
        <span className="dk-items-title">Položky dokladu ({polozky.length})</span>
        {srcSection ? <span className="dv-src-chip">{srcSection}</span> : null}
        <button
          type="button"
          role="switch"
          aria-checked={enabled}
          aria-label="Zapnúť rozpis na položky"
          title="Zapnúť / vypnúť rozpis na položky"
          className={`dk-switch${enabled ? ' dk-on' : ''}`}
          disabled={readOnly}
          onClick={() => onToggle(!enabled)}
        />
        <div style={{ marginLeft: 'auto' }} ref={menuRef} className="dk-pick">
          <button type="button" className="dk-btn dk-btn-sm" disabled={readOnly || !enabled} onClick={() => setMenuOpen((value) => !value)}>
            <PencilIcon />
            Upraviť položky
          </button>
          {menuOpen && (
            <div className="dk-menu">
              <button type="button" className="dk-pick-opt" onClick={addItem}><span className="dk-pick-tick" />Pridať položku</button>
              <button type="button" className="dk-pick-opt" onClick={zRozpisu}><span className="dk-pick-tick" />Položky z rozpisu DPH</button>
              <button type="button" className="dk-pick-opt" onClick={clearAll}><span className="dk-pick-tick" />Vymazať všetky položky</button>
              {/* Rozdelenie má zmysel až od dvoch položiek — jednu deliť nie je čo. */}
              {onSplit && polozky.length > 1 && (
                <button type="button" className="dk-pick-opt" onClick={() => { setMenuOpen(false); onSplit(); }}>
                  <span className="dk-pick-tick" />Rozdeliť doklad…
                </button>
              )}
            </div>
          )}
        </div>
      </div>

      {!enabled ? (
        <div className="dk-items-off">
          Rozpis na položky je vypnutý. Doklad sa zaúčtuje jednou sumou — sadzby a základy uprav nižšie v <strong>Rozpise DPH</strong>.
        </div>
      ) : polozky.length === 0 ? (
        <div className="dk-items-empty">
          Žiadne položky. Pridaj ich cez <strong>Upraviť položky → Pridať položku</strong>, alebo ich nechaj predvyplniť z <strong>rozpisu DPH</strong>.
        </div>
      ) : (
        <div className="dk-items-scroll">
          <div className="dk-row dk-row-head">
            <span>#</span>
            <span>Text položky</span>
            <span className="dk-r">Celkom</span>
            <span className="dk-r">Suma DPH</span>
            <span>DPH</span>
            <span>Členenie DPH</span>
            <span>Kontr. výkaz</span>
            <span>Predkontácia</span>
            <span />
          </div>

          {polozky.map((item, index) => (
            <div key={item.id}>
              <div className="dk-row dk-row-item">
                <span className="dk-row-no">{index + 1}</span>
                <DcCell value={item.popis} placeholder="Text položky" disabled={readOnly} onCommit={(raw) => patch(item.id, { popis: raw })} />
                <div className={`dk-r dk-strong${(item.sumaSpolu ?? 0) < 0 ? ' dk-neg' : ''}`}>
                  <DcCell
                    align="right" inputMode="decimal" disabled={readOnly}
                    value={item.sumaSpolu === undefined ? '' : String(item.sumaSpolu)}
                    display={item.sumaSpolu === undefined ? '' : fmtMoney(item.sumaSpolu, mena)}
                    onCommit={(raw) => patch(item.id, { sumaSpolu: parseOpt(raw) }, 'sumaSpolu')}
                  />
                </div>
                {money(item.sumaDph, (raw) => patch(item.id, { sumaDph: parseOpt(raw) }, 'sumaDph'), (item.sumaDph ?? 0) < 0)}
                <DcPick
                  value={item.sadzbaDph != null ? String(item.sadzbaDph) : undefined}
                  options={rateOpts(item.sadzbaDph)} disabled={readOnly}
                  onChange={(value) => patch(item.id, { sadzbaDph: Number(value) as VatRate }, 'sadzbaDph')}
                />
                {/* title je zároveň prístupný názov — bez neho je pri hodnote „—" tlačidlo bezmenné.
                    Prázdna položka ukazuje našedo kód z hlavičky — ten pri exporte zdedí. */}
                <DcPick title={zdedene('Členenie DPH', index, headerUcto?.clenenieDph)} placeholder={headerUcto?.clenenieDph ?? '—'} value={item.ucto?.clenenieDphId} options={dphOpts} disabled={readOnly} onChange={(value) => patchUcto(item.id, { clenenieDphId: value })} />
                <DcPick title={zdedene('Kontrolný výkaz', index, headerUcto?.clenenieKv)} placeholder={headerUcto?.clenenieKv ?? '—'} value={item.ucto?.clenenieKvKod} options={kvOpts} disabled={readOnly} onChange={(value) => patchUcto(item.id, { clenenieKvKod: value })} />
                <DcPick title={zdedene('Predkontácia', index, headerUcto?.predkontacia)} placeholder={headerUcto?.predkontacia ?? '—'} value={item.ucto?.predkontaciaId} options={predkOpts} disabled={readOnly} onChange={(value) => patchUcto(item.id, { predkontaciaId: value })} />
                <button
                  type="button"
                  className="dk-caret"
                  aria-expanded={Boolean(open[item.id])}
                  aria-label="Podrobnosti položky"
                  onClick={() => setOpen((current) => ({ ...current, [item.id]: !current[item.id] }))}
                >
                  {open[item.id] ? '▾' : '▸'}
                </button>
              </div>

              {open[item.id] && (
                <>
                  <div className="dk-sub">
                    <span className="dk-lbl">Bez DPH</span>
                    <DcCell inputMode="decimal" disabled={readOnly} value={item.sumaBezDph === undefined ? '' : String(item.sumaBezDph)} onCommit={(raw) => patch(item.id, { sumaBezDph: parseOpt(raw) }, 'sumaBezDph')} />
                    <span className="dk-lbl">Počet</span>
                    <DcCell inputMode="decimal" disabled={readOnly} value={item.mnozstvo === undefined ? '' : String(item.mnozstvo)} onCommit={(raw) => patch(item.id, { mnozstvo: parseOpt(raw) }, 'mnozstvo')} />
                    <span className="dk-lbl">Jedn. cena</span>
                    <DcCell inputMode="decimal" disabled={readOnly} value={item.jednotkovaCenaBezDph === undefined ? '' : String(item.jednotkovaCenaBezDph)} onCommit={(raw) => patch(item.id, { jednotkovaCenaBezDph: parseOpt(raw) }, 'jednotkovaCenaBezDph')} />
                  </div>
                  <div className="dk-sub">
                    <span className="dk-lbl">Jednotka</span>
                    <DcPick value={item.jednotka} options={unitOpts(item.jednotka)} disabled={readOnly} onChange={(value) => patch(item.id, { jednotka: value || undefined })} />
                    <span className="dk-lbl">Stredisko</span>
                    <DcPick title={zdedene('Stredisko', index, headerUcto?.stredisko)} placeholder={headerUcto?.stredisko ?? '—'} value={item.ucto?.strediskoId} options={strediskoOpts} disabled={readOnly} onChange={(value) => patchUcto(item.id, { strediskoId: value })} />
                    <span className="dk-lbl">Činnosť</span>
                    <DcPick title={zdedene('Činnosť', index, headerUcto?.cinnost)} placeholder={headerUcto?.cinnost ?? '—'} value={item.ucto?.cinnostId} options={cinnostOpts} disabled={readOnly} onChange={(value) => patchUcto(item.id, { cinnostId: value })} />
                  </div>
                  <div className="dk-sub">
                    <span className="dk-lbl">Zákazka</span>
                    <DcPick title={zdedene('Zákazka', index, headerUcto?.zakazka)} placeholder={headerUcto?.zakazka ?? '—'} value={item.ucto?.zakazkaId} options={zakazkaOpts} disabled={readOnly} onChange={(value) => patchUcto(item.id, { zakazkaId: value })} />
                    <span className="dk-lbl" />
                    <span />
                    <span className="dk-lbl" />
                    {!readOnly && (
                      <button type="button" className="dk-sub-del" onClick={() => removeItem(item.id)}>
                        Odstrániť položku
                      </button>
                    )}
                  </div>
                </>
              )}
            </div>
          ))}

          <div className="dk-row dk-row-total">
            <span />
            <span>Celkom</span>
            <span className="dk-r">{fmtMoney(totals.spolu, mena)}</span>
            <span className="dk-r">{fmtMoney(totals.bez, mena)}</span>
            <span className="dk-r">{fmtMoney(totals.dph, mena)}</span>
            <span /><span /><span /><span /><span />
          </div>
        </div>
      )}
    </div>
  );
}

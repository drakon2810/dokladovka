// Inline bunky editora dokladu — verne k `Cell.dc.html` a `Pick.dc.html`
// z Claude Design. Na rozdiel od `DcDropdown` nemajú vlastný popisok ani rám:
// sedia priamo v mriežke „popis vľavo, hodnota vpravo" ako v POHODE a rám
// dostanú až pri hovere/editácii.
import { useCallback, useEffect, useLayoutEffect, useRef, useState, type CSSProperties } from 'react';
import { createPortal } from 'react-dom';

export interface DcOption {
  value: string;
  label?: string;
  /** Plný text do tooltipu, keď sa label v úzkej bunke odreže. */
  title?: string;
}

/** Dátum z dokladu sa ukladá ISO, účtovníkovi sa ukazuje po slovensky. */
export function formatDateSk(iso?: string): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso ?? '');
  return match ? `${match[3]}.${match[2]}.${match[1]}` : (iso ?? '');
}

interface DcCellProps {
  /** Surová hodnota, ktorá sa edituje (pri type="date" ISO yyyy-mm-dd). */
  value: string;
  /** Čo sa zobrazí v pokoji — napr. „135,30 €". Prázdne = `value`. */
  display?: string;
  placeholder?: string;
  align?: 'left' | 'right';
  disabled?: boolean;
  title?: string;
  type?: 'text' | 'date';
  inputMode?: 'text' | 'decimal' | 'numeric';
  /** Stav poľa: chyba (červený rám) alebo upozornenie (jantárový). */
  tone?: 'err' | 'warn';
  /** Zvýraznenie zdroja údajov — trieda `dv-src …` z panelu. */
  srcClass?: string;
  onCommit: (value: string) => void;
}

export function DcCell({
  value, display, placeholder = '—', align = 'left', disabled = false, title,
  type = 'text', inputMode, tone, srcClass = '', onCommit,
}: DcCellProps) {
  // Počas editácie sa v poli drží presne to, čo účtovník napísal. Bez toho by
  // sa „135," po prepočte na číslo vrátilo ako „135" a desatinné miesta by sa
  // nedali napísať.
  const [draft, setDraft] = useState<string | null>(null);
  const editing = draft !== null;
  const inputRef = useRef<HTMLInputElement>(null);
  /** Hodnota pri začatí editácie — Escape ju vráti späť. */
  const povodna = useRef('');
  const zacniEditovat = () => { povodna.current = value; setDraft(value); };

  // Zameranie musí prebehnúť pred vykreslením, inak bliká pôvodný text.
  useLayoutEffect(() => {
    if (!editing) return;
    inputRef.current?.focus();
    if (type === 'text') inputRef.current?.select();
  }, [editing, type]);

  const cls = `dk-cell${align === 'right' ? ' dk-right' : ''}${tone ? ` dk-cell-${tone}` : ''}${srcClass}`;
  if (editing && !disabled) {
    return (
      <input
        ref={inputRef}
        className={`${cls} dk-cell-edit`}
        type={type === 'date' ? 'date' : 'text'}
        inputMode={inputMode}
        value={draft}
        onChange={(event) => { setDraft(event.target.value); onCommit(event.target.value); }}
        onBlur={() => setDraft(null)}
        onKeyDown={(event) => {
          if (event.key === 'Enter') { event.preventDefault(); setDraft(null); }
          if (event.key === 'Escape') { event.preventDefault(); onCommit(povodna.current); setDraft(null); }
        }}
      />
    );
  }
  const shown = (display ?? value).trim();
  return (
    <span
      role="textbox"
      tabIndex={disabled ? -1 : 0}
      title={title}
      className={`${cls}${disabled ? ' dk-cell-off' : ''}${shown ? '' : ' dk-cell-empty'}`}
      onClick={() => { if (!disabled) zacniEditovat(); }}
      onKeyDown={(event) => {
        if (disabled) return;
        if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); zacniEditovat(); }
      }}
    >
      {shown || placeholder}
    </span>
  );
}

interface DcPickProps {
  value?: string;
  options: DcOption[];
  placeholder?: string;
  disabled?: boolean;
  title?: string;
  align?: 'left' | 'right';
  /** Vyhľadávanie sa zapne samo pri dlhom číselníku (predkontácie). */
  searchable?: boolean;
  srcClass?: string;
  /** „Synchronizovať mostíkom" v pätičke — stiahne číselník z POHODY. */
  onMostikSync?: () => void;
  onChange: (value: string) => void;
}

/** Nad týmto počtom položiek má zoznam vyhľadávanie — bez neho sa nedá použiť. */
const SEARCH_FROM = 8;

function bezDiakritiky(value: unknown): string {
  return String(value ?? '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
}

export function DcPick({
  value, options, placeholder = '—', disabled = false, title, align = 'left',
  searchable, srcClass = '', onMostikSync, onChange,
}: DcPickProps) {
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState('');
  const [active, setActive] = useState(0);
  const [kotva, setKotva] = useState<DOMRect>();
  const rootRef = useRef<HTMLDivElement>(null);
  const popRef = useRef<HTMLDivElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);

  // Zoznam sa vykresľuje do <body>: tabuľka položiek má vodorovný posun, ktorý
  // by inak rozbaľovací zoznam orezal — presne to sa dialo pri členení DPH,
  // kontrolnom výkaze a predkontácii v riadku položky.
  const zmerajKotvu = useCallback(() => {
    const element = rootRef.current;
    if (element) setKotva(element.getBoundingClientRect());
  }, []);

  useEffect(() => {
    if (!open) return undefined;
    zmerajKotvu();
    const onDoc = (event: MouseEvent) => {
      const target = event.target as Node;
      if (rootRef.current?.contains(target) || popRef.current?.contains(target)) return;
      setOpen(false);
    };
    // capture: zachytí aj posun vnútri tabuľky, nielen posun stránky.
    const onMove = () => zmerajKotvu();
    document.addEventListener('mousedown', onDoc);
    window.addEventListener('scroll', onMove, true);
    window.addEventListener('resize', onMove);
    return () => {
      document.removeEventListener('mousedown', onDoc);
      window.removeEventListener('scroll', onMove, true);
      window.removeEventListener('resize', onMove);
    };
  }, [open, zmerajKotvu]);

  const withSearch = searchable ?? options.length > SEARCH_FROM;
  useEffect(() => {
    if (open && withSearch) searchRef.current?.focus();
  }, [open, withSearch]);

  const query = bezDiakritiky(search).trim();
  const filtered = query
    ? options.filter((option) => bezDiakritiky(`${option.label ?? ''} ${option.title ?? ''} ${option.value}`).includes(query))
    : options;
  const selected = options.find((option) => option.value === value);
  const shown = selected ? (selected.label || selected.title || selected.value) : '';
  const activeIdx = Math.min(active, Math.max(filtered.length - 1, 0));

  const pick = (next: string) => { onChange(next); setOpen(false); setSearch(''); };

  /** Zoznam ide pod bunku; keď tam nie je miesto, vyklopí sa nahor. */
  const popStyle = (): CSSProperties => {
    if (!kotva) return { visibility: 'hidden' };
    const podKotvou = window.innerHeight - kotva.bottom;
    const nahor = podKotvou < 300 && kotva.top > podKotvou;
    // Šírka zoznamu je daná obsahom (min 260, max 560 z CSS) a pred vykreslením
    // nie je známa. Pri pravom okraji sa preto zoznam kotví za PRAVÚ hranu bunky
    // a rastie doľava — ostane pri bunke bez ohľadu na skutočnú šírku.
    const priPravomOkraji = kotva.left + 568 > window.innerWidth;
    return {
      ...(priPravomOkraji
        ? { right: Math.max(8, window.innerWidth - kotva.right - 2) }
        : { left: Math.max(8, kotva.left - 2) }),
      minWidth: Math.max(kotva.width + 4, 260),
      maxHeight: (nahor ? kotva.top : podKotvou) - 14,
      ...(nahor ? { bottom: window.innerHeight - kotva.top + 4 } : { top: kotva.bottom + 4 }),
    };
  };

  return (
    <div ref={rootRef} className={`dk-pick${open ? ' dk-open' : ''}`}>
      <span
        role="button"
        tabIndex={disabled ? -1 : 0}
        title={title ?? (selected?.title || shown)}
        className={`dk-cell dk-pick-btn${align === 'right' ? ' dk-right' : ''}${disabled ? ' dk-cell-off' : ''}${shown ? '' : ' dk-cell-empty'}${srcClass}`}
        onClick={() => { if (!disabled) { setSearch(''); setActive(0); setOpen((current) => !current); } }}
        onKeyDown={(event) => {
          if (disabled) return;
          if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); setSearch(''); setOpen((current) => !current); }
          if (event.key === 'Escape') setOpen(false);
        }}
      >
        {shown || placeholder}
      </span>
      {open && createPortal(
        <div ref={popRef} className="dk-pick-pop" style={popStyle()}>
          {withSearch && (
            <input
              ref={searchRef}
              className="dk-pick-search"
              value={search}
              placeholder="Hľadať…"
              onChange={(event) => { setSearch(event.target.value); setActive(0); }}
              onKeyDown={(event) => {
                if (event.key === 'ArrowDown') { event.preventDefault(); setActive((a) => Math.min(a + 1, filtered.length - 1)); }
                else if (event.key === 'ArrowUp') { event.preventDefault(); setActive((a) => Math.max(a - 1, 0)); }
                else if (event.key === 'Enter') { event.preventDefault(); const option = filtered[activeIdx]; if (option) pick(option.value); }
                else if (event.key === 'Escape') { event.preventDefault(); setOpen(false); }
              }}
            />
          )}
          <div className="dk-pick-list">
            {filtered.map((option, index) => (
              <button
                key={option.value}
                type="button"
                className={`dk-pick-opt${option.value === value ? ' dk-selected' : ''}${index === activeIdx ? ' dk-active' : ''}`}
                title={option.title}
                onMouseEnter={() => setActive(index)}
                onClick={() => pick(option.value)}
              >
                <span className="dk-pick-tick">{option.value === value ? '✓' : ''}</span>
                {option.label || option.title || option.value}
              </button>
            ))}
            {filtered.length === 0 && <div className="dk-pick-empty">Žiadne výsledky</div>}
          </div>
          {onMostikSync && (
            <button type="button" className="dk-pick-sync" onClick={() => { setOpen(false); onMostikSync(); }}>
              Synchronizovať mostíkom
            </button>
          )}
        </div>,
        document.body,
      )}
    </div>
  );
}

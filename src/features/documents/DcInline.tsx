// Inline bunky editora dokladu — verne k `Cell.dc.html` a `Pick.dc.html`
// z Claude Design. Na rozdiel od `DcDropdown` nemajú vlastný popisok ani rám:
// sedia priamo v mriežke „popis vľavo, hodnota vpravo" ako v POHODE a rám
// dostanú až pri hovere/editácii.
import { useEffect, useLayoutEffect, useRef, useState } from 'react';

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
  const rootRef = useRef<HTMLDivElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!open) return undefined;
    const onDoc = (event: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', onDoc);
    return () => document.removeEventListener('mousedown', onDoc);
  }, [open]);

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
      {open && (
        <div className="dk-pick-pop">
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
        </div>
      )}
    </div>
  );
}

// Dropdown pre panel úpravy faktúry 1b — dva režimy: 'simple' (badge + label)
// a 'account' (karty predkontácií so syntetickým účtom). Vyhľadávanie, navigácia
// klávesnicou (↑↓ Enter Esc), zatvorenie klikom mimo. Verne k Dropdown.dc.html.
import { useEffect, useRef, useState } from 'react';

export interface DcOption {
  value: string;
  label?: string;
  title?: string;
  empty?: boolean;
  badge?: string;
  color?: string;
  synt?: string;
  anal?: string;
  agenda?: string;
  typDokladu?: string;
  predk?: string;
}

interface DcDropdownProps {
  label: string;
  value?: string;
  options: DcOption[];
  mode?: 'simple' | 'account';
  variant?: 'klasik' | 'karty';
  searchable?: boolean;
  confidence?: number;
  error?: boolean;
  placeholder?: string;
  disabled?: boolean;
  onChange: (value: string) => void;
}

const Check = ({ size = 14, width = 3 }: { size?: number; width?: number }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={width} strokeLinecap="round" strokeLinejoin="round"><path d="M20 6L9 17l-5-5" /></svg>
);

function bezDiakritiky(value: unknown): string {
  return String(value ?? '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
}

export function DcDropdown({
  label, value, options, mode = 'simple', variant = 'karty',
  searchable = false, confidence, error = false, placeholder = 'Vyberte…', disabled = false, onChange,
}: DcDropdownProps) {
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState('');
  const [active, setActive] = useState(0);
  const rootRef = useRef<HTMLDivElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);

  const isSearchable = searchable || mode === 'account';
  const isKarty = variant === 'karty';

  useEffect(() => {
    if (!open) return undefined;
    const onDoc = (event: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', onDoc);
    return () => document.removeEventListener('mousedown', onDoc);
  }, [open]);

  const query = bezDiakritiky(search).trim();
  const filtered = query
    ? options.filter((option) => bezDiakritiky([option.label, option.title, option.value, option.synt, option.anal, option.predk, option.agenda].filter(Boolean).join(' ')).includes(query))
    : options;

  const selected = options.find((option) => option.value === value) ?? null;
  const isPlaceholder = !selected || selected.empty;
  const selectedText = selected ? (selected.title || selected.label || '') : placeholder;

  const toggle = () => {
    if (disabled) return;
    const willOpen = !open;
    const selIdx = options.findIndex((option) => option.value === value);
    setSearch('');
    setActive(selIdx >= 0 ? selIdx : 0);
    setOpen(willOpen);
    if (willOpen) setTimeout(() => searchRef.current?.focus(), 40);
  };

  const pick = (v: string) => { onChange(v); setOpen(false); };

  const onKey = (event: React.KeyboardEvent) => {
    if (event.key === 'ArrowDown') { event.preventDefault(); setActive((a) => Math.min(a + 1, filtered.length - 1)); }
    else if (event.key === 'ArrowUp') { event.preventDefault(); setActive((a) => Math.max(a - 1, 0)); }
    else if (event.key === 'Enter') { event.preventDefault(); const opt = filtered[active]; if (opt) pick(opt.value); }
    else if (event.key === 'Escape') { event.preventDefault(); setOpen(false); }
  };

  const activeIdx = Math.min(active, Math.max(filtered.length - 1, 0));

  return (
    <div ref={rootRef} className={`dv-dd${open ? ' dv-dd-open' : ''}`}>
      <button type="button" className="dv-dd-btn" onClick={toggle} disabled={disabled}>
        <span className="dv-label">{label}</span>
        {confidence != null && (
          <span className="dv-dd-conf"><Check size={11} />{confidence} %</span>
        )}
        {selected?.badge && (
          <span className="dv-dd-badge" style={{ background: selected.color ?? '#0E7A5F' }}>{selected.badge}</span>
        )}
        <span className={`dv-dd-text${isPlaceholder ? ' dv-placeholder' : ''}`}>{selectedText}</span>
        <svg className="dv-dd-caret" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M6 9l6 6 6-6" /></svg>
      </button>
      <div className="dv-dd-pop">
        {isSearchable && (
          <div className="dv-dd-search">
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="11" cy="11" r="7" /><path d="M21 21l-4.3-4.3" /></svg>
            <input ref={searchRef} value={search} placeholder="Hľadať…" onChange={(e) => { setSearch(e.target.value); setActive(0); }} onKeyDown={onKey} />
          </div>
        )}
        <div className="dv-dd-list">
          {filtered.map((option, index) => {
            const isSelected = option.value === value;
            const isActive = index === activeIdx;
            const cls = `${isSelected ? ' dv-selected' : ''}${isActive ? ' dv-active' : ''}`;
            if (mode === 'account' && !option.empty && isKarty) {
              return (
                <button key={option.value} type="button" className={`dv-card${cls}`} onClick={() => pick(option.value)} onMouseEnter={() => setActive(index)}>
                  <div className="dv-card-top">
                    <span className="dv-card-synt" style={{ background: option.color ?? '#5C645F' }}>{option.synt || '—'}</span>
                    <div className="dv-card-main">
                      <div className="dv-card-title">{option.title || option.label}</div>
                      {option.predk && <div className="dv-card-sub">Predkontácia {option.predk}</div>}
                    </div>
                    {isSelected && <span className="dv-card-check"><Check size={11} /></span>}
                  </div>
                  {(option.anal || option.agenda) && (
                    <div className="dv-card-pills">
                      {option.anal && <span className="dv-pill">Analytický {option.anal}</span>}
                      {option.agenda && <span className="dv-pill">{option.agenda}</span>}
                      {option.typDokladu && <span className="dv-pill">{option.typDokladu}</span>}
                    </div>
                  )}
                </button>
              );
            }
            return (
              <button key={option.value} type="button" className={`dv-opt${cls}`} onClick={() => pick(option.value)} onMouseEnter={() => setActive(index)}>
                {option.badge && <span className="dv-opt-badge" style={{ background: option.color ?? '#5C645F' }}>{option.badge}</span>}
                <span className="dv-opt-label">{option.title || option.label}</span>
                {isSelected && <span className="dv-opt-check"><Check /></span>}
              </button>
            );
          })}
          {filtered.length === 0 && (
            <div className="dv-dd-empty">Žiadne výsledky pre „{search}“</div>
          )}
        </div>
      </div>
    </div>
  );
}

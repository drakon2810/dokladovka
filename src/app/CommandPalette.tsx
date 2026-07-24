// Príkazová paleta (⌘K) — Aurora 2a. Fuzzy skok na akcie, organizácie, doklady
// a stránky. Číta reálne dáta z useDataQuery, žiadny nový backend.
import { useEffect, useMemo, useRef, useState } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import { useNavigate } from 'react-router-dom';
import type { DocumentItem, Organization, Role } from '../data/types';
import { t } from '../i18n/sk';

const stroke = {
  fill: 'none',
  stroke: 'currentColor',
  strokeWidth: 1.9,
  strokeLinecap: 'round',
  strokeLinejoin: 'round',
} as const;

function norm(value: string): string {
  return value
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLocaleLowerCase('sk')
    .trim();
}

interface PaletteItem {
  id: string;
  group: string;
  title: string;
  subtitle?: string;
  icon: JSX.Element;
  dot?: string;
  run: () => void;
}

interface CommandPaletteProps {
  open: boolean;
  onClose: () => void;
  organizations: Organization[];
  documents: DocumentItem[];
  role: Role;
  onPickOrg: (organizationId: string) => void;
  onAddDocument: () => void;
}

const IconSearch = (
  <svg width="18" height="18" viewBox="0 0 24 24" {...stroke} strokeWidth={2}>
    <circle cx="11" cy="11" r="8" />
    <path d="m21 21-4.3-4.3" />
  </svg>
);

export function CommandPalette({
  open,
  onClose,
  organizations,
  documents,
  role,
  onPickOrg,
  onAddDocument,
}: CommandPaletteProps) {
  const navigate = useNavigate();
  const [query, setQuery] = useState('');
  const [active, setActive] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (open) {
      setQuery('');
      setActive(0);
      const id = window.setTimeout(() => inputRef.current?.focus(), 20);
      return () => window.clearTimeout(id);
    }
    return undefined;
  }, [open]);

  const naKontroleFor = (organizationId: string) =>
    documents.filter(
      (document) =>
        document.orgId === organizationId &&
        (document.status === 'na_kontrole' || document.status === 'extrahovany'),
    ).length;

  const items = useMemo<PaletteItem[]>(() => {
    const go = (path: string) => () => {
      navigate(path);
      onClose();
    };
    const iconDoc = (
      <svg width="16" height="16" viewBox="0 0 24 24" {...stroke}>
        <path d="M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z" />
        <path d="M14 2v4a2 2 0 0 0 2 2h4" />
        <path d="M16 13H8" />
        <path d="M16 17H8" />
      </svg>
    );
    const list: PaletteItem[] = [];

    if (role !== 'schvalovatel') {
      list.push({
        id: 'a-add',
        group: t('pal.akcie'),
        title: t('pal.pridatDoklad'),
        subtitle: t('pal.pridatPopis'),
        icon: (
          <svg width="16" height="16" viewBox="0 0 24 24" {...stroke} strokeWidth={2.2}>
            <path d="M12 5v14" />
            <path d="M5 12h14" />
          </svg>
        ),
        run: () => {
          onAddDocument();
          onClose();
        },
      });
    }
    list.push({
      id: 'a-export',
      group: t('pal.akcie'),
      title: t('pal.exportPohoda'),
      subtitle: t('pal.exportPopis'),
      icon: (
        <svg width="16" height="16" viewBox="0 0 24 24" {...stroke}>
          <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
          <polyline points="7 10 12 15 17 10" />
          <line x1="12" x2="12" y1="15" y2="3" />
        </svg>
      ),
      run: go('/export'),
    });

    for (const org of organizations.filter((o) => !o.archived)) {
      const count = naKontroleFor(org.id);
      list.push({
        id: `org-${org.id}`,
        group: t('pal.organizacie'),
        title: org.nazov,
        subtitle: `${t('pal.prepnut')} · ${count} ${t('pal.naKontrole')}`,
        icon: <span />,
        dot: org.farba,
        run: () => {
          onPickOrg(org.id);
          navigate('/doklady');
          onClose();
        },
      });
    }

    const recent = [...documents]
      .filter((d) => d.status !== 'zamietnuty')
      .sort((a, b) => (a.prijateDna < b.prijateDna ? 1 : -1))
      .slice(0, 8);
    for (const document of recent) {
      const overdue =
        !!document.extracted.datumSplatnosti &&
        document.extracted.datumSplatnosti < new Date().toISOString().slice(0, 10);
      list.push({
        id: `doc-${document.id}`,
        group: t('pal.doklady'),
        title: `${document.extracted.dodavatel.nazov} — ${document.extracted.sumaSpolu.toLocaleString('sk-SK', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} €`,
        subtitle: `${document.typ} · VS ${document.extracted.variabilnySymbol ?? '—'}${overdue ? ` · ${t('platby.stav.po_splatnosti').toLowerCase()}` : ''}`,
        icon: iconDoc,
        run: () => {
          onPickOrg(document.orgId);
          navigate(`/doklady/${document.id}`);
          onClose();
        },
      });
    }

    const pages: Array<[string, string]> = [
      ['/', t('nav.prehlad')],
      ['/doklady', t('nav.doklady')],
      ['/nespracovane', t('nav.nespracovane')],
      ['/dokumenty', t('nav.dokumenty')],
      ['/partneri', t('nav.partneri')],
      ['/uhrady', t('nav.uhrady')],
      ['/export', t('nav.export')],
    ];
    if (role === 'admin') pages.push(['/nastavenia', t('nav.nastavenia')]);
    for (const [path, label] of pages) {
      list.push({
        id: `page-${path}`,
        group: t('pal.stranky'),
        title: label,
        icon: iconDoc,
        run: go(path),
      });
    }
    return list;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [organizations, documents, role]);

  const filtered = useMemo(() => {
    const q = norm(query);
    if (!q) return items;
    return items.filter((item) => norm(`${item.title} ${item.subtitle ?? ''} ${item.group}`).includes(q));
  }, [items, query]);

  useEffect(() => {
    setActive((current) => Math.min(current, Math.max(0, filtered.length - 1)));
  }, [filtered.length]);

  const grouped: Array<{ group: string; items: PaletteItem[] }> = [];
  filtered.forEach((item) => {
    const bucket = grouped.find((g) => g.group === item.group);
    if (bucket) bucket.items.push(item);
    else grouped.push({ group: item.group, items: [item] });
  });

  const onKeyDown = (event: React.KeyboardEvent) => {
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      setActive((current) => Math.min(filtered.length - 1, current + 1));
    } else if (event.key === 'ArrowUp') {
      event.preventDefault();
      setActive((current) => Math.max(0, current - 1));
    } else if (event.key === 'Enter') {
      event.preventDefault();
      filtered[active]?.run();
    } else if (event.key === 'Escape') {
      event.preventDefault();
      onClose();
    }
  };

  return (
    <AnimatePresence>
      {open && (
      <motion.div
        className="fixed inset-0 z-[70] flex items-start justify-center px-4 pt-[14vh]"
        style={{ background: 'rgba(16,25,21,0.34)', backdropFilter: 'blur(4px)' }}
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        exit={{ opacity: 0 }}
        transition={{ duration: 0.16 }}
        onMouseDown={(event) => {
          if (event.target === event.currentTarget) onClose();
        }}
        onKeyDown={(event) => {
          if (event.key === 'Escape') {
            event.preventDefault();
            onClose();
          }
        }}
        role="dialog"
        aria-modal="true"
        aria-label={t('topbar.prikazovaPaleta')}
      >
        <motion.div
          className="w-[620px] max-w-full overflow-hidden rounded-2xl border border-line bg-surface/95 shadow-pop backdrop-blur-xl"
          initial={{ opacity: 0, y: -10, scale: 0.98 }}
          animate={{ opacity: 1, y: 0, scale: 1 }}
          exit={{ opacity: 0, y: -8, scale: 0.98 }}
          transition={{ duration: 0.18, ease: [0.32, 0.72, 0, 1] }}
        >
          <div className="flex items-center gap-3 border-b border-line-soft px-4 py-3.5">
            <span className="text-accent">{IconSearch}</span>
            <input
              ref={inputRef}
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              onKeyDown={onKeyDown}
              placeholder={t('pal.placeholder')}
              className="flex-1 border-0 bg-transparent text-[15px] font-medium text-ink outline-none placeholder:text-ink-faint"
              aria-label={t('pal.placeholder')}
              role="combobox"
              aria-expanded={filtered.length > 0}
              aria-controls="cmdk-listbox"
              aria-activedescendant={filtered[active] ? `cmdk-opt-${filtered[active].id}` : undefined}
              aria-autocomplete="list"
            />
            <kbd className="rounded-md border border-line bg-app px-1.5 py-0.5 text-[10.5px] font-semibold text-ink-faint">
              ESC
            </kbd>
          </div>
          <div id="cmdk-listbox" role="listbox" aria-label={t('topbar.prikazovaPaleta')} className="max-h-[46vh] overflow-y-auto p-2">
            {filtered.length === 0 ? (
              <p className="px-3 py-8 text-center text-sm text-ink-faint">{t('pal.ziadneVysledky')}</p>
            ) : (
              grouped.map((bucket) => (
                <div key={bucket.group}>
                  <p className="mb-0.5 mt-1.5 px-2 text-[10.5px] font-semibold uppercase tracking-wider text-ink-mute">
                    {bucket.group}
                  </p>
                  {bucket.items.map((item) => {
                    const index = filtered.indexOf(item);
                    const isActive = index === active;
                    return (
                      <button
                        key={item.id}
                        id={`cmdk-opt-${item.id}`}
                        role="option"
                        aria-selected={isActive}
                        tabIndex={-1}
                        type="button"
                        className={`flex w-full items-center gap-3 rounded-[10px] px-3 py-2.5 text-left transition ${
                          isActive ? 'bg-tint' : 'hover:bg-app'
                        }`}
                        onMouseMove={() => setActive(index)}
                        onClick={() => item.run()}
                      >
                        <span
                          className="grid h-[30px] w-[30px] shrink-0 place-items-center rounded-lg bg-app text-ink-soft"
                          aria-hidden
                        >
                          {item.dot ? (
                            <span
                              className="h-2.5 w-2.5 rounded-full"
                              style={{ backgroundColor: item.dot }}
                            />
                          ) : (
                            item.icon
                          )}
                        </span>
                        <span className="min-w-0 flex-1">
                          <span className="block truncate text-[13.5px] font-semibold text-ink">
                            {item.title}
                          </span>
                          {item.subtitle && (
                            <span className="mt-0.5 block truncate text-[11.5px] text-ink-faint">
                              {item.subtitle}
                            </span>
                          )}
                        </span>
                      </button>
                    );
                  })}
                </div>
              ))
            )}
          </div>
          <div className="flex items-center gap-4 border-t border-line-soft bg-surface-2 px-4 py-2.5 text-[11.5px] font-medium text-ink-faint">
            <span className="flex items-center gap-1.5">
              <kbd className="grid h-[18px] min-w-[18px] place-items-center rounded border border-line bg-surface px-1">↑</kbd>
              <kbd className="grid h-[18px] min-w-[18px] place-items-center rounded border border-line bg-surface px-1">↓</kbd>
              {t('pal.pohyb')}
            </span>
            <span className="flex items-center gap-1.5">
              <kbd className="grid h-[18px] min-w-[18px] place-items-center rounded border border-line bg-surface px-1">↵</kbd>
              {t('pal.otvorit')}
            </span>
            <span className="ml-auto font-semibold text-ink-mute">Dokladovka ⌘K</span>
          </div>
        </motion.div>
      </motion.div>
      )}
    </AnimatePresence>
  );
}

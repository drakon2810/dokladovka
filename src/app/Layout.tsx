// Layout — Aurora 2a redizajn shellu. Logika (useDataQuery, setCurrentOrg,
// modály, role, routovanie) nedotknutá; nové sú štýly a interakcie:
// kĺzavý pill-indikátor (framer-motion), accordion fronty, glass topbar,
// vyhľadávací dropdown, notifikácie a príkazová paleta (⌘K).
import { useEffect, useRef, useState } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import { NavLink, Outlet, useLocation, useNavigate } from 'react-router-dom';
import { setCurrentOrg } from '../data/api';
import { useDataQuery } from '../data/query';
import { t } from '../i18n/sk';
import { OrgDot, ToastViewport } from '../components/ui';
import { showToast } from '../components/toast';
import { DocumentCreateModal } from '../features/documents/DocumentCreateModal';
import { OrganizationFormModal } from '../features/settings/OrganizationsTab';
import { useAuth } from '../auth/AuthContext';
import { AUTH_MODE } from '../auth/config';
import { CommandPalette } from './CommandPalette';

const stroke = { fill: 'none', stroke: 'currentColor', strokeWidth: 1.9, strokeLinecap: 'round', strokeLinejoin: 'round' } as const;

function IconPrehlad() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" {...stroke} className="shrink-0" aria-hidden>
      <rect width="7" height="9" x="3" y="3" rx="1.5" /><rect width="7" height="5" x="14" y="3" rx="1.5" />
      <rect width="7" height="9" x="14" y="12" rx="1.5" /><rect width="7" height="5" x="3" y="16" rx="1.5" />
    </svg>
  );
}
function IconDoklady() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" {...stroke} className="shrink-0" aria-hidden>
      <path d="M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z" /><path d="M14 2v4a2 2 0 0 0 2 2h4" />
      <path d="M10 9H8" /><path d="M16 13H8" /><path d="M16 17H8" />
    </svg>
  );
}
function IconExport() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" {...stroke} className="shrink-0" aria-hidden>
      <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" /><polyline points="7 10 12 15 17 10" /><line x1="12" x2="12" y1="15" y2="3" />
    </svg>
  );
}
function IconNespracovane() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" {...stroke} className="shrink-0" aria-hidden>
      <path d="M22 12h-6l-2 3h-4l-2-3H2" />
      <path d="M5.45 5.11 2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.45-6.89A2 2 0 0 0 16.76 4H7.24a2 2 0 0 0-1.79 1.11z" />
    </svg>
  );
}
function IconDokumenty() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" {...stroke} className="shrink-0" aria-hidden>
      <path d="M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z" />
    </svg>
  );
}
function IconPartneri() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" {...stroke} className="shrink-0" aria-hidden>
      <path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2" />
      <circle cx="9" cy="7" r="4" />
      <path d="M22 21v-2a4 4 0 0 0-3-3.87" />
      <path d="M16 3.13a4 4 0 0 1 0 7.75" />
    </svg>
  );
}
function IconUhrady() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" {...stroke} className="shrink-0" aria-hidden>
      <rect width="20" height="12" x="2" y="6" rx="2" />
      <circle cx="12" cy="12" r="2" />
      <path d="M6 12h.01M18 12h.01" />
    </svg>
  );
}
function IconNastavenia() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" {...stroke} className="shrink-0" aria-hidden>
      <path d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z" />
      <circle cx="12" cy="12" r="3" />
    </svg>
  );
}
function IconBell() {
  return (
    <svg width="19" height="19" viewBox="0 0 24 24" {...stroke} aria-hidden>
      <path d="M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9" />
      <path d="M10.3 21a1.94 1.94 0 0 0 3.4 0" />
    </svg>
  );
}
function IconMail() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" {...stroke} aria-hidden>
      <rect width="20" height="15" x="2" y="4.5" rx="2.5" />
      <path d="m22 7-8.97 5.7a1.94 1.94 0 0 1-2.06 0L2 7" />
    </svg>
  );
}
function IconAlert() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" {...stroke} aria-hidden>
      <path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z" />
      <path d="M12 9v4" /><path d="M12 17h.01" />
    </svg>
  );
}
function IconClock() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" {...stroke} aria-hidden>
      <circle cx="12" cy="12" r="9" /><path d="M12 7.5V12l3 1.8" />
    </svg>
  );
}

const NAV_ITEMS = [
  { to: '/', label: 'nav.prehlad', icon: <IconPrehlad />, end: true, badge: false },
  { to: '/doklady', label: 'nav.doklady', icon: <IconDoklady />, end: false, badge: true },
  { to: '/nespracovane', label: 'nav.nespracovane', icon: <IconNespracovane />, end: false, badge: false },
  { to: '/dokumenty', label: 'nav.dokumenty', icon: <IconDokumenty />, end: false, badge: false },
  { to: '/partneri', label: 'nav.partneri', icon: <IconPartneri />, end: false, badge: false },
  { to: '/uhrady', label: 'nav.uhrady', icon: <IconUhrady />, end: false, badge: false },
  { to: '/export', label: 'nav.export', icon: <IconExport />, end: false, badge: false },
] as const;

const RECENT_KEY = 'dokladovka.recentSearch';

function loadRecent(): string[] {
  try {
    const raw = localStorage.getItem(RECENT_KEY);
    const parsed = raw ? (JSON.parse(raw) as unknown) : [];
    return Array.isArray(parsed) ? parsed.filter((x): x is string => typeof x === 'string').slice(0, 3) : [];
  } catch {
    return [];
  }
}

function timeAgo(iso: string): string {
  const diff = Date.now() - Date.parse(iso);
  if (!Number.isFinite(diff) || diff < 0) return 'nedávno';
  const min = Math.round(diff / 60000);
  if (min < 1) return 'teraz';
  if (min < 60) return `pred ${min} min`;
  const hours = Math.round(min / 60);
  if (hours < 24) return `pred ${hours} h`;
  return `pred ${Math.round(hours / 24)} d`;
}

export function Layout() {
  const [collapsed, setCollapsed] = useState(false);
  const [orgMenuOpen, setOrgMenuOpen] = useState(false);
  const [documentModalOpen, setDocumentModalOpen] = useState(false);
  const [documentModalOrganizationId, setDocumentModalOrganizationId] = useState<string>();
  const [organizationModalOpen, setOrganizationModalOpen] = useState(false);
  const [profileMenuOpen, setProfileMenuOpen] = useState(false);
  const [searchOpen, setSearchOpen] = useState(false);
  const [notifOpen, setNotifOpen] = useState(false);
  // Počet notifikácií „videných" pri poslednom otvorení zvončeka; bejdž sa
  // znovu rozsvieti, keď notifCount prekročí túto hodnotu (prídu nové doklady).
  const [notifSeen, setNotifSeen] = useState(0);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [collapsedGroups, setCollapsedGroups] = useState<Set<string>>(() => new Set());
  const [recentSearches, setRecentSearches] = useState<string[]>(() => loadRecent());
  const orgMenuRef = useRef<HTMLDivElement>(null);
  const profileMenuRef = useRef<HTMLDivElement>(null);
  const searchRef = useRef<HTMLDivElement>(null);
  const notifRef = useRef<HTMLDivElement>(null);
  const navigate = useNavigate();
  const location = useLocation();
  const { session, logout } = useAuth();

  const { data } = useDataQuery();
  const role = session?.user.role ?? data?.role ?? 'uctovnik';
  const currentOrgId = data?.currentOrgId ?? 'all';
  const organizations = data?.organizations ?? [];
  const queues = data?.queues ?? [];
  const documents = data?.documents ?? [];

  const activeOrgs = organizations.filter((o) => !o.archived);
  const currentOrg = organizations.find((o) => o.id === currentOrgId);
  const userName = session?.user.name ?? '—';
  const activeQueueId = new URLSearchParams(location.search).get('fronta');

  const countNaKontrolu = (orgId: string) =>
    documents.filter(
      (d) => d.orgId === orgId && (d.status === 'na_kontrole' || d.status === 'extrahovany'),
    ).length;

  const naKontroleTotal = activeOrgs.reduce((sum, o) => sum + countNaKontrolu(o.id), 0);
  const problemDocs = documents.filter(
    (d) =>
      d.status === 'chyba' ||
      d.status === 'karantena' ||
      d.status === 'duplicita' ||
      d.processingStatus.startsWith('failed'),
  );
  const recentEmailDocs = [...documents]
    .filter((d) => d.zdroj.typ === 'email' && d.status !== 'zamietnuty')
    .sort((a, b) => (a.prijateDna < b.prijateDna ? 1 : -1))
    .slice(0, 3);
  const notifCount = naKontroleTotal + problemDocs.length;

  const chooseOrganization = (organizationId: string) => {
    void setCurrentOrg(organizationId);
    if (location.pathname.startsWith('/doklady')) {
      const params = new URLSearchParams(location.search);
      params.delete('fronta');
      navigate({ pathname: '/doklady', search: params.toString() });
    }
  };

  const runSearch = (raw: string) => {
    const q = raw.trim();
    setSearchOpen(false);
    if (q) {
      setRecentSearches((current) => {
        const next = [q, ...current.filter((item) => item !== q)].slice(0, 3);
        try {
          localStorage.setItem(RECENT_KEY, JSON.stringify(next));
        } catch {
          /* ignore */
        }
        return next;
      });
    }
    navigate(`/doklady?q=${encodeURIComponent(q)}`);
  };

  const applyQuickFilter = (search: string) => {
    setSearchOpen(false);
    navigate(`/doklady${search}`);
  };

  useEffect(() => {
    const onClick = (e: MouseEvent) => {
      const target = e.target as Node;
      if (orgMenuRef.current && !orgMenuRef.current.contains(target)) setOrgMenuOpen(false);
      if (profileMenuRef.current && !profileMenuRef.current.contains(target)) setProfileMenuOpen(false);
      if (searchRef.current && !searchRef.current.contains(target)) setSearchOpen(false);
      if (notifRef.current && !notifRef.current.contains(target)) setNotifOpen(false);
    };
    document.addEventListener('mousedown', onClick);
    return () => document.removeEventListener('mousedown', onClick);
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && (e.key === 'k' || e.key === 'K')) {
        e.preventDefault();
        setPaletteOpen(true);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const toggleGroup = (orgId: string) =>
    setCollapsedGroups((current) => {
      const next = new Set(current);
      if (next.has(orgId)) next.delete(orgId);
      else next.add(orgId);
      return next;
    });

  return (
    <div className="flex min-h-screen">
      {/* Sidebar */}
      <aside
        className={`flex shrink-0 flex-col border-r border-line bg-gradient-to-b from-surface to-surface-2 transition-all duration-300 ${
          collapsed ? 'w-[72px]' : 'w-[264px]'
        }`}
        style={{ boxShadow: '8px 0 30px -22px rgba(16,32,27,.4)' }}
      >
        <div className={`flex h-16 items-center gap-2.5 border-b border-line-soft ${collapsed ? 'justify-center px-2' : 'px-4'}`}>
          <span
            className="grid h-9 w-9 shrink-0 place-items-center rounded-[11px] bg-gradient-to-br from-accent-bright to-accent text-white shadow-glow"
            style={{ boxShadow: '0 6px 14px -6px rgba(14,122,95,.6), inset 0 1px 0 rgba(255,255,255,.25)' }}
            aria-hidden
          >
            <svg width="18" height="18" viewBox="0 0 24 24" {...stroke} stroke="white">
              <path d="M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z" /><path d="M14 2v4a2 2 0 0 0 2 2h4" />
              <path d="M16 13H8" /><path d="M16 17H8" />
            </svg>
          </span>
          {!collapsed && (
            <span className="whitespace-nowrap text-[17px] font-bold tracking-tight">{t('app.nazov')}</span>
          )}
        </div>

        {/* Prepínač organizácie */}
        <div className="relative border-b border-line-soft p-3" ref={orgMenuRef}>
          <button
            type="button"
            className={`flex w-full items-center gap-2.5 rounded-[11px] border border-line bg-surface px-2.5 py-2 text-left text-sm transition hover:border-[#A7D9C9] hover:shadow-card ${
              collapsed ? 'justify-center' : ''
            }`}
            onClick={() => setOrgMenuOpen((v) => !v)}
            aria-label={t('org.prepnut')}
            aria-expanded={orgMenuOpen}
            title={currentOrg ? currentOrg.nazov : t('org.vsetky')}
          >
            {currentOrg ? (
              <>
                <OrgDot org={currentOrg} size={9} />
                {!collapsed && <span className="flex-1 truncate font-semibold">{currentOrg.nazov}</span>}
              </>
            ) : (
              <>
                <span className="inline-block h-2.5 w-2.5 shrink-0 rounded-full bg-ink-soft" aria-hidden />
                {!collapsed && <span className="flex-1 truncate font-semibold">{t('org.vsetky')}</span>}
              </>
            )}
            {!collapsed && (
              <svg
                width="14" height="14" viewBox="0 0 24 24" {...stroke} strokeWidth={2}
                className={`shrink-0 text-ink-faint transition-transform ${orgMenuOpen ? 'rotate-180' : ''}`}
                aria-hidden
              >
                <path d="m6 9 6 6 6-6" />
              </svg>
            )}
          </button>
          <AnimatePresence>
            {orgMenuOpen && (
              <motion.div
                initial={{ opacity: 0, y: -6, scale: 0.985 }}
                animate={{ opacity: 1, y: 0, scale: 1 }}
                exit={{ opacity: 0, y: -6, scale: 0.985 }}
                transition={{ duration: 0.16, ease: [0.32, 0.72, 0, 1] }}
                className="absolute left-3 right-3 z-40 mt-1.5 max-h-80 overflow-y-auto rounded-xl border border-line bg-surface p-1.5 shadow-pop"
              >
                <button
                  type="button"
                  className={`flex w-full items-center gap-2.5 rounded-[9px] px-2.5 py-2 text-left text-sm transition hover:bg-app ${
                    currentOrgId === 'all' ? 'bg-tint font-semibold text-accent-hover' : ''
                  }`}
                  onClick={() => {
                    chooseOrganization('all');
                    setOrgMenuOpen(false);
                  }}
                >
                  <span className="inline-block h-2 w-2 rounded-full bg-ink-soft" aria-hidden />
                  <span className="flex-1">{t('org.vsetky')}</span>
                  <span className="tnum text-xs text-accent-hover">{naKontroleTotal}</span>
                </button>
                {activeOrgs.map((org) => (
                  <div key={org.id} className="flex items-center rounded-[9px] transition hover:bg-app">
                    <button
                      type="button"
                      className={`flex min-w-0 flex-1 items-center gap-2.5 rounded-[9px] px-2.5 py-2 text-left text-sm ${
                        currentOrgId === org.id ? 'bg-tint font-semibold text-accent-hover' : ''
                      }`}
                      onClick={() => {
                        chooseOrganization(org.id);
                        setOrgMenuOpen(false);
                      }}
                    >
                      <OrgDot org={org} size={8} />
                      <span className="flex-1 truncate">{org.nazov}</span>
                      <span className="tnum rounded-full bg-app px-2 py-0.5 text-xs text-ink-soft">
                        {countNaKontrolu(org.id)}
                      </span>
                    </button>
                    {role !== 'schvalovatel' && (
                      <button
                        type="button"
                        className="mr-1 rounded px-2 py-1 text-accent transition hover:bg-tint"
                        aria-label={`${t('doklady.pridat')}: ${org.nazov}`}
                        title={t('doklady.pridat')}
                        onClick={() => {
                          setDocumentModalOrganizationId(org.id);
                          setDocumentModalOpen(true);
                          setOrgMenuOpen(false);
                        }}
                      >
                        +
                      </button>
                    )}
                  </div>
                ))}
              </motion.div>
            )}
          </AnimatePresence>
        </div>

        {/* Navigácia */}
        <nav className="flex-1 overflow-y-auto p-3">
          <div className="relative flex flex-col gap-1">
            {NAV_ITEMS.map((item) => (
              <NavLink
                key={item.to}
                to={item.to}
                end={item.end}
                className={({ isActive }) =>
                  `relative flex h-[38px] items-center gap-2.5 rounded-[11px] px-3 text-sm transition ${
                    collapsed ? 'justify-center' : ''
                  } ${isActive ? 'font-semibold text-accent-hover' : 'font-medium text-ink-soft hover:text-accent-hover'}`
                }
                title={t(item.label)}
              >
                {({ isActive }) => (
                  <>
                    {isActive && (
                      <motion.span
                        layoutId="navIndicator"
                        className="absolute inset-0 rounded-[11px] bg-tint"
                        style={{ boxShadow: 'inset 0 0 0 1px rgba(14,122,95,.15), inset 3px 0 0 #0E7A5F, 0 6px 14px -8px rgba(14,122,95,.45)' }}
                        transition={{ type: 'spring', stiffness: 520, damping: 40 }}
                        aria-hidden
                      />
                    )}
                    <span className="relative z-[1] flex shrink-0">{item.icon}</span>
                    {!collapsed && <span className="relative z-[1] flex-1 text-left">{t(item.label)}</span>}
                    {!collapsed && item.badge && naKontroleTotal > 0 && (
                      <span className="relative z-[1] inline-flex h-[19px] min-w-[19px] items-center justify-center rounded-[10px] bg-accent px-1.5 text-[11px] font-semibold text-white tnum">
                        {naKontroleTotal}
                      </span>
                    )}
                  </>
                )}
              </NavLink>
            ))}
            {role === 'admin' && (
              <NavLink
                to="/nastavenia"
                className={({ isActive }) =>
                  `relative flex h-[38px] items-center gap-2.5 rounded-[11px] px-3 text-sm transition ${
                    collapsed ? 'justify-center' : ''
                  } ${isActive ? 'font-semibold text-accent-hover' : 'font-medium text-ink-soft hover:text-accent-hover'}`
                }
                title={t('nav.nastavenia')}
              >
                {({ isActive }) => (
                  <>
                    {isActive && (
                      <motion.span
                        layoutId="navIndicator"
                        className="absolute inset-0 rounded-[11px] bg-tint"
                        style={{ boxShadow: 'inset 0 0 0 1px rgba(14,122,95,.15), inset 3px 0 0 #0E7A5F, 0 6px 14px -8px rgba(14,122,95,.45)' }}
                        transition={{ type: 'spring', stiffness: 520, damping: 40 }}
                        aria-hidden
                      />
                    )}
                    <span className="relative z-[1] flex shrink-0"><IconNastavenia /></span>
                    {!collapsed && <span className="relative z-[1] flex-1 text-left">{t('nav.nastavenia')}</span>}
                  </>
                )}
              </NavLink>
            )}
          </div>

          {!collapsed && (
            <div className="mt-5 border-t border-line-soft pt-4">
              <p className="mb-2 px-3 text-[11px] font-semibold uppercase tracking-widest text-ink-mute">
                {t('fronta.organizacie')}
              </p>
              {activeOrgs.map((org) => {
                const organizationQueues = queues.filter(
                  (queue) => queue.organizationId === org.id && queue.active,
                );
                const open = !collapsedGroups.has(org.id);
                return (
                  <div key={org.id} className="mb-1">
                    <div className="mb-0.5 flex w-full items-center gap-1 rounded-[9px] pr-2 transition hover:bg-app">
                      <button
                        type="button"
                        className="grid h-7 w-7 shrink-0 place-items-center rounded-[8px] text-ink-mute transition hover:text-ink"
                        onClick={() => toggleGroup(org.id)}
                        aria-expanded={open}
                        aria-label={open ? t('fronta.zbalit') : t('fronta.rozbalit')}
                      >
                        <svg
                          width="12" height="12" viewBox="0 0 24 24" {...stroke} strokeWidth={2}
                          className={`transition-transform duration-300 ${open ? '' : '-rotate-90'}`}
                          aria-hidden
                        >
                          <path d="m6 9 6 6 6-6" />
                        </svg>
                      </button>
                      <button
                        type="button"
                        className="flex min-w-0 flex-1 items-center gap-2 py-1.5 text-left text-xs font-semibold text-ink-soft transition hover:text-ink"
                        onClick={() => {
                          void setCurrentOrg(org.id);
                          navigate('/doklady');
                        }}
                        title={org.nazov}
                      >
                        <OrgDot org={org} size={7} />
                        <span className="min-w-0 flex-1 truncate">{org.nazov}</span>
                        <span className="tnum inline-flex h-[18px] min-w-[18px] items-center justify-center rounded-[9px] bg-tint px-1.5 text-[10.5px] font-semibold text-accent-hover">
                          {countNaKontrolu(org.id)}
                        </span>
                      </button>
                    </div>
                    <AnimatePresence initial={false}>
                      {open && (
                        <motion.div
                          initial={{ height: 0, opacity: 0 }}
                          animate={{ height: 'auto', opacity: 1 }}
                          exit={{ height: 0, opacity: 0 }}
                          transition={{ duration: 0.26, ease: [0.32, 0.72, 0, 1] }}
                          className="overflow-hidden"
                        >
                          {organizationQueues.map((queue) => {
                            const count = documents.filter((document) => document.queueId === queue.id).length;
                            const isActive =
                              location.pathname.startsWith('/doklady') && activeQueueId === queue.id;
                            return (
                              <NavLink
                                key={queue.id}
                                to={`/doklady?fronta=${encodeURIComponent(queue.id)}`}
                                onClick={() => void setCurrentOrg(org.id)}
                                className={`mb-0.5 flex items-center gap-2 rounded-[8px] py-1.5 pl-[33px] pr-2 text-xs transition ${
                                  isActive
                                    ? 'bg-tint font-semibold text-accent-hover'
                                    : 'text-ink-soft hover:bg-app hover:text-ink'
                                }`}
                                title={`${org.nazov} · ${queue.name}`}
                              >
                                <span className="min-w-0 flex-1 truncate">{queue.name}</span>
                                <span className={`tnum ${count === 0 ? 'text-ink-mute/70' : ''}`}>{count}</span>
                              </NavLink>
                            );
                          })}
                        </motion.div>
                      )}
                    </AnimatePresence>
                  </div>
                );
              })}
            </div>
          )}
        </nav>

        <div className="border-t border-line-soft p-3">
          <button
            type="button"
            className={`flex w-full items-center gap-2.5 rounded-[10px] px-3 py-2 text-xs font-medium text-ink-soft transition hover:bg-app hover:text-ink ${
              collapsed ? 'justify-center' : ''
            }`}
            onClick={() => setCollapsed((v) => !v)}
            aria-label={collapsed ? t('nav.rozbalit') : t('nav.zbalit')}
            title={collapsed ? t('nav.rozbalit') : t('nav.zbalit')}
          >
            <svg
              width="17" height="17" viewBox="0 0 24 24" {...stroke}
              className={`shrink-0 transition-transform duration-300 ${collapsed ? 'rotate-180' : ''}`}
              aria-hidden
            >
              <rect width="18" height="18" x="3" y="3" rx="2" /><path d="M9 3v18" /><path d="m16 15-3-3 3-3" />
            </svg>
            {!collapsed && t('nav.zbalit')}
          </button>
        </div>
      </aside>

      {/* Hlavná časť */}
      <div className="flex min-w-0 flex-1 flex-col">
        <header
          className="z-30 flex h-16 items-center gap-3.5 border-b border-line px-5"
          style={{ background: 'rgba(255,255,255,.72)', backdropFilter: 'blur(16px) saturate(1.5)', WebkitBackdropFilter: 'blur(16px) saturate(1.5)' }}
        >
          <div className="relative max-w-[420px] flex-1" ref={searchRef}>
            <form
              onSubmit={(e) => {
                e.preventDefault();
                runSearch(String(new FormData(e.currentTarget).get('q') ?? ''));
              }}
              role="search"
            >
              <svg
                width="16" height="16" viewBox="0 0 24 24" {...stroke} strokeWidth={2}
                className="pointer-events-none absolute left-3.5 top-1/2 -translate-y-1/2 text-ink-mute"
                aria-hidden
              >
                <circle cx="11" cy="11" r="8" /><path d="m21 21-4.3-4.3" />
              </svg>
              <input
                name="q"
                type="search"
                className="h-10 w-full rounded-[11px] border border-line bg-app pl-10 pr-16 text-sm text-ink outline-none transition placeholder:text-ink-faint focus:border-accent focus:bg-surface focus:ring-[3px] focus:ring-accent/15"
                placeholder={t('topbar.hladat')}
                aria-label={t('topbar.hladat')}
                onFocus={() => setSearchOpen(true)}
              />
              <button
                type="button"
                className="absolute right-2 top-1/2 flex -translate-y-1/2 items-center rounded-md border border-line bg-surface px-1.5 py-1 text-[11px] font-semibold text-ink-faint transition hover:border-[#A7D9C9] hover:text-accent-hover"
                title={t('topbar.prikazovaPaleta')}
                onClick={() => {
                  setSearchOpen(false);
                  setPaletteOpen(true);
                }}
              >
                ⌘K
              </button>
            </form>
            <AnimatePresence>
              {searchOpen && (
                <motion.div
                  initial={{ opacity: 0, y: -6, scale: 0.99 }}
                  animate={{ opacity: 1, y: 0, scale: 1 }}
                  exit={{ opacity: 0, y: -6, scale: 0.99 }}
                  transition={{ duration: 0.15, ease: [0.32, 0.72, 0, 1] }}
                  className="absolute left-0 right-0 top-[calc(100%+8px)] z-50 rounded-xl border border-line bg-surface p-2 shadow-pop"
                >
                  {recentSearches.length > 0 && (
                    <>
                      <p className="mb-0.5 mt-1 px-2 text-[10.5px] font-semibold uppercase tracking-wider text-ink-mute">
                        {t('search.nedavne')}
                      </p>
                      {recentSearches.map((term) => (
                        <button
                          key={term}
                          type="button"
                          className="flex w-full items-center gap-2.5 rounded-lg px-2 py-2 text-left text-sm text-ink transition hover:bg-app"
                          onClick={() => runSearch(term)}
                        >
                          <svg width="14" height="14" viewBox="0 0 24 24" {...stroke} strokeWidth={2} className="text-ink-mute" aria-hidden>
                            <circle cx="11" cy="11" r="8" /><path d="m21 21-4.3-4.3" />
                          </svg>
                          {term}
                        </button>
                      ))}
                    </>
                  )}
                  <p className="mb-0.5 mt-1.5 px-2 text-[10.5px] font-semibold uppercase tracking-wider text-ink-mute">
                    {t('search.rychleFiltre')}
                  </p>
                  <button
                    type="button"
                    className="flex w-full items-center gap-2.5 rounded-lg px-2 py-2 text-left text-sm text-ink transition hover:bg-app"
                    onClick={() => applyQuickFilter('?tab=na_kontrole')}
                  >
                    <span className="h-1.5 w-1.5 rounded-full bg-amber-500" aria-hidden />
                    {t('doklady.tab.naKontrolu')}
                  </button>
                  <div className="mt-1 flex items-center justify-between border-t border-line-soft px-2 pb-1 pt-2 text-[11.5px] font-medium text-ink-faint">
                    {t('search.prikazovyRezim')}
                    <span className="inline-flex gap-1">
                      <kbd className="grid h-[19px] min-w-[19px] place-items-center rounded-md border border-line bg-app px-1 text-[11px] font-semibold">⌘</kbd>
                      <kbd className="grid h-[19px] min-w-[19px] place-items-center rounded-md border border-line bg-app px-1 text-[11px] font-semibold">K</kbd>
                    </span>
                  </div>
                </motion.div>
              )}
            </AnimatePresence>
          </div>

          <div className="ml-auto flex items-center gap-2.5">
            {role !== 'schvalovatel' && activeOrgs.length > 0 && (
              <button
                type="button"
                className="inline-flex h-[38px] items-center gap-1.5 whitespace-nowrap rounded-[10px] bg-gradient-to-br from-accent-bright to-accent px-3.5 text-[13px] font-semibold text-white shadow-glow transition hover:brightness-[1.06] active:translate-y-px"
                aria-label={t('topbar.pridatDoklad')}
                onClick={() => {
                  setDocumentModalOrganizationId(currentOrgId === 'all' ? undefined : currentOrgId);
                  setDocumentModalOpen(true);
                }}
              >
                <svg width="15" height="15" viewBox="0 0 24 24" {...stroke} strokeWidth={2.2} aria-hidden><path d="M12 5v14" /><path d="M5 12h14" /></svg>
                <span className="hidden xl:inline">{t('topbar.pridatDoklad')}</span>
              </button>
            )}
            {role === 'admin' && (
              <button
                type="button"
                className="inline-flex h-[38px] items-center gap-1.5 whitespace-nowrap rounded-[10px] border border-line bg-surface px-3.5 text-[13px] font-medium text-ink transition hover:border-[#A7D9C9] hover:text-accent-hover"
                aria-label={t('topbar.pridatOrganizaciu')}
                onClick={() => setOrganizationModalOpen(true)}
              >
                <svg width="15" height="15" viewBox="0 0 24 24" {...stroke} strokeWidth={2.2} aria-hidden><path d="M12 5v14" /><path d="M5 12h14" /></svg>
                <span className="hidden xl:inline">{t('topbar.pridatOrganizaciu')}</span>
              </button>
            )}

            {/* Notifikácie */}
            <div className="relative" ref={notifRef}>
              <button
                type="button"
                className="relative grid h-10 w-10 place-items-center rounded-[10px] border border-line bg-surface text-ink-soft transition hover:border-[#A7D9C9] hover:text-accent-hover"
                title={t('topbar.notifikacie')}
                aria-label={t('topbar.notifikacie')}
                aria-expanded={notifOpen}
                onClick={() => {
                  setNotifOpen((v) => !v);
                  setNotifSeen(notifCount);
                }}
              >
                <IconBell />
                {notifCount > notifSeen && (
                  <span className="tnum absolute -right-1.5 -top-1.5 flex h-[18px] min-w-[18px] items-center justify-center rounded-full bg-[#C0392B] px-1 text-[10.5px] font-bold text-white ring-2 ring-surface">
                    {notifCount}
                  </span>
                )}
              </button>
              <AnimatePresence>
                {notifOpen && (
                  <motion.div
                    initial={{ opacity: 0, y: -6, scale: 0.98 }}
                    animate={{ opacity: 1, y: 0, scale: 1 }}
                    exit={{ opacity: 0, y: -6, scale: 0.98 }}
                    transition={{ duration: 0.16, ease: [0.32, 0.72, 0, 1] }}
                    className="absolute right-0 top-[calc(100%+10px)] z-50 w-[366px] overflow-hidden rounded-2xl border border-line bg-surface shadow-pop"
                  >
                    <div className="flex items-center justify-between border-b border-line-soft px-4 py-3">
                      <span className="text-sm font-bold text-ink">{t('topbar.notifikacie')}</span>
                      <button
                        type="button"
                        className="text-xs font-semibold text-accent transition hover:text-accent-hover"
                        onClick={() => {
                          setNotifSeen(notifCount);
                          setNotifOpen(false);
                        }}
                      >
                        {t('topbar.oznacitPrecitane')}
                      </button>
                    </div>
                    <div className="max-h-[340px] overflow-y-auto p-1.5">
                      {notifCount === 0 && recentEmailDocs.length === 0 ? (
                        <p className="px-3 py-8 text-center text-sm text-ink-faint">{t('notif.prazdne')}</p>
                      ) : (
                        <>
                          {recentEmailDocs.length > 0 && (
                            <p className="mb-0.5 mt-1 px-2.5 text-[10.5px] font-semibold uppercase tracking-wider text-ink-mute">
                              {t('notif.noveEmaily')}
                            </p>
                          )}
                          {recentEmailDocs.map((document) => (
                            <button
                              key={document.id}
                              type="button"
                              className="flex w-full gap-3 rounded-[9px] px-2.5 py-2.5 text-left transition hover:bg-app"
                              onClick={() => {
                                setNotifOpen(false);
                                void setCurrentOrg(document.orgId);
                                navigate(`/doklady/${document.id}`);
                              }}
                            >
                              <span className="grid h-8 w-8 shrink-0 place-items-center rounded-[9px] bg-sky-50 text-sky-700" aria-hidden>
                                <IconMail />
                              </span>
                              <span className="min-w-0 flex-1">
                                <span className="block truncate text-[13px] font-medium text-ink">
                                  {t('notif.novyEmailom')} — {document.extracted.dodavatel.nazov}
                                </span>
                                <span className="mt-0.5 block text-[11.5px] text-ink-mute">{timeAgo(document.prijateDna)}</span>
                              </span>
                            </button>
                          ))}
                          {(naKontroleTotal > 0 || problemDocs.length > 0) && (
                            <p className="mb-0.5 mt-2 px-2.5 text-[10.5px] font-semibold uppercase tracking-wider text-ink-mute">
                              {t('notif.vyzadujePozornost')}
                            </p>
                          )}
                          {problemDocs.slice(0, 3).map((document) => (
                            <button
                              key={document.id}
                              type="button"
                              className="flex w-full gap-3 rounded-[9px] px-2.5 py-2.5 text-left transition hover:bg-app"
                              onClick={() => {
                                setNotifOpen(false);
                                void setCurrentOrg(document.orgId);
                                navigate(`/doklady/${document.id}`);
                              }}
                            >
                              <span className="grid h-8 w-8 shrink-0 place-items-center rounded-[9px] bg-red-50 text-red-700" aria-hidden>
                                <IconAlert />
                              </span>
                              <span className="min-w-0 flex-1">
                                <span className="block truncate text-[13px] font-medium text-ink">
                                  {t('notif.problemDoklad')} — {document.extracted.dodavatel.nazov}
                                </span>
                                <span className="mt-0.5 block text-[11.5px] text-ink-mute">{t(`status.${document.status}`)}</span>
                              </span>
                            </button>
                          ))}
                          {naKontroleTotal > 0 && (
                            <button
                              type="button"
                              className="flex w-full gap-3 rounded-[9px] px-2.5 py-2.5 text-left transition hover:bg-app"
                              onClick={() => {
                                setNotifOpen(false);
                                navigate('/doklady?tab=na_kontrole');
                              }}
                            >
                              <span className="grid h-8 w-8 shrink-0 place-items-center rounded-[9px] bg-amber-50 text-amber-700" aria-hidden>
                                <IconClock />
                              </span>
                              <span className="min-w-0 flex-1">
                                <span className="block truncate text-[13px] font-medium text-ink">
                                  {naKontroleTotal} · {t('notif.cakaNaKontrolu')}
                                </span>
                                <span className="mt-0.5 block text-[11.5px] text-ink-mute">{t('doklady.tab.naKontrolu')}</span>
                              </span>
                            </button>
                          )}
                        </>
                      )}
                    </div>
                    <button
                      type="button"
                      className="w-full border-t border-line-soft bg-surface-2 py-3 text-xs font-semibold text-accent transition hover:text-accent-hover"
                      onClick={() => {
                        setNotifOpen(false);
                        navigate('/doklady?tab=na_kontrole');
                      }}
                    >
                      {t('topbar.vsetkyNotifikacie')}
                    </button>
                  </motion.div>
                )}
              </AnimatePresence>
            </div>

            {AUTH_MODE === 'demo' && (
              <span className="hidden items-center gap-1.5 whitespace-nowrap rounded-full border border-amber-300 bg-amber-50 px-2.5 py-1 text-[11px] font-semibold text-amber-800 lg:inline-flex">
                <span className="h-1.5 w-1.5 rounded-full bg-amber-600" aria-hidden />
                {t('auth.demo')}
              </span>
            )}
            <span className="hidden rounded-lg bg-[#EEF1EE] px-2.5 py-1.5 text-xs font-medium text-ink-soft lg:inline">
              {t(`rola.${role}`)}
            </span>
            <div className="relative" ref={profileMenuRef}>
              <button
                type="button"
                className="grid h-10 w-10 place-items-center rounded-full bg-gradient-to-br from-accent-bright to-accent text-sm font-semibold text-white transition"
                style={{ boxShadow: '0 0 0 3px rgba(14,122,95,.12), inset 0 1px 0 rgba(255,255,255,.2)' }}
                title={userName}
                aria-label={userName}
                aria-expanded={profileMenuOpen}
                onClick={() => setProfileMenuOpen((value) => !value)}
              >
                {userName
                  .split(' ')
                  .map((part) => part[0])
                  .slice(0, 2)
                  .join('')}
              </button>
              <AnimatePresence>
                {profileMenuOpen && (
                  <motion.div
                    initial={{ opacity: 0, y: -6, scale: 0.98 }}
                    animate={{ opacity: 1, y: 0, scale: 1 }}
                    exit={{ opacity: 0, y: -6, scale: 0.98 }}
                    transition={{ duration: 0.16, ease: [0.32, 0.72, 0, 1] }}
                    className="absolute right-0 z-40 mt-2 w-64 rounded-2xl border border-line bg-surface p-1.5 shadow-pop"
                  >
                    <div className="border-b border-line-soft px-2.5 py-2.5">
                      <p className="font-medium text-ink">{userName}</p>
                      <p className="truncate text-xs text-ink-faint">{session?.user.email}</p>
                      <p className="mt-1 text-xs font-semibold text-accent">{t(`rola.${role}`)}</p>
                    </div>
                    <button
                      type="button"
                      className="mt-1 w-full rounded-[9px] px-2.5 py-2 text-left text-sm transition hover:bg-app"
                      onClick={() => {
                        setProfileMenuOpen(false);
                        navigate('/profil');
                      }}
                    >
                      {t('auth.profil')}
                    </button>
                    <button
                      type="button"
                      className="w-full rounded-[9px] px-2.5 py-2 text-left text-sm transition hover:bg-app"
                      onClick={() => {
                        setProfileMenuOpen(false);
                        void logout().then(() => navigate('/login', { replace: true }));
                      }}
                    >
                      {t('auth.odhlasit')}
                    </button>
                  </motion.div>
                )}
              </AnimatePresence>
            </div>
          </div>
        </header>
        <main className="min-w-0 flex-1 p-6">
          <Outlet />
        </main>
      </div>

      <CommandPalette
        open={paletteOpen}
        onClose={() => setPaletteOpen(false)}
        organizations={organizations}
        documents={documents}
        role={role}
        onPickOrg={(id) => void setCurrentOrg(id)}
        onAddDocument={() => {
          setDocumentModalOrganizationId(currentOrgId === 'all' ? undefined : currentOrgId);
          setDocumentModalOpen(true);
        }}
      />

      {documentModalOpen && (
        <DocumentCreateModal
          initialOrganizationId={documentModalOrganizationId}
          onClose={() => {
            setDocumentModalOpen(false);
            setDocumentModalOrganizationId(undefined);
          }}
          onCreated={(document) => {
            setDocumentModalOpen(false);
            setDocumentModalOrganizationId(undefined);
            void setCurrentOrg(document.orgId);
            navigate(`/doklady/${document.id}`);
          }}
        />
      )}

      {organizationModalOpen && (
        <OrganizationFormModal
          onClose={() => setOrganizationModalOpen(false)}
          onCreated={(result) => {
            setOrganizationModalOpen(false);
            void setCurrentOrg(result.organization.id);
            showToast(
              `${t('nast.org.vytvorena')} ${result.primaryEmailAlias.address}`,
              {
                actionLabel: t('akcia.kopirovat'),
                onAction: () => void navigator.clipboard.writeText(result.primaryEmailAlias.address),
              },
            );
          }}
        />
      )}
      <ToastViewport />
    </div>
  );
}

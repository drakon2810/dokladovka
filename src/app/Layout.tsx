// Layout — редизайн: та же логика (useDataQuery, setCurrentOrg, модалки, роли),
// обновлены только стили: сайдбар 264px с SVG-иконками, мягкие тени, скругления.
import { useEffect, useRef, useState } from 'react';
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

const stroke = { fill: 'none', stroke: 'currentColor', strokeWidth: 2, strokeLinecap: 'round', strokeLinejoin: 'round' } as const;

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
function IconNastavenia() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" {...stroke} className="shrink-0" aria-hidden>
      <path d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z" />
      <circle cx="12" cy="12" r="3" />
    </svg>
  );
}

const NAV_ITEMS = [
  { to: '/', label: 'nav.prehlad', icon: <IconPrehlad />, end: true },
  { to: '/doklady', label: 'nav.doklady', icon: <IconDoklady />, end: false },
  { to: '/nespracovane', label: 'nav.nespracovane', icon: <IconNespracovane />, end: false },
  { to: '/dokumenty', label: 'nav.dokumenty', icon: <IconDokumenty />, end: false },
  { to: '/export', label: 'nav.export', icon: <IconExport />, end: false },
] as const;

export function Layout() {
  const [collapsed, setCollapsed] = useState(false);
  const [orgMenuOpen, setOrgMenuOpen] = useState(false);
  const [documentModalOpen, setDocumentModalOpen] = useState(false);
  const [documentModalOrganizationId, setDocumentModalOrganizationId] = useState<string>();
  const [organizationModalOpen, setOrganizationModalOpen] = useState(false);
  const [profileMenuOpen, setProfileMenuOpen] = useState(false);
  const orgMenuRef = useRef<HTMLDivElement>(null);
  const profileMenuRef = useRef<HTMLDivElement>(null);
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

  const chooseOrganization = (organizationId: string) => {
    void setCurrentOrg(organizationId);
    if (location.pathname.startsWith('/doklady')) {
      const params = new URLSearchParams(location.search);
      params.delete('fronta');
      navigate({ pathname: '/doklady', search: params.toString() });
    }
  };

  useEffect(() => {
    const onClick = (e: MouseEvent) => {
      if (orgMenuRef.current && !orgMenuRef.current.contains(e.target as Node)) {
        setOrgMenuOpen(false);
      }
      if (profileMenuRef.current && !profileMenuRef.current.contains(e.target as Node)) {
        setProfileMenuOpen(false);
      }
    };
    document.addEventListener('mousedown', onClick);
    return () => document.removeEventListener('mousedown', onClick);
  }, []);

  return (
    <div className="flex min-h-screen">
      {/* Sidebar */}
      <aside
        className={`flex shrink-0 flex-col border-r border-line bg-surface transition-all duration-300 ${
          collapsed ? 'w-[72px]' : 'w-[264px]'
        }`}
      >
        <div className={`flex h-16 items-center gap-2.5 border-b border-line/60 ${collapsed ? 'justify-center px-2' : 'px-4'}`}>
          <span
            className="grid h-9 w-9 shrink-0 place-items-center rounded-[11px] bg-gradient-to-br from-accent to-accent-hover shadow-glow"
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
        <div className="relative border-b border-line/60 p-3" ref={orgMenuRef}>
          <button
            type="button"
            className={`flex w-full items-center gap-2.5 rounded border border-line bg-surface px-2.5 py-2 text-left text-sm transition hover:border-[#A7D9C9] hover:shadow-card ${
              collapsed ? 'justify-center' : ''
            }`}
            onClick={() => setOrgMenuOpen((v) => !v)}
            aria-label={t('org.prepnut')}
            aria-expanded={orgMenuOpen}
          >
            {currentOrg ? (
              <>
                <OrgDot org={currentOrg} />
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
                width="14" height="14" viewBox="0 0 24 24" {...stroke}
                className={`shrink-0 text-ink-soft transition-transform ${orgMenuOpen ? 'rotate-180' : ''}`}
                aria-hidden
              >
                <path d="m6 9 6 6 6-6" />
              </svg>
            )}
          </button>
          {orgMenuOpen && (
            <div className="absolute left-3 right-3 z-40 mt-1.5 max-h-80 overflow-y-auto rounded-xl border border-line bg-surface p-1.5 shadow-pop">
              <button
                type="button"
                className={`flex w-full items-center gap-2.5 rounded px-2.5 py-2 text-left text-sm transition hover:bg-app ${
                  currentOrgId === 'all' ? 'bg-accent/10 font-semibold text-accent-hover' : ''
                }`}
                onClick={() => {
                  chooseOrganization('all');
                  setOrgMenuOpen(false);
                }}
              >
                <span className="inline-block h-2 w-2 rounded-full bg-ink-soft" aria-hidden />
                <span className="flex-1">{t('org.vsetky')}</span>
                <span className="tnum text-xs text-ink-soft">
                  {activeOrgs.reduce((sum, o) => sum + countNaKontrolu(o.id), 0)}
                </span>
              </button>
              {activeOrgs.map((org) => (
                <div key={org.id} className="flex items-center rounded transition hover:bg-app">
                  <button
                    type="button"
                    className={`flex min-w-0 flex-1 items-center gap-2.5 rounded px-2.5 py-2 text-left text-sm ${
                      currentOrgId === org.id ? 'bg-accent/10 font-semibold text-accent-hover' : ''
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
                      className="mr-1 rounded px-2 py-1 text-accent transition hover:bg-accent/10"
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
            </div>
          )}
        </div>

        {/* Navigácia */}
        <nav className="flex-1 overflow-y-auto p-3">
          {NAV_ITEMS.map((item) => (
            <NavLink
              key={item.to}
              to={item.to}
              end={item.end}
              className={({ isActive }) =>
                `mb-0.5 flex items-center gap-2.5 rounded px-2.5 py-2 text-sm font-medium transition ${
                  collapsed ? 'justify-center' : ''
                } ${isActive ? 'bg-accent/10 text-accent-hover' : 'text-ink-soft hover:bg-app hover:text-ink'}`
              }
              title={t(item.label)}
            >
              {item.icon}
              {!collapsed && t(item.label)}
            </NavLink>
          ))}
          {role === 'admin' && (
            <NavLink
              to="/nastavenia"
              className={({ isActive }) =>
                `mb-0.5 flex items-center gap-2.5 rounded px-2.5 py-2 text-sm font-medium transition ${
                  collapsed ? 'justify-center' : ''
                } ${isActive ? 'bg-accent/10 text-accent-hover' : 'text-ink-soft hover:bg-app hover:text-ink'}`
              }
              title={t('nav.nastavenia')}
            >
              <IconNastavenia />
              {!collapsed && t('nav.nastavenia')}
            </NavLink>
          )}

          {!collapsed && (
            <div className="mt-5 border-t border-line/60 pt-4">
              <p className="mb-2.5 px-2.5 text-[11px] font-semibold uppercase tracking-widest text-ink-soft/80">
                {t('fronta.organizacie')}
              </p>
              {activeOrgs.map((org) => {
                const organizationQueues = queues.filter(
                  (queue) => queue.organizationId === org.id && queue.active,
                );
                return (
                  <div key={org.id} className="mb-3">
                    <button
                      type="button"
                      className={`mb-0.5 flex w-full items-center gap-2.5 rounded px-2.5 py-1.5 text-left text-xs font-semibold transition hover:bg-app ${
                        currentOrgId === org.id ? 'text-ink' : 'text-ink-soft'
                      }`}
                      onClick={() => {
                        void setCurrentOrg(org.id);
                        navigate('/doklady');
                      }}
                    >
                      <OrgDot org={org} size={7} />
                      <span className="min-w-0 flex-1 truncate">{org.nazov}</span>
                      <span className="tnum rounded-full bg-app px-1.5 py-0.5 font-normal">
                        {countNaKontrolu(org.id)}
                      </span>
                    </button>
                    {organizationQueues.map((queue) => {
                      const count = documents.filter((document) => document.queueId === queue.id).length;
                      const isActive =
                        location.pathname.startsWith('/doklady') && activeQueueId === queue.id;
                      return (
                        <NavLink
                          key={queue.id}
                          to={`/doklady?fronta=${encodeURIComponent(queue.id)}`}
                          onClick={() => void setCurrentOrg(org.id)}
                          className={`mb-0.5 flex items-center gap-2 rounded py-1.5 pl-7 pr-2 text-xs transition ${
                            isActive
                              ? 'bg-accent/10 font-semibold text-accent-hover'
                              : 'text-ink-soft hover:bg-app hover:text-ink'
                          }`}
                          title={`${org.nazov} · ${queue.name}`}
                        >
                          <span className="min-w-0 flex-1 truncate">{queue.name}</span>
                          <span className="tnum">{count}</span>
                        </NavLink>
                      );
                    })}
                  </div>
                );
              })}
            </div>
          )}
        </nav>

        <div className="border-t border-line/60 p-3">
          <button
            type="button"
            className={`flex w-full items-center gap-2.5 rounded px-2.5 py-2 text-xs font-medium text-ink-soft transition hover:bg-app hover:text-ink ${
              collapsed ? 'justify-center' : ''
            }`}
            onClick={() => setCollapsed((v) => !v)}
            aria-label={collapsed ? t('nav.rozbalit') : t('nav.zbalit')}
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
        <header className="z-30 flex h-16 items-center gap-4 border-b border-line bg-surface/90 px-5 backdrop-blur-md">
          <form
            className="relative max-w-md flex-1"
            onSubmit={(e) => {
              e.preventDefault();
              const q = new FormData(e.currentTarget).get('q');
              navigate(`/doklady?q=${encodeURIComponent(String(q ?? ''))}`);
            }}
            role="search"
          >
            <svg
              width="16" height="16" viewBox="0 0 24 24" {...stroke}
              className="pointer-events-none absolute left-3.5 top-1/2 -translate-y-1/2 text-ink-soft/70"
              aria-hidden
            >
              <circle cx="11" cy="11" r="8" /><path d="m21 21-4.3-4.3" />
            </svg>
            <input
              name="q"
              type="search"
              className="input bg-app pl-10 focus:bg-surface"
              placeholder={t('topbar.hladat')}
              aria-label={t('topbar.hladat')}
            />
          </form>
          <div className="ml-auto flex items-center gap-3">
            {role !== 'schvalovatel' && activeOrgs.length > 0 && (
              <button
                type="button"
                className="btn btn-primary whitespace-nowrap"
                aria-label={t('topbar.pridatDoklad')}
                onClick={() => {
                  setDocumentModalOrganizationId(currentOrgId === 'all' ? undefined : currentOrgId);
                  setDocumentModalOpen(true);
                }}
              >
                + <span className="hidden xl:inline">{t('topbar.pridatDoklad')}</span>
              </button>
            )}
            {role === 'admin' && (
              <button
                type="button"
                className="btn whitespace-nowrap"
                aria-label={t('topbar.pridatOrganizaciu')}
                onClick={() => setOrganizationModalOpen(true)}
              >
                + <span className="hidden xl:inline">{t('topbar.pridatOrganizaciu')}</span>
              </button>
            )}
            {AUTH_MODE === 'demo' && (
              <span className="inline-flex items-center gap-1.5 whitespace-nowrap rounded-full border border-amber-300 bg-amber-50 px-2.5 py-1 text-[11px] font-semibold text-amber-800">
                <span className="h-1.5 w-1.5 rounded-full bg-amber-600" aria-hidden />
                {t('auth.demo')}
              </span>
            )}
            <span className="hidden text-xs text-ink-soft lg:inline">{t(`rola.${role}`)}</span>
            <div className="relative" ref={profileMenuRef}>
              <button
                type="button"
                className="flex h-9 w-9 items-center justify-center rounded-full bg-gradient-to-br from-accent to-accent-hover text-sm font-semibold text-white ring-2 ring-accent/15 transition hover:ring-[3px] hover:ring-accent/25"
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
              {profileMenuOpen && (
                <div className="absolute right-0 z-40 mt-2 w-64 rounded-xl border border-line bg-surface p-1.5 shadow-pop">
                  <div className="border-b border-line/60 px-2.5 py-2.5">
                    <p className="font-medium text-ink">{userName}</p>
                    <p className="truncate text-xs text-ink-soft">{session?.user.email}</p>
                    <p className="mt-1 text-xs font-medium text-accent">{t(`rola.${role}`)}</p>
                  </div>
                  <button
                    type="button"
                    className="mt-1 w-full rounded px-2.5 py-2 text-left text-sm transition hover:bg-app"
                    onClick={() => {
                      setProfileMenuOpen(false);
                      navigate('/profil');
                    }}
                  >
                    {t('auth.profil')}
                  </button>
                  <button
                    type="button"
                    className="w-full rounded px-2.5 py-2 text-left text-sm transition hover:bg-app"
                    onClick={() => {
                      setProfileMenuOpen(false);
                      void logout().then(() => navigate('/login', { replace: true }));
                    }}
                  >
                    {t('auth.odhlasit')}
                  </button>
                </div>
              )}
            </div>
          </div>
        </header>
        <main className="min-w-0 flex-1 p-6">
          <Outlet />
        </main>
      </div>

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

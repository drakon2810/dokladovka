// Layout — SPEC §6.1: ľavý sidebar 240 px (zbaliteľný na ikony),
// prepínač organizácie s farebnými krúžkami a počítadlom „na kontrolu",
// topbar s globálnym vyhľadávaním a prepínačom roly.
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

const NAV_ITEMS = [
  { to: '/', label: 'nav.prehlad', icon: '◫', end: true },
  { to: '/doklady', label: 'nav.doklady', icon: '☰', end: false },
  { to: '/export', label: 'nav.export', icon: '⇩', end: false },
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
        className={`flex shrink-0 flex-col border-r border-line bg-surface transition-all ${
          collapsed ? 'w-14' : 'w-60'
        }`}
      >
        <div className="flex h-14 items-center gap-2 border-b border-line px-3">
          <span className="text-lg font-bold text-accent" aria-hidden>
            ▦
          </span>
          {!collapsed && <span className="text-base font-semibold">{t('app.nazov')}</span>}
        </div>

        {/* Prepínač organizácie */}
        <div className="relative border-b border-line p-2" ref={orgMenuRef}>
          <button
            type="button"
            className="flex w-full items-center gap-2 rounded border border-line bg-surface px-2 py-2 text-left text-sm hover:bg-app"
            onClick={() => setOrgMenuOpen((v) => !v)}
            aria-label={t('org.prepnut')}
            aria-expanded={orgMenuOpen}
          >
            {currentOrg ? (
              <>
                <OrgDot org={currentOrg} />
                {!collapsed && <span className="flex-1 truncate font-medium">{currentOrg.nazov}</span>}
              </>
            ) : (
              <>
                <span className="inline-block h-2.5 w-2.5 shrink-0 rounded-full bg-ink-soft" aria-hidden />
                {!collapsed && <span className="flex-1 truncate font-medium">{t('org.vsetky')}</span>}
              </>
            )}
            {!collapsed && <span className="text-ink-soft">▾</span>}
          </button>
          {orgMenuOpen && (
            <div className="absolute left-2 right-2 z-40 mt-1 card max-h-80 overflow-y-auto p-1">
              <button
                type="button"
                className={`flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-sm hover:bg-app ${
                  currentOrgId === 'all' ? 'font-semibold text-accent' : ''
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
                <div key={org.id} className="flex items-center rounded hover:bg-app">
                  <button
                    type="button"
                    className={`flex min-w-0 flex-1 items-center gap-2 rounded px-2 py-1.5 text-left text-sm ${
                      currentOrgId === org.id ? 'font-semibold text-accent' : ''
                    }`}
                    onClick={() => {
                      chooseOrganization(org.id);
                      setOrgMenuOpen(false);
                    }}
                  >
                    <OrgDot org={org} size={8} />
                    <span className="flex-1 truncate">{org.nazov}</span>
                    <span className="tnum text-xs text-ink-soft">{countNaKontrolu(org.id)}</span>
                  </button>
                  {role !== 'schvalovatel' && (
                    <button
                      type="button"
                      className="mr-1 rounded px-2 py-1 text-accent hover:bg-accent/10"
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
        <nav className="flex-1 overflow-y-auto p-2">
          {NAV_ITEMS.map((item) => (
            <NavLink
              key={item.to}
              to={item.to}
              end={item.end}
              className={({ isActive }) =>
                `mb-0.5 flex items-center gap-2.5 rounded px-2.5 py-2 text-sm font-medium ${
                  isActive ? 'bg-accent/10 text-accent' : 'text-ink hover:bg-app'
                }`
              }
              title={t(item.label)}
            >
              <span aria-hidden>{item.icon}</span>
              {!collapsed && t(item.label)}
            </NavLink>
          ))}
          {role === 'admin' && (
            <NavLink
              to="/nastavenia"
              className={({ isActive }) =>
                `mb-0.5 flex items-center gap-2.5 rounded px-2.5 py-2 text-sm font-medium ${
                  isActive ? 'bg-accent/10 text-accent' : 'text-ink hover:bg-app'
                }`
              }
              title={t('nav.nastavenia')}
            >
              <span aria-hidden>⚙</span>
              {!collapsed && t('nav.nastavenia')}
            </NavLink>
          )}

          {!collapsed && (
            <div className="mt-4 border-t border-line pt-3">
              <p className="mb-2 px-2 text-[11px] font-semibold uppercase tracking-wide text-ink-soft">
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
                      className={`mb-1 flex w-full items-center gap-2 rounded px-2 py-1 text-left text-xs font-semibold hover:bg-app ${
                        currentOrgId === org.id ? 'text-ink' : 'text-ink-soft'
                      }`}
                      onClick={() => {
                        void setCurrentOrg(org.id);
                        navigate('/doklady');
                      }}
                    >
                      <OrgDot org={org} size={7} />
                      <span className="min-w-0 flex-1 truncate">{org.nazov}</span>
                      <span className="tnum font-normal">{countNaKontrolu(org.id)}</span>
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
                          className={`mb-0.5 flex items-center gap-2 rounded py-1.5 pl-7 pr-2 text-xs ${
                            isActive
                              ? 'bg-accent/10 font-semibold text-accent'
                              : 'text-ink-soft hover:bg-app hover:text-ink'
                          }`}
                          title={`${org.nazov} · ${queue.name}`}
                        >
                          <span aria-hidden>└</span>
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

        <button
          type="button"
          className="m-2 rounded border border-line px-2 py-1.5 text-xs text-ink-soft hover:bg-app"
          onClick={() => setCollapsed((v) => !v)}
          aria-label={collapsed ? t('nav.rozbalit') : t('nav.zbalit')}
        >
          {collapsed ? '»' : `« ${t('nav.zbalit')}`}
        </button>
      </aside>

      {/* Hlavná časť */}
      <div className="flex min-w-0 flex-1 flex-col">
        <header className="flex h-14 items-center gap-4 border-b border-line bg-surface px-4">
          <form
            className="max-w-md flex-1"
            onSubmit={(e) => {
              e.preventDefault();
              const q = new FormData(e.currentTarget).get('q');
              navigate(`/doklady?q=${encodeURIComponent(String(q ?? ''))}`);
            }}
            role="search"
          >
            <input
              name="q"
              type="search"
              className="input"
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
              <span className="rounded border border-amber-300 bg-amber-50 px-2 py-1 text-[11px] font-semibold text-amber-800">
                {t('auth.demo')}
              </span>
            )}
            <span className="hidden text-xs text-ink-soft lg:inline">{t(`rola.${role}`)}</span>
            <div className="relative" ref={profileMenuRef}>
              <button
                type="button"
                className="flex h-9 w-9 items-center justify-center rounded-full bg-accent text-sm font-semibold text-white"
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
                <div className="absolute right-0 z-40 mt-2 w-64 card p-2">
                  <div className="border-b border-line px-2 py-2">
                    <p className="font-medium text-ink">{userName}</p>
                    <p className="truncate text-xs text-ink-soft">{session?.user.email}</p>
                    <p className="mt-1 text-xs text-accent">{t(`rola.${role}`)}</p>
                  </div>
                  <button
                    type="button"
                    className="mt-1 w-full rounded px-2 py-2 text-left text-sm hover:bg-app"
                    onClick={() => {
                      setProfileMenuOpen(false);
                      navigate('/profil');
                    }}
                  >
                    {t('auth.profil')}
                  </button>
                  <button
                    type="button"
                    className="mt-1 w-full rounded px-2 py-2 text-left text-sm hover:bg-app"
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
        <main className="min-w-0 flex-1 p-5">
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

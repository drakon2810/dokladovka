import { lazy, Suspense } from 'react';
import { BrowserRouter, Navigate, Route, Routes, useLocation } from 'react-router-dom';
import { Layout } from './Layout';
import { LandingPage } from '../features/landing/LandingPage';
import { DashboardPage } from '../features/dashboard/DashboardPage';
import { DocumentsPage } from '../features/documents/DocumentsPage';
import { DokumentyPage } from '../features/dokumenty/DokumentyPage';
import { ExportPage } from '../features/export/ExportPage';
import { SettingsPage } from '../features/settings/SettingsPage';
import { useDataQuery } from '../data/query';
import { t } from '../i18n/sk';
import { ErrorBoundary } from '../components/ErrorBoundary';
import { AuthProvider } from '../auth/AuthProvider';
import { useAuth } from '../auth/AuthContext';
import { LoginPage } from '../features/auth/LoginPage';
import { ProfilePage } from '../features/profile/ProfilePage';

const DocumentDetailPage = lazy(() =>
  import('../features/documents/DocumentDetailPage').then((module) => ({
    default: module.DocumentDetailPage,
  })),
);

function AppShell() {
  const { session, loading } = useAuth();
  const location = useLocation();
  if (loading) return <p className="p-6 text-sm text-ink-soft">{t('stav.nacitavam')}</p>;
  if (!session) {
    if (location.pathname === '/') return <LandingPage />;
    return <Navigate to="/login" replace state={{ from: location }} />;
  }
  return <Layout />;
}

function AdminRoute({ children }: { children: JSX.Element }) {
  const { session, loading } = useAuth();
  const { loading: dataLoading } = useDataQuery();
  if (loading || dataLoading) return <p className="text-sm text-ink-soft">{t('stav.nacitavam')}</p>;
  if (session?.user.role !== 'admin') return <Navigate to="/" replace />;
  return children;
}

export function App() {
  return (
    <BrowserRouter
      future={{ v7_startTransition: true, v7_relativeSplatPath: true }}
    >
      <AuthProvider>
        <Routes>
          <Route path="/login" element={<LoginPage />} />
          <Route element={<AppShell />}>
            <Route path="/" element={<DashboardPage />} />
            <Route path="/doklady" element={<DocumentsPage />} />
            <Route
              path="/doklady/:id"
              element={
                <ErrorBoundary>
                  <Suspense fallback={<p className="text-sm text-ink-soft">{t('stav.nacitavam')}</p>}>
                    <DocumentDetailPage />
                  </Suspense>
                </ErrorBoundary>
              }
            />
            <Route path="/dokumenty" element={<DokumentyPage />} />
            <Route path="/export" element={<ExportPage />} />
            <Route path="/profil" element={<ProfilePage />} />
            <Route
              path="/nastavenia"
              element={
                <AdminRoute>
                  <SettingsPage />
                </AdminRoute>
              }
            />
            <Route path="*" element={<Navigate to="/" replace />} />
          </Route>
        </Routes>
      </AuthProvider>
    </BrowserRouter>
  );
}

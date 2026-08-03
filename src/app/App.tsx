import { lazy, Suspense } from 'react';
import { MotionConfig } from 'framer-motion';
import { BrowserRouter, Navigate, Route, Routes, useLocation } from 'react-router-dom';
import { Layout } from './Layout';
import { LandingPage } from '../features/landing/LandingPage';
import { DashboardPage } from '../features/dashboard/DashboardPage';
import { DocumentsPage } from '../features/documents/DocumentsPage';
import { OtherDocumentPage } from '../features/documents/OtherDocumentPage';
import { NespracovanePage } from '../features/nespracovane/NespracovanePage';
import { ExportPage } from '../features/export/ExportPage';
import { PartnersPage } from '../features/partners/PartnersPage';
import { AssistantPage } from '../features/assistant/AssistantPage';
import { SettingsPage } from '../features/settings/SettingsPage';
import { GlobalRulesPage } from '../features/pravidla/GlobalRulesPage';
import { useDataQuery } from '../data/query';
import { t } from '../i18n/sk';
import { ErrorBoundary } from '../components/ErrorBoundary';
import { AuthProvider } from '../auth/AuthProvider';
import { useAuth } from '../auth/AuthContext';
import { LoginPage } from '../features/auth/LoginPage';
import { RegisterPage } from '../features/auth/RegisterPage';
import { ForgotPasswordPage } from '../features/auth/ForgotPasswordPage';
import { ResetPasswordPage } from '../features/auth/ResetPasswordPage';
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
  // Správca platformy nemá firmy ani doklady — celá aplikácia je pre neho jedna
  // obrazovka s globálnymi pravidlami (bez navigácie a bez snapshotu tenanta).
  if (session.user.role === 'superadmin') return <GlobalRulesPage />;
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
      <MotionConfig reducedMotion="user">
      <AuthProvider>
        <Routes>
          <Route path="/login" element={<LoginPage />} />
          <Route path="/registracia" element={<RegisterPage />} />
          <Route path="/zabudnute-heslo" element={<ForgotPasswordPage />} />
          <Route path="/obnova-hesla" element={<ResetPasswordPage />} />
          <Route element={<AppShell />}>
            <Route path="/" element={<DashboardPage />} />
            <Route path="/doklady" element={<DocumentsPage />} />
            {/* Voľné firemné dokumenty žijú v tom istom zozname ako doklady,
                len majú vlastný detail bez editácie. */}
            <Route path="/doklady/ine/:id" element={<OtherDocumentPage />} />
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
            <Route path="/nespracovane" element={<NespracovanePage />} />
            <Route path="/export" element={<ExportPage />} />
            <Route path="/partneri" element={<PartnersPage />} />
            <Route path="/asistent" element={<AssistantPage />} />
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
      </MotionConfig>
    </BrowserRouter>
  );
}

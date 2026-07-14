import type { ReactElement } from 'react';
import { Navigate, useLocation } from 'react-router-dom';
import { useAuth } from './AuthContext';
import { t } from '../i18n/sk';

export function RequireAuth({ children }: { children: ReactElement }) {
  const { session, loading } = useAuth();
  const location = useLocation();
  if (loading) return <p className="p-6 text-sm text-ink-soft">{t('stav.nacitavam')}</p>;
  if (!session) return <Navigate to="/login" replace state={{ from: location }} />;
  return children;
}

import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { sessionGateway } from './sessionGateway';
import type { AuthSession } from './types';
import { setRole } from '../data/api';
import { AuthContext, type AuthContextValue } from './AuthContext';

export function AuthProvider({ children }: { children: ReactNode }) {
  const [session, setSession] = useState<AuthSession | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let active = true;
    void sessionGateway
      .getSession()
      .then(async (next) => {
        if (next) await setRole(next.user.role);
        if (active) setSession(next);
      })
      .catch(() => {
        if (active) setSession(null);
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, []);

  const value = useMemo<AuthContextValue>(
    () => ({
      session,
      loading,
      async login(credentials) {
        const next = await sessionGateway.login(credentials);
        await setRole(next.user.role);
        setSession(next);
        return next;
      },
      async logout() {
        await sessionGateway.logout(session ?? undefined);
        setSession(null);
      },
      async updateProfile(input) {
        if (!session) throw new Error('Používateľ nie je prihlásený');
        const next = await sessionGateway.updateProfile(input, session);
        setSession(next);
        return next;
      },
    }),
    [loading, session],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

import { getDataSnapshot, setRole, updateOwnUserProfile } from '../data/api';
import type { AppUser, UserNotificationPreferences } from '../data/types';
import { AUTH_MODE, DEMO_PASSWORD } from './config';
import {
  AuthError,
  type AuthSession,
  type LoginCredentials,
  type SessionGateway,
  type SessionSecurityStatus,
  type SessionUser,
} from './types';

const DEMO_SESSION_KEY = 'dokladovka-demo-session-v2';
let memorySession: string | null = null;

const DEMO_SECURITY: SessionSecurityStatus = {
  twoFactor: { enabled: false, canManage: false },
  google: { connected: false, canManage: false },
  microsoft: { connected: false, canManage: false },
};

function readDemoSession(): string | null {
  if (typeof sessionStorage === 'undefined') return memorySession;
  return sessionStorage.getItem(DEMO_SESSION_KEY);
}

function writeDemoSession(value: string | null): void {
  if (typeof sessionStorage === 'undefined') {
    memorySession = value;
    return;
  }
  if (value === null) sessionStorage.removeItem(DEMO_SESSION_KEY);
  else sessionStorage.setItem(DEMO_SESSION_KEY, value);
}

function isNotificationPreferences(value: unknown): value is UserNotificationPreferences {
  if (!value || typeof value !== 'object') return false;
  const preferences = value as Partial<UserNotificationPreferences>;
  return (
    typeof preferences.email === 'boolean' &&
    typeof preferences.inApp === 'boolean' &&
    typeof preferences.comments === 'boolean' &&
    typeof preferences.mentions === 'boolean'
  );
}

function isSecurityStatus(value: unknown): value is SessionSecurityStatus {
  if (!value || typeof value !== 'object') return false;
  const security = value as Partial<SessionSecurityStatus>;
  return Boolean(
    security.twoFactor &&
      typeof security.twoFactor.enabled === 'boolean' &&
      typeof security.twoFactor.canManage === 'boolean' &&
      security.google &&
      typeof security.google.connected === 'boolean' &&
      typeof security.google.canManage === 'boolean' &&
      security.microsoft &&
      typeof security.microsoft.connected === 'boolean' &&
      typeof security.microsoft.canManage === 'boolean',
  );
}

export function isAuthSession(value: unknown): value is AuthSession {
  if (!value || typeof value !== 'object') return false;
  const session = value as Partial<AuthSession>;
  return Boolean(
    session.user &&
      typeof session.user.id === 'string' &&
      typeof session.user.tenantId === 'string' &&
      typeof session.user.name === 'string' &&
      typeof session.user.email === 'string' &&
      ['uctovnik', 'schvalovatel', 'admin'].includes(session.user.role) &&
      Array.isArray(session.user.organizationIds) &&
      session.user.organizationIds.every((id) => typeof id === 'string') &&
      session.user.language === 'sk' &&
      isNotificationPreferences(session.user.notifications) &&
      isSecurityStatus(session.user.security) &&
      typeof session.expiresAt === 'string' &&
      (session.mode === 'demo' || session.mode === 'bff'),
  );
}

function toDemoSessionUser(user: AppUser, organizationIds: string[]): SessionUser {
  return {
    id: user.id,
    tenantId: user.tenantId,
    name: user.meno,
    email: user.email,
    role: user.rola,
    organizationIds,
    language: user.jazyk,
    notifications: { ...user.notifikacie },
    security: structuredClone(DEMO_SECURITY),
  };
}

const demoGateway: SessionGateway = {
  async getSession() {
    const raw = readDemoSession();
    if (!raw) return null;
    try {
      const session: unknown = JSON.parse(raw);
      if (!isAuthSession(session) || Date.parse(session.expiresAt) <= Date.now()) {
        writeDemoSession(null);
        return null;
      }
      await setRole(session.user.role);
      return session;
    } catch {
      writeDemoSession(null);
      return null;
    }
  },

  async login(credentials: LoginCredentials) {
    const data = await getDataSnapshot();
    const email = credentials.email.trim().toLocaleLowerCase('sk');
    const user = data.users.find((item) => item.email.toLocaleLowerCase('sk') === email);
    if (!user || credentials.password !== DEMO_PASSWORD) {
      throw new AuthError('invalid_credentials');
    }
    await setRole(user.rola);
    const expiresAt = new Date(Date.now() + 8 * 60 * 60 * 1000).toISOString();
    const session: AuthSession = {
      mode: 'demo',
      expiresAt,
      user: toDemoSessionUser(
        user,
        data.organizations
          .filter((organization) => organization.tenantId === user.tenantId && !organization.archived)
          .map((organization) => organization.id),
      ),
    };
    writeDemoSession(JSON.stringify(session));
    return session;
  },

  async logout() {
    writeDemoSession(null);
  },

  async updateProfile(input, session) {
    const updated = await updateOwnUserProfile(session.user.id, session.user.tenantId, {
      meno: input.name,
      jazyk: input.language,
      notifikacie: input.notifications,
    });
    const next: AuthSession = {
      ...session,
      user: toDemoSessionUser(updated, session.user.organizationIds),
    };
    writeDemoSession(JSON.stringify(next));
    return next;
  },
};

async function requestBff(path: string, init?: RequestInit): Promise<Response> {
  try {
    return await fetch(path, { credentials: 'include', ...init });
  } catch {
    throw new AuthError('session_unavailable');
  }
}

const bffGateway: SessionGateway = {
  async getSession() {
    const response = await requestBff('/api/auth/session');
    if (response.status === 401) return null;
    if (!response.ok) throw new AuthError('session_unavailable');
    const session: unknown = await response.json();
    if (!isAuthSession(session)) throw new AuthError('session_unavailable');
    return session;
  },

  async login(credentials: LoginCredentials) {
    const response = await requestBff('/api/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(credentials),
    });
    if (response.status === 401) throw new AuthError('invalid_credentials');
    if (!response.ok) throw new AuthError('session_unavailable');
    const session: unknown = await response.json();
    if (!isAuthSession(session)) throw new AuthError('session_unavailable');
    return session;
  },

  async logout(session) {
    const response = await requestBff('/api/auth/logout', {
      method: 'POST',
      headers: session?.csrfToken ? { 'X-CSRF-Token': session.csrfToken } : undefined,
    });
    if (!response.ok && response.status !== 401) throw new AuthError('session_unavailable');
  },

  async updateProfile(input, session) {
    const response = await requestBff('/api/auth/profile', {
      method: 'PATCH',
      headers: {
        'Content-Type': 'application/json',
        ...(session.csrfToken ? { 'X-CSRF-Token': session.csrfToken } : {}),
      },
      body: JSON.stringify(input),
    });
    if (!response.ok) throw new AuthError('session_unavailable');
    const next: unknown = await response.json();
    if (!isAuthSession(next)) throw new AuthError('session_unavailable');
    return next;
  },
};

export const sessionGateway: SessionGateway = AUTH_MODE === 'demo' ? demoGateway : bffGateway;

export function startOidc(provider: 'google' | 'microsoft'): void {
  if (AUTH_MODE !== 'bff') return;
  window.location.assign(`/api/auth/oidc/${provider}/start`);
}

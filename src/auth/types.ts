import type { Role, UserLanguage, UserNotificationPreferences } from '../data/types';

export interface ConnectedIdentityStatus {
  connected: boolean;
  canManage: boolean;
}

export interface TwoFactorStatus {
  enabled: boolean;
  canManage: boolean;
}

export interface SessionSecurityStatus {
  twoFactor: TwoFactorStatus;
  google: ConnectedIdentityStatus;
  microsoft: ConnectedIdentityStatus;
}

export interface SessionUser {
  id: string;
  tenantId: string;
  name: string;
  email: string;
  role: Role;
  organizationIds: string[];
  language: UserLanguage;
  notifications: UserNotificationPreferences;
  security: SessionSecurityStatus;
}

export interface AuthSession {
  user: SessionUser;
  expiresAt: string;
  /** CSRF token vracia iba produkčný BFF; nikdy nejde do localStorage. */
  csrfToken?: string;
  mode: 'demo' | 'bff';
}

export interface LoginCredentials {
  email: string;
  password: string;
}

export interface UpdateProfileInput {
  name: string;
  language: UserLanguage;
  notifications: UserNotificationPreferences;
}

export interface SessionGateway {
  getSession(): Promise<AuthSession | null>;
  login(credentials: LoginCredentials): Promise<AuthSession>;
  logout(session?: AuthSession): Promise<void>;
  updateProfile(input: UpdateProfileInput, session: AuthSession): Promise<AuthSession>;
}

export class AuthError extends Error {
  constructor(public readonly code: 'invalid_credentials' | 'session_unavailable') {
    super(code);
    this.name = 'AuthError';
  }
}

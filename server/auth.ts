import { randomUUID } from 'node:crypto';
import type { FastifyReply, FastifyRequest } from 'fastify';
import type { ServerConfig } from './config.js';
import type { Database } from './db/database.js';
import { HttpError } from './http.js';
import { randomToken, sha256 } from './security.js';

export type UserRole = 'uctovnik' | 'schvalovatel' | 'admin';

interface SessionRow extends Record<string, unknown> {
  session_id: string;
  user_id: string;
  tenant_id: string;
  csrf_token_hash: string;
  expires_at: string | Date;
  name: string;
  email: string;
  role: UserRole;
  language: 'sk';
  notifications: Record<string, boolean>;
}

export interface AuthContext {
  sessionId: string;
  userId: string;
  tenantId: string;
  name: string;
  email: string;
  role: UserRole;
  language: 'sk';
  notifications: Record<string, boolean>;
  csrfTokenHash: string;
  expiresAt: Date;
}

export interface BrowserSessionResponse {
  mode: 'bff';
  expiresAt: string;
  csrfToken: string;
  user: {
    id: string;
    tenantId: string;
    name: string;
    email: string;
    role: UserRole;
    organizationIds: string[];
    language: 'sk';
    notifications: Record<string, boolean>;
    security: {
      twoFactor: { enabled: boolean; canManage: boolean };
      google: { connected: boolean; canManage: boolean };
      microsoft: { connected: boolean; canManage: boolean };
    };
  };
}

const COOKIE_NAME = 'dokladovka_session';

export function setSessionCookie(reply: FastifyReply, token: string, config: ServerConfig): void {
  reply.setCookie(COOKIE_NAME, token, {
    path: '/',
    httpOnly: true,
    secure: config.sessionCookieSecure,
    sameSite: 'strict',
    maxAge: config.sessionTtlHours * 60 * 60,
  });
}

export function clearSessionCookie(reply: FastifyReply, config: ServerConfig): void {
  reply.clearCookie(COOKIE_NAME, {
    path: '/',
    httpOnly: true,
    secure: config.sessionCookieSecure,
    sameSite: 'strict',
  });
}

export async function createSession(
  database: Database,
  user: { id: string; tenantId: string },
  config: ServerConfig,
): Promise<{ token: string; csrfToken: string; expiresAt: Date; sessionId: string }> {
  const token = randomToken();
  const csrfToken = randomToken(24);
  const expiresAt = new Date(Date.now() + config.sessionTtlHours * 60 * 60 * 1000);
  const sessionId = randomUUID();
  await database.query(
    `INSERT INTO sessions (id, user_id, tenant_id, token_hash, csrf_token_hash, expires_at)
     VALUES ($1,$2,$3,$4,$5,$6)`,
    [sessionId, user.id, user.tenantId, sha256(token), sha256(csrfToken), expiresAt.toISOString()],
  );
  return { token, csrfToken, expiresAt, sessionId };
}

export async function optionalBrowserAuth(request: FastifyRequest, database: Database): Promise<AuthContext | null> {
  const token = request.cookies[COOKIE_NAME];
  if (!token) return null;
  const result = await database.query<SessionRow>(
    `SELECT s.id AS session_id, s.user_id, s.tenant_id, s.csrf_token_hash, s.expires_at,
            u.name, u.email, u.role, u.language, u.notifications
       FROM sessions s
       JOIN users u ON u.id = s.user_id AND u.tenant_id = s.tenant_id
      WHERE s.token_hash = $1 AND s.expires_at > now() AND u.active = true`,
    [sha256(token)],
  );
  const row = result.rows[0];
  if (!row) return null;
  await database.query('UPDATE sessions SET last_seen_at = now() WHERE id = $1', [row.session_id]);
  return {
    sessionId: row.session_id,
    userId: row.user_id,
    tenantId: row.tenant_id,
    name: row.name,
    email: row.email,
    role: row.role,
    language: row.language,
    notifications: row.notifications,
    csrfTokenHash: row.csrf_token_hash,
    expiresAt: new Date(row.expires_at),
  };
}

export async function requireBrowserAuth(request: FastifyRequest, database: Database): Promise<AuthContext> {
  const auth = await optionalBrowserAuth(request, database);
  if (!auth) throw new HttpError(401, 'unauthorized', 'Prihlásenie je neplatné alebo vypršalo');
  return auth;
}

export function requireCsrf(request: FastifyRequest, auth: AuthContext): void {
  const token = request.headers['x-csrf-token'];
  if (typeof token !== 'string' || sha256(token) !== auth.csrfTokenHash) {
    throw new HttpError(403, 'csrf_invalid', 'CSRF token je neplatný');
  }
}

export function requireRole(auth: AuthContext, roles: UserRole[]): void {
  if (!roles.includes(auth.role)) {
    throw new HttpError(403, 'forbidden', 'Na túto operáciu nemáte oprávnenie');
  }
}

export async function requireOrganizationAccess(
  database: Database,
  auth: AuthContext,
  organizationId: string,
): Promise<void> {
  const result = await database.query(
    `SELECT 1
       FROM organization_memberships m
       JOIN organizations o ON o.id = m.organization_id AND o.tenant_id = m.tenant_id
      WHERE m.user_id = $1 AND m.tenant_id = $2 AND m.organization_id = $3`,
    [auth.userId, auth.tenantId, organizationId],
  );
  if (result.rowCount === 0) {
    throw new HttpError(404, 'organization_not_found', 'Organizácia neexistuje');
  }
}

export async function rotateCsrfAndBuildSession(
  database: Database,
  auth: AuthContext,
): Promise<BrowserSessionResponse> {
  const csrfToken = randomToken(24);
  await database.query('UPDATE sessions SET csrf_token_hash = $1 WHERE id = $2', [sha256(csrfToken), auth.sessionId]);
  return buildBrowserSession(database, auth, csrfToken);
}

export async function buildBrowserSession(
  database: Database,
  auth: AuthContext,
  csrfToken: string,
): Promise<BrowserSessionResponse> {
  const organizations = await database.query<{ organization_id: string } & Record<string, unknown>>(
    `SELECT organization_id FROM organization_memberships
      WHERE user_id = $1 AND tenant_id = $2 ORDER BY organization_id`,
    [auth.userId, auth.tenantId],
  );
  return {
    mode: 'bff',
    expiresAt: auth.expiresAt.toISOString(),
    csrfToken,
    user: {
      id: auth.userId,
      tenantId: auth.tenantId,
      name: auth.name,
      email: auth.email,
      role: auth.role,
      organizationIds: organizations.rows.map((row) => row.organization_id),
      language: auth.language,
      notifications: auth.notifications,
      security: {
        twoFactor: { enabled: false, canManage: false },
        google: { connected: false, canManage: false },
        microsoft: { connected: false, canManage: false },
      },
    },
  };
}

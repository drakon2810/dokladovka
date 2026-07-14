import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { ServerConfig } from '../config.js';
import type { Database } from '../db/database.js';
import {
  buildBrowserSession,
  clearSessionCookie,
  createSession,
  optionalBrowserAuth,
  requireBrowserAuth,
  requireCsrf,
  rotateCsrfAndBuildSession,
  setSessionCookie,
  type AuthContext,
} from '../auth.js';
import { HttpError } from '../http.js';
import { sha256, verifyPassword } from '../security.js';
import { writeAudit } from '../audit.js';

interface UserRow extends Record<string, unknown> {
  id: string;
  tenant_id: string;
  name: string;
  email: string;
  password_hash: string;
  role: 'uctovnik' | 'schvalovatel' | 'admin';
  language: 'sk';
  notifications: Record<string, boolean>;
}

const loginSchema = z.object({ email: z.string().email(), password: z.string().min(1).max(1024) }).strict();
const profileSchema = z.object({
  name: z.string().trim().min(1).max(120),
  language: z.literal('sk'),
  notifications: z.object({
    email: z.boolean(),
    inApp: z.boolean(),
    comments: z.boolean(),
    mentions: z.boolean(),
  }).strict(),
}).strict();

export function registerAuthRoutes(app: FastifyInstance, database: Database, config: ServerConfig): void {
  app.get('/api/auth/session', async (request, reply) => {
    const auth = await optionalBrowserAuth(request, database);
    if (!auth) return reply.code(401).send({ code: 'unauthorized' });
    return rotateCsrfAndBuildSession(database, auth);
  });

  app.post('/api/auth/login', {
    config: { rateLimit: { max: 10, timeWindow: '1 minute' } },
  }, async (request, reply) => {
    const body = loginSchema.parse(request.body);
    const result = await database.query<UserRow>(
      `SELECT id, tenant_id, name, email, password_hash, role, language, notifications
         FROM users WHERE lower(email) = lower($1) AND active = true`,
      [body.email.trim()],
    );
    const user = result.rows[0];
    if (!user || !await verifyPassword(body.password, user.password_hash)) {
      throw new HttpError(401, 'invalid_credentials', 'Nesprávny e-mail alebo heslo');
    }
    const session = await createSession(database, { id: user.id, tenantId: user.tenant_id }, config);
    setSessionCookie(reply, session.token, config);
    const auth: AuthContext = {
      sessionId: session.sessionId,
      userId: user.id,
      tenantId: user.tenant_id,
      name: user.name,
      email: user.email,
      role: user.role,
      language: user.language,
      notifications: user.notifications,
      csrfTokenHash: sha256(session.csrfToken),
      expiresAt: session.expiresAt,
    };
    await writeAudit(database, {
      tenantId: user.tenant_id,
      actorType: 'user',
      actorId: user.id,
      action: 'auth.login',
      entityType: 'session',
      entityId: session.sessionId,
      correlationId: request.id,
    });
    return buildBrowserSession(database, auth, session.csrfToken);
  });

  app.post('/api/auth/logout', async (request, reply) => {
    const auth = await optionalBrowserAuth(request, database);
    if (auth) {
      requireCsrf(request, auth);
      await database.query('DELETE FROM sessions WHERE id = $1 AND tenant_id = $2', [auth.sessionId, auth.tenantId]);
      await writeAudit(database, {
        tenantId: auth.tenantId,
        actorType: 'user',
        actorId: auth.userId,
        action: 'auth.logout',
        entityType: 'session',
        entityId: auth.sessionId,
        correlationId: request.id,
      });
    }
    clearSessionCookie(reply, config);
    return reply.code(204).send();
  });

  app.patch('/api/auth/profile', async (request) => {
    const auth = await requireBrowserAuth(request, database);
    requireCsrf(request, auth);
    const body = profileSchema.parse(request.body);
    await database.query(
      `UPDATE users SET name = $1, language = $2, notifications = $3::jsonb, updated_at = now()
        WHERE id = $4 AND tenant_id = $5`,
      [body.name, body.language, JSON.stringify(body.notifications), auth.userId, auth.tenantId],
    );
    const updated: AuthContext = { ...auth, name: body.name, language: body.language, notifications: body.notifications };
    await writeAudit(database, {
      tenantId: auth.tenantId,
      actorType: 'user',
      actorId: auth.userId,
      action: 'user.profile_updated',
      entityType: 'user',
      entityId: auth.userId,
      correlationId: request.id,
    });
    return rotateCsrfAndBuildSession(database, updated);
  });
}

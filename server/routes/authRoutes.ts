import { randomUUID } from 'node:crypto';
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
import {
  constantTimeStringEqual,
  createNumericCode,
  hashPassword,
  randomToken,
  sha256,
  verifyPassword,
} from '../security.js';
import { writeAudit } from '../audit.js';
import type { Mailer } from '../mailer.js';
import { verifyTurnstile } from '../turnstile.js';

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

/** Platnosť registračného kódu a odkazu na obnovu hesla. */
const REGISTRATION_CODE_TTL_MINUTES = 15;
const RESET_LINK_TTL_MINUTES = 60;
/** Po vyčerpaní pokusov je kód mŕtvy — chráni 6-miestny kód pred hádaním. */
const MAX_CODE_ATTEMPTS = 5;

const captchaToken = z.string().max(4096).optional();
const passwordField = z.string().min(10).max(1024);
const emailField = z.string().trim().email().max(255);

const loginSchema = z
  .object({ email: z.string().email(), password: z.string().min(1).max(1024), captchaToken })
  .strict();
const registerSchema = z
  .object({ name: z.string().trim().min(1).max(120), email: emailField, password: passwordField, captchaToken })
  .strict();
const confirmSchema = z
  .object({ registrationId: z.string().uuid(), code: z.string().trim().regex(/^\d{6}$/) })
  .strict();
const forgotSchema = z.object({ email: emailField, captchaToken }).strict();
const resetSchema = z.object({ token: z.string().min(1).max(512), password: passwordField }).strict();
let dummyHashPromise: Promise<string> | null = null;
/** Hash neexistujúceho účtu, aby prihlásenie trvalo rovnako dlho v oboch vetvách. */
function dummyPasswordHash(): Promise<string> {
  dummyHashPromise ??= hashPassword(randomToken());
  return dummyHashPromise;
}

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

export function registerAuthRoutes(
  app: FastifyInstance,
  database: Database,
  config: ServerConfig,
  mailer: Mailer,
): void {
  app.get('/api/auth/session', async (request, reply) => {
    const auth = await optionalBrowserAuth(request, database);
    if (!auth) return reply.code(401).send({ code: 'unauthorized' });
    return rotateCsrfAndBuildSession(database, auth);
  });

  app.post('/api/auth/login', {
    config: { rateLimit: { max: 10, timeWindow: '1 minute' } },
  }, async (request, reply) => {
    const body = loginSchema.parse(request.body);
    await verifyTurnstile(config, body.captchaToken, request);
    const result = await database.query<UserRow>(
      `SELECT id, tenant_id, name, email, password_hash, role, language, notifications
         FROM users WHERE lower(email) = lower($1) AND active = true`,
      [body.email.trim()],
    );
    const user = result.rows[0];
    // Aj pri neznámom e-maile prebehne jedno scrypt overenie — inak by
    // odpoveď prišla o ~100 ms skôr a prezradila, ktoré adresy existujú.
    const passwordOk = await verifyPassword(body.password, user?.password_hash ?? await dummyPasswordHash());
    if (!user || !passwordOk) {
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

  // Registrácia beží na dva kroky: /register uloží čakajúcu registráciu a pošle
  // kód, /register/confirm z nej založí tenanta s adminom. Do users sa zapisuje
  // až po overení e-mailu, takže neoverená adresa nikdy neblokuje registráciu.
  app.post('/api/auth/register', {
    config: { rateLimit: { max: 5, timeWindow: '10 minutes' } },
  }, async (request) => {
    const body = registerSchema.parse(request.body);
    await verifyTurnstile(config, body.captchaToken, request);
    const email = body.email.toLowerCase();
    const passwordHash = await hashPassword(body.password);
    await database.query('DELETE FROM pending_registrations WHERE expires_at < now()');

    const existing = await database.query('SELECT id FROM users WHERE lower(email) = $1', [email]);
    if (existing.rowCount > 0) {
      // Neprezrádzame, či adresa má účet — namiesto kódu dostane jej majiteľ
      // upozornenie s odkazom na obnovu hesla. Odpoveď vrátane registrationId
      // vyzerá rovnako ako pri voľnej adrese.
      await mailer.send({
        to: body.email,
        subject: 'Dokladovka — účet už existuje',
        text: `Na adrese ${body.email} už účet v Dokladovke existuje.\n\n`
          + `Ak ste sa práve pokúšali zaregistrovať, prihláste sa na ${config.appBaseUrl} `
          + 'alebo si nechajte poslať odkaz na obnovu hesla cez „Zabudli ste heslo?“.',
      });
      return { status: 'sent', registrationId: randomUUID(), expiresInMinutes: REGISTRATION_CODE_TTL_MINUTES };
    }

    const code = createNumericCode();
    const registrationId = randomUUID();
    const expiresAt = new Date(Date.now() + REGISTRATION_CODE_TTL_MINUTES * 60 * 1000);
    // `id = EXCLUDED.id` je podstatné: nový pokus dostane nové id a potvrdzuje
    // sa práve tým id. Inak by cudzí pokus prepísal čakajúcu registráciu (aj
    // heslo) a obeť by svojím kódom založila účet s heslom útočníka.
    await database.query(
      `INSERT INTO pending_registrations (id, email, email_normalized, name, password_hash, code_hash, expires_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7)
       ON CONFLICT (email_normalized) DO UPDATE SET
         id = EXCLUDED.id, email = EXCLUDED.email, name = EXCLUDED.name, password_hash = EXCLUDED.password_hash,
         code_hash = EXCLUDED.code_hash, expires_at = EXCLUDED.expires_at, attempts = 0, created_at = now()`,
      [registrationId, body.email, email, body.name, passwordHash, sha256(code), expiresAt.toISOString()],
    );
    await mailer.send({
      to: body.email,
      subject: `Dokladovka — overovací kód ${code}`,
      text: `Váš overovací kód je ${code}.\n\n`
        + `Zadajte ho do formulára registrácie. Kód platí ${REGISTRATION_CODE_TTL_MINUTES} minút.\n`
        + 'Ak ste o registráciu nežiadali, tento e-mail ignorujte.',
    });
    return { status: 'sent', registrationId, expiresInMinutes: REGISTRATION_CODE_TTL_MINUTES };
  });

  app.post('/api/auth/register/confirm', {
    config: { rateLimit: { max: 20, timeWindow: '10 minutes' } },
  }, async (request, reply) => {
    const body = confirmSchema.parse(request.body);
    const invalid = new HttpError(400, 'code_invalid', 'Kód je neplatný alebo mu vypršala platnosť');
    // Započítanie pokusu a kontrola limitu v jednom UPDATE — dva súbežné
    // pokusy by pri „prečítaj, potom zvýš" limit obišli.
    const claimed = await database.query<{ id: string; email: string; name: string; password_hash: string; code_hash: string }>(
      `UPDATE pending_registrations SET attempts = attempts + 1
        WHERE id = $1 AND expires_at > now() AND attempts < $2
        RETURNING id, email, name, password_hash, code_hash`,
      [body.registrationId, MAX_CODE_ATTEMPTS],
    );
    const row = claimed.rows[0];
    if (!row || !constantTimeStringEqual(sha256(body.code), row.code_hash)) throw invalid;

    const tenantId = randomUUID();
    const userId = randomUUID();
    await database.transaction(async (tx) => {
      await tx.query('INSERT INTO tenants (id, name) VALUES ($1,$2)', [tenantId, row.name]);
      const created = await tx.query(
        `INSERT INTO users (id, tenant_id, name, email, password_hash, role)
         VALUES ($1,$2,$3,$4,$5,'admin')
         ON CONFLICT DO NOTHING`,
        [userId, tenantId, row.name, row.email, row.password_hash],
      );
      // Adresu medzitým zabral niekto iný (súbežné potvrdenie) — rollback aj
      // založeného tenanta, inak by ostal osirený.
      if (created.rowCount === 0) throw invalid;
      await tx.query('INSERT INTO tenant_integrations (tenant_id) VALUES ($1)', [tenantId]);
      await tx.query('DELETE FROM pending_registrations WHERE id = $1', [row.id]);
    });

    const session = await createSession(database, { id: userId, tenantId }, config);
    setSessionCookie(reply, session.token, config);
    await writeAudit(database, {
      tenantId,
      actorType: 'user',
      actorId: userId,
      action: 'auth.register',
      entityType: 'user',
      entityId: userId,
      correlationId: request.id,
    });
    return buildBrowserSession(
      database,
      {
        sessionId: session.sessionId,
        userId,
        tenantId,
        name: row.name,
        email: row.email,
        role: 'admin',
        language: 'sk',
        notifications: { email: true, inApp: true, comments: true, mentions: true },
        csrfTokenHash: sha256(session.csrfToken),
        expiresAt: session.expiresAt,
      },
      session.csrfToken,
    );
  });

  app.post('/api/auth/password/forgot', {
    config: { rateLimit: { max: 5, timeWindow: '10 minutes' } },
  }, async (request) => {
    const body = forgotSchema.parse(request.body);
    await verifyTurnstile(config, body.captchaToken, request);
    const found = await database.query<{ id: string; tenant_id: string; email: string }>(
      'SELECT id, tenant_id, email FROM users WHERE lower(email) = $1 AND active = true',
      [body.email.toLowerCase()],
    );
    const user = found.rows[0];
    // Odpoveď je zámerne rovnaká aj pre neexistujúci účet (enumerácia adries).
    if (user) {
      const token = randomToken();
      const expiresAt = new Date(Date.now() + RESET_LINK_TTL_MINUTES * 60 * 1000);
      await database.query(
        `INSERT INTO password_reset_tokens (id, user_id, tenant_id, token_hash, expires_at)
         VALUES ($1,$2,$3,$4,$5)`,
        [randomUUID(), user.id, user.tenant_id, sha256(token), expiresAt.toISOString()],
      );
      const link = `${config.appBaseUrl.replace(/\/$/, '')}/obnova-hesla?token=${encodeURIComponent(token)}`;
      await mailer.send({
        to: user.email,
        subject: 'Dokladovka — obnova hesla',
        text: `Nové heslo si nastavíte cez tento odkaz:\n${link}\n\n`
          + `Odkaz platí ${RESET_LINK_TTL_MINUTES} minút a dá sa použiť raz.\n`
          + 'Ak ste o obnovu nežiadali, tento e-mail ignorujte — heslo zostáva nezmenené.',
      });
      await writeAudit(database, {
        tenantId: user.tenant_id,
        actorType: 'user',
        actorId: user.id,
        action: 'auth.password_reset_requested',
        entityType: 'user',
        entityId: user.id,
        correlationId: request.id,
      });
    }
    return { status: 'sent' };
  });

  app.post('/api/auth/password/reset', {
    config: { rateLimit: { max: 10, timeWindow: '10 minutes' } },
  }, async (request) => {
    const body = resetSchema.parse(request.body);
    const found = await database.query<{ id: string; user_id: string; tenant_id: string }>(
      `SELECT t.id, t.user_id, t.tenant_id
         FROM password_reset_tokens t
         JOIN users u ON u.id = t.user_id
        WHERE t.token_hash = $1 AND t.used_at IS NULL AND t.expires_at > now() AND u.active = true`,
      [sha256(body.token)],
    );
    const row = found.rows[0];
    if (!row) throw new HttpError(400, 'token_invalid', 'Odkaz je neplatný alebo mu vypršala platnosť');

    const passwordHash = await hashPassword(body.password);
    await database.transaction(async (tx) => {
      await tx.query('UPDATE users SET password_hash = $1, updated_at = now() WHERE id = $2', [passwordHash, row.user_id]);
      // Ostatné nepoužité tokeny aj bežiace relácie padajú — zmena hesla musí
      // odstrihnúť útočníka, ktorý sa medzitým prihlásil.
      await tx.query('UPDATE password_reset_tokens SET used_at = now() WHERE user_id = $1 AND used_at IS NULL', [row.user_id]);
      // tenant_id je v dotaze kvôli indexu sessions_user_idx (tenant, user).
      await tx.query('DELETE FROM sessions WHERE user_id = $1 AND tenant_id = $2', [row.user_id, row.tenant_id]);
    });
    await writeAudit(database, {
      tenantId: row.tenant_id,
      actorType: 'user',
      actorId: row.user_id,
      action: 'auth.password_reset_completed',
      entityType: 'user',
      entityId: row.user_id,
      correlationId: request.id,
    });
    return { status: 'ok' };
  });
}

import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { ServerConfig } from '../config.js';
import type { Database, Queryable } from '../db/database.js';
import {
  buildBrowserSession,
  createSession,
  requireBrowserAuth,
  requireCsrf,
  requireRole,
  setSessionCookie,
} from '../auth.js';
import { HttpError } from '../http.js';
import { hashPassword, randomToken, sha256, verifyPassword } from '../security.js';
import { writeAudit } from '../audit.js';
import type { Mailer } from '../mailer.js';

/**
 * Používatelia kancelárie a pozvánky.
 *
 * Model je ten istý ako v Doklado: kancelária (tenant) → ľudia → firmy. Prístup
 * k firme určuje VÝLUČNE organization_memberships — to isté, čo už kontroluje
 * requireOrganizationAccess aj buildBrowserSession. Admin tu nemá žiadnu
 * skratku „vidí všetko"; namiesto toho dostane členstvo vo všetkých firmách.
 * Jeden mechanizmus prístupu na všetkých miestach, inak by jedna vrstva pustila
 * a druhá nie.
 *
 * Mostík patrí kancelárii (agent_installations.tenant_id), nie používateľovi,
 * takže pozvaný ho automaticky používa tiež — nič sa nepáruje znova.
 */

const ROLY = ['admin', 'uctovnik', 'schvalovatel'] as const;
type Rola = typeof ROLY[number];

/** Platnosť odkazu v pozvánke. Dlhšia než pri obnove hesla — kolega nemusí mail čítať hneď. */
const POZVANKA_PLATNOST_DNI = 7;
const MIN_DLZKA_HESLA = 10;

const pozvankaSchema = z.object({
  email: z.string().trim().email().max(254),
  meno: z.string().trim().min(1).max(200),
  rola: z.enum(ROLY),
  organizationIds: z.array(z.string().min(1).max(100)).max(500).default([]),
}).strict();

const upravaSchema = z.object({
  rola: z.enum(ROLY).optional(),
  organizationIds: z.array(z.string().min(1).max(100)).max(500).optional(),
}).strict();

const prijatieSchema = z.object({
  token: z.string().min(16).max(200),
  heslo: z.string().min(1).max(500),
  meno: z.string().trim().min(1).max(200).optional(),
}).strict();

async function vsetkyFirmy(tx: Queryable, tenantId: string): Promise<string[]> {
  const result = await tx.query<{ id: string } & Record<string, unknown>>(
    'SELECT id FROM organizations WHERE tenant_id=$1 ORDER BY id', [tenantId],
  );
  return result.rows.map((row) => row.id);
}

/**
 * Firmy, ktoré smie používateľ vidieť. Admin dostane vždy všetky firmy
 * kancelárie — inak by šéfka nevidela firmu, ktorú založil jej účtovník.
 * Ostatní dostanú len firmy z výberu, a to len tie, ktoré kancelárii naozaj
 * patria: cudzie id z požiadavky sa ticho zahodí.
 */
async function firmyPreRolu(tx: Queryable, tenantId: string, rola: Rola, vyber: readonly string[]): Promise<string[]> {
  const firmy = await vsetkyFirmy(tx, tenantId);
  if (rola === 'admin') return firmy;
  const patria = new Set(firmy);
  return [...new Set(vyber)].filter((id) => patria.has(id));
}

async function nastavFirmy(tx: Queryable, tenantId: string, userId: string, firmy: readonly string[]): Promise<void> {
  await tx.query('DELETE FROM organization_memberships WHERE tenant_id=$1 AND user_id=$2', [tenantId, userId]);
  for (const organizationId of firmy) {
    await tx.query(
      'INSERT INTO organization_memberships (user_id, organization_id, tenant_id) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING',
      [userId, organizationId, tenantId],
    );
  }
}

async function pocetAdminov(tx: Queryable, tenantId: string): Promise<number> {
  const result = await tx.query<{ n: string } & Record<string, unknown>>(
    `SELECT count(*)::text AS n FROM users WHERE tenant_id=$1 AND role='admin' AND active=true`, [tenantId],
  );
  return Number(result.rows[0]?.n ?? 0);
}

/** Nová firma patrí hneď aj všetkým adminom kancelárie, nie len tomu, kto ju založil. */
export async function pridajAdminovKFirme(tx: Queryable, tenantId: string, organizationId: string): Promise<void> {
  await tx.query(
    `INSERT INTO organization_memberships (user_id, organization_id, tenant_id)
     SELECT id, $2, $1 FROM users WHERE tenant_id=$1 AND role='admin' AND active=true
     ON CONFLICT DO NOTHING`,
    [tenantId, organizationId],
  );
}

interface PozvankaRow extends Record<string, unknown> {
  id: string;
  tenant_id: string;
  tenant_name: string;
  email: string;
  email_normalized: string;
  name: string;
  role: Rola;
  organization_ids: unknown;
  inviter_name: string;
}

async function najdiPozvanku(database: Queryable, token: string): Promise<PozvankaRow | undefined> {
  const result = await database.query<PozvankaRow>(
    `SELECT i.id, i.tenant_id, t.name AS tenant_name, i.email, i.email_normalized, i.name, i.role,
            i.organization_ids, u.name AS inviter_name
       FROM user_invitations i
       JOIN tenants t ON t.id = i.tenant_id
       JOIN users u ON u.id = i.invited_by
      WHERE i.token_hash=$1 AND i.accepted_at IS NULL AND i.revoked_at IS NULL AND i.expires_at > now()`,
    [sha256(token)],
  );
  return result.rows[0];
}

interface ExistujuciRow extends Record<string, unknown> {
  id: string;
  tenant_id: string;
  role: string;
  password_hash: string;
  firiem_v_kancelarii: string;
}

/**
 * Smie sa účet presunúť do inej kancelárie? Len z prázdnej (bez firiem) a nikdy
 * účet platformy — superadmin má tiež kanceláriu bez firiem, ale pozvánkou ho
 * nesmie nikto stiahnuť k sebe.
 */
function daSaPresunut(ucet: ExistujuciRow): boolean {
  return ucet.role !== 'superadmin' && Number(ucet.firiem_v_kancelarii) === 0;
}

/**
 * Existujúci účet s touto adresou. Používateľ patrí práve jednej kancelárii
 * (users.tenant_id) — a registrácia ho doteraz vždy zaradila do NOVEJ, prázdnej.
 * Taký účet sa smie presunúť do kancelárie, ktorá ho pozýva. Účet v kancelárii,
 * ktorá už má firmy, nie: tam má človek svoju prácu a tú mu nikto nesmie vziať.
 */
async function existujuciUcet(tx: Queryable, emailNormalized: string): Promise<ExistujuciRow | undefined> {
  const result = await tx.query<ExistujuciRow>(
    `SELECT u.id, u.tenant_id, u.role, u.password_hash,
            (SELECT count(*) FROM organizations o WHERE o.tenant_id = u.tenant_id)::text AS firiem_v_kancelarii
       FROM users u WHERE lower(u.email) = $1`,
    [emailNormalized],
  );
  return result.rows[0];
}

/**
 * Zlyhaná pošta ako správa, s ktorou admin vie niečo urobiť. EAUTH znamená, že
 * poštový server odmietol prihlásenie — chyba je v nastavení SMTP servera, nie
 * v pozvánke, a opakovanie nepomôže.
 */
function chybaPosty(error: unknown): HttpError {
  const kod = (error as { code?: unknown } | null)?.code;
  return new HttpError(502, 'mail_failed', kod === 'EAUTH'
    ? 'Pozvánku sa nepodarilo odoslať: poštový server odmietol prihlásenie. Treba opraviť heslo k SMTP v nastaveniach servera.'
    : 'Pozvánku sa nepodarilo odoslať e-mailom. Skúste to znova o chvíľu.');
}

function organizationIdsZPozvanky(value: unknown): string[] {
  const raw = typeof value === 'string' ? JSON.parse(value) : value;
  return Array.isArray(raw) ? raw.filter((id): id is string => typeof id === 'string') : [];
}

export function registerUserRoutes(app: FastifyInstance, database: Database, config: ServerConfig, mailer: Mailer): void {
  // Zoznam ľudí kancelárie s ich firmami a otvorené pozvánky.
  app.get('/api/users', async (request) => {
    const auth = await requireBrowserAuth(request, database);
    requireRole(auth, ['admin']);
    const users = await database.query<{
      id: string; name: string; email: string; role: Rola; active: boolean; organization_ids: string[] | null;
    } & Record<string, unknown>>(
      `SELECT u.id, u.name, u.email, u.role, u.active,
              array_remove(array_agg(m.organization_id ORDER BY m.organization_id), NULL) AS organization_ids
         FROM users u
         LEFT JOIN organization_memberships m ON m.user_id = u.id AND m.tenant_id = u.tenant_id
        WHERE u.tenant_id = $1 AND u.active = true AND u.role <> 'superadmin'
        GROUP BY u.id ORDER BY u.name`,
      [auth.tenantId],
    );
    const pozvanky = await database.query<{
      id: string; email: string; name: string; role: Rola; organization_ids: unknown; expires_at: Date | string;
    } & Record<string, unknown>>(
      `SELECT id, email, name, role, organization_ids, expires_at FROM user_invitations
        WHERE tenant_id=$1 AND accepted_at IS NULL AND revoked_at IS NULL AND expires_at > now()
        ORDER BY created_at DESC`,
      [auth.tenantId],
    );
    return {
      users: users.rows.map((row) => ({
        id: row.id, meno: row.name, email: row.email, rola: row.role,
        organizationIds: row.organization_ids ?? [], ja: row.id === auth.userId,
      })),
      pozvanky: pozvanky.rows.map((row) => ({
        id: row.id, email: row.email, meno: row.name, rola: row.role,
        organizationIds: organizationIdsZPozvanky(row.organization_ids),
        expiresAt: new Date(row.expires_at).toISOString(),
      })),
    };
  });

  app.post('/api/users/invitations', {
    config: { rateLimit: { max: 30, timeWindow: '10 minutes' } },
  }, async (request, reply) => {
    const auth = await requireBrowserAuth(request, database);
    requireCsrf(request, auth);
    requireRole(auth, ['admin']);
    const body = pozvankaSchema.parse(request.body);
    const emailNormalized = body.email.toLowerCase();

    const existujuci = await existujuciUcet(database, emailNormalized);
    if (existujuci?.tenant_id === auth.tenantId) {
      throw new HttpError(409, 'user_already_member', 'Tento človek už v kancelárii je — firmy mu nastavíte v zozname');
    }
    if (existujuci && !daSaPresunut(existujuci)) {
      throw new HttpError(409, 'user_in_other_office',
        'Adresa patrí účtu v inej kancelárii, ktorá má vlastné firmy. Taký účet sa presunúť nedá.');
    }

    const token = randomToken();
    const id = randomUUID();
    const expiresAt = new Date(Date.now() + POZVANKA_PLATNOST_DNI * 24 * 60 * 60 * 1000);
    const firmy = await firmyPreRolu(database, auth.tenantId, body.rola, body.organizationIds);
    const kancelaria = await database.query<{ name: string } & Record<string, unknown>>(
      'SELECT name FROM tenants WHERE id=$1', [auth.tenantId],
    );
    const link = `${config.appBaseUrl.replace(/\/$/, '')}/pozvanka?token=${encodeURIComponent(token)}`;
    const nazovKancelarie = kancelaria.rows[0]?.name ?? 'Dokladovka';
    await database.transaction(async (tx) => {
      // Nová pozvánka odvolá predchádzajúcu — platí vždy len posledný odkaz.
      await tx.query(
        `UPDATE user_invitations SET revoked_at=now()
          WHERE tenant_id=$1 AND email_normalized=$2 AND accepted_at IS NULL AND revoked_at IS NULL`,
        [auth.tenantId, emailNormalized],
      );
      await tx.query(
        `INSERT INTO user_invitations
          (id, tenant_id, email, email_normalized, name, role, organization_ids, token_hash, invited_by, expires_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb,$8,$9,$10)`,
        [id, auth.tenantId, body.email, emailNormalized, body.meno, body.rola, JSON.stringify(firmy),
          sha256(token), auth.userId, expiresAt.toISOString()],
      );
      // E-mail ide VNÚTRI transakcie. Keď neodíde, pozvánka sa nezapíše — ani
      // predchádzajúca sa neodvolá. Pôvodne sa zápis potvrdil pred odoslaním:
      // pri zlyhanej pošte ostala v databáze pozvánka s odkazom, ktorý nikto
      // nedostal, a admin videl len „neočakávanú chybu".
      try {
        await mailer.send({
          to: body.email,
          subject: `Dokladovka — pozvánka do kancelárie ${nazovKancelarie}`,
          text: `${auth.name} vás pozýva do kancelárie ${nazovKancelarie} v Dokladovke.\n\n`
            + `Prijmete ju cez tento odkaz:\n${link}\n\n`
            + `Odkaz platí ${POZVANKA_PLATNOST_DNI} dní a dá sa použiť raz.\n`
            + (existujuci
              ? 'Na tejto adrese už účet máte — prihlásite sa svojím doterajším heslom.\n'
              : 'Pri prijatí si nastavíte heslo.\n')
            + 'Ak pozvánku nečakáte, tento e-mail ignorujte.',
        });
      } catch (error) {
        throw chybaPosty(error);
      }
    });
    await writeAudit(database, {
      tenantId: auth.tenantId, actorType: 'user', actorId: auth.userId,
      action: 'user.invited', entityType: 'user_invitation', entityId: id, correlationId: request.id,
      metadata: { rola: body.rola, firiem: firmy.length },
    });
    return reply.code(201).send({ id, email: body.email, meno: body.meno, rola: body.rola, organizationIds: firmy, expiresAt: expiresAt.toISOString() });
  });

  app.delete<{ Params: { id: string } }>('/api/users/invitations/:id', async (request) => {
    const auth = await requireBrowserAuth(request, database);
    requireCsrf(request, auth);
    requireRole(auth, ['admin']);
    const result = await database.query(
      `UPDATE user_invitations SET revoked_at=now()
        WHERE id=$1 AND tenant_id=$2 AND accepted_at IS NULL AND revoked_at IS NULL`,
      [request.params.id, auth.tenantId],
    );
    if (result.rowCount === 0) throw new HttpError(404, 'invitation_not_found', 'Pozvánka neexistuje');
    return { status: 'revoked' };
  });

  app.put<{ Params: { id: string } }>('/api/users/:id', async (request) => {
    const auth = await requireBrowserAuth(request, database);
    requireCsrf(request, auth);
    requireRole(auth, ['admin']);
    const body = upravaSchema.parse(request.body);
    return database.transaction(async (tx) => {
      const found = await tx.query<{ role: Rola } & Record<string, unknown>>(
        `SELECT role FROM users WHERE id=$1 AND tenant_id=$2 AND active=true AND role <> 'superadmin'`,
        [request.params.id, auth.tenantId],
      );
      const povodna = found.rows[0]?.role;
      if (!povodna) throw new HttpError(404, 'user_not_found', 'Používateľ neexistuje');
      const rola = body.rola ?? povodna;
      // Kancelária bez admina by nemala kto pozývať ani spravovať Mostík.
      if (povodna === 'admin' && rola !== 'admin' && await pocetAdminov(tx, auth.tenantId) <= 1) {
        throw new HttpError(409, 'last_admin', 'Kancelária musí mať aspoň jedného admina');
      }
      if (rola !== povodna) {
        await tx.query('UPDATE users SET role=$1, updated_at=now() WHERE id=$2', [rola, request.params.id]);
      }
      // Firmy sa prepočítajú vždy, keď sa mení rola alebo výber: povýšený na
      // admina dostane všetky, ostatným sa uloží výber.
      if (body.organizationIds !== undefined || rola !== povodna) {
        const vyber = body.organizationIds ?? (await tx.query<{ organization_id: string } & Record<string, unknown>>(
          'SELECT organization_id FROM organization_memberships WHERE tenant_id=$1 AND user_id=$2',
          [auth.tenantId, request.params.id],
        )).rows.map((row) => row.organization_id);
        await nastavFirmy(tx, auth.tenantId, request.params.id, await firmyPreRolu(tx, auth.tenantId, rola, vyber));
      }
      await writeAudit(tx, {
        tenantId: auth.tenantId, actorType: 'user', actorId: auth.userId,
        action: 'user.access_updated', entityType: 'user', entityId: request.params.id, correlationId: request.id,
        metadata: { rola, zmenaFiriem: body.organizationIds !== undefined },
      });
      return { status: 'ok', rola };
    });
  });

  app.delete<{ Params: { id: string } }>('/api/users/:id', async (request) => {
    const auth = await requireBrowserAuth(request, database);
    requireCsrf(request, auth);
    requireRole(auth, ['admin']);
    if (request.params.id === auth.userId) {
      throw new HttpError(409, 'cannot_remove_self', 'Seba z kancelárie odstrániť nemôžete');
    }
    return database.transaction(async (tx) => {
      const found = await tx.query<{ role: Rola } & Record<string, unknown>>(
        `SELECT role FROM users WHERE id=$1 AND tenant_id=$2 AND active=true AND role <> 'superadmin'`,
        [request.params.id, auth.tenantId],
      );
      const rola = found.rows[0]?.role;
      if (!rola) throw new HttpError(404, 'user_not_found', 'Používateľ neexistuje');
      if (rola === 'admin' && await pocetAdminov(tx, auth.tenantId) <= 1) {
        throw new HttpError(409, 'last_admin', 'Kancelária musí mať aspoň jedného admina');
      }
      // Deaktivácia, nie zmazanie: na používateľa odkazujú exporty, platby
      // a audit. Prístup končí hneď — padne členstvo aj všetky relácie.
      await tx.query('UPDATE users SET active=false, updated_at=now() WHERE id=$1', [request.params.id]);
      await tx.query('DELETE FROM organization_memberships WHERE tenant_id=$1 AND user_id=$2', [auth.tenantId, request.params.id]);
      await tx.query('DELETE FROM sessions WHERE tenant_id=$1 AND user_id=$2', [auth.tenantId, request.params.id]);
      await writeAudit(tx, {
        tenantId: auth.tenantId, actorType: 'user', actorId: auth.userId,
        action: 'user.removed', entityType: 'user', entityId: request.params.id, correlationId: request.id,
      });
      return { status: 'removed' };
    });
  });

  // Verejné: čo pozvánka ponúka. Token je tajný a prišiel na pozvanú adresu,
  // takže to, či adresa už účet má, vidí len jej majiteľ.
  app.get<{ Params: { token: string } }>('/api/invitations/:token', {
    config: { rateLimit: { max: 30, timeWindow: '10 minutes' } },
  }, async (request) => {
    const pozvanka = await najdiPozvanku(database, request.params.token);
    if (!pozvanka) throw new HttpError(404, 'invitation_invalid', 'Pozvánka je neplatná alebo jej vypršala platnosť');
    const existujuci = await existujuciUcet(database, pozvanka.email_normalized);
    return {
      kancelaria: pozvanka.tenant_name,
      email: pozvanka.email,
      meno: pozvanka.name,
      pozval: pozvanka.inviter_name,
      existujuciUcet: Boolean(existujuci),
    };
  });

  app.post('/api/invitations/accept', {
    config: { rateLimit: { max: 10, timeWindow: '10 minutes' } },
  }, async (request, reply) => {
    const body = prijatieSchema.parse(request.body);
    const pozvanka = await najdiPozvanku(database, body.token);
    if (!pozvanka) throw new HttpError(400, 'invitation_invalid', 'Pozvánka je neplatná alebo jej vypršala platnosť');

    const vysledok = await database.transaction(async (tx) => {
      const existujuci = await existujuciUcet(tx, pozvanka.email_normalized);
      let userId: string;
      let meno = body.meno ?? pozvanka.name;
      if (existujuci) {
        // Kontrola ešte raz, pri prijatí: kancelária mohla medzitým firmu dostať.
        if (existujuci.tenant_id !== pozvanka.tenant_id && !daSaPresunut(existujuci)) {
          throw new HttpError(409, 'user_in_other_office',
            'Váš účet patrí kancelárii, ktorá má vlastné firmy. Taký účet sa presunúť nedá.');
        }
        // Presun účtu je vážnejší než nový účet: odkaz dokazuje len vlastníctvo
        // schránky, doterajšie heslo dokazuje vlastníctvo účtu.
        if (!await verifyPassword(body.heslo, existujuci.password_hash)) {
          throw new HttpError(400, 'password_invalid', 'Heslo nesedí s vaším doterajším účtom');
        }
        userId = existujuci.id;
        const menoRow = await tx.query<{ name: string } & Record<string, unknown>>('SELECT name FROM users WHERE id=$1', [userId]);
        meno = menoRow.rows[0]?.name ?? meno;
        await tx.query(
          'UPDATE users SET tenant_id=$1, role=$2, active=true, updated_at=now() WHERE id=$3',
          [pozvanka.tenant_id, pozvanka.role, userId],
        );
        // Relácie a odkazy na obnovu hesla patria starej kancelárii.
        await tx.query('DELETE FROM sessions WHERE user_id=$1', [userId]);
        await tx.query('UPDATE password_reset_tokens SET used_at=now() WHERE user_id=$1 AND used_at IS NULL', [userId]);
        await tx.query('DELETE FROM organization_memberships WHERE user_id=$1', [userId]);
      } else {
        if (body.heslo.length < MIN_DLZKA_HESLA) {
          throw new HttpError(400, 'password_too_short', `Heslo musí mať aspoň ${MIN_DLZKA_HESLA} znakov`);
        }
        userId = randomUUID();
        await tx.query(
          `INSERT INTO users (id, tenant_id, name, email, password_hash, role) VALUES ($1,$2,$3,$4,$5,$6)`,
          [userId, pozvanka.tenant_id, meno, pozvanka.email, await hashPassword(body.heslo), pozvanka.role],
        );
      }
      await nastavFirmy(tx, pozvanka.tenant_id, userId,
        await firmyPreRolu(tx, pozvanka.tenant_id, pozvanka.role, organizationIdsZPozvanky(pozvanka.organization_ids)));
      const prijata = await tx.query(
        'UPDATE user_invitations SET accepted_at=now() WHERE id=$1 AND accepted_at IS NULL AND revoked_at IS NULL',
        [pozvanka.id],
      );
      // Súbežné prijatie tej istej pozvánky — druhé nesmie nič zmeniť.
      if (prijata.rowCount === 0) throw new HttpError(400, 'invitation_invalid', 'Pozvánka už bola použitá');
      return { userId, meno, presun: Boolean(existujuci) };
    });

    const session = await createSession(database, { id: vysledok.userId, tenantId: pozvanka.tenant_id }, config);
    setSessionCookie(reply, session.token, config);
    await writeAudit(database, {
      tenantId: pozvanka.tenant_id, actorType: 'user', actorId: vysledok.userId,
      action: vysledok.presun ? 'user.invitation_accepted_moved' : 'user.invitation_accepted',
      entityType: 'user', entityId: vysledok.userId, correlationId: request.id,
    });
    return buildBrowserSession(database, {
      sessionId: session.sessionId,
      userId: vysledok.userId,
      tenantId: pozvanka.tenant_id,
      name: vysledok.meno,
      email: pozvanka.email,
      role: pozvanka.role,
      language: 'sk',
      notifications: { email: true, inApp: true, comments: true, mentions: true },
      csrfTokenHash: sha256(session.csrfToken),
      expiresAt: session.expiresAt,
    }, session.csrfToken);
  });
}

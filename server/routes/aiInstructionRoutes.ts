import { randomUUID } from 'node:crypto';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { requireBrowserAuth, requireCsrf, requireOrganizationAccess, requireRole } from '../auth.js';
import type { Database, Queryable } from '../db/database.js';
import { HttpError } from '../http.js';

// Textové pravidlá pre AI. Globálne píše jediný správca platformy (rola
// superadmin) a platia pre všetky firmy; firemné píše účtovník v nastaveniach.
// Obe cesty používajú tú istú tabuľku aj to isté telo požiadavky.

const TYPY_DOKLADOV = ['FP', 'FV', 'BV', 'MZDY', 'OZ', 'PD'] as const;

const teloSchema = z.object({
  nazov: z.string().trim().min(1).max(120),
  text: z.string().trim().min(1).max(8_000),
  faza: z.enum(['extraction', 'accounting', 'both']).default('both'),
  typyDokladov: z.array(z.enum(TYPY_DOKLADOV)).max(TYPY_DOKLADOV.length).default([]),
  klucoveSlova: z.array(z.string().trim().min(1).max(40)).max(10).default([]),
  priorita: z.number().int().min(0).max(1000).default(100),
  active: z.boolean().default(true),
}).strict();
const zmenaSchema = teloSchema.partial().strict();

function mapRow(row: Record<string, unknown>) {
  return {
    id: String(row.id),
    scope: row.scope as 'global' | 'organization',
    nazov: String(row.nazov),
    text: String(row.text),
    faza: row.faza as 'extraction' | 'accounting' | 'both',
    typyDokladov: Array.isArray(row.typy_dokladov) ? (row.typy_dokladov as string[]) : [],
    klucoveSlova: Array.isArray(row.klucove_slova) ? (row.klucove_slova as string[]) : [],
    priorita: Number(row.priorita),
    active: row.active === true,
    updatedAt: row.updated_at ? new Date(String(row.updated_at)).toISOString() : undefined,
  };
}

type Ciel = { scope: 'global'; tenantId: null; organizationId: null }
  | { scope: 'organization'; tenantId: string; organizationId: string };

async function zoznam(database: Queryable, ciel: Ciel) {
  const result = await database.query<Record<string, unknown>>(
    `SELECT id, scope, nazov, text, faza, typy_dokladov, klucove_slova, priorita, active, updated_at
       FROM ai_instructions
      WHERE scope=$1 AND tenant_id IS NOT DISTINCT FROM $2 AND organization_id IS NOT DISTINCT FROM $3
      ORDER BY priorita, created_at`,
    [ciel.scope, ciel.tenantId, ciel.organizationId],
  );
  return { pravidla: result.rows.map(mapRow) };
}

async function vytvor(database: Queryable, ciel: Ciel, telo: z.infer<typeof teloSchema>, userId: string) {
  const result = await database.query<Record<string, unknown>>(
    `INSERT INTO ai_instructions
      (id,scope,tenant_id,organization_id,nazov,text,faza,typy_dokladov,klucove_slova,priorita,active,updated_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9::jsonb,$10,$11,$12)
     RETURNING id, scope, nazov, text, faza, typy_dokladov, klucove_slova, priorita, active, updated_at`,
    [randomUUID(), ciel.scope, ciel.tenantId, ciel.organizationId, telo.nazov, telo.text, telo.faza,
      JSON.stringify(telo.typyDokladov), JSON.stringify(telo.klucoveSlova), telo.priorita, telo.active, userId],
  );
  return mapRow(result.rows[0]);
}

async function uprav(
  database: Queryable,
  ciel: Ciel,
  id: string,
  zmena: z.infer<typeof zmenaSchema>,
  userId: string,
) {
  const result = await database.query<Record<string, unknown>>(
    `UPDATE ai_instructions SET
       nazov=COALESCE($4,nazov), text=COALESCE($5,text), faza=COALESCE($6,faza),
       typy_dokladov=COALESCE($7::jsonb,typy_dokladov), klucove_slova=COALESCE($8::jsonb,klucove_slova),
       priorita=COALESCE($9,priorita), active=COALESCE($10,active),
       updated_at=now(), updated_by=$11
     WHERE id=$1 AND scope=$2 AND organization_id IS NOT DISTINCT FROM $3
       AND tenant_id IS NOT DISTINCT FROM $12
     RETURNING id, scope, nazov, text, faza, typy_dokladov, klucove_slova, priorita, active, updated_at`,
    [id, ciel.scope, ciel.organizationId, zmena.nazov ?? null, zmena.text ?? null, zmena.faza ?? null,
      zmena.typyDokladov ? JSON.stringify(zmena.typyDokladov) : null,
      zmena.klucoveSlova ? JSON.stringify(zmena.klucoveSlova) : null,
      zmena.priorita ?? null, zmena.active ?? null, userId, ciel.tenantId],
  );
  if (!result.rows[0]) throw new HttpError(404, 'instruction_not_found', 'Pravidlo neexistuje');
  return mapRow(result.rows[0]);
}

async function zmaz(database: Queryable, ciel: Ciel, id: string) {
  const result = await database.query(
    `DELETE FROM ai_instructions
      WHERE id=$1 AND scope=$2 AND organization_id IS NOT DISTINCT FROM $3
        AND tenant_id IS NOT DISTINCT FROM $4`,
    [id, ciel.scope, ciel.organizationId, ciel.tenantId],
  );
  if (result.rowCount === 0) throw new HttpError(404, 'instruction_not_found', 'Pravidlo neexistuje');
  return { ok: true };
}

const GLOBAL: Ciel = { scope: 'global', tenantId: null, organizationId: null };
const idSchema = z.object({ instructionId: z.string().uuid() });
const orgIdSchema = z.object({ id: z.string().uuid() });

export function registerAiInstructionRoutes(app: FastifyInstance, database: Database): void {
  // ===== Globálne pravidlá — jediný účet s rolou superadmin =====

  app.get('/api/global-instructions', async (request) => {
    const auth = await requireBrowserAuth(request, database);
    requireRole(auth, ['superadmin']);
    return zoznam(database, GLOBAL);
  });

  app.post('/api/global-instructions', async (request) => {
    const auth = await requireBrowserAuth(request, database);
    requireCsrf(request, auth);
    requireRole(auth, ['superadmin']);
    return vytvor(database, GLOBAL, teloSchema.parse(request.body), auth.userId);
  });

  app.patch('/api/global-instructions/:instructionId', async (request) => {
    const auth = await requireBrowserAuth(request, database);
    requireCsrf(request, auth);
    requireRole(auth, ['superadmin']);
    const { instructionId } = idSchema.parse(request.params);
    return uprav(database, GLOBAL, instructionId, zmenaSchema.parse(request.body), auth.userId);
  });

  app.delete('/api/global-instructions/:instructionId', async (request) => {
    const auth = await requireBrowserAuth(request, database);
    requireCsrf(request, auth);
    requireRole(auth, ['superadmin']);
    const { instructionId } = idSchema.parse(request.params);
    return zmaz(database, GLOBAL, instructionId);
  });

  // ===== Pravidlá firmy — účtovník/admin s prístupom k organizácii =====

  const cielFirmy = async (request: FastifyRequest, write: boolean) => {
    const auth = await requireBrowserAuth(request, database);
    if (write) requireCsrf(request, auth);
    requireRole(auth, ['admin', 'uctovnik']);
    const { id } = orgIdSchema.parse(request.params);
    await requireOrganizationAccess(database, auth, id);
    return { auth, ciel: { scope: 'organization', tenantId: auth.tenantId, organizationId: id } as Ciel };
  };

  app.get('/api/organizations/:id/instructions', async (request) => {
    const { ciel } = await cielFirmy(request, false);
    return zoznam(database, ciel);
  });

  app.post('/api/organizations/:id/instructions', async (request) => {
    const { auth, ciel } = await cielFirmy(request, true);
    return vytvor(database, ciel, teloSchema.parse(request.body), auth.userId);
  });

  app.patch('/api/organizations/:id/instructions/:instructionId', async (request) => {
    const { auth, ciel } = await cielFirmy(request, true);
    const { instructionId } = idSchema.parse(request.params);
    return uprav(database, ciel, instructionId, zmenaSchema.parse(request.body), auth.userId);
  });

  app.delete('/api/organizations/:id/instructions/:instructionId', async (request) => {
    const { ciel } = await cielFirmy(request, true);
    const { instructionId } = idSchema.parse(request.params);
    return zmaz(database, ciel, instructionId);
  });
}

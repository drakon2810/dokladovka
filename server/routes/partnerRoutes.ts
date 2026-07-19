import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { requireBrowserAuth, requireCsrf, requireOrganizationAccess, requireRole } from '../auth.js';
import { writeAudit } from '../audit.js';
import type { Database } from '../db/database.js';
import { HttpError } from '../http.js';
import { mapPartnerRow, normalizovanyNazov } from '../services/partnerService.js';

// Partneri (kontrahenti) — ručná správa adresára. Automatické zakladanie
// z dokladov rieši worker (partnerService.upsertPartnerZDokladu).

const partnerSchema = z.object({
  nazov: z.string().trim().min(1).max(200),
  ico: z.string().trim().max(20).optional(),
  dic: z.string().trim().max(20).optional(),
  icDph: z.string().trim().max(20).optional(),
  iban: z.string().trim().max(40).optional(),
  adresa: z.string().trim().max(300).optional(),
  email: z.string().trim().max(200).optional(),
  telefon: z.string().trim().max(40).optional(),
  predvolenaPredkontaciaId: z.string().optional(),
  predvoleneClenenieDphId: z.string().optional(),
  predvoleneStrediskoId: z.string().optional(),
  poznamka: z.string().trim().max(500).optional(),
}).strict();

async function overPredvolby(
  database: Database,
  tenantId: string,
  organizationId: string,
  body: z.infer<typeof partnerSchema>,
): Promise<void> {
  const ids = [body.predvolenaPredkontaciaId, body.predvoleneClenenieDphId, body.predvoleneStrediskoId]
    .filter((value): value is string => Boolean(value));
  if (ids.length === 0) return;
  const valid = await database.query(
    `SELECT id FROM code_list_items
      WHERE tenant_id=$1 AND organization_id=$2 AND active=true AND id=ANY($3::text[])`,
    [tenantId, organizationId, ids],
  );
  if (valid.rowCount !== new Set(ids).size) {
    throw new HttpError(400, 'partner_defaults_invalid', 'Predvolený číselník nepatrí organizácii alebo nie je aktívny');
  }
}

interface PartnerRow extends Record<string, unknown> {
  id: string;
  organization_id: string;
}

async function scopedPartner(database: Database, tenantId: string, id: string): Promise<PartnerRow> {
  const result = await database.query<PartnerRow>(
    'SELECT * FROM partners WHERE id=$1 AND tenant_id=$2', [id, tenantId],
  );
  if (!result.rows[0]) throw new HttpError(404, 'partner_not_found', 'Partner neexistuje');
  return result.rows[0];
}

export function registerPartnerRoutes(app: FastifyInstance, database: Database): void {
  app.post('/api/organizations/:organizationId/partners', async (request, reply) => {
    const auth = await requireBrowserAuth(request, database);
    requireCsrf(request, auth);
    requireRole(auth, ['admin', 'uctovnik']);
    const { organizationId } = z.object({ organizationId: z.string().uuid() }).parse(request.params);
    await requireOrganizationAccess(database, auth, organizationId);
    const body = partnerSchema.parse(request.body);
    await overPredvolby(database, auth.tenantId, organizationId, body);
    const id = randomUUID();
    await database.query(
      `INSERT INTO partners
        (id, tenant_id, organization_id, name, name_normalized, ico, dic, ic_dph, iban, address,
         email, phone, default_predkontacia_id, default_clenenie_dph_id, default_stredisko_id,
         note, source, updated_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,'manual',$17)`,
      [id, auth.tenantId, organizationId, body.nazov, normalizovanyNazov(body.nazov),
        body.ico ?? null, body.dic ?? null, body.icDph ?? null, body.iban ?? null, body.adresa ?? null,
        body.email ?? null, body.telefon ?? null, body.predvolenaPredkontaciaId ?? null,
        body.predvoleneClenenieDphId ?? null, body.predvoleneStrediskoId ?? null,
        body.poznamka ?? null, auth.userId],
    );
    await writeAudit(database, {
      tenantId: auth.tenantId,
      organizationId,
      actorType: 'user',
      actorId: auth.userId,
      action: 'partner.created',
      entityType: 'partner',
      entityId: id,
      correlationId: request.id,
      metadata: { nazov: body.nazov },
    });
    const created = await database.query<Record<string, unknown>>('SELECT * FROM partners WHERE id=$1', [id]);
    return reply.code(201).send(mapPartnerRow(created.rows[0]));
  });

  app.patch('/api/partners/:id', async (request) => {
    const auth = await requireBrowserAuth(request, database);
    requireCsrf(request, auth);
    requireRole(auth, ['admin', 'uctovnik']);
    const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
    const partner = await scopedPartner(database, auth.tenantId, id);
    await requireOrganizationAccess(database, auth, partner.organization_id);
    const body = partnerSchema.partial().strict().parse(request.body);
    await overPredvolby(database, auth.tenantId, partner.organization_id, body as z.infer<typeof partnerSchema>);
    const nazov = body.nazov ?? String(partner.name);
    await database.query(
      `UPDATE partners SET
         name=$1, name_normalized=$2,
         ico=$3, dic=$4, ic_dph=$5, iban=$6, address=$7, email=$8, phone=$9,
         default_predkontacia_id=$10, default_clenenie_dph_id=$11, default_stredisko_id=$12,
         note=$13, source='manual', updated_by=$14, updated_at=now()
       WHERE id=$15 AND tenant_id=$16`,
      [nazov, normalizovanyNazov(nazov),
        body.ico ?? partner.ico ?? null, body.dic ?? partner.dic ?? null,
        body.icDph ?? partner.ic_dph ?? null, body.iban ?? partner.iban ?? null,
        body.adresa ?? partner.address ?? null, body.email ?? partner.email ?? null,
        body.telefon ?? partner.phone ?? null,
        body.predvolenaPredkontaciaId ?? partner.default_predkontacia_id ?? null,
        body.predvoleneClenenieDphId ?? partner.default_clenenie_dph_id ?? null,
        body.predvoleneStrediskoId ?? partner.default_stredisko_id ?? null,
        body.poznamka ?? partner.note ?? null, auth.userId, id, auth.tenantId],
    );
    await writeAudit(database, {
      tenantId: auth.tenantId,
      organizationId: partner.organization_id,
      actorType: 'user',
      actorId: auth.userId,
      action: 'partner.updated',
      entityType: 'partner',
      entityId: id,
      correlationId: request.id,
    });
    const updated = await database.query<Record<string, unknown>>('SELECT * FROM partners WHERE id=$1', [id]);
    return mapPartnerRow(updated.rows[0]);
  });

  app.post('/api/partners/:id/archive', async (request, reply) => {
    const auth = await requireBrowserAuth(request, database);
    requireCsrf(request, auth);
    requireRole(auth, ['admin', 'uctovnik']);
    const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
    const partner = await scopedPartner(database, auth.tenantId, id);
    await requireOrganizationAccess(database, auth, partner.organization_id);
    await database.query(
      'UPDATE partners SET active=false, updated_by=$1, updated_at=now() WHERE id=$2 AND tenant_id=$3',
      [auth.userId, id, auth.tenantId],
    );
    await writeAudit(database, {
      tenantId: auth.tenantId,
      organizationId: partner.organization_id,
      actorType: 'user',
      actorId: auth.userId,
      action: 'partner.archived',
      entityType: 'partner',
      entityId: id,
      correlationId: request.id,
    });
    return reply.code(204).send();
  });
}

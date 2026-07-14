import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { requireBrowserAuth, requireCsrf, requireOrganizationAccess, requireRole } from '../auth.js';
import { writeAudit } from '../audit.js';
import type { Database } from '../db/database.js';

const kinds = ['predkontacie', 'cleneniaDph', 'ciselneRady', 'strediska'] as const;
const itemSchema = z.object({
  kod: z.string().trim().min(1).max(100),
  nazov: z.string().trim().min(1).max(300),
  externalId: z.string().trim().max(100).optional(),
  agenda: z.string().trim().max(100).optional(),
  uctovnyRok: z.string().trim().max(20).optional(),
}).strict();
const removedSchema = z.object({ id: z.string().min(1), kod: z.string().min(1) }).passthrough();
const kindSchema = z.object({
  nove: z.array(itemSchema),
  aktualizovane: z.array(itemSchema),
  bezZmeny: z.number().int().nonnegative(),
  vyradene: z.array(removedSchema),
}).strict();
const importSchema = z.object({
  orgId: z.string().uuid(),
  perKind: z.object(Object.fromEntries(kinds.map((kind) => [kind, kindSchema])) as Record<typeof kinds[number], typeof kindSchema>),
  warnings: z.array(z.string()).default([]),
}).strict();

type Counts = { nove: number; aktualizovane: number; vyradene: number; bezZmeny: number };

export function registerCodeListRoutes(app: FastifyInstance, database: Database): void {
  app.put('/api/organizations/:id/code-lists/import', async (request) => {
    const auth = await requireBrowserAuth(request, database);
    requireCsrf(request, auth);
    requireRole(auth, ['admin', 'uctovnik']);
    const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
    const body = importSchema.parse(request.body);
    if (body.orgId !== id) throw new Error('Import nepatrí vybranej organizácii');
    await requireOrganizationAccess(database, auth, id);
    const syncedAt = new Date().toISOString();
    const perKind = Object.fromEntries(kinds.map((kind) => [kind, {
      nove: 0,
      aktualizovane: 0,
      vyradene: 0,
      bezZmeny: body.perKind[kind].bezZmeny,
    }])) as Record<typeof kinds[number], Counts>;

    await database.transaction(async (tx) => {
      for (const kind of kinds) {
        const incoming = [...body.perKind[kind].nove, ...body.perKind[kind].aktualizovane];
        const seen = new Set<string>();
        for (const item of incoming) {
          if (seen.has(item.kod)) throw new Error(`Kód ${item.kod} je v importe uvedený viackrát`);
          seen.add(item.kod);
          const existing = await tx.query<{
            id: string; name: string; source: string; active: boolean; external_id?: string;
            agenda?: string; accounting_year?: string;
          } & Record<string, unknown>>(
            `SELECT id,name,source,active,external_id,agenda,accounting_year FROM code_list_items
              WHERE tenant_id=$1 AND organization_id=$2 AND kind=$3 AND code=$4`,
            [auth.tenantId, id, kind, item.kod],
          );
          const row = existing.rows[0];
          const unchanged = row && row.source === 'pohoda' && row.active && row.name === item.nazov
            && (row.external_id ?? undefined) === item.externalId
            && (row.agenda ?? undefined) === item.agenda
            && (row.accounting_year ?? undefined) === item.uctovnyRok;
          if (unchanged) {
            perKind[kind].bezZmeny += 1;
            continue;
          }
          await tx.query(
            `INSERT INTO code_list_items
              (id,tenant_id,organization_id,kind,code,name,source,active,external_id,agenda,accounting_year,synced_at)
             VALUES ($1,$2,$3,$4,$5,$6,'pohoda',true,$7,$8,$9,$10)
             ON CONFLICT (tenant_id,organization_id,kind,code) DO UPDATE SET
               name=EXCLUDED.name,source='pohoda',active=true,external_id=EXCLUDED.external_id,
               agenda=EXCLUDED.agenda,accounting_year=EXCLUDED.accounting_year,synced_at=EXCLUDED.synced_at,updated_at=now()`,
            [randomUUID(), auth.tenantId, id, kind, item.kod, item.nazov, item.externalId ?? null,
              item.agenda ?? null, item.uctovnyRok ?? null, syncedAt],
          );
          if (row) perKind[kind].aktualizovane += 1;
          else perKind[kind].nove += 1;
        }
        for (const removed of body.perKind[kind].vyradene) {
          const result = await tx.query(
            `UPDATE code_list_items SET active=false,synced_at=$1,updated_at=now()
              WHERE id=$2 AND tenant_id=$3 AND organization_id=$4 AND kind=$5 AND source='pohoda' AND active=true`,
            [syncedAt, removed.id, auth.tenantId, id, kind],
          );
          perKind[kind].vyradene += result.rowCount;
        }
      }
      await writeAudit(tx, {
        tenantId: auth.tenantId,
        organizationId: id,
        actorType: 'user',
        actorId: auth.userId,
        action: 'code_lists.imported',
        entityType: 'organization',
        entityId: id,
        correlationId: request.id,
      });
    });

    const totals = kinds.reduce((result, kind) => ({
      nove: result.nove + perKind[kind].nove,
      aktualizovane: result.aktualizovane + perKind[kind].aktualizovane,
      vyradene: result.vyradene + perKind[kind].vyradene,
      bezZmeny: result.bezZmeny + perKind[kind].bezZmeny,
    }), { nove: 0, aktualizovane: 0, vyradene: 0, bezZmeny: 0 });
    return { perKind, ...totals, totalChanges: totals.nove + totals.aktualizovane + totals.vyradene };
  });
}

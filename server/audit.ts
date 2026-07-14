import { randomUUID } from 'node:crypto';
import type { Queryable } from './db/database.js';

export interface AuditEvent {
  tenantId: string;
  organizationId?: string;
  actorType: 'user' | 'agent' | 'system';
  actorId?: string;
  action: string;
  entityType: string;
  entityId?: string;
  correlationId: string;
  metadata?: Record<string, unknown>;
}

export async function writeAudit(queryable: Queryable, event: AuditEvent): Promise<void> {
  await queryable.query(
    `INSERT INTO audit_logs
      (id, tenant_id, organization_id, actor_type, actor_id, action, entity_type, entity_id, correlation_id, metadata)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb)`,
    [
      randomUUID(),
      event.tenantId,
      event.organizationId ?? null,
      event.actorType,
      event.actorId ?? null,
      event.action,
      event.entityType,
      event.entityId ?? null,
      event.correlationId,
      JSON.stringify(event.metadata ?? {}),
    ],
  );
}

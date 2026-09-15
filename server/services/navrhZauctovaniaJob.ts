import { randomUUID } from 'node:crypto';
import type { Queryable } from '../db/database.js';

/**
 * Zaradí nový návrh zaúčtovania dokladu do fronty. Volá sa v transakcii toho,
 * kto starý návrh zneplatnil: prázdny návrh bez jobu, ktorý ho nahradí, by
 * ostal prázdny navždy. Čakajúci alebo bežiaci job stačí jeden — druhé prepnutie
 * druhu pred jeho spustením by model len zavolalo dvakrát nad tým istým dokladom.
 */
export async function zaradNavrhZauctovania(db: Queryable, input: {
  tenantId: string;
  organizationId: string;
  documentId: string;
  correlationId: string;
}): Promise<void> {
  await db.query(
    `INSERT INTO processing_jobs (id, tenant_id, organization_id, document_id, kind, status, correlation_id, max_attempts, payload)
     SELECT $1, $2, $3, $4, 'navrh_zauctovania', 'queued', $5, 3, '{}'::jsonb
      WHERE NOT EXISTS (
        SELECT 1 FROM processing_jobs
         WHERE tenant_id=$2 AND document_id=$4 AND kind='navrh_zauctovania' AND status IN ('queued','running'))`,
    [randomUUID(), input.tenantId, input.organizationId, input.documentId, input.correlationId],
  );
}

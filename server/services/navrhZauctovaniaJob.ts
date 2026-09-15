import { randomUUID } from 'node:crypto';
import type { Queryable } from '../db/database.js';

/**
 * Zaradí nový návrh zaúčtovania dokladu do fronty. Volá sa v transakcii toho,
 * kto starý návrh zneplatnil: prázdny návrh bez jobu, ktorý ho nahradí, by
 * ostal prázdny navždy. Čakajúci job stačí jeden — druhé prepnutie druhu pred
 * jeho spustením by model len zavolalo dvakrát nad tým istým dokladom. Bežiaci
 * job však doklad prečítal ešte v starom druhu a jeho návrh by ostal posledný,
 * preto sa za ním zaradí ďalší.
 * ponytail: claimJob pustí čakajúci job aj súbežne s bežiacim toho istého
 * dokladu (viac slučiek workera); keby starý skončil neskôr, prepíše návrh
 * starým druhom. Oprava: claimJob preskočí navrh_zauctovania dokladu s bežiacim.
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
         WHERE tenant_id=$2 AND document_id=$4 AND kind='navrh_zauctovania' AND status='queued')`,
    [randomUUID(), input.tenantId, input.organizationId, input.documentId, input.correlationId],
  );
}

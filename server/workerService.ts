import { randomUUID } from 'node:crypto';
import type { ServerConfig } from './config.js';
import type { Database, Queryable } from './db/database.js';
import { writeAudit } from './audit.js';

interface JobRow extends Record<string, unknown> {
  id: string;
  tenant_id: string;
  organization_id: string;
  attachment_id: string;
  correlation_id: string;
  attempts: number;
  max_attempts: number;
  payload: { mockExtraction?: Record<string, unknown> };
}

interface AttachmentContext extends Record<string, unknown> {
  id: string;
  inbound_email_id: string;
  detected_mime_type: string;
  storage_key: string;
  original_file_name: string;
  sender_email?: string;
  subject?: string;
  received_at: string | Date;
  organization_name: string;
  organization_ico: string;
}

async function claimJob(database: Database, workerId: string): Promise<JobRow | undefined> {
  return database.transaction(async (tx) => {
    const result = await tx.query<JobRow>(
      `SELECT id, tenant_id, organization_id, attachment_id, correlation_id, attempts, max_attempts, payload
         FROM processing_jobs
        WHERE status='queued' AND available_at <= now()
        ORDER BY created_at
        FOR UPDATE SKIP LOCKED
        LIMIT 1`,
    );
    const job = result.rows[0];
    if (!job) return undefined;
    await tx.query(
      `UPDATE processing_jobs SET status='running', attempts=attempts+1, locked_at=now(), locked_by=$1, updated_at=now()
        WHERE id=$2`,
      [workerId, job.id],
    );
    return { ...job, attempts: job.attempts + 1 };
  });
}

async function failJob(tx: Queryable, job: JobRow, error: unknown): Promise<void> {
  const message = error instanceof Error ? error.message : String(error);
  const terminal = job.attempts >= job.max_attempts;
  const delaySeconds = Math.min(300, 2 ** job.attempts);
  await tx.query(
    `UPDATE processing_jobs
        SET status=$1, available_at=now() + ($2 * interval '1 second'), locked_at=NULL, locked_by=NULL,
            error_code='processing_failed', error_message=$3, updated_at=now()
      WHERE id=$4`,
    [terminal ? 'dead_letter' : 'queued', delaySeconds, message.slice(0, 500), job.id],
  );
  await tx.query(
    `UPDATE inbound_attachments SET status=$1, quarantine_reason='processing_failed' WHERE id=$2`,
    [terminal ? 'failed' : 'queued', job.attachment_id],
  );
}

export async function processNextJob(database: Database, config: ServerConfig, workerId = `worker-${process.pid}`): Promise<boolean> {
  const job = await claimJob(database, workerId);
  if (!job) return false;
  try {
    if (config.extractionProvider !== 'mock') {
      throw new Error('OpenAI provider patrí do samostatnej Fázy 2B a nie je aktivovaný');
    }
    const contextResult = await database.query<AttachmentContext>(
      `SELECT a.id, a.inbound_email_id, a.detected_mime_type, a.storage_key, a.original_file_name,
              e.sender_email, e.subject, e.received_at, o.name AS organization_name, o.ico AS organization_ico
         FROM inbound_attachments a
         JOIN inbound_emails e ON e.id=a.inbound_email_id
         JOIN organizations o ON o.id=a.organization_id AND o.tenant_id=a.tenant_id
        WHERE a.id=$1 AND a.tenant_id=$2 AND a.organization_id=$3`,
      [job.attachment_id, job.tenant_id, job.organization_id],
    );
    const context = contextResult.rows[0];
    if (!context) throw new Error('attachment_context_missing');
    const mock = job.payload?.mockExtraction ?? {};
    const documentId = randomUUID();
    const runId = randomUUID();
    const buyerIco = typeof mock.buyerIco === 'string' ? mock.buyerIco : context.organization_ico;
    const mismatch = buyerIco !== context.organization_ico;
    const total = typeof mock.totalAmount === 'number' ? mock.totalAmount : 0;
    const documentType = ['FP','FV','BV','MZDY','OZ','PD'].includes(String(mock.documentType)) ? String(mock.documentType) : 'FP';
    const extracted = {
      dodavatel: { nazov: typeof mock.supplierName === 'string' ? mock.supplierName : 'Neznámy dodávateľ', ico: typeof mock.supplierIco === 'string' ? mock.supplierIco : undefined },
      odberatel: { nazov: context.organization_name, ico: buyerIco },
      cisloFaktury: typeof mock.invoiceNumber === 'string' ? mock.invoiceNumber : '',
      datumVystavenia: typeof mock.issueDate === 'string' ? mock.issueDate : new Date(context.received_at).toISOString().slice(0, 10),
      datumDodania: typeof mock.taxDate === 'string' ? mock.taxDate : undefined,
      datumSplatnosti: typeof mock.dueDate === 'string' ? mock.dueDate : undefined,
      mena: typeof mock.currency === 'string' ? mock.currency : 'EUR',
      rozpisDph: [],
      sumaSpolu: total,
    };
    const result = {
      schemaVersion: '1',
      documentType,
      supplier: extracted.dodavatel,
      buyer: extracted.odberatel,
      invoiceNumber: extracted.cisloFaktury,
      issueDate: extracted.datumVystavenia,
      currency: extracted.mena,
      lineItems: [],
      vatBreakdown: [],
      totalAmount: String(total),
      fieldConfidence: {},
      evidence: {},
      warnings: mismatch ? [{ code: 'buyer_ico_mismatch', message: 'IČO odberateľa sa nezhoduje s organizáciou', severity: 'error' }] : [],
    };

    await database.transaction(async (tx) => {
      await tx.query(
        `INSERT INTO documents
          (id, tenant_id, organization_id, document_type, status, processing_status, source, extracted,
           accounting, confidence, field_confidence, total_amount, currency, history, quarantine_reason)
         VALUES ($1,$2,$3,$4,$5,'ready_for_review',$6::jsonb,$7::jsonb,'{}'::jsonb,$8,'{}'::jsonb,$9,$10,$11::jsonb,$12)`,
        [documentId, job.tenant_id, job.organization_id, documentType, mismatch ? 'karantena' : 'na_kontrole',
          JSON.stringify({ typ: 'email', inboundEmailId: context.inbound_email_id, attachmentId: context.id, mimeType: context.detected_mime_type, povodnyNazovSuboru: context.original_file_name, odosielatel: context.sender_email, predmet: context.subject }),
          JSON.stringify(extracted), 0.5, total, extracted.mena,
          JSON.stringify([{ ts: new Date().toISOString(), user: 'Systém', akcia: 'Doklad vytvorený z prijatého e-mailu' }]),
          mismatch ? 'buyer_ico_mismatch' : null],
      );
      await tx.query(
        `INSERT INTO extraction_runs
          (id, tenant_id, organization_id, document_id, provider, prompt_version, schema_version,
           status, result, started_at, completed_at)
         VALUES ($1,$2,$3,$4,'mock','invoice-sk-v1','1','succeeded',$5::jsonb,now(),now())`,
        [runId, job.tenant_id, job.organization_id, documentId, JSON.stringify(result)],
      );
      await tx.query(
        `UPDATE inbound_attachments SET status='document_created', document_id=$1 WHERE id=$2 AND tenant_id=$3`,
        [documentId, job.attachment_id, job.tenant_id],
      );
      await tx.query(`UPDATE processing_jobs SET status='succeeded', document_id=$1, locked_at=NULL, locked_by=NULL, updated_at=now() WHERE id=$2`, [documentId, job.id]);
      await tx.query(
        `UPDATE inbound_emails SET status='processed'
          WHERE id=$1 AND NOT EXISTS (
            SELECT 1 FROM inbound_attachments WHERE inbound_email_id=$1 AND status IN ('queued','processing','received','stored')
          )`,
        [context.inbound_email_id],
      );
      await writeAudit(tx, { tenantId: job.tenant_id, organizationId: job.organization_id, actorType: 'system', action: 'document.extracted', entityType: 'document', entityId: documentId, correlationId: job.correlation_id, metadata: { provider: 'mock', extractionRunId: runId } });
    });
    return true;
  } catch (error) {
    await database.transaction((tx) => failJob(tx, job, error));
    return true;
  }
}

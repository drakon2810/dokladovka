import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { writeAudit } from '../audit.js';
import { requireBrowserAuth, requireCsrf, requireOrganizationAccess, requireRole } from '../auth.js';
import type { ServerConfig } from '../config.js';
import type { Database } from '../db/database.js';
import { HttpError } from '../http.js';
import { constantTimeStringEqual, sha256 } from '../security.js';
import type { ObjectStorage } from '../storage.js';

const attachmentSchema = z.object({
  fileName: z.string().min(1).max(255),
  mimeType: z.string().min(1).max(120),
  contentBase64: z.string().min(1),
  mockExtraction: z.record(z.string(), z.unknown()).optional(),
}).strict();

const inboundSchema = z.object({
  providerMessageId: z.string().min(1).max(300),
  envelopeRecipients: z.array(z.string().email()).min(1).max(20),
  senderEmail: z.string().email().optional(),
  senderName: z.string().max(200).optional(),
  subject: z.string().max(500).optional(),
  receivedAt: z.string().datetime().optional(),
  attachments: z.array(attachmentSchema).max(20),
}).strict();

interface AliasResolution extends Record<string, unknown> {
  id: string;
  tenant_id: string;
  organization_id: string;
  address_normalized: string;
}

function detectedMimeType(bytes: Uint8Array): string | undefined {
  if (bytes.length >= 5 && Buffer.from(bytes.slice(0, 5)).toString('ascii') === '%PDF-') return 'application/pdf';
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'image/jpeg';
  if (bytes.length >= 8 && Buffer.from(bytes.slice(0, 8)).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return 'image/png';
  return undefined;
}

function safeName(value: string): string {
  const base = value.replaceAll('\\', '/').split('/').pop() ?? 'attachment';
  return base.replace(/[^a-zA-Z0-9._-]+/g, '_').slice(0, 120) || 'attachment';
}

export function registerInboundRoutes(
  app: FastifyInstance,
  database: Database,
  storage: ObjectStorage,
  config: ServerConfig,
): void {
  app.post('/api/webhooks/inbound-email/:provider', {
    config: { rateLimit: { max: 120, timeWindow: '1 minute' } },
    bodyLimit: 30 * 1024 * 1024,
  }, async (request, reply) => {
    if (config.webhookSecret) {
      const signature = request.headers['x-dokladovka-webhook-secret'];
      if (typeof signature !== 'string' || !constantTimeStringEqual(signature, config.webhookSecret)) {
        throw new HttpError(401, 'webhook_signature_invalid', 'Webhook podpis je neplatný');
      }
    }
    const { provider } = z.object({ provider: z.string().regex(/^[a-z0-9_-]{1,40}$/) }).parse(request.params);
    const body = inboundSchema.parse(request.body);
    const existing = await database.query<{ id: string } & Record<string, unknown>>(
      'SELECT id FROM inbound_emails WHERE provider=$1 AND provider_message_id=$2',
      [provider, body.providerMessageId],
    );
    if (existing.rows[0]) return reply.code(202).send({ id: existing.rows[0].id, duplicate: true });

    const recipients = [...new Set(body.envelopeRecipients.map((value) => value.trim().toLowerCase()))];
    const aliases = await database.query<AliasResolution>(
      `SELECT id, tenant_id, organization_id, address_normalized
         FROM organization_email_aliases
        WHERE address_normalized = ANY($1::text[])
          AND (status='active' OR (status='grace_period' AND grace_until > now()))`,
      [recipients],
    );
    const scopes = new Set(aliases.rows.map((row) => `${row.tenant_id}:${row.organization_id}`));
    const resolved = scopes.size === 1 ? aliases.rows[0] : undefined;
    const quarantineReason = scopes.size === 0 ? 'unknown_alias' : scopes.size > 1 ? 'ambiguous_recipient' : undefined;
    const emailId = randomUUID();
    const correlationId = request.id;
    const receivedAt = body.receivedAt ?? new Date().toISOString();

    await database.query(
      `INSERT INTO inbound_emails
        (id, tenant_id, organization_id, alias_id, provider, provider_message_id, envelope_recipients,
         sender_email, sender_name, subject, received_at, status, attachment_count, quarantine_reason, correlation_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb,$8,$9,$10,$11,$12,$13,$14,$15)`,
      [emailId, resolved?.tenant_id ?? null, resolved?.organization_id ?? null, resolved?.id ?? null,
        provider, body.providerMessageId, JSON.stringify(recipients), body.senderEmail ?? null,
        body.senderName ?? null, body.subject ?? null, receivedAt, quarantineReason ? 'quarantine' : 'received',
        body.attachments.length, quarantineReason ?? null, correlationId],
    );

    let queued = 0;
    for (const attachment of body.attachments) {
      const attachmentId = randomUUID();
      const bytes = Buffer.from(attachment.contentBase64, 'base64');
      const actualMime = detectedMimeType(bytes);
      const hash = sha256(bytes);
      let status: 'queued' | 'quarantine' | 'duplicate' = 'quarantine';
      let reason = quarantineReason;
      let storageKey: string | undefined;

      if (!reason && bytes.byteLength > 20 * 1024 * 1024) reason = 'attachment_too_large';
      if (!reason && !actualMime) reason = 'unsupported_or_corrupted_file';
      if (!reason && actualMime !== attachment.mimeType) reason = 'mime_mismatch';
      if (!reason && resolved) {
        const duplicate = await database.query(
          `SELECT 1 FROM inbound_attachments
            WHERE tenant_id=$1 AND organization_id=$2 AND sha256=$3
              AND status IN ('queued','processing','document_created','duplicate')`,
          [resolved.tenant_id, resolved.organization_id, hash],
        );
        if (duplicate.rowCount > 0) {
          status = 'duplicate';
          reason = 'technical_duplicate';
        } else {
          storageKey = `inbound/${resolved.tenant_id}/${resolved.organization_id}/${emailId}/${attachmentId}/${safeName(attachment.fileName)}`;
          await storage.put(storageKey, bytes, actualMime!);
          status = 'queued';
          queued += 1;
        }
      }

      await database.query(
        `INSERT INTO inbound_attachments
          (id, tenant_id, inbound_email_id, organization_id, original_file_name, safe_file_name,
           declared_mime_type, detected_mime_type, byte_size, sha256, storage_key, status, quarantine_reason)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
        [attachmentId, resolved?.tenant_id ?? null, emailId, resolved?.organization_id ?? null,
          attachment.fileName, safeName(attachment.fileName), attachment.mimeType, actualMime ?? null,
          bytes.byteLength, hash, storageKey ?? null, status, reason ?? null],
      );
      if (status === 'queued' && resolved) {
        await database.query(
          `INSERT INTO processing_jobs
            (id, tenant_id, organization_id, attachment_id, kind, status, correlation_id, payload)
           VALUES ($1,$2,$3,$4,'extract_document','queued',$5,$6::jsonb)`,
          [randomUUID(), resolved.tenant_id, resolved.organization_id, attachmentId, correlationId,
            JSON.stringify({ mockExtraction: attachment.mockExtraction ?? {} })],
        );
      }
    }

    if (!quarantineReason) {
      await database.query(
        `UPDATE inbound_emails SET status=$1, quarantine_reason=$2 WHERE id=$3`,
        [queued > 0 ? 'queued' : 'quarantine', queued > 0 ? null : 'no_supported_attachment', emailId],
      );
    }
    if (resolved) {
      await writeAudit(database, {
        tenantId: resolved.tenant_id,
        organizationId: resolved.organization_id,
        actorType: 'system',
        action: 'inbound_email.received',
        entityType: 'inbound_email',
        entityId: emailId,
        correlationId,
        metadata: { provider, attachmentCount: body.attachments.length, queued },
      });
    }
    return reply.code(202).send({ id: emailId, duplicate: false, queued, status: queued > 0 ? 'queued' : 'quarantine' });
  });

  app.get('/api/inbound-emails', async (request) => {
    const auth = await requireBrowserAuth(request, database);
    const query = z.object({ organizationId: z.string().uuid().optional() }).parse(request.query);
    if (query.organizationId) await requireOrganizationAccess(database, auth, query.organizationId);
    const result = await database.query(
      `SELECT id, tenant_id AS "tenantId", organization_id AS "organizationId", alias_id AS "aliasId",
              provider, provider_message_id AS "providerMessageId", envelope_recipients AS "envelopeRecipients",
              sender_email AS "senderEmail", sender_name AS "senderName", subject, received_at AS "receivedAt",
              status, attachment_count AS "attachmentCount", quarantine_reason AS "quarantineReason",
              processing_error_code AS "processingErrorCode", processing_error_message AS "processingErrorMessage",
              correlation_id AS "correlationId", created_at AS "createdAt"
         FROM inbound_emails
        WHERE tenant_id=$1 AND ($2::text IS NULL OR organization_id=$2)
        ORDER BY created_at DESC LIMIT 200`,
      [auth.tenantId, query.organizationId ?? null],
    );
    return result.rows;
  });

  app.get('/api/inbound-emails/:id', async (request) => {
    const auth = await requireBrowserAuth(request, database);
    const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
    const email = await database.query<{ organization_id: string } & Record<string, unknown>>(
      'SELECT organization_id FROM inbound_emails WHERE id=$1 AND tenant_id=$2', [id, auth.tenantId],
    );
    if (!email.rows[0]) throw new HttpError(404, 'inbound_email_not_found', 'E-mail neexistuje');
    await requireOrganizationAccess(database, auth, email.rows[0].organization_id);
    const details = await database.query('SELECT * FROM inbound_emails WHERE id=$1 AND tenant_id=$2', [id, auth.tenantId]);
    const attachments = await database.query('SELECT * FROM inbound_attachments WHERE inbound_email_id=$1 AND tenant_id=$2 ORDER BY created_at', [id, auth.tenantId]);
    return { email: details.rows[0], attachments: attachments.rows };
  });

  app.post('/api/inbound-emails/:id/retry', async (request, reply) => {
    const auth = await requireBrowserAuth(request, database);
    requireCsrf(request, auth);
    requireRole(auth, ['admin', 'uctovnik']);
    const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
    const attachments = await database.query<{ id: string; organization_id: string } & Record<string, unknown>>(
      `SELECT id, organization_id FROM inbound_attachments
        WHERE inbound_email_id=$1 AND tenant_id=$2 AND storage_key IS NOT NULL AND status IN ('failed','quarantine')`,
      [id, auth.tenantId],
    );
    for (const attachment of attachments.rows) {
      await requireOrganizationAccess(database, auth, attachment.organization_id);
      await database.query(`UPDATE inbound_attachments SET status='queued', quarantine_reason=NULL WHERE id=$1 AND tenant_id=$2`, [attachment.id, auth.tenantId]);
      await database.query(
        `INSERT INTO processing_jobs (id, tenant_id, organization_id, attachment_id, kind, status, correlation_id)
         VALUES ($1,$2,$3,$4,'extract_document','queued',$5)`,
        [randomUUID(), auth.tenantId, attachment.organization_id, attachment.id, request.id],
      );
    }
    return reply.code(202).send({ queued: attachments.rowCount });
  });

  app.post('/api/inbound-emails/:id/assign-organization', async (request, reply) => {
    const auth = await requireBrowserAuth(request, database);
    requireCsrf(request, auth);
    requireRole(auth, ['admin']);
    const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
    const { organizationId } = z.object({ organizationId: z.string().uuid() }).strict().parse(request.body);
    await requireOrganizationAccess(database, auth, organizationId);
    await database.query(
      `UPDATE inbound_emails SET tenant_id=$1, organization_id=$2, status='received', quarantine_reason=NULL
        WHERE id=$3 AND (tenant_id IS NULL OR tenant_id=$1)`,
      [auth.tenantId, organizationId, id],
    );
    await writeAudit(database, { tenantId: auth.tenantId, organizationId, actorType: 'user', actorId: auth.userId, action: 'inbound_email.assigned', entityType: 'inbound_email', entityId: id, correlationId: request.id });
    return reply.code(204).send();
  });
}

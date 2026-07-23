import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { writeAudit } from '../audit.js';
import { requireBrowserAuth, requireCsrf, requireOrganizationAccess, requireRole } from '../auth.js';
import type { ServerConfig } from '../config.js';
import type { Database } from '../db/database.js';
import { HttpError } from '../http.js';
import { constantTimeStringEqual, sha256 } from '../security.js';
import { classifyXml } from '../inbound/xmlClassifier.js';
import { detectedMimeType, mimeMatchesDeclared, safeName } from '../inbound/attachmentMime.js';
import type { ObjectStorage } from '../storage.js';

const attachmentSchema = z.object({
  fileName: z.string().min(1).max(255),
  mimeType: z.string().min(1).max(120),
  contentBase64: z.string().min(1),
  mockExtraction: z.record(z.string(), z.unknown()).optional(),
}).strict();

const inboundSchema = z.object({
  providerMessageId: z.string().min(1).max(300),
  // Neplatné adresy (napr. divné Delivered-To/X-Original-To od poštového servera)
  // odfiltrujeme namiesto odmietnutia celého e-mailu — inak jeden pokazený
  // príjemca zablokuje doručenie dokladu na platný alias a poller to opakuje donekonečna.
  envelopeRecipients: z.preprocess(
    (val) => (Array.isArray(val)
      ? val
          .map((e) => (typeof e === 'string' ? e.trim().toLowerCase() : e))
          .filter((e) => z.string().email().safeParse(e).success)
      : val),
    z.array(z.string().email()).min(1).max(20),
  ),
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
    let quarantineReason = scopes.size === 0 ? 'unknown_alias' : scopes.size > 1 ? 'ambiguous_recipient' : undefined;
    // Diagnostika smerovania: ktoré adresy prišli, ktorý alias sa zhodol a do
    // ktorej organizácie sa e-mail zaradil. Bez toho sa nedá overiť, prečo
    // doklad skončil pod inou firmou, než odosielateľ zamýšľal.
    request.log.info(
      {
        recipients,
        matchedAliases: aliases.rows.map((row) => row.address_normalized),
        resolvedOrganizationId: resolved?.organization_id ?? null,
        quarantineReason: quarantineReason ?? null,
      },
      'inbound_routing',
    );
    // Whitelist odosielateľov: ak je pre organizáciu vyplnený, e-maily od
    // iných adries končia v karanténe (prázdny zoznam = prijíma sa všetko).
    if (!quarantineReason && resolved) {
      const organization = await database.query<{ sender_whitelist?: string[] } & Record<string, unknown>>(
        'SELECT sender_whitelist FROM organizations WHERE id=$1 AND tenant_id=$2',
        [resolved.organization_id, resolved.tenant_id],
      );
      const whitelist = (organization.rows[0]?.sender_whitelist ?? [])
        .map((address) => String(address).trim().toLowerCase())
        .filter(Boolean);
      const sender = body.senderEmail?.trim().toLowerCase();
      if (whitelist.length > 0 && (!sender || !whitelist.includes(sender))) {
        quarantineReason = 'sender_not_whitelisted';
      }
    }
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
    let duplicates = 0;
    for (const attachment of body.attachments) {
      const attachmentId = randomUUID();
      const bytes = Buffer.from(attachment.contentBase64, 'base64');
      const actualMime = detectedMimeType(bytes);
      const hash = sha256(bytes);
      let status: 'queued' | 'quarantine' | 'duplicate' = 'quarantine';
      let reason: string | undefined;
      let storageKey: string | undefined;

      if (bytes.byteLength > config.extractionMaxFileBytes) reason = 'attachment_too_large';
      if (!reason && !actualMime) reason = 'unsupported_or_corrupted_file';
      if (!reason && !mimeMatchesDeclared(actualMime!, attachment.mimeType)) reason = 'mime_mismatch';
      if (!reason && actualMime === 'application/xml') {
        // PEPPOL BIS (UBL Invoice/CreditNote) aj SEPA camt.053 sa spracúvajú
        // deterministicky; iné XML zostáva v karanténe.
        if (classifyXml(bytes) === 'unknown_xml') reason = 'unsupported_xml';
      }
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
          duplicates += 1;
        } else {
          storageKey = `inbound/${resolved.tenant_id}/${resolved.organization_id}/${emailId}/${attachmentId}/${safeName(attachment.fileName)}`;
          await storage.put(storageKey, bytes, actualMime!);
          status = 'queued';
          queued += 1;
        }
      } else if (!reason) {
        // Nezaradený e-mail (unknown_alias/ambiguous_recipient): platné bajty sa
        // uložia, aby priradenie organizácii mohlo spustiť extrakciu bez
        // opätovného zaslania e-mailu.
        storageKey = `inbound/unassigned/${emailId}/${attachmentId}/${safeName(attachment.fileName)}`;
        await storage.put(storageKey, bytes, actualMime!);
        reason = quarantineReason;
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
            (id, tenant_id, organization_id, attachment_id, kind, status, correlation_id, payload, max_attempts)
           VALUES ($1,$2,$3,$4,'extract_document','queued',$5,$6::jsonb,$7)`,
          [randomUUID(), resolved.tenant_id, resolved.organization_id, attachmentId, correlationId,
            JSON.stringify({ mockExtraction: attachment.mockExtraction ?? {} }),
            config.extractionProvider === 'openai' ? config.openai.maxRetries + 1 : 5],
        );
      }
    }

    // Technický repeat (všetky prílohy sú duplicity) je 'processed' — §11.11;
    // karanténa je len pre e-maily bez použiteľnej prílohy.
    const allDuplicates = body.attachments.length > 0 && duplicates === body.attachments.length;
    const emailStatus = quarantineReason
      ? 'quarantine'
      : queued > 0 ? 'queued' : allDuplicates ? 'processed' : 'quarantine';
    if (!quarantineReason) {
      await database.query(
        `UPDATE inbound_emails SET status=$1, quarantine_reason=$2 WHERE id=$3`,
        [emailStatus, emailStatus === 'quarantine' ? 'no_supported_attachment' : null, emailId],
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
    return reply.code(202).send({ id: emailId, duplicate: false, queued, status: emailStatus });
  });

  app.get('/api/inbound-emails', async (request) => {
    const auth = await requireBrowserAuth(request, database);
    const query = z.object({ organizationId: z.string().uuid().optional() }).parse(request.query);
    if (query.organizationId) await requireOrganizationAccess(database, auth, query.organizationId);
    // Nezaradené karanténne e-maily (tenant_id IS NULL) vidí iba admin —
    // rozhoduje o ich priradení organizácii.
    const result = await database.query(
      `SELECT id, tenant_id AS "tenantId", organization_id AS "organizationId", alias_id AS "aliasId",
              provider, provider_message_id AS "providerMessageId", envelope_recipients AS "envelopeRecipients",
              sender_email AS "senderEmail", sender_name AS "senderName", subject, received_at AS "receivedAt",
              status, attachment_count AS "attachmentCount", quarantine_reason AS "quarantineReason",
              processing_error_code AS "processingErrorCode", processing_error_message AS "processingErrorMessage",
              correlation_id AS "correlationId", created_at AS "createdAt"
         FROM inbound_emails
        WHERE (tenant_id=$1 OR ($3 AND tenant_id IS NULL AND status='quarantine'))
          AND ($2::text IS NULL OR organization_id=$2)
          AND provider <> 'manual-upload'
        ORDER BY created_at DESC LIMIT 200`,
      [auth.tenantId, query.organizationId ?? null, auth.role === 'admin'],
    );
    return result.rows;
  });

  app.get('/api/inbound-emails/:id', async (request) => {
    const auth = await requireBrowserAuth(request, database);
    const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
    const email = await database.query<{ tenant_id: string | null; organization_id: string | null } & Record<string, unknown>>(
      'SELECT tenant_id, organization_id FROM inbound_emails WHERE id=$1', [id],
    );
    const scope = email.rows[0];
    if (!scope || (scope.tenant_id !== null && scope.tenant_id !== auth.tenantId)) {
      throw new HttpError(404, 'inbound_email_not_found', 'E-mail neexistuje');
    }
    if (scope.tenant_id === null || scope.organization_id === null) requireRole(auth, ['admin']);
    else await requireOrganizationAccess(database, auth, scope.organization_id);
    const details = await database.query('SELECT * FROM inbound_emails WHERE id=$1', [id]);
    const attachments = await database.query('SELECT * FROM inbound_attachments WHERE inbound_email_id=$1 ORDER BY created_at', [id]);
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
        `INSERT INTO processing_jobs (id, tenant_id, organization_id, attachment_id, kind, status, correlation_id, max_attempts)
         VALUES ($1,$2,$3,$4,'extract_document','queued',$5,$6)`,
        [randomUUID(), auth.tenantId, attachment.organization_id, attachment.id, request.id,
          config.extractionProvider === 'openai' ? config.openai.maxRetries + 1 : 5],
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
    const updated = await database.query(
      `UPDATE inbound_emails SET tenant_id=$1, organization_id=$2, status='received', quarantine_reason=NULL
        WHERE id=$3 AND (tenant_id IS NULL OR tenant_id=$1) RETURNING id`,
      [auth.tenantId, organizationId, id],
    );
    if (updated.rowCount === 0) throw new HttpError(404, 'inbound_email_not_found', 'E-mail neexistuje');

    // Prílohy s uloženými bajtmi sa po priradení zaradia do extrakcie —
    // rovnaká dedup logika ako pri priamom routovaní cez alias.
    const attachments = await database.query<{ id: string; storage_key: string | null; sha256: string; status: string } & Record<string, unknown>>(
      `SELECT id, storage_key, sha256, status FROM inbound_attachments
        WHERE inbound_email_id=$1 AND (tenant_id IS NULL OR tenant_id=$2)`,
      [id, auth.tenantId],
    );
    let queued = 0;
    let duplicates = 0;
    for (const attachment of attachments.rows) {
      if (attachment.storage_key && attachment.status === 'quarantine') {
        const duplicate = await database.query(
          `SELECT 1 FROM inbound_attachments
            WHERE tenant_id=$1 AND organization_id=$2 AND sha256=$3
              AND status IN ('queued','processing','document_created','duplicate')`,
          [auth.tenantId, organizationId, attachment.sha256],
        );
        if (duplicate.rowCount > 0) {
          await database.query(
            `UPDATE inbound_attachments SET tenant_id=$1, organization_id=$2, status='duplicate', quarantine_reason='technical_duplicate' WHERE id=$3`,
            [auth.tenantId, organizationId, attachment.id],
          );
          duplicates += 1;
        } else {
          await database.query(
            `UPDATE inbound_attachments SET tenant_id=$1, organization_id=$2, status='queued', quarantine_reason=NULL WHERE id=$3`,
            [auth.tenantId, organizationId, attachment.id],
          );
          await database.query(
            `INSERT INTO processing_jobs (id, tenant_id, organization_id, attachment_id, kind, status, correlation_id, max_attempts)
             VALUES ($1,$2,$3,$4,'extract_document','queued',$5,$6)`,
            [randomUUID(), auth.tenantId, organizationId, attachment.id, request.id,
              config.extractionProvider === 'openai' ? config.openai.maxRetries + 1 : 5],
          );
          queued += 1;
        }
      } else {
        await database.query(
          `UPDATE inbound_attachments SET tenant_id=$1, organization_id=$2 WHERE id=$3`,
          [auth.tenantId, organizationId, attachment.id],
        );
      }
    }
    const emailStatus = queued > 0
      ? 'queued'
      : attachments.rowCount > 0 && duplicates === attachments.rowCount ? 'processed' : 'received';
    if (emailStatus !== 'received') {
      await database.query('UPDATE inbound_emails SET status=$1 WHERE id=$2', [emailStatus, id]);
    }
    await writeAudit(database, {
      tenantId: auth.tenantId, organizationId, actorType: 'user', actorId: auth.userId,
      action: 'inbound_email.assigned', entityType: 'inbound_email', entityId: id,
      correlationId: request.id, metadata: { queued, duplicates },
    });
    return reply.code(204).send();
  });
}

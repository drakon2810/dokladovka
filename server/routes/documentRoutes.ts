import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { writeAudit } from '../audit.js';
import { requireBrowserAuth, requireCsrf, requireOrganizationAccess, requireRole } from '../auth.js';
import type { Database } from '../db/database.js';
import { HttpError } from '../http.js';
import { buildApprovedDocumentsXml } from '../services/exportService.js';
import type { ObjectStorage } from '../storage.js';
import type { ServerConfig } from '../config.js';
import { extractionResultSchema } from '../extraction/contract.js';
import { normalizeExtractionResult, validateExtractionResult, validateNormalizedExtraction } from '../extraction/normalize.js';
import { rebuildAccountingSuggestion } from '../services/accountingSuggestionService.js';

interface DocumentScope extends Record<string, unknown> {
  id: string;
  organization_id: string;
  status: string;
  processing_status: string;
  version: number;
  document_type: string;
  extracted: Record<string, unknown>;
  accounting: Record<string, string | undefined>;
  history: Array<Record<string, unknown>>;
}

async function scopedDocument(database: Database, tenantId: string, id: string): Promise<DocumentScope> {
  const result = await database.query<DocumentScope>(
    `SELECT id, organization_id, status, processing_status, version, document_type, extracted, accounting, history
       FROM documents WHERE id=$1 AND tenant_id=$2`, [id, tenantId],
  );
  if (!result.rows[0]) throw new HttpError(404, 'document_not_found', 'Doklad neexistuje');
  return result.rows[0];
}

export function registerDocumentRoutes(app: FastifyInstance, database: Database, storage: ObjectStorage, config: ServerConfig): void {
  app.get('/api/documents', async (request) => {
    const auth = await requireBrowserAuth(request, database);
    const query = z.object({ organizationId: z.string().uuid().optional(), status: z.string().max(40).optional() }).parse(request.query);
    if (query.organizationId) await requireOrganizationAccess(database, auth, query.organizationId);
    const result = await database.query(
      `SELECT d.* FROM documents d
        JOIN organization_memberships m ON m.organization_id=d.organization_id AND m.tenant_id=d.tenant_id
       WHERE d.tenant_id=$1 AND m.user_id=$2
         AND ($3::text IS NULL OR d.organization_id=$3)
         AND ($4::text IS NULL OR d.status=$4)
       ORDER BY d.created_at DESC LIMIT 500`,
      [auth.tenantId, auth.userId, query.organizationId ?? null, query.status ?? null],
    );
    return result.rows;
  });

  app.get('/api/documents/:id', async (request) => {
    const auth = await requireBrowserAuth(request, database);
    const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
    const document = await scopedDocument(database, auth.tenantId, id);
    await requireOrganizationAccess(database, auth, document.organization_id);
    const details = await database.query<Record<string, unknown>>('SELECT * FROM documents WHERE id=$1 AND tenant_id=$2', [id, auth.tenantId]);
    const attachment = await database.query<{ storage_key?: string } & Record<string, unknown>>(
      'SELECT storage_key FROM inbound_attachments WHERE document_id=$1 AND tenant_id=$2', [id, auth.tenantId],
    );
    const storageKey = attachment.rows[0]?.storage_key;
    return { ...details.rows[0], fileUrl: storageKey ? await storage.signedDownloadUrl(storageKey, 300) : undefined };
  });

  app.get('/api/documents/:id/file', async (request, reply) => {
    const auth = await requireBrowserAuth(request, database);
    const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
    const document = await scopedDocument(database, auth.tenantId, id);
    await requireOrganizationAccess(database, auth, document.organization_id);
    const attachment = await database.query<{
      storage_key?: string; detected_mime_type?: string; original_file_name: string;
    } & Record<string, unknown>>(
      `SELECT storage_key,detected_mime_type,original_file_name FROM inbound_attachments
        WHERE document_id=$1 AND tenant_id=$2 AND organization_id=$3 ORDER BY created_at LIMIT 1`,
      [id, auth.tenantId, document.organization_id],
    );
    const source = attachment.rows[0];
    if (!source?.storage_key) throw new HttpError(404, 'attachment_missing', 'Zdrojový súbor neexistuje');
    const safeName = source.original_file_name.replace(/[\r\n"\\]/g, '_').slice(0, 180);
    reply.header('Content-Type', source.detected_mime_type ?? 'application/octet-stream');
    reply.header('Content-Disposition', `inline; filename="${safeName}"`);
    return reply.send(Buffer.from(await storage.get(source.storage_key)));
  });

  app.patch('/api/documents/:id', async (request) => {
    const auth = await requireBrowserAuth(request, database);
    requireCsrf(request, auth);
    requireRole(auth, ['admin', 'uctovnik']);
    const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
    const body = z.object({
      documentType: z.enum(['FP','FV','BV','MZDY','OZ','PD']).optional(),
      extracted: z.record(z.string(), z.unknown()).optional(),
      accounting: z.record(z.string(), z.string().optional()).optional(),
      expectedVersion: z.number().int().positive(),
    }).strict().parse(request.body);
    const document = await scopedDocument(database, auth.tenantId, id);
    await requireOrganizationAccess(database, auth, document.organization_id);
    if (document.version !== body.expectedVersion) throw new HttpError(409, 'version_conflict', 'Doklad bol medzitým zmenený');
    const approvedChanged = document.status === 'schvaleny';
    const result = await database.query<Record<string, unknown>>(
      `UPDATE documents SET document_type=$1, extracted=$2::jsonb, accounting=$3::jsonb,
              version=version+1, status=$4, approved_version=NULL, approved_snapshot=NULL, updated_at=now()
        WHERE id=$5 AND tenant_id=$6 AND version=$7 RETURNING *`,
      [body.documentType ?? document.document_type, JSON.stringify(body.extracted ?? document.extracted),
        JSON.stringify(body.accounting ?? document.accounting), approvedChanged ? 'na_kontrole' : document.status,
        id, auth.tenantId, body.expectedVersion],
    );
    return result.rows[0];
  });

  app.post('/api/documents/:id/approve', async (request) => {
    const auth = await requireBrowserAuth(request, database);
    requireCsrf(request, auth);
    requireRole(auth, ['admin', 'uctovnik', 'schvalovatel']);
    const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
    const { expectedVersion } = z.object({ expectedVersion: z.number().int().positive() }).strict().parse(request.body);
    const document = await scopedDocument(database, auth.tenantId, id);
    await requireOrganizationAccess(database, auth, document.organization_id);
    if (document.version !== expectedVersion) throw new HttpError(409, 'version_conflict', 'Doklad bol medzitým zmenený');
    if (!['na_kontrole', 'extrahovany'].includes(document.status) || document.processing_status !== 'ready_for_review') {
      throw new HttpError(409, 'document_not_ready', 'Doklad ešte nie je pripravený na schválenie');
    }
    // Schvaľovanie podľa sumy: od prahu smie schváliť len vyhradená rola
    // (admin vždy). Deterministická kontrola pred všetkými ostatnými.
    const approvalRule = await database.query<{ min_amount: string | number; required_role: string } & Record<string, unknown>>(
      'SELECT min_amount, required_role FROM approval_rules WHERE organization_id=$1 AND tenant_id=$2 AND active=true',
      [document.organization_id, auth.tenantId],
    );
    const rule = approvalRule.rows[0];
    const documentTotal = Number((document.extracted as any)?.sumaSpolu ?? 0);
    if (rule && documentTotal >= Number(rule.min_amount)) {
      const allowedRoles = rule.required_role === 'admin' ? ['admin'] : ['admin', 'schvalovatel'];
      if (!allowedRoles.includes(auth.role)) {
        throw new HttpError(
          403,
          'approval_threshold',
          `Doklad od ${Number(rule.min_amount).toFixed(2)} € musí schváliť ${rule.required_role === 'admin' ? 'administrátor' : 'schvaľovateľ'}`,
        );
      }
    }
    const organization = await database.query<{ ico: string; dic?: string; ic_dph?: string } & Record<string, unknown>>(
      'SELECT ico,dic,ic_dph FROM organizations WHERE id=$1 AND tenant_id=$2',
      [document.organization_id, auth.tenantId],
    );
    const extracted = document.extracted as any;
    const validationIssues = validateNormalizedExtraction({
      documentType: document.document_type as any,
      extracted,
      fieldConfidence: {},
      confidence: 0,
      totalAmount: Number(extracted.sumaSpolu),
      currency: extracted.mena,
    }, organization.rows[0]);
    if (validationIssues.some((issue) => issue.severity === 'error')) {
      throw new HttpError(409, 'document_validation_failed', 'Doklad obsahuje údaje, ktoré treba opraviť pred schválením');
    }
    const requiredIds = [document.accounting.predkontaciaId, document.accounting.clenenieDphId, document.accounting.ciselnyRadId];
    if (requiredIds.some((value) => !value)) throw new HttpError(409, 'accounting_incomplete', 'Zaúčtovanie nie je kompletné');
    if (document.document_type === 'PD' && (!document.accounting.pokladnaKod || !['receipt', 'expense'].includes(document.accounting.pokladnaTyp ?? ''))) {
      throw new HttpError(409, 'cash_account_required', 'Pre pokladničný doklad je povinný kód pokladne a typ príjem/výdaj');
    }
    const valid = await database.query(
      `SELECT id FROM code_list_items
        WHERE tenant_id=$1 AND organization_id=$2 AND active=true AND id=ANY($3::text[])`,
      [auth.tenantId, document.organization_id, requiredIds],
    );
    if (valid.rowCount !== new Set(requiredIds).size) throw new HttpError(409, 'code_list_invalid', 'Číselník nepatrí organizácii alebo nie je aktívny');
    const approvedVersion = expectedVersion + 1;
    const snapshot = { version: approvedVersion, approvedAt: new Date().toISOString(), typ: document.document_type, extracted: document.extracted, ucto: document.accounting };
    const result = await database.query<Record<string, unknown>>(
      `UPDATE documents SET status='schvaleny', version=$1, approved_version=$1, approved_snapshot=$2::jsonb, updated_at=now()
        WHERE id=$3 AND tenant_id=$4 AND version=$5 RETURNING *`,
      [approvedVersion, JSON.stringify(snapshot), id, auth.tenantId, expectedVersion],
    );
    await writeAudit(database, { tenantId: auth.tenantId, organizationId: document.organization_id, actorType: 'user', actorId: auth.userId, action: 'document.approved', entityType: 'document', entityId: id, correlationId: request.id, metadata: { version: approvedVersion } });
    return result.rows[0];
  });

  for (const [route, status, action] of [
    ['reject', 'zamietnuty', 'document.rejected'],
    ['quarantine', 'karantena', 'document.quarantined'],
  ] as const) {
    app.post(`/api/documents/:id/${route}`, async (request) => {
      const auth = await requireBrowserAuth(request, database);
      requireCsrf(request, auth);
      requireRole(auth, route === 'reject' ? ['admin', 'uctovnik', 'schvalovatel'] : ['admin', 'uctovnik']);
      const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
      const document = await scopedDocument(database, auth.tenantId, id);
      await requireOrganizationAccess(database, auth, document.organization_id);
      const decision = route === 'reject'
        ? z.object({ expectedVersion: z.number().int().positive(), reason: z.string().trim().min(1).max(1000) }).strict().parse(request.body)
        : undefined;
      if (decision && document.version !== decision.expectedVersion) {
        throw new HttpError(409, 'version_conflict', 'Doklad bol medzitým zmenený');
      }
      const history = [
        ...document.history,
        {
          ts: new Date().toISOString(),
          user: auth.name,
          akcia: decision ? `Doklad zamietnutý — dôvod: ${decision.reason}` : 'Doklad presunutý do karantény',
        },
      ];
      const result = await database.query<Record<string, unknown>>(
        `UPDATE documents SET status=$1, version=version+1, approved_version=NULL, approved_snapshot=NULL,
              history=$2::jsonb, updated_at=now()
          WHERE id=$3 AND tenant_id=$4 RETURNING *`,
        [status, JSON.stringify(history), id, auth.tenantId],
      );
      await writeAudit(database, { tenantId: auth.tenantId, organizationId: document.organization_id, actorType: 'user', actorId: auth.userId, action, entityType: 'document', entityId: id, correlationId: request.id });
      return result.rows[0];
    });
  }

  app.post('/api/documents/:id/restore', async (request) => {
    const auth = await requireBrowserAuth(request, database);
    requireCsrf(request, auth);
    requireRole(auth, ['admin', 'uctovnik']);
    const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
    const document = await scopedDocument(database, auth.tenantId, id);
    await requireOrganizationAccess(database, auth, document.organization_id);
    if (document.status !== 'zamietnuty') {
      throw new HttpError(409, 'not_rejected', 'Obnoviť možno len zamietnutý doklad');
    }
    // Späť na kontrolu, ak je extrakcia hotová; inak do stavu chyba na došetrenie.
    const restoredStatus = document.processing_status === 'ready_for_review' ? 'na_kontrole' : 'chyba';
    const history = [
      ...document.history,
      { ts: new Date().toISOString(), user: auth.name, akcia: 'Doklad obnovený z koša' },
    ];
    const result = await database.query<Record<string, unknown>>(
      `UPDATE documents SET status=$1, version=version+1, history=$2::jsonb, updated_at=now()
        WHERE id=$3 AND tenant_id=$4 RETURNING *`,
      [restoredStatus, JSON.stringify(history), id, auth.tenantId],
    );
    await writeAudit(database, {
      tenantId: auth.tenantId,
      organizationId: document.organization_id,
      actorType: 'user',
      actorId: auth.userId,
      action: 'document.restored',
      entityType: 'document',
      entityId: id,
      correlationId: request.id,
    });
    return result.rows[0];
  });

  app.post('/api/documents/:id/reprocess', async (request, reply) => {
    const auth = await requireBrowserAuth(request, database);
    requireCsrf(request, auth);
    requireRole(auth, ['admin', 'uctovnik']);
    const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
    const document = await scopedDocument(database, auth.tenantId, id);
    await requireOrganizationAccess(database, auth, document.organization_id);
    const attachment = await database.query<{ id: string } & Record<string, unknown>>('SELECT id FROM inbound_attachments WHERE document_id=$1 AND tenant_id=$2', [id, auth.tenantId]);
    if (!attachment.rows[0]) throw new HttpError(409, 'attachment_missing', 'Doklad nemá zdrojovú prílohu');
    await database.query(
      `INSERT INTO processing_jobs (id, tenant_id, organization_id, attachment_id, document_id, kind, status, correlation_id, max_attempts)
       VALUES ($1,$2,$3,$4,$5,'reprocess_document','queued',$6,$7)`,
      [randomUUID(), auth.tenantId, document.organization_id, attachment.rows[0].id, id, request.id,
        config.extractionProvider === 'openai' ? config.openai.maxRetries + 1 : 5],
    );
    return reply.code(202).send({ queued: true });
  });

  app.get('/api/documents/:id/extraction-runs', async (request) => {
    const auth = await requireBrowserAuth(request, database);
    const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
    const document = await scopedDocument(database, auth.tenantId, id);
    await requireOrganizationAccess(database, auth, document.organization_id);
    const runs = await database.query(
      `SELECT * FROM extraction_runs
        WHERE document_id=$1 AND tenant_id=$2 AND organization_id=$3 ORDER BY created_at DESC`,
      [id, auth.tenantId, document.organization_id],
    );
    return runs.rows;
  });

  app.post('/api/documents/:id/extraction-runs/:runId/apply', async (request) => {
    const auth = await requireBrowserAuth(request, database);
    requireCsrf(request, auth);
    requireRole(auth, ['admin', 'uctovnik']);
    const { id, runId } = z.object({ id: z.string().uuid(), runId: z.string().uuid() }).parse(request.params);
    const { expectedVersion } = z.object({ expectedVersion: z.number().int().positive() }).strict().parse(request.body);
    const document = await scopedDocument(database, auth.tenantId, id);
    await requireOrganizationAccess(database, auth, document.organization_id);
    if (document.version !== expectedVersion) throw new HttpError(409, 'version_conflict', 'Doklad bol medzitým zmenený');
    if (document.status === 'exportovany') throw new HttpError(409, 'document_exported', 'Exportovaný doklad nie je možné meniť');
    const run = await database.query<{ result: unknown } & Record<string, unknown>>(
      `SELECT result FROM extraction_runs
        WHERE id=$1 AND document_id=$2 AND tenant_id=$3 AND organization_id=$4 AND status='succeeded'`,
      [runId, id, auth.tenantId, document.organization_id],
    );
    if (!run.rows[0]?.result) throw new HttpError(404, 'extraction_run_not_found', 'Úspešný výsledok extrakcie neexistuje');
    const result = extractionResultSchema.parse(run.rows[0].result);
    const normalized = normalizeExtractionResult(result, id, new Date().toISOString().slice(0, 10));
    const organization = await database.query<{ ico: string; dic?: string; ic_dph?: string } & Record<string, unknown>>(
      'SELECT ico,dic,ic_dph FROM organizations WHERE id=$1 AND tenant_id=$2',
      [document.organization_id, auth.tenantId],
    );
    const issues = validateExtractionResult(result, normalized, organization.rows[0]);
    const buyerMismatch = issues.some((issue) => ['buyer_ico_mismatch', 'supplier_buyer_may_be_inverted'].includes(issue.code));
    const invoiceNumber = result.invoiceNumber?.trim().toLocaleLowerCase('sk');
    const supplierIco = result.supplier.ico?.replace(/\D/g, '');
    const supplierName = result.supplier.nazov?.trim().toLocaleLowerCase('sk');
    let duplicateId: string | undefined;
    if (invoiceNumber && (supplierIco || supplierName)) {
      const candidates = await database.query<{ id: string; extracted: any } & Record<string, unknown>>(
        `SELECT id,extracted FROM documents
          WHERE tenant_id=$1 AND organization_id=$2 AND id<>$3 AND status<>'zamietnuty'
          ORDER BY created_at DESC LIMIT 500`,
        [auth.tenantId, document.organization_id, id],
      );
      duplicateId = candidates.rows.find((candidate) => {
        const supplier = candidate.extracted?.dodavatel ?? {};
        const sameSupplier = supplierIco
          ? String(supplier.ico ?? '').replace(/\D/g, '') === supplierIco
          : String(supplier.nazov ?? '').trim().toLocaleLowerCase('sk') === supplierName;
        return sameSupplier && String(candidate.extracted?.cisloFaktury ?? '').trim().toLocaleLowerCase('sk') === invoiceNumber;
      })?.id;
    }
    const status = buyerMismatch ? 'karantena' : duplicateId ? 'duplicita' : 'na_kontrole';
    const history = [...document.history, { ts: new Date().toISOString(), user: auth.name, akcia: `Použitá extrakcia ${runId}` }];
    const updated = await database.transaction(async (tx) => {
      const changed = await tx.query<Record<string, unknown>>(
        `UPDATE documents SET document_type=$1,status=$2,processing_status='ready_for_review',extracted=$3::jsonb,
                field_confidence=$4::jsonb,confidence=$5,total_amount=$6,currency=$7,history=$8::jsonb,
                quarantine_reason=$9,duplicate_of_document_id=$10,not_duplicate=false,
                applied_extraction_run_id=$11,version=version+1,approved_version=NULL,approved_snapshot=NULL,updated_at=now()
          WHERE id=$12 AND tenant_id=$13 AND organization_id=$14 AND version=$15 RETURNING *`,
        [normalized.documentType, status, JSON.stringify(normalized.extracted), JSON.stringify(normalized.fieldConfidence),
          normalized.confidence, normalized.totalAmount, normalized.currency, JSON.stringify(history),
          buyerMismatch ? 'buyer_ico_mismatch' : null, duplicateId ?? null, runId,
          id, auth.tenantId, document.organization_id, expectedVersion],
      );
      if (!changed.rows[0]) throw new HttpError(409, 'version_conflict', 'Doklad bol medzitým zmenený');
      await rebuildAccountingSuggestion(tx, {
        tenantId: auth.tenantId, organizationId: document.organization_id, documentId: id,
        supplierIco: result.supplier.ico, supplierName: result.supplier.nazov,
      });
      await writeAudit(tx, {
        tenantId: auth.tenantId, organizationId: document.organization_id, actorType: 'user', actorId: auth.userId,
        action: 'document.extraction_applied', entityType: 'document', entityId: id, correlationId: request.id,
        metadata: { extractionRunId: runId },
      });
      return changed.rows[0];
    });
    return updated;
  });

  app.post('/api/exports/pohoda/xml', async (request, reply) => {
    const auth = await requireBrowserAuth(request, database);
    requireCsrf(request, auth);
    requireRole(auth, ['admin', 'uctovnik']);
    const body = z.object({ organizationId: z.string().uuid(), documentIds: z.array(z.string().uuid()).min(1) }).strict().parse(request.body);
    await requireOrganizationAccess(database, auth, body.organizationId);
    const organization = await database.query<{ ico: string; name: string } & Record<string, unknown>>('SELECT ico, name FROM organizations WHERE id=$1 AND tenant_id=$2', [body.organizationId, auth.tenantId]);
    if (!organization.rows[0]) throw new HttpError(404, 'organization_not_found', 'Organizácia neexistuje');
    const id = randomUUID();
    const xml = await buildApprovedDocumentsXml(database, { tenantId: auth.tenantId, organizationId: body.organizationId, ico: organization.rows[0].ico, documentIds: body.documentIds, packId: id });
    const fileName = `pohoda-${organization.rows[0].ico}-${new Date().toISOString().slice(0, 10).replaceAll('-', '')}.xml`;
    await database.transaction(async (tx) => {
      await tx.query(
        `INSERT INTO export_batches (id, tenant_id, organization_id, created_by, document_ids, xml_file_name, xml_snapshot)
         VALUES ($1,$2,$3,$4,$5::jsonb,$6,$7)`,
        [id, auth.tenantId, body.organizationId, auth.userId, JSON.stringify(body.documentIds), fileName, xml],
      );
      await tx.query(
        `UPDATE documents SET status='exportovany', export_id=$1, updated_at=now()
          WHERE tenant_id=$2 AND organization_id=$3 AND id=ANY($4::text[])`,
        [id, auth.tenantId, body.organizationId, body.documentIds],
      );
      await writeAudit(tx, { tenantId: auth.tenantId, organizationId: body.organizationId, actorType: 'user', actorId: auth.userId, action: 'export.xml_created', entityType: 'export_batch', entityId: id, correlationId: request.id, metadata: { documentCount: body.documentIds.length } });
    });
    return reply.code(201).send({ batch: { id, tenantId: auth.tenantId, orgId: body.organizationId, createdAt: new Date().toISOString(), user: auth.name, documentIds: body.documentIds, xmlFileName: fileName }, xml });
  });

  app.get('/api/exports', async (request) => {
    const auth = await requireBrowserAuth(request, database);
    const result = await database.query(
      `SELECT e.id, e.tenant_id AS "tenantId", e.organization_id AS "orgId", e.created_at AS "createdAt",
              u.name AS "user", e.document_ids AS "documentIds", e.xml_file_name AS "xmlFileName"
         FROM export_batches e JOIN users u ON u.id=e.created_by
        WHERE e.tenant_id=$1 ORDER BY e.created_at DESC`,
      [auth.tenantId],
    );
    return result.rows;
  });

  app.get('/api/exports/:id/download', async (request, reply) => {
    const auth = await requireBrowserAuth(request, database);
    const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
    const result = await database.query<{ xml_snapshot: string; xml_file_name: string; organization_id: string } & Record<string, unknown>>(
      'SELECT xml_snapshot, xml_file_name, organization_id FROM export_batches WHERE id=$1 AND tenant_id=$2', [id, auth.tenantId],
    );
    if (!result.rows[0]) throw new HttpError(404, 'export_not_found', 'Export neexistuje');
    await requireOrganizationAccess(database, auth, result.rows[0].organization_id);
    reply.header('Content-Type', 'application/xml; charset=windows-1250');
    reply.header('Content-Disposition', `attachment; filename="${result.rows[0].xml_file_name}"`);
    return result.rows[0].xml_snapshot;
  });
}

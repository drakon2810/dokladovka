import type { FastifyInstance } from 'fastify';
import { requireBrowserAuth } from '../auth.js';
import type { Database } from '../db/database.js';

function iso(value: unknown): string | undefined {
  return value ? new Date(String(value)).toISOString() : undefined;
}

export function registerDataSnapshotRoutes(app: FastifyInstance, database: Database): void {
  app.get('/api/data/snapshot', async (request) => {
    const auth = await requireBrowserAuth(request, database);
    const organizations = await database.query<Record<string, any>>(
      `SELECT o.*, a.address AS email_alias FROM organizations o
        JOIN organization_memberships m ON m.organization_id=o.id AND m.tenant_id=o.tenant_id
        LEFT JOIN organization_email_aliases a ON a.organization_id=o.id AND a.is_primary=true AND a.status<>'disabled'
       WHERE o.tenant_id=$1 AND m.user_id=$2 ORDER BY o.name`, [auth.tenantId, auth.userId],
    );
    const organizationIds = organizations.rows.map((row) => row.id as string);
    const inScope = async (table: string, order = 'created_at DESC') => database.query<Record<string, any>>(
      `SELECT * FROM ${table} WHERE tenant_id=$1 AND organization_id=ANY($2::text[]) ORDER BY ${order}`,
      [auth.tenantId, organizationIds],
    );
    const queues = await inScope('document_queues', 'name');
    const bankAccounts = await inScope('organization_bank_accounts', 'label');
    const aliases = await inScope('organization_email_aliases');
    const documents = await inScope('documents');
    const inboundEmails = await inScope('inbound_emails');
    const inboundAttachments = await inScope('inbound_attachments');
    const extractionRuns = await inScope('extraction_runs');
    const codeListRows = await inScope('code_list_items', 'code');
    const users = await database.query<Record<string, any>>(
      'SELECT id,tenant_id,name,email,role,language,notifications FROM users WHERE tenant_id=$1 AND active=true ORDER BY name',
      [auth.tenantId],
    );
    const batches = await database.query<Record<string, any>>(
      `SELECT e.*, u.name AS user_name FROM export_batches e JOIN users u ON u.id=e.created_by
        WHERE e.tenant_id=$1 AND e.organization_id=ANY($2::text[]) ORDER BY e.created_at DESC`, [auth.tenantId, organizationIds],
    );
    const integration = await database.query<Record<string, any>>('SELECT mostik_enabled FROM tenant_integrations WHERE tenant_id=$1', [auth.tenantId]);
    const installations = await database.query<Record<string, any>>('SELECT * FROM agent_installations WHERE tenant_id=$1 ORDER BY created_at DESC', [auth.tenantId]);
    const links = await database.query<Record<string, any>>('SELECT * FROM pohoda_company_links WHERE tenant_id=$1 ORDER BY organization_id', [auth.tenantId]);
    const jobs = await database.query<Record<string, any>>(
      `SELECT id,tenant_id,organization_id,document_ids,status,idempotency_key,request_xml_hash,response_meta,
              attempt,created_at,created_by,sent_at,completed_at,retry_of_job_id
         FROM export_jobs WHERE tenant_id=$1 AND organization_id=ANY($2::text[]) ORDER BY created_at DESC`, [auth.tenantId, organizationIds],
    );

    const codeLists = { predkontacie: [], cleneniaDph: [], ciselneRady: [], strediska: [] } as Record<string, any[]>;
    for (const row of codeListRows.rows) {
      codeLists[row.kind].push({
        id: row.id, tenantId: row.tenant_id, orgId: row.organization_id, kod: row.code, nazov: row.name,
        source: row.source, active: row.active, externalId: row.external_id ?? undefined,
        agenda: row.agenda ?? undefined, uctovnyRok: row.accounting_year ?? undefined, syncedAt: iso(row.synced_at),
      });
    }

    return {
      role: auth.role,
      currentOrgId: 'all',
      organizations: organizations.rows.map((row) => ({
        id: row.id, tenantId: row.tenant_id, nazov: row.name, ico: row.ico, dic: row.dic,
        icDph: row.ic_dph ?? undefined, emailAlias: row.email_alias ?? '', farba: row.color, archived: row.archived,
      })),
      queues: queues.rows.map((row) => ({
        id: row.id, tenantId: row.tenant_id, organizationId: row.organization_id, name: row.name, kind: row.kind,
        documentTypes: row.document_types, importAlias: row.import_alias ?? undefined, active: row.active,
        features: row.features, warningThreshold: row.warning_threshold == null ? undefined : Number(row.warning_threshold), automation: row.automation,
      })),
      bankAccounts: bankAccounts.rows.map((row) => ({
        id: row.id, tenantId: row.tenant_id, organizationId: row.organization_id, label: row.label,
        iban: row.iban, bic: row.bic ?? undefined, currency: row.currency, isDefault: row.is_default, active: row.active,
      })),
      aliases: aliases.rows.map((row) => ({
        id: row.id, tenantId: row.tenant_id, organizationId: row.organization_id, address: row.address,
        addressNormalized: row.address_normalized, localPart: row.local_part, domain: row.domain,
        slugAtCreation: row.slug_at_creation, token: row.token, status: row.status, isPrimary: row.is_primary,
        providerRouteId: row.provider_route_id ?? undefined, createdAt: iso(row.created_at),
        graceUntil: iso(row.grace_until), disabledAt: iso(row.disabled_at),
      })),
      documents: documents.rows.map((row) => ({
        id: row.id, tenantId: row.tenant_id, orgId: row.organization_id, queueId: row.queue_id ?? '', typ: row.document_type,
        status: row.status, processingStatus: row.processing_status, pdfUrl: '', prijateDna: iso(row.created_at),
        zdroj: row.source, confidence: Number(row.confidence), fieldConfidence: row.field_confidence,
        extracted: row.extracted, ucto: row.accounting, history: row.history, comments: row.comments,
        exportId: row.export_id ?? undefined, quarantineReason: row.quarantine_reason ?? undefined,
        duplicateOfDocumentId: row.duplicate_of_document_id ?? undefined, notDuplicate: row.not_duplicate,
        version: row.version, approvedVersion: row.approved_version ?? undefined, approvedSnapshot: row.approved_snapshot ?? undefined,
      })),
      inboundEmails: inboundEmails.rows.map((row) => ({
        id: row.id, tenantId: row.tenant_id, organizationId: row.organization_id ?? undefined, aliasId: row.alias_id ?? undefined,
        provider: row.provider, providerMessageId: row.provider_message_id, envelopeRecipients: row.envelope_recipients,
        senderEmail: row.sender_email ?? undefined, senderName: row.sender_name ?? undefined, subject: row.subject ?? undefined,
        receivedAt: iso(row.received_at), status: row.status, attachmentCount: row.attachment_count,
        rawMessageStorageKey: row.raw_message_storage_key ?? undefined, quarantineReason: row.quarantine_reason ?? undefined,
        processingErrorCode: row.processing_error_code ?? undefined, processingErrorMessage: row.processing_error_message ?? undefined,
        correlationId: row.correlation_id, createdAt: iso(row.created_at),
      })),
      inboundAttachments: inboundAttachments.rows.map((row) => ({
        id: row.id, tenantId: row.tenant_id, inboundEmailId: row.inbound_email_id, organizationId: row.organization_id ?? undefined,
        originalFileName: row.original_file_name, safeFileName: row.safe_file_name, declaredMimeType: row.declared_mime_type ?? undefined,
        detectedMimeType: row.detected_mime_type ?? undefined, byteSize: Number(row.byte_size), sha256: row.sha256,
        storageKey: row.storage_key ?? undefined, status: row.status, documentId: row.document_id ?? undefined,
        quarantineReason: row.quarantine_reason ?? undefined, createdAt: iso(row.created_at),
      })),
      extractionRuns: extractionRuns.rows.map((row) => ({
        id: row.id, tenantId: row.tenant_id, organizationId: row.organization_id, documentId: row.document_id,
        provider: row.provider, model: row.model ?? undefined, promptVersion: row.prompt_version, schemaVersion: row.schema_version,
        status: row.status, result: row.result ?? undefined, errorCode: row.error_code ?? undefined, errorMessage: row.error_message ?? undefined,
        latencyMs: row.latency_ms ?? undefined, usage: row.usage ?? undefined, startedAt: iso(row.started_at), completedAt: iso(row.completed_at), createdAt: iso(row.created_at),
      })),
      suggestions: [],
      codeLists,
      users: users.rows.map((row) => ({ id: row.id, tenantId: row.tenant_id, meno: row.name, email: row.email, rola: row.role, jazyk: row.language, notifikacie: row.notifications })),
      exportBatches: batches.rows.map((row) => ({
        id: row.id, tenantId: row.tenant_id, orgId: row.organization_id, createdAt: iso(row.created_at),
        user: row.user_name, documentIds: row.document_ids, xmlFileName: row.xml_file_name, xmlSnapshot: row.xml_snapshot,
      })),
      mostikEnabled: integration.rows[0]?.mostik_enabled === true,
      agentInstallations: installations.rows.map((row) => ({
        id: row.id, tenantId: row.tenant_id, name: row.name, hostname: row.hostname, createdAt: iso(row.created_at),
        lastSeenAt: iso(row.last_seen_at), agentVersion: row.agent_version, status: row.status,
      })),
      pohodaCompanyLinks: links.rows.map((row) => ({
        tenantId: row.tenant_id, organizationId: row.organization_id, ico: row.ico, dbName: row.db_name ?? undefined,
        uctovnyRok: row.accounting_year ?? undefined, preferredYear: row.preferred_year, matchedAt: iso(row.matched_at), matchRule: row.match_rule ?? undefined,
      })),
      exportJobs: jobs.rows.map((row) => ({
        id: row.id, tenantId: row.tenant_id, organizationId: row.organization_id, documentIds: row.document_ids,
        status: row.status, idempotencyKey: row.idempotency_key, requestXmlHash: row.request_xml_hash,
        responseMeta: row.response_meta ?? undefined, attempt: row.attempt, createdAt: iso(row.created_at), createdBy: row.created_by,
        sentAt: iso(row.sent_at), completedAt: iso(row.completed_at), retryOfJobId: row.retry_of_job_id ?? undefined,
      })),
    };
  });
}

import { randomUUID } from 'node:crypto';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { writeAudit } from '../audit.js';
import { requireBrowserAuth, requireCsrf, requireOrganizationAccess, requireRole, type AuthContext } from '../auth.js';
import type { ServerConfig } from '../config.js';
import type { Database, Queryable } from '../db/database.js';
import { HttpError } from '../http.js';
import { createPairingCode, randomToken, sha256 } from '../security.js';
import { buildApprovedDocumentsXml } from '../services/exportService.js';

interface AgentAuth extends Record<string, unknown> {
  id: string;
  tenant_id: string;
  hostname: string;
  agent_version: string;
}

interface ExportJobRow extends Record<string, unknown> {
  id: string;
  tenant_id: string;
  organization_id: string;
  document_ids: string[];
  status: 'pending' | 'sent' | 'confirmed' | 'failed';
  idempotency_key: string;
  request_xml: string;
  request_xml_hash: string;
  response_meta?: Record<string, unknown>;
  result_hash?: string;
  attempt: number;
  created_at: string | Date;
  created_by: string;
}

const codeListKind = z.enum(['predkontacie', 'cleneniaDph', 'ciselneRady', 'strediska']);
const codeListItem = z.object({
  kod: z.string().trim().min(1).max(100),
  nazov: z.string().trim().min(1).max(300),
  externalId: z.string().max(100).optional(),
  agenda: z.string().max(50).optional(),
  uctovnyRok: z.string().max(20).optional(),
}).strict();

async function mostikEnabled(queryable: Queryable, tenantId: string): Promise<boolean> {
  const result = await queryable.query<{ mostik_enabled: boolean } & Record<string, unknown>>(
    'SELECT mostik_enabled FROM tenant_integrations WHERE tenant_id=$1', [tenantId],
  );
  return result.rows[0]?.mostik_enabled === true;
}

async function requireAgent(request: FastifyRequest, database: Database): Promise<AgentAuth> {
  const authorization = request.headers.authorization;
  if (!authorization?.startsWith('Bearer ')) throw new HttpError(401, 'agent_unauthorized', 'Agent token chýba');
  const token = authorization.slice('Bearer '.length).trim();
  if (!token) throw new HttpError(401, 'agent_unauthorized', 'Agent token chýba');
  const result = await database.query<AgentAuth>(
    `SELECT id, tenant_id, hostname, agent_version FROM agent_installations
      WHERE token_hash=$1 AND status='connected'`,
    [sha256(token)],
  );
  const agent = result.rows[0];
  if (!agent) throw new HttpError(401, 'agent_unauthorized', 'Agent token je neplatný');
  if (!await mostikEnabled(database, agent.tenant_id)) {
    throw new HttpError(403, 'paused', 'Mostík je pre tenant vypnutý');
  }
  return agent;
}

async function createExportJob(
  database: Database,
  auth: AuthContext,
  input: { organizationId: string; documentIds: string[]; idempotencyKey?: string },
  correlationId: string,
): Promise<ExportJobRow> {
  await requireOrganizationAccess(database, auth, input.organizationId);
  if (!await mostikEnabled(database, auth.tenantId)) throw new HttpError(409, 'mostik_disabled', 'Mostík nie je povolený');
  const link = await database.query<{ ico: string; matched_at?: string; db_name?: string } & Record<string, unknown>>(
    `SELECT ico, matched_at, db_name FROM pohoda_company_links
      WHERE organization_id=$1 AND tenant_id=$2`, [input.organizationId, auth.tenantId],
  );
  if (!link.rows[0]?.matched_at) throw new HttpError(409, 'organization_not_linked', 'Organizácia nie je spárovaná s POHODOU');
  const idempotencyKey = input.idempotencyKey?.trim() || randomUUID();
  const existing = await database.query<ExportJobRow>(
    'SELECT * FROM export_jobs WHERE tenant_id=$1 AND idempotency_key=$2', [auth.tenantId, idempotencyKey],
  );
  if (existing.rows[0]) return existing.rows[0];
  const id = randomUUID();
  const xml = await buildApprovedDocumentsXml(database, {
    tenantId: auth.tenantId,
    organizationId: input.organizationId,
    ico: link.rows[0].ico,
    documentIds: input.documentIds,
    packId: id,
  });
  const hash = sha256(xml);
  const result = await database.query<ExportJobRow>(
    `INSERT INTO export_jobs
      (id, tenant_id, organization_id, document_ids, status, idempotency_key, request_xml,
       request_xml_hash, created_by)
     VALUES ($1,$2,$3,$4::jsonb,'pending',$5,$6,$7,$8)
     RETURNING *`,
    [id, auth.tenantId, input.organizationId, JSON.stringify([...new Set(input.documentIds)]), idempotencyKey, xml, hash, auth.userId],
  );
  await writeAudit(database, {
    tenantId: auth.tenantId,
    organizationId: input.organizationId,
    actorType: 'user',
    actorId: auth.userId,
    action: 'mostik.export_job_created',
    entityType: 'export_job',
    entityId: id,
    correlationId,
    metadata: { documentCount: input.documentIds.length, requestXmlHash: hash },
  });
  return result.rows[0];
}

function publicJob(row: ExportJobRow) {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    organizationId: row.organization_id,
    documentIds: row.document_ids,
    status: row.status,
    idempotencyKey: row.idempotency_key,
    requestXmlHash: row.request_xml_hash,
    responseMeta: row.response_meta,
    attempt: row.attempt,
    createdAt: new Date(row.created_at).toISOString(),
    createdBy: row.created_by,
  };
}

export function registerAgentRoutes(app: FastifyInstance, database: Database, config: ServerConfig): void {
  app.post('/api/agent/pair', {
    config: { rateLimit: { max: 10, timeWindow: '1 minute' } },
  }, async (request, reply) => {
    const body = z.object({
      pairingCode: z.string().trim().min(8).max(20),
      hostname: z.string().trim().min(1).max(255),
      agentVersion: z.string().trim().min(1).max(50),
    }).strict().parse(request.body);
    const codeHash = sha256(body.pairingCode.toUpperCase());
    const token = randomToken();
    const installationId = randomUUID();
    const paired = await database.transaction(async (tx) => {
      const result = await tx.query<{ id: string; tenant_id: string; created_by: string } & Record<string, unknown>>(
        `SELECT id, tenant_id, created_by FROM agent_pairing_codes
          WHERE code_hash=$1 AND used_at IS NULL AND expires_at > now()
          FOR UPDATE`,
        [codeHash],
      );
      const pairing = result.rows[0];
      if (!pairing) throw new HttpError(400, 'pairing_code_invalid', 'Párovací kód je neplatný alebo vypršal');
      if (!await mostikEnabled(tx, pairing.tenant_id)) throw new HttpError(403, 'paused', 'Mostík je pre tenant vypnutý');
      await tx.query('UPDATE agent_pairing_codes SET used_at=now() WHERE id=$1', [pairing.id]);
      await tx.query(
        `INSERT INTO agent_installations
          (id, tenant_id, name, hostname, token_hash, last_seen_at, agent_version, status)
         VALUES ($1,$2,$3,$3,$4,now(),$5,'connected')`,
        [installationId, pairing.tenant_id, body.hostname, sha256(token), body.agentVersion],
      );
      await writeAudit(tx, { tenantId: pairing.tenant_id, actorType: 'agent', actorId: installationId, action: 'agent.paired', entityType: 'agent_installation', entityId: installationId, correlationId: request.id, metadata: { hostname: body.hostname, agentVersion: body.agentVersion } });
      return pairing;
    });
    return reply.code(201).send({ agentToken: token, installationId, tenantId: paired.tenant_id });
  });

  app.get('/api/agent/organizations', async (request) => {
    const agent = await requireAgent(request, database);
    const result = await database.query(
      `SELECT o.id AS "organizationId", o.ico, o.name AS nazov,
              l.db_name AS "dbName", l.accounting_year AS "uctovnyRok",
              COALESCE(l.preferred_year, 'latest') AS "preferredYear"
         FROM organizations o
         LEFT JOIN pohoda_company_links l ON l.organization_id=o.id AND l.tenant_id=o.tenant_id
        WHERE o.tenant_id=$1 AND o.archived=false ORDER BY o.name`, [agent.tenant_id],
    );
    await database.query('UPDATE agent_installations SET last_seen_at=now() WHERE id=$1', [agent.id]);
    return result.rows;
  });

  app.post('/api/agent/sync-results', async (request, reply) => {
    const agent = await requireAgent(request, database);
    const body = z.object({
      organizationId: z.string().uuid(),
      kind: codeListKind,
      state: z.enum(['ok', 'error']),
      itemCount: z.number().int().min(0).max(20_000),
      durationMs: z.number().int().min(0).max(86_400_000),
      errorCode: z.string().max(200).optional(),
    }).strict().parse(request.body);
    const organization = await database.query('SELECT 1 FROM organizations WHERE id=$1 AND tenant_id=$2', [body.organizationId, agent.tenant_id]);
    if (organization.rowCount === 0) throw new HttpError(404, 'organization_not_found', 'Organizácia neexistuje');
    await database.query(
      `INSERT INTO agent_sync_runs
        (id,tenant_id,organization_id,agent_installation_id,kind,state,item_count,duration_ms,error_code)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
      [randomUUID(), agent.tenant_id, body.organizationId, agent.id, body.kind, body.state, body.itemCount, body.durationMs, body.errorCode ?? null],
    );
    return reply.code(202).send({ accepted: true });
  });

  app.put('/api/agent/organizations/:id/code-lists', async (request) => {
    const agent = await requireAgent(request, database);
    const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
    const body = z.object({ kind: codeListKind, items: z.array(codeListItem).max(20_000) }).strict().parse(request.body);
    const organization = await database.query('SELECT 1 FROM organizations WHERE id=$1 AND tenant_id=$2 AND archived=false', [id, agent.tenant_id]);
    if (organization.rowCount === 0) throw new HttpError(404, 'organization_not_found', 'Organizácia neexistuje');
    const normalized = new Map<string, z.infer<typeof codeListItem>>();
    for (const item of body.items) {
      if (normalized.has(item.kod)) throw new HttpError(400, 'duplicate_code', `Duplicitný kód ${item.kod}`);
      normalized.set(item.kod, item);
    }
    const counts = await database.transaction(async (tx) => {
      let insertedOrUpdated = 0;
      for (const item of normalized.values()) {
        await tx.query(
          `INSERT INTO code_list_items
            (id, tenant_id, organization_id, kind, code, name, source, active, external_id, agenda, accounting_year, synced_at)
           VALUES ($1,$2,$3,$4,$5,$6,'pohoda',true,$7,$8,$9,now())
           ON CONFLICT (tenant_id, organization_id, kind, code)
           DO UPDATE SET name=excluded.name, source='pohoda', active=true, external_id=excluded.external_id,
                         agenda=excluded.agenda, accounting_year=excluded.accounting_year, synced_at=now(), updated_at=now()`,
          [randomUUID(), agent.tenant_id, id, body.kind, item.kod, item.nazov, item.externalId ?? null, item.agenda ?? null, item.uctovnyRok ?? null],
        );
        insertedOrUpdated += 1;
      }
      const deactivated = await tx.query(
        `UPDATE code_list_items SET active=false, updated_at=now()
          WHERE tenant_id=$1 AND organization_id=$2 AND kind=$3 AND source='pohoda' AND active=true
            AND NOT (code = ANY($4::text[]))`,
        [agent.tenant_id, id, body.kind, [...normalized.keys()]],
      );
      await writeAudit(tx, { tenantId: agent.tenant_id, organizationId: id, actorType: 'agent', actorId: agent.id, action: 'agent.code_lists_synced', entityType: 'organization', entityId: id, correlationId: request.id, metadata: { kind: body.kind, itemCount: normalized.size, deactivated: deactivated.rowCount } });
      return { upserted: insertedOrUpdated, deactivated: deactivated.rowCount };
    });
    await database.query('UPDATE agent_installations SET last_seen_at=now(), agent_version=$1 WHERE id=$2', [agent.agent_version, agent.id]);
    return counts;
  });

  app.get('/api/agent/export-queue', async (request) => {
    const agent = await requireAgent(request, database);
    const { organizationId } = z.object({ organizationId: z.string().uuid() }).parse(request.query);
    const organization = await database.query('SELECT 1 FROM organizations WHERE id=$1 AND tenant_id=$2', [organizationId, agent.tenant_id]);
    if (organization.rowCount === 0) throw new HttpError(404, 'organization_not_found', 'Organizácia neexistuje');
    const jobs = await database.transaction(async (tx) => {
      const pending = await tx.query<ExportJobRow>(
        `SELECT * FROM export_jobs
          WHERE tenant_id=$1 AND organization_id=$2 AND status='pending'
          ORDER BY created_at FOR UPDATE SKIP LOCKED LIMIT 20`,
        [agent.tenant_id, organizationId],
      );
      if (pending.rowCount > 0) {
        await tx.query(
          `UPDATE export_jobs SET status='sent', sent_at=now()
            WHERE tenant_id=$1 AND id=ANY($2::text[])`,
          [agent.tenant_id, pending.rows.map((row) => row.id)],
        );
        for (const job of pending.rows) {
          await writeAudit(tx, { tenantId: agent.tenant_id, organizationId, actorType: 'agent', actorId: agent.id, action: 'agent.export_job_claimed', entityType: 'export_job', entityId: job.id, correlationId: request.id, metadata: { requestXmlHash: job.request_xml_hash } });
        }
      }
      return pending.rows;
    });
    await database.query('UPDATE agent_installations SET last_seen_at=now() WHERE id=$1', [agent.id]);
    return jobs.map((job) => ({ exportJobId: job.id, dataPackXml: job.request_xml, idempotencyKey: job.idempotency_key }));
  });

  app.post('/api/agent/export-results', async (request) => {
    const agent = await requireAgent(request, database);
    const body = z.object({
      exportJobId: z.string().uuid(),
      perDocument: z.array(z.object({
        documentId: z.string().uuid(),
        state: z.enum(['ok', 'warning', 'error']),
        pohodaNumber: z.string().max(100).optional(),
        message: z.string().max(1000).optional(),
      }).strict()).min(1),
      rawResponseMeta: z.record(z.string(), z.unknown()).default({}),
    }).strict().parse(request.body);
    const resultHash = sha256(JSON.stringify(body));
    return database.transaction(async (tx) => {
      const jobs = await tx.query<ExportJobRow>('SELECT * FROM export_jobs WHERE id=$1 AND tenant_id=$2 FOR UPDATE', [body.exportJobId, agent.tenant_id]);
      const job = jobs.rows[0];
      if (!job) throw new HttpError(404, 'export_job_not_found', 'Export job neexistuje');
      if (job.status === 'confirmed' || job.status === 'failed') {
        return { accepted: true, idempotent: true, status: job.status };
      }
      if (job.status !== 'sent') throw new HttpError(409, 'export_job_not_sent', 'Export job nebol vydaný agentovi');
      const expected = new Set(job.document_ids);
      const actual = new Set(body.perDocument.map((item) => item.documentId));
      if (actual.size !== body.perDocument.length || actual.size !== expected.size || [...actual].some((id) => !expected.has(id))) {
        throw new HttpError(400, 'result_documents_mismatch', 'Výsledok neobsahuje presne doklady export jobu');
      }
      let okCount = 0;
      for (const item of body.perDocument) {
        if (item.state === 'ok') {
          okCount += 1;
          await tx.query(
            `UPDATE documents SET status='exportovany', export_id=$1,
                    history=history || $2::jsonb, updated_at=now()
              WHERE id=$3 AND tenant_id=$4 AND organization_id=$5`,
            [job.id, JSON.stringify([{ ts: new Date().toISOString(), user: 'POHODA', akcia: `Prenos potvrdený${item.pohodaNumber ? ` č. ${item.pohodaNumber}` : ''}` }]), item.documentId, agent.tenant_id, job.organization_id],
          );
        } else if (item.state === 'error') {
          await tx.query(
            `UPDATE documents SET status='chyba', history=history || $1::jsonb, updated_at=now()
              WHERE id=$2 AND tenant_id=$3 AND organization_id=$4`,
            [JSON.stringify([{ ts: new Date().toISOString(), user: 'POHODA', akcia: `Chyba prenosu: ${item.message ?? 'Neznáma chyba'}` }]), item.documentId, agent.tenant_id, job.organization_id],
          );
        } else {
          await tx.query(
            `UPDATE documents SET history=history || $1::jsonb, updated_at=now()
              WHERE id=$2 AND tenant_id=$3 AND organization_id=$4`,
            [JSON.stringify([{ ts: new Date().toISOString(), user: 'POHODA', akcia: `Upozornenie pri prenose: ${item.message ?? ''}` }]), item.documentId, agent.tenant_id, job.organization_id],
          );
        }
      }
      const status = okCount === body.perDocument.length ? 'confirmed' : 'failed';
      const responseMeta = {
        ...body.rawResponseMeta,
        perDocument: body.perDocument,
        summary: { ok: okCount, warning: body.perDocument.filter((item) => item.state === 'warning').length, error: body.perDocument.filter((item) => item.state === 'error').length },
      };
      await tx.query(
        `UPDATE export_jobs SET status=$1, response_meta=$2::jsonb, result_hash=$3, completed_at=now()
          WHERE id=$4 AND tenant_id=$5`,
        [status, JSON.stringify(responseMeta), resultHash, job.id, agent.tenant_id],
      );
      await writeAudit(tx, { tenantId: agent.tenant_id, organizationId: job.organization_id, actorType: 'agent', actorId: agent.id, action: 'agent.export_results_received', entityType: 'export_job', entityId: job.id, correlationId: request.id, metadata: { status, okCount, total: body.perDocument.length } });
      return { accepted: true, idempotent: false, status };
    });
  });

  app.post('/api/agent/heartbeat', async (request) => {
    const agent = await requireAgent(request, database);
    const body = z.object({
      companies: z.array(z.object({ ico: z.string().regex(/^\d{8}$/), dbName: z.string().min(1).max(255), uctovnyRok: z.string().min(1).max(20) }).strict()).max(1000),
      agentVersion: z.string().min(1).max(50),
    }).strict().parse(request.body);
    await database.transaction(async (tx) => {
      await tx.query('UPDATE agent_installations SET last_seen_at=now(), agent_version=$1 WHERE id=$2 AND tenant_id=$3', [body.agentVersion, agent.id, agent.tenant_id]);
      const organizations = await tx.query<{ id: string; ico: string; preferred_year: string } & Record<string, unknown>>(
        `SELECT o.id, o.ico, COALESCE(l.preferred_year, 'latest') AS preferred_year
           FROM organizations o
           LEFT JOIN pohoda_company_links l ON l.organization_id=o.id AND l.tenant_id=o.tenant_id
          WHERE o.tenant_id=$1 AND o.archived=false`, [agent.tenant_id],
      );
      for (const organization of organizations.rows) {
        const matches = body.companies.filter((company) => company.ico === organization.ico).sort((a, b) => b.uctovnyRok.localeCompare(a.uctovnyRok, 'sk', { numeric: true }));
        const selected = organization.preferred_year === 'latest'
          ? matches[0]
          : matches.find((company) => company.uctovnyRok === organization.preferred_year);
        if (selected) {
          await tx.query(
            `UPDATE pohoda_company_links
                SET db_name=$1, accounting_year=$2, matched_at=now(), match_rule='auto_ico', updated_at=now()
              WHERE organization_id=$3 AND tenant_id=$4 AND (match_rule IS NULL OR match_rule='auto_ico')`,
            [selected.dbName, selected.uctovnyRok, organization.id, agent.tenant_id],
          );
        }
      }
      await writeAudit(tx, { tenantId: agent.tenant_id, actorType: 'agent', actorId: agent.id, action: 'agent.heartbeat', entityType: 'agent_installation', entityId: agent.id, correlationId: request.id, metadata: { companyCount: body.companies.length, agentVersion: body.agentVersion } });
    });
    return { accepted: true, serverTime: new Date().toISOString() };
  });

  app.get('/api/agent/latest', async () => {
    const result = await database.query<{ version: string; download_url: string; sha256: string } & Record<string, unknown>>(
      `SELECT version, download_url, sha256 FROM agent_releases
        WHERE active=true ORDER BY created_at DESC LIMIT 1`,
    );
    if (!result.rows[0]) throw new HttpError(404, 'release_not_available', 'Inštalátor zatiaľ nie je publikovaný');
    return { version: result.rows[0].version, downloadUrl: result.rows[0].download_url, sha256: result.rows[0].sha256 };
  });

  // Browser/admin API used by the Mostík UI.
  app.get('/api/mostik/settings', async (request) => {
    const auth = await requireBrowserAuth(request, database);
    return { enabled: await mostikEnabled(database, auth.tenantId) };
  });

  app.put('/api/mostik/settings', async (request) => {
    const auth = await requireBrowserAuth(request, database);
    requireCsrf(request, auth);
    requireRole(auth, ['admin']);
    const { enabled } = z.object({ enabled: z.boolean() }).strict().parse(request.body);
    await database.query(
      `INSERT INTO tenant_integrations (tenant_id, mostik_enabled, updated_by)
       VALUES ($1,$2,$3)
       ON CONFLICT (tenant_id) DO UPDATE SET mostik_enabled=excluded.mostik_enabled, updated_by=excluded.updated_by, updated_at=now()`,
      [auth.tenantId, enabled, auth.userId],
    );
    await writeAudit(database, { tenantId: auth.tenantId, actorType: 'user', actorId: auth.userId, action: enabled ? 'mostik.enabled' : 'mostik.disabled', entityType: 'tenant_integration', entityId: auth.tenantId, correlationId: request.id });
    return { enabled };
  });

  app.post('/api/mostik/pairing-codes', async (request, reply) => {
    const auth = await requireBrowserAuth(request, database);
    requireCsrf(request, auth);
    requireRole(auth, ['admin']);
    if (!await mostikEnabled(database, auth.tenantId)) throw new HttpError(409, 'mostik_disabled', 'Mostík nie je povolený');
    const code = createPairingCode();
    const expiresAt = new Date(Date.now() + 15 * 60 * 1000);
    await database.query(
      `INSERT INTO agent_pairing_codes (id, code_hash, tenant_id, created_by, expires_at)
       VALUES ($1,$2,$3,$4,$5)`,
      [randomUUID(), sha256(code), auth.tenantId, auth.userId, expiresAt.toISOString()],
    );
    return reply.code(201).send({ code, expiresAt: expiresAt.toISOString() });
  });

  app.get('/api/mostik/installations', async (request) => {
    const auth = await requireBrowserAuth(request, database);
    const result = await database.query<Record<string, unknown>>(
      `SELECT id, hostname, name, agent_version AS "agentVersion", created_at AS "createdAt",
              last_seen_at AS "lastSeenAt", status,
              (status='connected' AND last_seen_at > now() - interval '5 minutes') AS connected
         FROM agent_installations WHERE tenant_id=$1 ORDER BY created_at DESC`, [auth.tenantId],
    );
    return result.rows;
  });

  app.get('/api/mostik/health', async (request) => {
    const auth = await requireBrowserAuth(request, database);
    const installations = await database.query<Record<string, unknown>>(
      `SELECT id, hostname, last_seen_at AS "lastSeenAt",
              (status='connected' AND last_seen_at > now() - ($2::text || ' hours')::interval) AS online
         FROM agent_installations WHERE tenant_id=$1 AND status='connected' ORDER BY hostname`,
      [auth.tenantId, config.agentOfflineAlertHours],
    );
    const sync = await database.query<Record<string, unknown>>(
      `SELECT DISTINCT ON (organization_id, kind)
              organization_id AS "organizationId", kind, state, item_count AS "itemCount",
              duration_ms AS "durationMs", error_code AS "errorCode", created_at AS "createdAt"
         FROM agent_sync_runs WHERE tenant_id=$1
        ORDER BY organization_id, kind, created_at DESC`, [auth.tenantId],
    );
    const exports = await database.query<Record<string, unknown>>(
      `SELECT COUNT(*)::int AS total,
              COALESCE(SUM(CASE WHEN status='failed' THEN 1 ELSE 0 END),0)::int AS failed
         FROM export_jobs WHERE tenant_id=$1 AND created_at > now() - interval '24 hours'`, [auth.tenantId],
    );
    const alerts = auth.role === 'admin'
      ? (await database.query<Record<string, unknown>>(
          `SELECT id, event_type AS "eventType", state, created_at AS "createdAt"
             FROM notification_outbox WHERE tenant_id=$1 AND created_at > now() - interval '7 days'
            ORDER BY created_at DESC LIMIT 20`, [auth.tenantId],
        )).rows
      : [];
    return { installations: installations.rows, latestSyncs: sync.rows, exports24h: exports.rows[0] ?? { total: 0, failed: 0 }, alerts };
  });

  app.delete('/api/mostik/installations/:id', async (request, reply) => {
    const auth = await requireBrowserAuth(request, database);
    requireCsrf(request, auth);
    requireRole(auth, ['admin']);
    const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
    const result = await database.query(
      `UPDATE agent_installations SET status='revoked', revoked_at=now()
        WHERE id=$1 AND tenant_id=$2 AND status='connected'`, [id, auth.tenantId],
    );
    if (result.rowCount === 0) throw new HttpError(404, 'agent_not_found', 'Inštalácia agenta neexistuje');
    await writeAudit(database, { tenantId: auth.tenantId, actorType: 'user', actorId: auth.userId, action: 'agent.revoked', entityType: 'agent_installation', entityId: id, correlationId: request.id });
    return reply.code(204).send();
  });

  app.get('/api/mostik/organization-links', async (request) => {
    const auth = await requireBrowserAuth(request, database);
    const result = await database.query(
      `SELECT o.id AS "organizationId", o.name AS "organizationName", o.ico,
              l.db_name AS "dbName", l.accounting_year AS "uctovnyRok", l.preferred_year AS "preferredYear",
              l.matched_at AS "matchedAt", l.match_rule AS "matchRule"
         FROM organizations o
         JOIN organization_memberships m ON m.organization_id=o.id AND m.tenant_id=o.tenant_id
         LEFT JOIN pohoda_company_links l ON l.organization_id=o.id AND l.tenant_id=o.tenant_id
        WHERE o.tenant_id=$1 AND m.user_id=$2 AND o.archived=false ORDER BY o.name`,
      [auth.tenantId, auth.userId],
    );
    return result.rows;
  });

  app.patch('/api/mostik/organization-links/:organizationId', async (request) => {
    const auth = await requireBrowserAuth(request, database);
    requireCsrf(request, auth);
    requireRole(auth, ['admin']);
    const { organizationId } = z.object({ organizationId: z.string().uuid() }).parse(request.params);
    await requireOrganizationAccess(database, auth, organizationId);
    const body = z.object({ dbName: z.string().min(1).max(255), uctovnyRok: z.string().min(1).max(20), preferredYear: z.string().min(1).max(20).default('latest') }).strict().parse(request.body);
    await database.query(
      `UPDATE pohoda_company_links SET db_name=$1, accounting_year=$2, preferred_year=$3,
              matched_at=now(), match_rule='manual', updated_at=now()
        WHERE organization_id=$4 AND tenant_id=$5`,
      [body.dbName, body.uctovnyRok, body.preferredYear, organizationId, auth.tenantId],
    );
    return { organizationId, ...body, matchedAt: new Date().toISOString(), matchRule: 'manual' };
  });

  app.post('/api/mostik/export-jobs', async (request, reply) => {
    const auth = await requireBrowserAuth(request, database);
    requireCsrf(request, auth);
    requireRole(auth, ['admin', 'uctovnik']);
    const body = z.object({ organizationId: z.string().uuid(), documentIds: z.array(z.string().uuid()).min(1), idempotencyKey: z.string().max(200).optional() }).strict().parse(request.body);
    return reply.code(201).send(publicJob(await createExportJob(database, auth, body, request.id)));
  });

  app.get('/api/mostik/export-jobs', async (request) => {
    const auth = await requireBrowserAuth(request, database);
    const result = await database.query<ExportJobRow>(
      `SELECT e.* FROM export_jobs e
        JOIN organization_memberships m ON m.organization_id=e.organization_id AND m.tenant_id=e.tenant_id
       WHERE e.tenant_id=$1 AND m.user_id=$2 ORDER BY e.created_at DESC LIMIT 200`,
      [auth.tenantId, auth.userId],
    );
    return result.rows.map(publicJob);
  });

  app.post('/api/mostik/export-jobs/:id/retry', async (request, reply) => {
    const auth = await requireBrowserAuth(request, database);
    requireCsrf(request, auth);
    requireRole(auth, ['admin', 'uctovnik']);
    const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
    const current = await database.query<ExportJobRow>('SELECT * FROM export_jobs WHERE id=$1 AND tenant_id=$2', [id, auth.tenantId]);
    const job = current.rows[0];
    if (!job || job.status !== 'failed') throw new HttpError(409, 'job_not_retryable', 'Prenos nie je možné zopakovať');
    await requireOrganizationAccess(database, auth, job.organization_id);
    const next = await database.query<ExportJobRow>(
      `INSERT INTO export_jobs
        (id,tenant_id,organization_id,document_ids,status,idempotency_key,request_xml,request_xml_hash,
         response_meta,attempt,created_by,retry_of_job_id)
       VALUES ($1,$2,$3,$4::jsonb,'pending',$5,$6,$7,NULL,$8,$9,$10) RETURNING *`,
      [randomUUID(), auth.tenantId, job.organization_id, JSON.stringify(job.document_ids), randomUUID(), job.request_xml, job.request_xml_hash, job.attempt + 1, auth.userId, job.id],
    );
    return reply.code(201).send(publicJob(next.rows[0]));
  });

  app.post('/api/mostik/releases', async (request, reply) => {
    const auth = await requireBrowserAuth(request, database);
    requireCsrf(request, auth);
    requireRole(auth, ['admin']);
    const body = z.object({ version: z.string().regex(/^\d+\.\d+\.\d+(?:[-+][A-Za-z0-9.-]+)?$/), downloadUrl: z.string().url(), sha256: z.string().regex(/^[a-f0-9]{64}$/) }).strict().parse(request.body);
    await database.transaction(async (tx) => {
      await tx.query('UPDATE agent_releases SET active=false WHERE active=true');
      await tx.query(
        `INSERT INTO agent_releases (version,download_url,sha256,active)
         VALUES ($1,$2,$3,true)
         ON CONFLICT (version) DO UPDATE SET download_url=excluded.download_url, sha256=excluded.sha256, active=true, created_at=now()`,
        [body.version, body.downloadUrl, body.sha256],
      );
      await writeAudit(tx, { tenantId: auth.tenantId, actorType: 'user', actorId: auth.userId, action: 'agent.release_published', entityType: 'agent_release', entityId: body.version, correlationId: request.id, metadata: { sha256: body.sha256 } });
    });
    return reply.code(201).send(body);
  });
}

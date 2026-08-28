// Schránka organizácie (sekcia Dokumenty): voľné súbory mimo účtovného workflow.
// Prísna izolácia per-organizácia; obsah sa ukladá do privátneho object storage.
import { contentDisposition } from '../contentDisposition.js';
import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import OpenAI from 'openai';
import { zodTextFormat } from 'openai/helpers/zod';
import { z } from 'zod';
import { writeAudit } from '../audit.js';
import { requireBrowserAuth, requireCsrf, requireOrganizationAccess, requireRole } from '../auth.js';
import type { ServerConfig } from '../config.js';
import type { Database } from '../db/database.js';
import { HttpError } from '../http.js';
import { sha256 } from '../security.js';
import { looksLikeXml } from '../inbound/xmlClassifier.js';
import type { ObjectStorage } from '../storage.js';

/** Nad túto veľkosť sa dokument do modelu neposiela (cena aj limity vstupu). */
const MAX_SUMMARY_BYTES = 12 * 1024 * 1024;

const uploadSchema = z.object({
  fileName: z.string().min(1).max(255),
  mimeType: z.string().min(1).max(120),
  contentBase64: z.string().min(1),
  note: z.string().max(500).optional(),
}).strict();

function detectedMimeType(bytes: Uint8Array): string | undefined {
  if (bytes.length >= 5 && Buffer.from(bytes.slice(0, 5)).toString('ascii') === '%PDF-') return 'application/pdf';
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'image/jpeg';
  if (bytes.length >= 8 && Buffer.from(bytes.slice(0, 8)).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return 'image/png';
  if (bytes.length >= 12 && Buffer.from(bytes.slice(0, 4)).toString('ascii') === 'RIFF'
    && Buffer.from(bytes.slice(8, 12)).toString('ascii') === 'WEBP') return 'image/webp';
  if (looksLikeXml(bytes)) return 'application/xml';
  return undefined;
}

function safeName(value: string): string {
  const base = value.replaceAll('\\', '/').split('/').pop() ?? 'dokument';
  return base.replace(/[^a-zA-Z0-9._-]+/g, '_').slice(0, 120) || 'dokument';
}

function rowToDto(row: Record<string, any>) {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    organizationId: row.organization_id,
    fileName: row.file_name,
    mimeType: row.mime_type,
    byteSize: Number(row.byte_size),
    sha256: row.sha256,
    uploadedBy: row.uploaded_by ?? undefined,
    uploadedByName: row.uploaded_by_name ?? undefined,
    note: row.note ?? undefined,
    aiSummary: row.ai_summary ?? undefined,
    createdAt: row.created_at ? new Date(String(row.created_at)).toISOString() : undefined,
  };
}

/** Zhrnutie je krátke a v bodoch — na rýchle „o čom to je", nie na prepis. */
const summarySchema = z.object({
  nadpis: z.string(),
  body: z.array(z.string()),
});

export function registerOrgDocumentRoutes(
  app: FastifyInstance,
  database: Database,
  storage: ObjectStorage,
  config: ServerConfig,
): void {
  const params = z.object({ organizationId: z.string().uuid() });
  const itemParams = z.object({ organizationId: z.string().uuid(), id: z.string().uuid() });

  app.get('/api/organizations/:organizationId/documents', async (request) => {
    const auth = await requireBrowserAuth(request, database);
    const { organizationId } = params.parse(request.params);
    await requireOrganizationAccess(database, auth, organizationId);
    const result = await database.query(
      `SELECT d.*, u.name AS uploaded_by_name
         FROM organization_documents d
         LEFT JOIN users u ON u.id = d.uploaded_by
        WHERE d.tenant_id=$1 AND d.organization_id=$2
        ORDER BY d.created_at DESC LIMIT 500`,
      [auth.tenantId, organizationId],
    );
    return result.rows.map(rowToDto);
  });

  app.post('/api/organizations/:organizationId/documents', {
    bodyLimit: 30 * 1024 * 1024,
  }, async (request, reply) => {
    const auth = await requireBrowserAuth(request, database);
    requireCsrf(request, auth);
    requireRole(auth, ['admin', 'uctovnik']);
    const { organizationId } = params.parse(request.params);
    await requireOrganizationAccess(database, auth, organizationId);
    const body = uploadSchema.parse(request.body);

    const bytes = Buffer.from(body.contentBase64, 'base64');
    if (bytes.byteLength === 0) throw new HttpError(400, 'empty_file', 'Súbor je prázdny');
    if (bytes.byteLength > config.extractionMaxFileBytes) {
      throw new HttpError(413, 'file_too_large', 'Súbor prekračuje povolenú veľkosť');
    }
    const actualMime = detectedMimeType(bytes);
    if (!actualMime) throw new HttpError(415, 'unsupported_file_type', 'Podporované sú PDF, obrázky a XML');

    const id = randomUUID();
    const storageKey = `org-documents/${auth.tenantId}/${organizationId}/${id}/${safeName(body.fileName)}`;
    await storage.put(storageKey, bytes, actualMime);
    await database.query(
      `INSERT INTO organization_documents
        (id, tenant_id, organization_id, file_name, mime_type, byte_size, sha256, storage_key, uploaded_by, note)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
      [id, auth.tenantId, organizationId, body.fileName, actualMime, bytes.byteLength,
        sha256(bytes), storageKey, auth.userId, body.note ?? null],
    );
    await writeAudit(database, {
      tenantId: auth.tenantId,
      organizationId,
      actorType: 'user',
      actorId: auth.userId,
      action: 'organization_document.uploaded',
      entityType: 'organization_document',
      entityId: id,
      correlationId: request.id,
      metadata: { fileName: body.fileName, byteSize: bytes.byteLength },
    });
    const inserted = await database.query(
      `SELECT d.*, u.name AS uploaded_by_name FROM organization_documents d
         LEFT JOIN users u ON u.id=d.uploaded_by WHERE d.id=$1`, [id],
    );
    return reply.code(201).send(rowToDto(inserted.rows[0]));
  });

  app.get('/api/organizations/:organizationId/documents/:id/file', async (request, reply) => {
    const auth = await requireBrowserAuth(request, database);
    const { organizationId, id } = itemParams.parse(request.params);
    await requireOrganizationAccess(database, auth, organizationId);
    const result = await database.query<{ storage_key: string; mime_type: string; file_name: string } & Record<string, unknown>>(
      'SELECT storage_key, mime_type, file_name FROM organization_documents WHERE id=$1 AND tenant_id=$2 AND organization_id=$3',
      [id, auth.tenantId, organizationId],
    );
    const row = result.rows[0];
    if (!row) throw new HttpError(404, 'document_not_found', 'Dokument neexistuje');
    reply.header('Content-Type', row.mime_type);
    reply.header('Content-Disposition', contentDisposition('inline', String(row.file_name)));
    return reply.send(Buffer.from(await storage.get(row.storage_key)));
  });

  // „Vysvetliť dokument" — AI prečíta súbor a vráti krátke zhrnutie v bodoch.
  // Výsledok sa uloží, takže druhé otvorenie je zadarmo a okamžité.
  app.post('/api/organizations/:organizationId/documents/:id/summary', async (request) => {
    const auth = await requireBrowserAuth(request, database);
    requireCsrf(request, auth);
    const { organizationId, id } = itemParams.parse(request.params);
    await requireOrganizationAccess(database, auth, organizationId);
    const row = (await database.query<Record<string, any>>(
      `SELECT file_name, mime_type, byte_size, storage_key, ai_summary FROM organization_documents
        WHERE id=$1 AND tenant_id=$2 AND organization_id=$3`,
      [id, auth.tenantId, organizationId],
    )).rows[0];
    if (!row) throw new HttpError(404, 'document_not_found', 'Dokument neexistuje');
    if (row.ai_summary) return row.ai_summary;
    if (!config.openai.apiKey) {
      throw new HttpError(503, 'ai_unavailable', 'AI nie je nakonfigurovaná (chýba API kľúč).');
    }
    if (Number(row.byte_size) > MAX_SUMMARY_BYTES) {
      throw new HttpError(413, 'document_too_large', 'Dokument je príliš veľký na vysvetlenie.');
    }

    const bytes = await storage.get(row.storage_key);
    const dataUrl = `data:${row.mime_type};base64,${Buffer.from(bytes).toString('base64')}`;
    const client = new OpenAI({ apiKey: config.openai.apiKey, timeout: config.openai.timeoutMs, maxRetries: 0 });
    let summary: z.infer<typeof summarySchema>;
    try {
      const response = await client.responses.parse({
        model: config.openai.model,
        store: config.openai.storeResponses,
        instructions:
          'Si asistent slovenskej účtovnej kancelárie. Prečítaj priložený dokument a vysvetli po slovensky, '
          + 'o čo ide. Vráť krátky nadpis a 3 až 7 vecných bodov (čo to je, koho sa týka, dôležité sumy, '
          + 'termíny a povinnosti). Nevymýšľaj si údaje, ktoré v dokumente nie sú.',
        input: [{
          role: 'user',
          content: [
            row.mime_type?.startsWith('image/')
              ? { type: 'input_image' as const, image_url: dataUrl, detail: 'high' as const }
              : { type: 'input_file' as const, filename: row.file_name, file_data: dataUrl },
            { type: 'input_text' as const, text: `Súbor: ${row.file_name}` },
          ],
        }],
        text: { format: zodTextFormat(summarySchema, 'zhrnutie_dokumentu') },
      });
      if (!response.output_parsed) throw new Error('empty_output');
      summary = summarySchema.parse(response.output_parsed);
    } catch (error) {
      request.log.error({ err: error }, 'document_summary_failed');
      throw new HttpError(502, 'ai_failed', 'Dokument sa nepodarilo vysvetliť. Skúste to znova.');
    }

    await database.query(
      'UPDATE organization_documents SET ai_summary=$1::jsonb, ai_summary_at=now() WHERE id=$2 AND tenant_id=$3',
      [JSON.stringify(summary), id, auth.tenantId],
    );
    await writeAudit(database, {
      tenantId: auth.tenantId, organizationId, actorType: 'user', actorId: auth.userId,
      action: 'organization_document.summarized', entityType: 'organization_document',
      entityId: id, correlationId: request.id,
    });
    return summary;
  });

  app.delete('/api/organizations/:organizationId/documents/:id', async (request, reply) => {
    const auth = await requireBrowserAuth(request, database);
    requireCsrf(request, auth);
    requireRole(auth, ['admin', 'uctovnik']);
    const { organizationId, id } = itemParams.parse(request.params);
    await requireOrganizationAccess(database, auth, organizationId);
    const deleted = await database.query(
      'DELETE FROM organization_documents WHERE id=$1 AND tenant_id=$2 AND organization_id=$3 RETURNING id',
      [id, auth.tenantId, organizationId],
    );
    if (deleted.rowCount === 0) throw new HttpError(404, 'document_not_found', 'Dokument neexistuje');
    await writeAudit(database, {
      tenantId: auth.tenantId,
      organizationId,
      actorType: 'user',
      actorId: auth.userId,
      action: 'organization_document.deleted',
      entityType: 'organization_document',
      entityId: id,
      correlationId: request.id,
    });
    return reply.code(204).send();
  });
}

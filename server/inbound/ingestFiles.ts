// Spoločný príjem súborov do pipeline — drag & drop aj SharePoint.
//
// Doklad nevzniká z e-mailu, ale z prílohy. Ručné nahratie to už roky rieši
// tak, že si založí SYNTETICKÝ e-mail (provider 'manual-upload') a ďalej ide
// tou istou cestou ako pošta. SharePoint je tretí zdroj a robí to isto — ale
// kopírovať kvôli tomu kontroly veľkosti, magic-byte a duplicity by znamenalo
// tri kópie, ktoré sa raz potichu rozídu. Preto sú tu, na jednom mieste.
import { randomUUID } from 'node:crypto';
import type { ServerConfig } from '../config.js';
import type { Queryable } from '../db/database.js';
import { sha256 } from '../security.js';
import type { ObjectStorage } from '../storage.js';
import { detectedMimeType, safeName } from './attachmentMime.js';
import { isTechnicalDuplicate } from './duplicateCheck.js';
import { classifyXml } from './xmlClassifier.js';

export type IngestStatus = 'queued' | 'quarantine' | 'duplicate';

export interface IngestFile {
  fileName: string;
  /** Čo tvrdí zdroj. Autorita je vždy magic-byte detekcia, toto je len záznam. */
  declaredMimeType: string;
  bytes: Buffer;
  /**
   * Odkiaľ súbor prišiel, ak sa tam má vrátiť. Drží sa na prílohe, lebo z
   * jedného PDF môže rozdelením vzniknúť viac dokladov.
   */
  sharePoint?: { driveId: string; itemId: string };
}

export interface IngestSource {
  /** Zapíše sa do inbound_emails.provider — 'manual-upload' | 'sharepoint'. */
  provider: string;
  /** Prefix cesty v object storage: 'upload' | 'sharepoint'. */
  storagePrefix: string;
  subject: string;
  senderEmail?: string;
  senderName?: string;
}

export interface IngestScope {
  tenantId: string;
  organizationId: string;
  correlationId: string;
}

export interface IngestFileResult {
  fileName: string;
  attachmentId: string;
  status: IngestStatus;
  reason?: string;
}

export interface IngestResult {
  emailId: string;
  queued: number;
  results: IngestFileResult[];
}

export async function ingestFiles(
  deps: { database: Queryable; storage: ObjectStorage; config: ServerConfig },
  scope: IngestScope,
  source: IngestSource,
  files: IngestFile[],
): Promise<IngestResult> {
  const { database, storage, config } = deps;
  const emailId = randomUUID();
  const maxAttempts = config.extractionProvider === 'openai' ? config.openai.maxRetries + 1 : 5;

  await database.query(
    `INSERT INTO inbound_emails
      (id, tenant_id, organization_id, alias_id, provider, provider_message_id, envelope_recipients,
       sender_email, sender_name, subject, received_at, status, attachment_count, correlation_id)
     VALUES ($1,$2,$3,NULL,$4,$5,'[]'::jsonb,$6,$7,$8,now(),'received',$9,$10)`,
    [emailId, scope.tenantId, scope.organizationId, source.provider, randomUUID(),
      source.senderEmail ?? null, source.senderName ?? null, source.subject, files.length, scope.correlationId],
  );

  const results: IngestFileResult[] = [];
  let queued = 0;
  for (const file of files) {
    const attachmentId = randomUUID();
    const bytes = file.bytes;
    // Magic-byte detekcia je autorita; deklarovaný MIME je len záznam.
    const actualMime = detectedMimeType(bytes);
    const hash = sha256(bytes);
    let status: IngestStatus = 'quarantine';
    let reason: string | undefined;
    let storageKey: string | undefined;

    if (bytes.byteLength === 0) reason = 'empty_file';
    if (!reason && bytes.byteLength > config.extractionMaxFileBytes) reason = 'attachment_too_large';
    if (!reason && !actualMime) reason = 'unsupported_or_corrupted_file';
    if (!reason && actualMime === 'application/xml' && classifyXml(bytes) === 'unknown_xml') reason = 'unsupported_xml';
    if (!reason) {
      const duplicate = await isTechnicalDuplicate(database, {
        tenantId: scope.tenantId, organizationId: scope.organizationId, sha256: hash,
      });
      if (duplicate) {
        status = 'duplicate';
        reason = 'technical_duplicate';
      } else {
        storageKey = `${source.storagePrefix}/${scope.tenantId}/${scope.organizationId}/${emailId}/${attachmentId}/${safeName(file.fileName)}`;
        await storage.put(storageKey, bytes, actualMime!);
        status = 'queued';
        queued += 1;
      }
    }

    await database.query(
      `INSERT INTO inbound_attachments
        (id, tenant_id, inbound_email_id, organization_id, original_file_name, safe_file_name,
         declared_mime_type, detected_mime_type, byte_size, sha256, storage_key, status, quarantine_reason,
         sharepoint_drive_id, sharepoint_item_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)`,
      [attachmentId, scope.tenantId, emailId, scope.organizationId, file.fileName, safeName(file.fileName),
        file.declaredMimeType, actualMime ?? null, bytes.byteLength, hash, storageKey ?? null, status, reason ?? null,
        file.sharePoint?.driveId ?? null, file.sharePoint?.itemId ?? null],
    );
    if (status === 'queued') {
      await database.query(
        `INSERT INTO processing_jobs
          (id, tenant_id, organization_id, attachment_id, kind, status, correlation_id, payload, max_attempts)
         VALUES ($1,$2,$3,$4,'extract_document','queued',$5,'{}'::jsonb,$6)`,
        [randomUUID(), scope.tenantId, scope.organizationId, attachmentId, scope.correlationId, maxAttempts],
      );
    }
    results.push({ fileName: file.fileName, attachmentId, status, reason });
  }

  await database.query(
    'UPDATE inbound_emails SET status=$1 WHERE id=$2',
    [queued > 0 ? 'queued' : 'quarantine', emailId],
  );
  return { emailId, queued, results };
}

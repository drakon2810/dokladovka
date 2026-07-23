import { randomUUID } from 'node:crypto';
import type { ServerConfig } from './config.js';
import type { Database, Queryable } from './db/database.js';
import { writeAudit } from './audit.js';
import {
  EXTRACTION_PROMPT_VERSION,
  EXTRACTION_SCHEMA_VERSION,
  SUPPORTED_EXTRACTION_MIME_TYPES,
  extractionResultSchema,
  type ExtractionInput,
  type ExtractionResult,
  type ServerDocumentExtractionProvider,
} from './extraction/contract.js';
import { MockServerDocumentExtractionProvider, type MockExtractionHints } from './extraction/mockProvider.js';
import { ExtractionProviderError, OpenAIDocumentExtractionProvider } from './extraction/openaiProvider.js';
import { PeppolDocumentExtractionProvider } from './extraction/peppolProvider.js';
import { SepaStatementExtractionProvider } from './extraction/sepaProvider.js';
import { classifyXml } from './inbound/xmlClassifier.js';
import { normalizeExtractionResult, validateExtractionResult } from './extraction/normalize.js';
import {
  maybeAiAccountingSuggestion,
  rebuildAccountingSuggestion,
  type AiSuggestionDocumentContext,
} from './services/accountingSuggestionService.js';
import { matchStatementPayments } from './services/paymentService.js';
import { upsertPartnerZDokladu } from './services/partnerService.js';
import type { ObjectStorage } from './storage.js';
import { PDFDocument } from 'pdf-lib';

interface JobRow extends Record<string, unknown> {
  id: string;
  tenant_id: string;
  organization_id: string;
  attachment_id: string;
  document_id?: string;
  correlation_id: string;
  kind: 'extract_document' | 'reprocess_document';
  attempts: number;
  max_attempts: number;
  payload: { mockExtraction?: MockExtractionHints };
}

interface AttachmentContext extends Record<string, unknown> {
  id: string;
  document_id?: string;
  inbound_email_id: string;
  detected_mime_type: string;
  byte_size: number;
  storage_key: string;
  original_file_name: string;
  email_provider: string;
  sender_email?: string;
  subject?: string;
  received_at: string | Date;
  organization_name: string;
  organization_ico: string;
  organization_dic?: string;
  organization_ic_dph?: string;
}

interface PreparedRun {
  documentId: string;
  runId: string;
  isReprocess: boolean;
  providerName: ServerDocumentExtractionProvider['name'];
}

export interface WorkerDependencies {
  storage?: ObjectStorage;
  provider?: ServerDocumentExtractionProvider;
}

async function claimJob(database: Database, workerId: string): Promise<JobRow | undefined> {
  return database.transaction(async (tx) => {
    const result = await tx.query<JobRow>(
      `SELECT id, tenant_id, organization_id, attachment_id, document_id, correlation_id, kind,
              attempts, max_attempts, payload
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

async function attachmentContext(database: Database, job: JobRow): Promise<AttachmentContext> {
  const result = await database.query<AttachmentContext>(
    `SELECT a.id, a.document_id, a.inbound_email_id, a.detected_mime_type, a.byte_size, a.storage_key,
            a.original_file_name, e.provider AS email_provider, e.sender_email, e.subject, e.received_at,
            o.name AS organization_name, o.ico AS organization_ico, o.dic AS organization_dic,
            o.ic_dph AS organization_ic_dph
       FROM inbound_attachments a
       JOIN inbound_emails e ON e.id=a.inbound_email_id
       JOIN organizations o ON o.id=a.organization_id AND o.tenant_id=a.tenant_id
      WHERE a.id=$1 AND a.tenant_id=$2 AND a.organization_id=$3`,
    [job.attachment_id, job.tenant_id, job.organization_id],
  );
  if (!result.rows[0]) throw new ExtractionProviderError('attachment_context_missing', 'Zdrojová príloha nie je dostupná', false);
  return result.rows[0];
}

async function prepareRun(
  database: Database,
  job: JobRow,
  context: AttachmentContext,
  providerName: ServerDocumentExtractionProvider['name'],
  model?: string,
): Promise<PreparedRun> {
  const documentId = job.document_id ?? context.document_id ?? randomUUID();
  const runId = randomUUID();
  const isReprocess = job.kind === 'reprocess_document';
  const isUpload = context.email_provider === 'manual-upload';
  const fallbackDate = new Date(context.received_at).toISOString().slice(0, 10);
  const source = {
    typ: isUpload ? 'upload' : 'email',
    inboundEmailId: context.inbound_email_id,
    attachmentId: context.id,
    mimeType: context.detected_mime_type,
    byteSize: Number(context.byte_size),
    povodnyNazovSuboru: context.original_file_name,
    odosielatel: context.sender_email,
    predmet: context.subject,
  };
  const emptyExtracted = {
    dodavatel: { nazov: '' },
    odberatel: { nazov: context.organization_name, ico: context.organization_ico },
    cisloFaktury: '',
    datumVystavenia: fallbackDate,
    mena: 'EUR',
    rozpisDph: [],
    sumaSpolu: 0,
    polozky: [],
  };
  await database.transaction(async (tx) => {
    await tx.query(
      `INSERT INTO documents
        (id,tenant_id,organization_id,queue_id,document_type,status,processing_status,source,extracted,
         accounting,field_confidence,confidence,total_amount,currency,history)
       VALUES ($1,$2,$3,
         (SELECT id FROM document_queues WHERE tenant_id=$2 AND organization_id=$3 AND active=true ORDER BY created_at LIMIT 1),
         'FP','novy','extracting',$4::jsonb,$5::jsonb,'{}'::jsonb,'{}'::jsonb,0,0,'EUR',$6::jsonb)
       ON CONFLICT (id) DO NOTHING`,
      [documentId, job.tenant_id, job.organization_id, JSON.stringify(source), JSON.stringify(emptyExtracted),
        JSON.stringify([{ ts: new Date().toISOString(), user: 'Systém',
          akcia: isUpload ? 'Doklad vytvorený z ručne nahratého súboru' : 'Doklad vytvorený z prijatého e-mailu' }])],
    );
    await tx.query(
      `UPDATE documents SET processing_status='extracting', updated_at=now()
        WHERE id=$1 AND tenant_id=$2 AND organization_id=$3`,
      [documentId, job.tenant_id, job.organization_id],
    );
    await tx.query(
      `UPDATE inbound_attachments SET status='processing', document_id=$1
        WHERE id=$2 AND tenant_id=$3 AND organization_id=$4`,
      [documentId, context.id, job.tenant_id, job.organization_id],
    );
    await tx.query(
      `UPDATE processing_jobs SET document_id=$1 WHERE id=$2 AND tenant_id=$3`,
      [documentId, job.id, job.tenant_id],
    );
    await tx.query(
      `INSERT INTO extraction_runs
        (id,tenant_id,organization_id,document_id,provider,model,prompt_version,schema_version,status,started_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'running',now())`,
      [runId, job.tenant_id, job.organization_id, documentId, providerName, model ?? null,
        EXTRACTION_PROMPT_VERSION, EXTRACTION_SCHEMA_VERSION],
    );
  });
  return { documentId, runId, isReprocess, providerName };
}

async function findDuplicate(
  database: Database,
  job: JobRow,
  documentId: string,
  result: ExtractionResult,
): Promise<string | undefined> {
  const invoiceNumber = result.invoiceNumber?.trim().toLocaleLowerCase('sk');
  const supplierIco = result.supplier.ico?.replace(/\D/g, '');
  const supplierName = result.supplier.nazov?.trim().toLocaleLowerCase('sk');
  if (!invoiceNumber || (!supplierIco && !supplierName)) return undefined;
  const candidates = await database.query<{ id: string; extracted: any } & Record<string, unknown>>(
    `SELECT id, extracted FROM documents
      WHERE tenant_id=$1 AND organization_id=$2 AND id<>$3
        AND status NOT IN ('zamietnuty') ORDER BY created_at DESC LIMIT 500`,
    [job.tenant_id, job.organization_id, documentId],
  );
  return candidates.rows.find((row) => {
    const extracted = row.extracted ?? {};
    const supplier = extracted.dodavatel ?? {};
    const sameSupplier = supplierIco
      ? String(supplier.ico ?? '').replace(/\D/g, '') === supplierIco
      : String(supplier.nazov ?? '').trim().toLocaleLowerCase('sk') === supplierName;
    return sameSupplier && String(extracted.cisloFaktury ?? '').trim().toLocaleLowerCase('sk') === invoiceNumber;
  })?.id;
}

/** Formát zdroja pre UI — odvodený z MIME a klasifikovaného typu dokladu. */
function sourceFormat(mimeType: string, documentType: string): string {
  if (mimeType === 'application/xml') return documentType === 'BV' ? 'sepa_xml' : 'peppol_xml';
  if (mimeType === 'application/pdf') return documentType === 'MZDY' ? 'mzdova_paska' : 'pdf';
  return documentType === 'PD' ? 'blocek_foto' : 'foto';
}

function asProviderError(error: unknown): ExtractionProviderError {
  if (error instanceof ExtractionProviderError) return error;
  return new ExtractionProviderError('invalid_extraction_result', 'Výsledok AI extrakcie nemá platný formát', false);
}

async function completeRun(
  database: Database,
  job: JobRow,
  context: AttachmentContext,
  prepared: PreparedRun,
  outcome: Awaited<ReturnType<ServerDocumentExtractionProvider['extract']>>,
  startedAt: number,
): Promise<(AiSuggestionDocumentContext & { status: string }) | undefined> {
  if (outcome.result.schemaVersion !== EXTRACTION_SCHEMA_VERSION) {
    throw new ExtractionProviderError('schema_version_mismatch', 'AI služba vrátila nepodporovanú verziu schémy', false);
  }
  const result = extractionResultSchema.parse(outcome.result);
  const fallbackDate = new Date(context.received_at).toISOString().slice(0, 10);
  const normalized = normalizeExtractionResult(result, prepared.documentId, fallbackDate);
  const issues = validateExtractionResult(result, normalized, {
    ico: context.organization_ico,
    dic: context.organization_dic,
    icDph: context.organization_ic_dph,
  });
  result.warnings.push(...issues.map((issue) => ({ code: issue.code, message: issue.message, severity: issue.severity })));
  const duplicateId = await findDuplicate(database, job, prepared.documentId, result);
  const buyerMismatch = issues.some((issue) => ['buyer_ico_mismatch', 'supplier_buyer_may_be_inverted'].includes(issue.code));
  const status = buyerMismatch ? 'karantena' : duplicateId ? 'duplicita' : 'na_kontrole';
  const latencyMs = Math.max(0, Math.round(performance.now() - startedAt));

  await database.transaction(async (tx) => {
    await tx.query(
      `UPDATE extraction_runs SET status='succeeded', result=$1::jsonb, model=$2, latency_ms=$3,
              usage=$4::jsonb, completed_at=now()
        WHERE id=$5 AND tenant_id=$6 AND organization_id=$7 AND document_id=$8`,
      [JSON.stringify(result), outcome.model ?? null, latencyMs, JSON.stringify({
        inputTokens: outcome.usage?.inputTokens,
        outputTokens: outcome.usage?.outputTokens,
        requestId: outcome.requestId,
      }), prepared.runId, job.tenant_id, job.organization_id, prepared.documentId],
    );
    if (prepared.isReprocess) {
      await tx.query(
        `UPDATE documents SET processing_status='ready_for_review',
                history=history || $1::jsonb, updated_at=now()
          WHERE id=$2 AND tenant_id=$3 AND organization_id=$4`,
        [JSON.stringify([{ ts: new Date().toISOString(), user: 'Systém', akcia: 'Nová extrakcia dokončená — čaká na ručné použitie' }]),
          prepared.documentId, job.tenant_id, job.organization_id],
      );
    } else {
      await tx.query(
        `UPDATE documents SET document_type=$1,status=$2,processing_status='ready_for_review',extracted=$3::jsonb,
                field_confidence=$4::jsonb,confidence=$5,total_amount=$6,currency=$7,
                quarantine_reason=$8,duplicate_of_document_id=$9,applied_extraction_run_id=$10,
                source=source || jsonb_build_object('format', $11::text),updated_at=now()
          WHERE id=$12 AND tenant_id=$13 AND organization_id=$14`,
        [normalized.documentType, status, JSON.stringify(normalized.extracted), JSON.stringify(normalized.fieldConfidence),
          normalized.confidence, normalized.totalAmount, normalized.currency,
          buyerMismatch ? 'buyer_ico_mismatch' : null, duplicateId ?? null, prepared.runId,
          sourceFormat(context.detected_mime_type, normalized.documentType),
          prepared.documentId, job.tenant_id, job.organization_id],
      );
      // Partner sa založí/doplní z dodávateľa ešte pred návrhom zaúčtovania,
      // aby predvoľby partnera platili už pre tento doklad.
      if (status !== 'karantena' && !['BV', 'MZDY'].includes(normalized.documentType)) {
        await upsertPartnerZDokladu(tx, {
          tenantId: job.tenant_id,
          organizationId: job.organization_id,
          dodavatel: {
            nazov: result.supplier.nazov,
            ico: result.supplier.ico,
            dic: result.supplier.dic,
            icDph: result.supplier.icDph,
            iban: result.supplier.iban,
            adresa: result.supplier.adresa,
          },
        });
      }
      await rebuildAccountingSuggestion(tx, {
        tenantId: job.tenant_id,
        organizationId: job.organization_id,
        documentId: prepared.documentId,
        supplierIco: result.supplier.ico,
        supplierName: result.supplier.nazov,
        supplierIcDph: result.supplier.icDph,
        supplierIban: result.supplier.iban,
      });
    }
    await tx.query(
      `UPDATE inbound_attachments SET status='document_created',document_id=$1,quarantine_reason=NULL
        WHERE id=$2 AND tenant_id=$3 AND organization_id=$4`,
      [prepared.documentId, job.attachment_id, job.tenant_id, job.organization_id],
    );
    await tx.query(
      `UPDATE processing_jobs SET status='succeeded',document_id=$1,locked_at=NULL,locked_by=NULL,
              error_code=NULL,error_message=NULL,updated_at=now()
        WHERE id=$2 AND tenant_id=$3`,
      [prepared.documentId, job.id, job.tenant_id],
    );
    await tx.query(
      `UPDATE inbound_emails SET status='processed'
        WHERE id=$1 AND NOT EXISTS (
          SELECT 1 FROM inbound_attachments WHERE inbound_email_id=$1 AND status IN ('queued','processing','received','stored')
        )`,
      [context.inbound_email_id],
    );
    await writeAudit(tx, {
      tenantId: job.tenant_id,
      organizationId: job.organization_id,
      actorType: 'system',
      action: prepared.isReprocess ? 'document.reprocessed' : 'document.extracted',
      entityType: 'document',
      entityId: prepared.documentId,
      correlationId: job.correlation_id,
      metadata: { provider: prepared.providerName, extractionRunId: prepared.runId, warningCount: result.warnings.length },
    });
  });
  if (prepared.isReprocess) return undefined;
  return {
    status,
    documentType: normalized.documentType,
    supplierName: result.supplier.nazov,
    supplierIco: result.supplier.ico,
    totalAmount: normalized.totalAmount,
    currency: normalized.currency,
    lineDescriptions: result.lineItems
      .map((item) => item.description ?? '')
      .filter(Boolean),
  };
}

/**
 * Backoff pred ďalším pokusom. Prechodné chyby (rate limit, timeout, 5xx)
 * potrebujú desiatky sekúnd, kým sa API zotaví; pôvodné 2^attempts (2s, 4s)
 * minulo všetky pokusy za pár sekúnd a z dočasného výpadku spravilo trvalú
 * chybu. Rastúci backoff (20/40/80/160/320s, strop 600s) + jitter dá API čas
 * a rozhodí dávku opakovaní, aby znova nenarazila na ten istý rate limit.
 */
export function retryDelaySeconds(attempts: number, rand: number = Math.random()): number {
  const base = Math.min(600, 20 * 2 ** (attempts - 1));
  return Math.round(base * (0.5 + rand * 0.5));
}

/**
 * Má vstup aspoň základnú štruktúru PDF (ukazovateľ na xref v závere súboru)?
 * pdf-lib odmietne aj množstvo platných PDF (šifrovanie vlastníckym heslom,
 * nezvyčajné objekty) — tie ale OpenAI prečíta, tak ich nezhadzujeme. Za
 * poškodené považujeme len dáta bez `startxref`, kde nemá zmysel volať OpenAI.
 */
export function looksLikePdfStructure(bytes: Uint8Array): boolean {
  return /startxref/.test(Buffer.from(bytes.slice(-2048)).toString('latin1'));
}

async function failJob(
  tx: Queryable,
  job: JobRow,
  prepared: PreparedRun | undefined,
  error: ExtractionProviderError,
  latencyMs: number,
): Promise<void> {
  const exhausted = job.attempts >= job.max_attempts;
  const retry = error.retryable && !exhausted;
  const jobStatus = retry ? 'queued' : exhausted && error.retryable ? 'dead_letter' : 'failed';
  const delaySeconds = retryDelaySeconds(job.attempts);
  await tx.query(
    `UPDATE processing_jobs SET status=$1, available_at=now() + ($2 * interval '1 second'),
            locked_at=NULL,locked_by=NULL,error_code=$3,error_message=$4,updated_at=now()
      WHERE id=$5 AND tenant_id=$6`,
    [jobStatus, delaySeconds, error.code, error.safeMessage.slice(0, 500), job.id, job.tenant_id],
  );
  await tx.query(
    `UPDATE inbound_attachments SET status=$1,quarantine_reason=$2
      WHERE id=$3 AND tenant_id=$4 AND organization_id=$5`,
    [retry ? 'queued' : 'failed', error.code, job.attachment_id, job.tenant_id, job.organization_id],
  );
  if (prepared) {
    await tx.query(
      `UPDATE extraction_runs SET status='failed',error_code=$1,error_message=$2,latency_ms=$3,completed_at=now()
        WHERE id=$4 AND tenant_id=$5 AND organization_id=$6`,
      [error.code, error.safeMessage.slice(0, 500), latencyMs, prepared.runId, job.tenant_id, job.organization_id],
    );
    await tx.query(
      `UPDATE documents SET processing_status=$1,status=CASE WHEN $2::boolean THEN status ELSE 'chyba' END,updated_at=now()
        WHERE id=$3 AND tenant_id=$4 AND organization_id=$5`,
      [retry ? 'failed_retryable' : 'failed_permanent', prepared.isReprocess,
        prepared.documentId, job.tenant_id, job.organization_id],
    );
  }
}

export async function processNextJob(
  database: Database,
  config: ServerConfig,
  workerId = `worker-${process.pid}`,
  dependencies: WorkerDependencies = {},
): Promise<boolean> {
  const job = await claimJob(database, workerId);
  if (!job) return false;
  const jobStartedAt = performance.now();
  let prepared: PreparedRun | undefined;
  try {
    const context = await attachmentContext(database, job);
    if (!(SUPPORTED_EXTRACTION_MIME_TYPES as readonly string[]).includes(context.detected_mime_type)) {
      throw new ExtractionProviderError('unsupported_file_type', 'Typ súboru nie je podporovaný', false);
    }
    if (Number(context.byte_size) > config.extractionMaxFileBytes) {
      throw new ExtractionProviderError('file_too_large', 'Súbor prekračuje povolenú veľkosť', false);
    }
    // XML sa rozlišuje podľa obsahu (PEPPOL faktúra vs. SEPA výpis) — bajty
    // treba načítať ešte pred výberom providera.
    let bytes = new Uint8Array();
    let provider: ServerDocumentExtractionProvider;
    if (dependencies.provider) {
      provider = dependencies.provider;
    } else if (context.detected_mime_type === 'application/xml') {
      if (!dependencies.storage) throw new ExtractionProviderError('object_storage_missing', 'Úložisko dokumentov nie je dostupné', true);
      bytes = await dependencies.storage.get(context.storage_key);
      provider = classifyXml(bytes) === 'sepa_camt053'
        ? new SepaStatementExtractionProvider()
        : new PeppolDocumentExtractionProvider();
    } else if (config.extractionProvider === 'openai') {
      provider = new OpenAIDocumentExtractionProvider(config.openai);
    } else {
      provider = new MockServerDocumentExtractionProvider(job.payload?.mockExtraction ?? {});
    }
    const model = provider.name === 'openai'
      ? config.openai.model
      : provider.name === 'peppol' ? 'peppol-bis-3.0'
        : provider.name === 'sepa' ? 'camt.053' : undefined;
    prepared = await prepareRun(database, job, context, provider.name, model);
    if (provider.name !== 'mock' && bytes.length === 0) {
      if (!dependencies.storage) throw new ExtractionProviderError('object_storage_missing', 'Úložisko dokumentov nie je dostupné', true);
      bytes = await dependencies.storage.get(context.storage_key);
      if (context.detected_mime_type === 'application/pdf') {
        try {
          const pdf = await PDFDocument.load(bytes, { ignoreEncryption: true, updateMetadata: false });
          if (pdf.getPageCount() > config.extractionMaxPdfPages) {
            throw new ExtractionProviderError('pdf_too_many_pages', 'PDF prekračuje povolený počet strán', false);
          }
        } catch (error) {
          if (error instanceof ExtractionProviderError) throw error;
          // pdf-lib nezvládne časť platných PDF — kontrolu počtu strán preto len
          // preskočíme (limit napokon vynúti aj OpenAI) a doklad pošleme na
          // extrakciu. Odmietneme iba dáta bez štruktúry PDF ako poškodené.
          if (!looksLikePdfStructure(bytes)) {
            throw new ExtractionProviderError('corrupted_file', 'PDF súbor je poškodený alebo nečitateľný', false);
          }
        }
      }
    }
    const startedAt = performance.now();
    const outcome = await provider.extract({
      documentId: prepared.documentId,
      mimeType: context.detected_mime_type as ExtractionInput['mimeType'],
      fileName: context.original_file_name,
      bytes,
      organizationContext: {
        nazov: context.organization_name,
        ico: context.organization_ico,
        dic: context.organization_dic,
        icDph: context.organization_ic_dph,
      },
      promptVersion: EXTRACTION_PROMPT_VERSION,
      schemaVersion: EXTRACTION_SCHEMA_VERSION,
    });
    const summary = await completeRun(database, job, context, prepared, outcome, startedAt);
    // Bankový výpis: automatické párovanie odchádzajúcich transakcií na otvorené
    // faktúry podľa VS + sumy. Zlyhanie párovania nesmie zhodiť spracovanie.
    if (summary && summary.documentType === 'BV') {
      try {
        await matchStatementPayments(database, {
          tenantId: job.tenant_id,
          organizationId: job.organization_id,
          statementDocumentId: prepared.documentId,
        });
      } catch {
        // Párovanie je best-effort; výpis je už uložený.
      }
    }
    // AI návrh zaúčtovania z POHODA číselníkov — len keď deterministické zdroje
    // nič nenašli; zlyhanie návrhu nesmie zhodiť spracovanie dokladu.
    if (summary && summary.status !== 'karantena' && summary.documentType !== 'BV') {
      try {
        await maybeAiAccountingSuggestion(database, config, {
          tenantId: job.tenant_id,
          organizationId: job.organization_id,
          documentId: prepared.documentId,
          supplierIco: summary.supplierIco,
          supplierName: summary.supplierName,
        }, summary);
      } catch {
        // Návrh je voliteľný — chyba AI sa ignoruje, doklad je už uložený.
      }
    }
    return true;
  } catch (error) {
    await database.transaction((tx) => failJob(
      tx, job, prepared, asProviderError(error), Math.max(0, Math.round(performance.now() - jobStartedAt)),
    ));
    return true;
  }
}

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
import { OpenAIDocumentClassifier, type Klasifikacia } from './extraction/classifyProvider.js';
import { posudADulozDph } from './services/dphAuditService.js';
import { PeppolDocumentExtractionProvider } from './extraction/peppolProvider.js';
import { SepaStatementExtractionProvider } from './extraction/sepaProvider.js';
import { classifyXml } from './inbound/xmlClassifier.js';
import { nacitajCiselnikIndex, polozkySKodmi, zauctovanieZKodov } from "./extraction/codeResolution.js";
import { normalizeExtractionResult, validateExtractionResult } from './extraction/normalize.js';
import {
  maybeAiAccountingSuggestion,
  rebuildAccountingSuggestion,
  type AiSuggestionDocumentContext,
} from './services/accountingSuggestionService.js';
import { suggestBankMovementAccounting } from './services/bankSuggestionService.js';
import { nacitajPokyny, pokynyPreModel } from './services/aiInstructionsService.js';
import { matchStatementPayments } from './services/paymentService.js';
import { upsertPartnerZDokladu } from './services/partnerService.js';
import { opravSkDanoveCisla } from './services/skTaxIdsService.js';
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

async function claimJob(
  database: Database,
  workerId: string,
  staleRunningSeconds: number,
): Promise<JobRow | undefined> {
  return database.transaction(async (tx) => {
    const result = await tx.query<JobRow>(
      `SELECT id, tenant_id, organization_id, attachment_id, document_id, correlation_id, kind,
              attempts, max_attempts, payload
         FROM processing_jobs
        WHERE (status='queued' AND available_at <= now())
           -- Zaseknutý beh: worker padol alebo ho niekto reštartoval uprostred
           -- extrakcie. Bez tejto vetvy ostane job navždy 'running' a doklad
           -- navždy v stave „spracúva sa" — nikto ho už nikdy nevyzdvihne.
           OR (status='running' AND locked_at < now() - make_interval(secs => $1))
        ORDER BY created_at
        FOR UPDATE SKIP LOCKED
        LIMIT 1`,
      [staleRunningSeconds],
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

/**
 * Účet POHODY pre bankový výpis: IBAN výpisu sa spáruje s číselníkom bankových
 * účtov (kind=bankoveUcty). Bez zhody a pri jedinom aktívnom účte firmy sa
 * použije ten — samostatný účet je zďaleka najčastejší prípad. Inak rozhodne
 * účtovník ručne v editore.
 */
async function najdiBankovyUcet(
  database: Database,
  tenantId: string,
  organizationId: string,
  iban: string | undefined,
): Promise<string | undefined> {
  const ucty = await database.query<{ code: string; iban: string | null } & Record<string, unknown>>(
    `SELECT code, iban FROM code_list_items
      WHERE tenant_id=$1 AND organization_id=$2 AND kind='bankoveUcty' AND active=true`,
    [tenantId, organizationId],
  );
  const hladany = iban?.replace(/\s/g, '').toUpperCase();
  if (hladany) {
    const zhoda = ucty.rows.find((row) => row.iban?.replace(/\s/g, '').toUpperCase() === hladany);
    if (zhoda) return zhoda.code;
    // IBAN výpisu poznáme a jediný účet firmy má INÝ IBAN — nepredvyplňovať:
    // výpis patrí účtu, ktorý v číselníku ešte nie je, a tichá zámena by
    // zaúčtovala pohyby na cudzí účet. Bez IBAN-u na strane číselníka sa
    // jediný účet použije (nie je ho čím vyvrátiť).
    if (ucty.rows.length === 1 && !ucty.rows[0].iban) return ucty.rows[0].code;
    return undefined;
  }
  return ucty.rows.length === 1 ? ucty.rows[0].code : undefined;
}

/** Formát zdroja pre UI — odvodený z MIME a klasifikovaného typu dokladu. */
function sourceFormat(mimeType: string, documentType: string): string {
  if (mimeType === 'application/xml') return documentType === 'BV' ? 'sepa_xml' : 'peppol_xml';
  if (mimeType === 'application/pdf') return documentType === 'MZDY' ? 'mzdova_paska' : 'pdf';
  return documentType === 'PD' ? 'blocek_foto' : 'foto';
}

/**
 * Vonkajší catch drží celé spracovanie — extrakciu, normalizáciu aj zápisy do
 * databázy. Čokoľvek v ňom zlyhá, účtovník doteraz uvidel „Výsledok AI
 * extrakcie nemá platný formát" a šiel hľadať chybu do dokladu, hoci padnúť
 * mohol zápis. Skutočnú príčinu sme pritom nikde nemali: do logu sa nedostala
 * a v extraction_runs zostala len tá zavádzajúca veta.
 *
 * Chyba, ktorá nie je od extrakčného providera, si preto nesie vlastnú správu
 * ďalej a zároveň sa zaloguje aj so stackom.
 */
function asProviderError(error: unknown, documentId?: string): ExtractionProviderError {
  if (error instanceof ExtractionProviderError) return error;
  console.error('[worker] spracovanie zlyhalo mimo extrakcie', { documentId, error });
  const dovod = error instanceof Error ? error.message : String(error);
  // Retryable zámerne: neznáma chyba je častejšie výpadok než chyba dokladu.
  // Doklad „kontrakt 2406" padol o 11:05 a o 11:09 ten istý súbor prešiel —
  // opakovanie by ho vyliečilo samo, lenže job umrel na prvom pokuse zo
  // šiestich. Ak je chyba naozaj trvalá, pokusy sa vyčerpajú a job skončí
  // v dead_letter, kde je stále vidieť.
  return new ExtractionProviderError('processing_failed', `Spracovanie zlyhalo: ${dovod}`.slice(0, 400), true);
}

/**
 * Súbor, ktorý nie je účtovný doklad (rozhodnutie z daňového úradu, zmluva,
 * potvrdenie…). Neúčtuje sa: uloží sa medzi firemné dokumenty („Iné doklady")
 * a rozpracovaný doklad sa zmaže, aby nikomu nevisel v zozname na kontrolu.
 * Bajty ostávajú v tom istom objekte v úložisku — nekopírujú sa.
 */
async function storeAsOrganizationDocument(
  database: Database,
  job: JobRow,
  context: AttachmentContext,
  prepared: PreparedRun,
  result: ExtractionResult,
  outcome: Awaited<ReturnType<ServerDocumentExtractionProvider['extract']>>,
  latencyMs: number,
): Promise<void> {
  const attachment = await database.query<{ sha256: string } & Record<string, unknown>>(
    'SELECT sha256 FROM inbound_attachments WHERE id=$1', [context.id],
  );
  await database.transaction(async (tx) => {
    await tx.query(
      `UPDATE extraction_runs SET status='succeeded', result=$1::jsonb, model=$2, latency_ms=$3,
              document_id=NULL, completed_at=now()
        WHERE id=$4 AND tenant_id=$5`,
      [JSON.stringify(result), outcome.model ?? null, latencyMs, prepared.runId, job.tenant_id],
    );
    await tx.query(
      `INSERT INTO organization_documents
        (id, tenant_id, organization_id, file_name, mime_type, byte_size, sha256, storage_key, note)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
      [randomUUID(), job.tenant_id, job.organization_id, context.original_file_name,
        context.detected_mime_type, context.byte_size, attachment.rows[0]?.sha256 ?? '',
        context.storage_key, context.subject ?? null],
    );
    await tx.query(
      `UPDATE inbound_attachments SET status='document_created', document_id=NULL, quarantine_reason=NULL
        WHERE id=$1 AND tenant_id=$2`,
      [context.id, job.tenant_id],
    );
    await tx.query(
      `UPDATE processing_jobs SET status='succeeded', document_id=NULL, locked_at=NULL, locked_by=NULL,
              error_code=NULL, error_message=NULL, updated_at=now()
        WHERE id=$1 AND tenant_id=$2`,
      [job.id, job.tenant_id],
    );
    // Placeholder dokladu vznikol pred klasifikáciou — teraz už netreba.
    await tx.query(
      'DELETE FROM documents WHERE id=$1 AND tenant_id=$2 AND organization_id=$3',
      [prepared.documentId, job.tenant_id, job.organization_id],
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
      action: 'organization_document.classified',
      entityType: 'organization_document',
      correlationId: job.correlation_id,
      metadata: { fileName: context.original_file_name, provider: prepared.providerName },
    });
  });
}

/** Dátum vystavenia z normalizovaného dokladu — určuje mesačný číselný rad. */
function datumZExtrakcie(extracted: unknown): string | undefined {
  const datum = (extracted as { datumVystavenia?: unknown } | undefined)?.datumVystavenia;
  return typeof datum === 'string' ? datum : undefined;
}

/**
 * Číslo, s ktorým doklad vznikne v POHODE. Vydaná faktúra si nesie vlastné
 * číslo z fakturačného systému a v POHODE má mať to isté — inak by jej POHODA
 * pridelila číslo zo svojho počítadla radu a účtovné číslo by sa rozišlo s
 * číslom na faktúre. Ostatné agendy čísluje POHODA sama.
 */
export function cisloVPohodeZDokladu(documentType: string, extracted: unknown): string | undefined {
  if (documentType !== 'FV') return undefined;
  const cislo = String((extracted as { cisloFaktury?: unknown } | undefined)?.cisloFaktury ?? '').trim();
  return cislo ? cislo.slice(0, 32) : undefined;
}

async function completeRun(
  database: Database,
  job: JobRow,
  context: AttachmentContext,
  prepared: PreparedRun,
  outcome: Awaited<ReturnType<ServerDocumentExtractionProvider['extract']>>,
  startedAt: number,
  config: ServerConfig,
): Promise<(AiSuggestionDocumentContext & {
  status: string;
  /** Doklady, ktoré vznikli rozdelením súboru — AI ich analyzuje rovnako. */
  dalsie: Array<AiSuggestionDocumentContext & { documentId: string }>;
}) | undefined> {
  if (outcome.result.schemaVersion !== EXTRACTION_SCHEMA_VERSION) {
    throw new ExtractionProviderError('schema_version_mismatch', 'AI služba vrátila nepodporovanú verziu schémy', false);
  }
  const result = extractionResultSchema.parse(outcome.result);
  // Nie je to účtovný doklad → skončí medzi „Iné doklady", nie v zozname na
  // kontrolu. Pri opakovanej extrakcii existujúceho dokladu to neplatí —
  // tam si o osude dokladu rozhoduje používateľ.
  if (!prepared.isReprocess && result.documentType === 'INY') {
    await storeAsOrganizationDocument(
      database, job, context, prepared, result, outcome,
      Math.max(0, Math.round(performance.now() - startedAt)),
    );
    return undefined;
  }
  const fallbackDate = new Date(context.received_at).toISOString().slice(0, 10);
  const normalized = normalizeExtractionResult(result, prepared.documentId, fallbackDate);
  // Daňové čísla slovenského dodávateľa proti registru Finančnej správy. Model
  // ich číta z fotky bločka a jedna prehliadnutá číslica spraví z IČ DPH
  // neplatné číslo, ktoré blokuje schválenie — a keby prešlo, išlo by tak do
  // kontrolného výkazu. Beží pred validáciou, aby opravený doklad už nemal
  // varovanie, a je best-effort: výpadok registra doklad nezhodí.
  try {
    const dodavatel = (normalized.extracted as { dodavatel?: Record<string, unknown> }).dodavatel ?? {};
    const opravene = await opravSkDanoveCisla(config.fsOpenDataApiKey, dodavatel);
    if (opravene) {
      Object.assign(dodavatel, opravene);
      // Aj do výsledku extrakcie: z neho vzniká karta partnera a kľúč duplicity.
      Object.assign(result.supplier, opravene);
    }
  } catch (cause) {
    console.warn('[sk-dane] register Finančnej správy nedostupný:', cause instanceof Error ? cause.message : cause);
  }
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
  // Kódy predkontácií, členení a číselného radu, ktoré model opísal z pravidla,
  // sa prekladajú na id číselníka firmy. Čo sa nespáruje, ostáva prázdne —
  // doplní to účtovník, nikdy sa nehádže na najbližší kód.
  const ciselnikIndex = prepared.isReprocess
    ? undefined
    : await nacitajCiselnikIndex(database, job.tenant_id, job.organization_id);
  // Ďalšie doklady z toho istého súboru sa normalizujú tou istou cestou ako
  // hlavný — hlavičku (dodávateľ, mena, číslo dokladu) dedia, vlastné majú
  // len to, čím sa líšia. Pri opakovanej extrakcii sa nezakladajú: tam si
  // o osude dokladu rozhoduje účtovník ručným použitím behu.
  const dalsieDoklady = prepared.isReprocess ? [] : (result.additionalDocuments ?? []).map((dalsi) => {
    const id = randomUUID();
    return {
      id,
      zdroj: dalsi,
      normalized: normalizeExtractionResult({
        ...result,
        documentType: dalsi.documentType,
        documentSummary: dalsi.documentSummary ?? result.documentSummary,
        variableSymbol: dalsi.variableSymbol,
        issueDate: dalsi.issueDate ?? result.issueDate,
        taxDate: dalsi.taxDate ?? result.taxDate,
        totalAmount: dalsi.totalAmount,
        lineItems: dalsi.lineItems,
        vatBreakdown: dalsi.vatBreakdown,
        additionalDocuments: [],
        warnings: [],
      }, id, fallbackDate),
    };
  });

  // Bankový výpis: účet POHODY sa určí deterministicky podľa IBAN-u výpisu
  // proti číselníku bankových účtov; pri jedinom aktívnom účte firmy sa použije ten.
  const bankUcetKod = !prepared.isReprocess && normalized.documentType === 'BV'
    ? await najdiBankovyUcet(database, job.tenant_id, job.organization_id, result.supplier.iban)
    : undefined;
  // Vydaná faktúra ide do POHODY s vlastným číslom z dokladu; účtovník ho môže
  // v páse prepísať alebo zmazať (potom číslo pridelí POHODA).
  const cisloVPohode = prepared.isReprocess
    ? undefined
    : cisloVPohodeZDokladu(normalized.documentType, normalized.extracted);

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
                accounting=accounting || $15::jsonb,
                field_confidence=$4::jsonb,confidence=$5,total_amount=$6,currency=$7,
                quarantine_reason=$8,duplicate_of_document_id=$9,applied_extraction_run_id=$10,
                source=source || jsonb_build_object('format', $11::text),updated_at=now()
          WHERE id=$12 AND tenant_id=$13 AND organization_id=$14`,
        [normalized.documentType, status,
          JSON.stringify(ciselnikIndex ? polozkySKodmi(ciselnikIndex, normalized.extracted, result.lineItems) : normalized.extracted),
          JSON.stringify(normalized.fieldConfidence),
          normalized.confidence, normalized.totalAmount, normalized.currency,
          buyerMismatch ? 'buyer_ico_mismatch' : null, duplicateId ?? null, prepared.runId,
          sourceFormat(context.detected_mime_type, normalized.documentType),
          prepared.documentId, job.tenant_id, job.organization_id,
          JSON.stringify({
            ...(ciselnikIndex ? zauctovanieZKodov(ciselnikIndex, result) : {}),
            ...(bankUcetKod ? { bankUcetKod } : {}),
            ...(cisloVPohode ? { cisloVPohode } : {}),
          })],
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
      // Jeden súbor, viac účtovných zápisov: rekapitulácia miezd dá samostatný
      // interný doklad na mzdy, ďalší na tvorbu sociálneho fondu a ďalší na
      // zúčtovanie zálohy. AI ich vráti len vtedy, keď to pravidlo firmy žiada.
      // Väzba je tá istá ako pri ručnom rozdelení, takže časti dedia sken aj
      // odkaz „zobraziť pôvodný doklad".
      for (const dalsi of dalsieDoklady) {
        await tx.query(
          `INSERT INTO documents
            (id,tenant_id,organization_id,queue_id,document_type,status,processing_status,source,extracted,
             accounting,field_confidence,confidence,total_amount,currency,history,split_from_document_id)
           SELECT $1,tenant_id,organization_id,queue_id,$2,$3,'ready_for_review',source,$4::jsonb,
             accounting || $10::jsonb,field_confidence,confidence,$5,$6,$7::jsonb,$8
             FROM documents WHERE id=$8 AND tenant_id=$9`,
          [dalsi.id, dalsi.normalized.documentType, status,
            JSON.stringify(ciselnikIndex
              ? polozkySKodmi(ciselnikIndex, dalsi.normalized.extracted, dalsi.zdroj.lineItems)
              : dalsi.normalized.extracted),
            dalsi.normalized.totalAmount, dalsi.normalized.currency,
            JSON.stringify([{ ts: new Date().toISOString(), user: 'Systém', akcia: 'Doklad vznikol rozdelením prijatého súboru podľa pravidla' }]),
            prepared.documentId, job.tenant_id,
            JSON.stringify(ciselnikIndex ? zauctovanieZKodov(ciselnikIndex, dalsi.zdroj) : {})],
        );
        await rebuildAccountingSuggestion(tx, {
          tenantId: job.tenant_id,
          organizationId: job.organization_id,
          documentId: dalsi.id,
          supplierIco: result.supplier.ico,
          supplierName: result.supplier.nazov,
          supplierIcDph: result.supplier.icDph,
          supplierIban: result.supplier.iban,
        });
      }
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
  // Právna kontrola členenia DPH — druhá mienka k tomu, čo navrhla pamäť.
  // Beží AŽ ZA transakciou: dopyt do AI trvá sekundy a držať kvôli nemu
  // otvorenú transakciu by blokovalo zápis ostatných dokladov. Zlyhanie
  // nesmie zhodiť doklad, ktorý je už uložený — verdikt je poradca.
  try {
    const navrh = await database.query<{ kod?: string; kv?: string } & Record<string, unknown>>(
      `SELECT c.code AS kod, s.clenenie_kv_kod AS kv
         FROM accounting_suggestions s
         LEFT JOIN code_list_items c ON c.id=s.clenenie_dph_id
        WHERE s.document_id=$1 AND s.tenant_id=$2`,
      [prepared.documentId, job.tenant_id],
    );
    await posudADulozDph(database, config, {
      tenantId: job.tenant_id,
      organizationId: job.organization_id,
      documentId: prepared.documentId,
      documentType: normalized.documentType,
      extracted: normalized.extracted as Record<string, unknown>,
      navrhnuteClenenieKod: navrh.rows[0]?.kod ?? undefined,
      navrhnutaKvSekcia: navrh.rows[0]?.kv ?? undefined,
    });
  } catch (error) {
    console.warn('[dph-audit] kontrola zlyhala', error);
  }
  if (prepared.isReprocess) return undefined;
  // Strany dokladu sú spoločné pre celý súbor aj pre doklady, ktoré z neho
  // vznikli rozdelením — líšia sa len typom, sumou a položkami.
  const strana = (kluc: 'dodavatel' | 'odberatel') =>
    (normalized.extracted as Record<string, { krajina?: string } | undefined>)[kluc];
  const strany = {
    supplierName: result.supplier.nazov,
    supplierIco: result.supplier.ico,
    supplierIcDph: result.supplier.icDph,
    // Krajina dodávateľa rozhoduje, ČIA daň je na doklade: rakúskych 20 % nie
    // je slovenská DPH a do slovenského priznania nikdy nevstúpi. Bez nej model
    // z nenulovej sadzby usudzoval tuzemské zdaniteľné plnenie.
    supplierKrajina: strana('dodavatel')?.krajina,
    // Odberateľ rozhoduje o DPH a sekcii KV vydanej faktúry (súkromná osoba
    // bez identifikátorov vs. podnikateľ) — model ho musí vidieť.
    odberatel: {
      nazov: result.buyer.nazov ?? undefined,
      ico: result.buyer.ico ?? undefined,
      dic: result.buyer.dic ?? undefined,
      icDph: result.buyer.icDph ?? undefined,
      krajina: strana('odberatel')?.krajina,
    },
  };
  // Sadzba DPH na položkách je pre model dôkaz o daňovom režime dokladu.
  const polozkyPreModel = (items: typeof result.lineItems) => items.slice(0, 15).map((item) => ({
    popis: item.description ?? undefined,
    sadzbaDph: item.vatRate == null ? undefined : Number(item.vatRate),
    suma: item.amountTotal == null ? undefined : Number(item.amountTotal),
  }));
  const popisy = (items: typeof result.lineItems) => items.map((item) => item.description ?? '').filter(Boolean);
  return {
    status,
    ...strany,
    documentType: normalized.documentType,
    // Dátum vystavenia: firma môže mať mesačné číselné rady.
    datumVystavenia: datumZExtrakcie(normalized.extracted),
    totalAmount: normalized.totalAmount,
    currency: normalized.currency,
    lineDescriptions: popisy(result.lineItems),
    polozky: polozkyPreModel(result.lineItems),
    dalsie: dalsieDoklady.map((dalsi) => ({
      documentId: dalsi.id,
      ...strany,
      documentType: dalsi.normalized.documentType,
      datumVystavenia: datumZExtrakcie(dalsi.normalized.extracted),
      totalAmount: dalsi.normalized.totalAmount,
      currency: dalsi.normalized.currency,
      // Doklad z rozdelenia býva jediná suma bez položiek (tvorba sociálneho
      // fondu, zúčtovanie zálohy) — jediný text, ktorý ho odlíši, je jeho
      // popis. Bez neho by model rozhodoval len podľa typu a sumy a nenašiel
      // by ani kategóriu, ani riadok denníka.
      lineDescriptions: [dalsi.zdroj.documentSummary, ...popisy(dalsi.zdroj.lineItems)]
        .filter((text): text is string => Boolean(text)),
      // Prázdne pole by v prompte zatienilo fallback na popisy — radšej nič.
      polozky: dalsi.zdroj.lineItems.length > 0 ? polozkyPreModel(dalsi.zdroj.lineItems) : undefined,
    })),
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
  // Zaseknutý job preberáme až po tom, čo už nemôže bežať: extrakcia je zhora
  // ohraničená timeoutom volania AI, takže dvojnásobok (minimálne 10 minút) je
  // bezpečný odstup — nehrozí, že by dvaja workeri robili to isté naraz.
  const staleRunningSeconds = Math.max(600, Math.ceil(config.openai.timeoutMs / 1000) * 2);
  const job = await claimJob(database, workerId, staleRunningSeconds);
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
    // Textové pravidlá pre čítanie dokladu (globálne + firemné). Typ dokladu
    // ešte nepoznáme, takže sa neposiela filtrovaný výber — podmienku („platí
    // pre MZDY") si model prečíta priamo v texte pravidla.
    const pokyny = pokynyPreModel(await nacitajPokyny(database, {
      tenantId: job.tenant_id,
      organizationId: job.organization_id,
      faza: 'extraction',
    }));
    // Samostatný krok klasifikácie. V extrakčnom prompte je documentType len
    // jedno pole z tridsiatich a zmluva s cenou skončila ako prijatá faktúra;
    // jedna otázka na jeden dopyt to rozhoduje spoľahlivejšie. Zlyhanie kroku
    // nesmie zhodiť spracovanie — extrakcia určí typ sama ako doteraz.
    let klasifikacia: Klasifikacia | undefined;
    if (provider.name === 'openai' && !dependencies.provider) {
      try {
        klasifikacia = await new OpenAIDocumentClassifier(config.openai).classify({
          bytes,
          mimeType: context.detected_mime_type as ExtractionInput['mimeType'],
          fileName: context.original_file_name,
          organizacia: {
            nazov: context.organization_name,
            ico: context.organization_ico,
            icDph: context.organization_ic_dph,
          },
        });
      } catch {
        klasifikacia = undefined;
      }
    }
    const startedAt = performance.now();
    const outcome = await provider.extract({
      documentId: prepared.documentId,
      mimeType: context.detected_mime_type as ExtractionInput['mimeType'],
      fileName: context.original_file_name,
      bytes,
      pokyny,
      organizationContext: {
        nazov: context.organization_name,
        ico: context.organization_ico,
        dic: context.organization_dic,
        icDph: context.organization_ic_dph,
      },
      promptVersion: EXTRACTION_PROMPT_VERSION,
      schemaVersion: EXTRACTION_SCHEMA_VERSION,
    });
    // Klasifikátor riešil jedinú otázku, extrakcia tridsať polí — pri rozpore
    // má prednosť špecializovaný krok. Týka sa to hlavne zmlúv a objednávok,
    // ktoré extrakcia kvôli vytlačenej cene vyhodnotila ako faktúru.
    // Prednosť má, ale len keď si je istý. Neistá klasifikácia by inak prebila
    // extrakciu, ktorá videla celý doklad — vtedy je lepšie nechať typ na nej.
    if (klasifikacia && klasifikacia.istota >= 0.6 && klasifikacia.documentType !== outcome.result.documentType) {
      console.info('[klasifikacia] typ prepisany', {
        documentId: prepared.documentId,
        zExtrakcie: outcome.result.documentType,
        zKlasifikacie: klasifikacia.documentType,
        istota: klasifikacia.istota,
        dovod: klasifikacia.dovod,
      });
      outcome.result.documentType = klasifikacia.documentType;
    }
    const summary = await completeRun(database, job, context, prepared, outcome, startedAt, config);
    // Prepravný spis chodí ako zväzok: žiadosť o prepravu, faktúra dopravcu,
    // CMR, niekedy akt služieb. Zaúčtuje sa faktúra, ostatné strany sú jej
    // podklady — a účtovník o nich vie len vtedy, ak mu to niekto povie.
    if (klasifikacia?.obsahZvazku) {
      const zaznamy = [{ ts: new Date().toISOString(), user: 'Systém', akcia: `Súbor je zväzok — ${klasifikacia.obsahZvazku}` }];
      // Druhá faktúra v tom istom súbore sa dnes nezaúčtuje. Nech to nie je
      // ticho: bez tohto riadka chýba náklad aj odpočet a nikto sa to nedozvie.
      if (klasifikacia.pocetFakturaciiVSubore > 1) {
        zaznamy.push({
          ts: new Date().toISOString(),
          user: 'Systém',
          akcia: `POZOR: súbor obsahuje ${klasifikacia.pocetFakturaciiVSubore} fakturujúce doklady, zaúčtoval sa iba jeden. Ostatné treba doplniť ručne.`,
        });
        console.warn('[klasifikacia] zvazok s viacerymi fakturami', {
          documentId: prepared.documentId,
          pocet: klasifikacia.pocetFakturaciiVSubore,
          obsah: klasifikacia.obsahZvazku,
        });
      }
      await database.query(
        `UPDATE documents SET history=history || $1::jsonb, updated_at=now()
          WHERE id=$2 AND tenant_id=$3 AND organization_id=$4`,
        [JSON.stringify(zaznamy), prepared.documentId, job.tenant_id, job.organization_id],
      );
    }
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
    // AI analýza zaúčtovania beží na každom doklade okrem bankového výpisu;
    // deterministický návrh vyššie je len okamžitý prvý odhad. Zlyhanie
    // analýzy nesmie zhodiť spracovanie dokladu — návrh ostane deterministický.
    if (summary && summary.status !== 'karantena') {
      // Doklady z rozdeleného súboru (mzdová rekapitulácia → mzdy, sociálny
      // fond, zúčtovanie zálohy) potrebujú vlastnú analýzu rovnako ako hlavný.
      const doklady = [{ documentId: prepared.documentId, kontext: summary as AiSuggestionDocumentContext }]
        .concat(summary.dalsie.map((dalsi) => ({ documentId: dalsi.documentId, kontext: dalsi })))
        // Bankový výpis má vlastnú analýzu po pohyboch (nižšie).
        .filter((doklad) => doklad.kontext.documentType !== 'BV');
      for (const doklad of doklady) {
        try {
          await maybeAiAccountingSuggestion(database, config, {
            tenantId: job.tenant_id,
            organizationId: job.organization_id,
            documentId: doklad.documentId,
            supplierIco: summary.supplierIco,
            supplierName: summary.supplierName,
          }, doklad.kontext);
        } catch (cause) {
          // Návrh je voliteľný — chyba AI nezhodí doklad, ktorý je už uložený,
          // a nesmie pripraviť o analýzu ani ostatné doklady zo súboru. Ticho
          // ju však neprehĺtame: inak by nikto nevedel, prečo doklad návrh nemá.
          console.warn(`[ai-navrh] doklad ${doklad.documentId} zlyhal:`, cause instanceof Error ? cause.message : cause);
        }
      }
    }
    // Bankový výpis má vlastný návrh po pohyboch — beží AŽ PO párovaní úhrad,
    // aby model videl, ktorý pohyb preukázateľne platí ktorý doklad.
    if (summary && summary.status !== 'karantena' && summary.documentType === 'BV') {
      try {
        await suggestBankMovementAccounting(database, config, {
          tenantId: job.tenant_id,
          organizationId: job.organization_id,
          documentId: prepared.documentId,
        });
      } catch {
        // Návrh je voliteľný — chyba AI sa ignoruje, výpis je už uložený.
      }
    }
    return true;
  } catch (error) {
    await database.transaction((tx) => failJob(
      tx, job, prepared, asProviderError(error, prepared?.documentId), Math.max(0, Math.round(performance.now() - jobStartedAt)),
    ));
    return true;
  }
}

// Mock inbound pipeline — SPEC §11.6, §11.7, §11.8, §11.11, §11.20.
// Poradie krokov zodpovedá produkčnému pipeline; reálny webhook, malware
// scan, object storage a OCR sú výhradne backend.
// TODO: integration point — InboundEmailProvider (verifyWebhook/parseWebhook/
// provisionAlias/disableAlias) implementuje Fáza 2A na backend/worker.
import type {
  DocumentItem,
  ExtractionRun,
  InboundAttachment,
  InboundEmail,
  SimulateInboundEmailInput,
  SimulateInboundEmailResult,
  VatBreakdownRow,
  VatRate,
} from '../types';
import { simulateInboundEmailInputSchema } from '../schemas';
import { MOCK_TENANT_ID, SUPPORTED_ATTACHMENT_MIME_TYPES } from '../config';
import { newId, nowIso } from '../../lib/id';
import { round2 } from '../../lib/validate';
import {
  EXTRACTION_PROMPT_VERSION,
  EXTRACTION_SCHEMA_VERSION,
  MockDocumentExtractionProvider,
  aggregateConfidence,
  mapFieldConfidenceToDocument,
  mapDocumentType,
  type MockExtractionHints,
} from '../extraction/extractionProvider';
import type { AppDataState } from '../store';
import { buildSuggestionForDocument } from '../suggestions/accountingSuggestionService';
import {
  parseDecimalString,
  validateDocument,
} from '../validation/documentValidation';

export interface InboundDeps {
  getState: () => AppDataState;
  setState: (partial: Partial<AppDataState>) => void;
}

/** SHA-256 hex obsahu (mock duplicate check — SPEC §11.6/§11.11). */
export async function sha256Hex(content: string): Promise<string> {
  const data = new TextEncoder().encode(content);
  const digest = await crypto.subtle.digest('SHA-256', data);
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('');
}

function seedNumber(sha: string): number {
  return parseInt(sha.slice(0, 8), 16);
}

/** Normalizácia envelope recipienta — lowercase + trim (SPEC §11.7). */
export function normalizeRecipient(recipient: string): string {
  return recipient.trim().toLowerCase();
}

const SAMPLE_PDFS = [
  '/samples/faktura-sluzby.pdf',
  '/samples/faktura-telekom.pdf',
  '/samples/faktura-energia.pdf',
  '/samples/faktura-kancelarske.pdf',
  '/samples/faktura-metro.pdf',
];

function isSupportedMime(mime: string | undefined): boolean {
  return !!mime && (SUPPORTED_ATTACHMENT_MIME_TYPES as readonly string[]).includes(mime);
}

function toVatRows(breakdown: Array<{ vatRate: string; base: string; vat: string }>): VatBreakdownRow[] {
  return breakdown
    .map((row) => {
      const sadzba = Number(row.vatRate);
      if (![23, 19, 5, 0].includes(sadzba)) return undefined;
      const zaklad = parseDecimalString(row.base);
      const dph = parseDecimalString(row.vat);
      if (zaklad === undefined || dph === undefined) return undefined;
      return {
        sadzba: sadzba as VatRate,
        zaklad: round2(zaklad),
        dph: round2(dph),
      };
    })
    .filter((r): r is VatBreakdownRow => r !== undefined);
}

/**
 * Simulácia prijatého e-mailu (SPEC §11.20) — celý mock pipeline:
 * validácia → idempotencia → routing podľa envelope recipienta →
 * prílohy → SHA-256 dedupe → 1 podporovaná príloha = 1 doklad →
 * mock extrakcia → deterministická validácia → suggestion → stavy.
 */
export async function simulateInboundEmail(
  rawInput: SimulateInboundEmailInput,
  deps: InboundDeps,
): Promise<SimulateInboundEmailResult> {
  const input = simulateInboundEmailInputSchema.parse(rawInput);
  const state = deps.getState();
  const correlationId = newId('corr');
  const receivedAt = nowIso();

  // --- Routing: presná zhoda normalizovanej adresy s aktívnym aliasom (§11.7).
  // Nikdy nehádať organizáciu podľa mena/predmetu/odosielateľa.
  const recipients = [input.recipientAlias, ...(input.additionalRecipientAliases ?? [])].map(
    normalizeRecipient,
  );
  const recipient = recipients[0];
  const aliasDelivers = (candidate: (typeof state.aliases)[number]) =>
    candidate.status === 'active' ||
    (candidate.status === 'grace_period' &&
      (!candidate.graceUntil || Date.parse(candidate.graceUntil) > Date.now()));
  const activeResolvedAliases = state.aliases.filter(
    (candidate) =>
      candidate.tenantId === MOCK_TENANT_ID &&
      recipients.includes(candidate.addressNormalized) &&
      aliasDelivers(candidate),
  );
  const resolvedOrganizationIds = new Set(
    activeResolvedAliases.map((candidate) => candidate.organizationId),
  );
  const alias = state.aliases.find(
    (a) =>
      a.tenantId === MOCK_TENANT_ID && a.addressNormalized === recipient,
  );
  const aliasActive = alias && aliasDelivers(alias);
  const organization = aliasActive
    ? state.organizations.find(
        (o) => o.tenantId === MOCK_TENANT_ID && o.id === alias.organizationId,
      )
    : undefined;

  let quarantineReason: string | undefined;
  if (resolvedOrganizationIds.size > 1) quarantineReason = 'ambiguous_recipient';
  else if (!alias) quarantineReason = 'unknown_alias';
  else if (!aliasActive) quarantineReason = 'alias_disabled';
  else if (!organization) quarantineReason = 'unknown_alias';
  else if (organization.archived) quarantineReason = 'organization_archived';

  const email: InboundEmail = {
    id: newId('in'),
    tenantId: MOCK_TENANT_ID,
    organizationId: quarantineReason ? undefined : organization?.id,
    aliasId: aliasActive && !quarantineReason ? alias?.id : undefined,
    provider: 'mock',
    providerMessageId: newId('msg'),
    envelopeRecipients: recipients,
    senderEmail: input.sender,
    subject: input.subject,
    receivedAt,
    status: 'received',
    attachmentCount: input.attachments.length,
    quarantineReason,
    correlationId,
    createdAt: receivedAt,
  };

  const attachments: InboundAttachment[] = [];
  const createdDocs: DocumentItem[] = [];
  const runs: ExtractionRun[] = [];

  if (quarantineReason) {
    // Neznámy/vypnutý alias alebo archivovaná organizácia:
    // e-mail zostáva v karanténe, dokument sa NIKDY nevytvorí „odhadom" (§11.7).
    email.status = 'quarantine';
    for (const att of input.attachments) {
      attachments.push(await mkAttachment(email, att, undefined, 'quarantine', quarantineReason));
    }
    commit(deps, email, attachments, [], []);
    return { inboundEmail: email, attachments, createdDocumentIds: [] };
  }

  const org = organization!;

  if (input.attachments.length === 0) {
    // E-mail bez príloh (§11.8)
    email.status = 'quarantine';
    email.quarantineReason = 'no_supported_attachment';
    commit(deps, email, [], [], []);
    return { inboundEmail: email, attachments: [], createdDocumentIds: [] };
  }

  // Pre scenár účtovnej duplicity: použiť dodávateľa + číslo existujúceho dokladu
  const duplicateTarget =
    input.scenario === 'duplicita'
      ? state.documents.find(
          (d) =>
            d.tenantId === MOCK_TENANT_ID &&
            d.orgId === org.id &&
            d.typ === 'FP' &&
            d.extracted.dodavatel.ico,
        )
      : undefined;
  // Pre IČO mismatch: IČO inej organizácie (alebo neexistujúce)
  const otherOrg = state.organizations.find(
    (o) => o.tenantId === MOCK_TENANT_ID && o.id !== org.id && !o.archived,
  );
  const mismatchIco = input.scenario === 'ico_mismatch' ? (otherOrg?.ico ?? '99999999') : undefined;

  for (const att of input.attachments) {
    const sha = await sha256Hex(att.contentSeed);

    // Nepodporovaný typ — kontrola skutočného MIME, nie scenára (§11.8).
    if (!isSupportedMime(att.mimeType)) {
      attachments.push(await mkAttachment(email, att, sha, 'quarantine', 'unsupported_type', org.id));
      continue;
    }

    // Technická duplicita: rovnaký obsah v rovnakej organizácii (§11.11 —
    // dedupe scope zahŕňa organizáciu; rovnaké PDF v inej organizácii je legálne).
    const currentState = deps.getState();
    const dupAttachment = [...currentState.inboundAttachments, ...attachments].find(
      (a) =>
        a.tenantId === MOCK_TENANT_ID &&
        a.sha256 === sha &&
        a.organizationId === org.id &&
        ['document_created', 'quarantine', 'duplicate'].includes(a.status),
    );
    if (dupAttachment) {
      attachments.push(await mkAttachment(email, att, sha, 'duplicate', undefined, org.id));
      continue;
    }

    const attachment = await mkAttachment(email, att, sha, 'processing', undefined, org.id);
    const seed = seedNumber(sha);
    const queue = deps.getState().queues.find(
      (item) =>
        item.tenantId === MOCK_TENANT_ID &&
        item.organizationId === org.id &&
        item.active &&
        (alias?.queueId ? item.id === alias.queueId : item.kind === 'received_invoices'),
    );
    if (!queue) {
      attachment.status = 'quarantine';
      attachment.quarantineReason = 'queue_not_found';
      attachments.push(attachment);
      continue;
    }

    // Poškodený alebo zaheslovaný PDF zlyhá už pri bezpečnej validácii súboru;
    // do extraction providera sa neposiela a nevzniká orphan ExtractionRun.
    if (
      input.scenario === 'poskodeny_subor' ||
      input.scenario === 'password_protected_pdf'
    ) {
      attachment.status = 'quarantine';
      attachment.quarantineReason =
        input.scenario === 'poskodeny_subor'
          ? 'corrupted_file'
          : 'password_protected_pdf';
      attachments.push(attachment);
      continue;
    }

    // 1 podporovaná príloha = 1 DocumentItem so spoločným inboundEmailId (§11.8)
    const doc: DocumentItem = {
      id: newId('doc'),
      tenantId: MOCK_TENANT_ID,
      orgId: org.id,
      queueId: queue.id,
      typ: 'FP',
      status: 'novy',
      processingStatus: 'extracting',
      pdfUrl: SAMPLE_PDFS[seed % SAMPLE_PDFS.length],
      prijateDna: receivedAt,
      zdroj: {
        typ: 'email',
        inboundEmailId: email.id,
        attachmentId: attachment.id,
        odosielatel: input.sender,
        prijemcaAlias: alias!.address,
        predmet: input.subject,
        povodnyNazovSuboru: att.fileName,
      },
      confidence: 0,
      extracted: {
        dodavatel: { nazov: '' },
        cisloFaktury: '',
        datumVystavenia: receivedAt.slice(0, 10),
        mena: 'EUR',
        rozpisDph: [],
        sumaSpolu: 0,
      },
      ucto: {},
      history: [
        { ts: receivedAt, user: 'system', akcia: `Doklad prijatý e-mailom (${correlationId})` },
      ],
      comments: [],
      version: 1,
    };

    const hints: MockExtractionHints = {
      scenario: input.scenario,
      seed,
      fileName: att.fileName,
      duplicateOf: duplicateTarget
        ? {
            supplierName: duplicateTarget.extracted.dodavatel.nazov,
            supplierIco: duplicateTarget.extracted.dodavatel.ico ?? '',
            invoiceNumber: duplicateTarget.extracted.cisloFaktury,
          }
        : undefined,
      mismatchBuyerIco: mismatchIco,
    };
    const provider = new MockDocumentExtractionProvider(hints);

    const run: ExtractionRun = {
      id: newId('run'),
      tenantId: MOCK_TENANT_ID,
      organizationId: org.id,
      documentId: doc.id,
      provider: 'mock',
      promptVersion: EXTRACTION_PROMPT_VERSION,
      schemaVersion: EXTRACTION_SCHEMA_VERSION,
      status: 'running',
      startedAt: nowIso(),
      createdAt: nowIso(),
    };

    try {
      const result = await provider.extract({
        documentId: doc.id,
        mimeType: att.mimeType,
        storageKey: attachment.storageKey ?? '',
        organizationContext: {
          nazov: org.nazov,
          ico: org.ico,
          dic: org.dic,
          icDph: org.icDph,
        },
        promptVersion: EXTRACTION_PROMPT_VERSION,
        schemaVersion: EXTRACTION_SCHEMA_VERSION,
      });

      run.status = 'succeeded';
      run.completedAt = nowIso();
      run.latencyMs = Math.max(0, Date.parse(run.completedAt) - Date.parse(run.startedAt!));
      run.result = result;

      // Normalizácia výsledku do dokladu (decimal strings → čísla; Fáza 1 mock)
      doc.typ = mapDocumentType(result.documentType);
      doc.extracted = {
        dodavatel: {
          nazov: result.supplier.nazov ?? '',
          ico: result.supplier.ico,
          dic: result.supplier.dic,
          icDph: result.supplier.icDph,
          adresa: result.supplier.adresa,
          iban: result.supplier.iban,
        },
        odberatel: {
          nazov: result.buyer.nazov,
          ico: result.buyer.ico,
          dic: result.buyer.dic,
          icDph: result.buyer.icDph,
        },
        cisloFaktury: result.invoiceNumber ?? '',
        variabilnySymbol: result.variableSymbol,
        konstantnySymbol: result.constantSymbol,
        specifickySymbol: result.specificSymbol,
        datumVystavenia: result.issueDate ?? receivedAt.slice(0, 10),
        datumSplatnosti: result.dueDate,
        datumDodania: result.taxDate,
        mena: (result.currency as 'EUR' | 'CZK' | 'USD') ?? 'EUR',
        rozpisDph: toVatRows(result.vatBreakdown),
        sumaSpolu: round2(parseDecimalString(result.totalAmount) ?? 0),
        polozky: result.lineItems.map((li, i) => ({
          id: `${doc.id}-li-${i}`,
          popis: li.description ?? '',
          mnozstvo: parseDecimalString(li.quantity),
          jednotka: li.unit,
          jednotkovaCenaBezDph: parseDecimalString(li.unitPriceWithoutVat),
          sadzbaDph: li.vatRate && [23, 19, 5, 0].includes(Number(li.vatRate))
            ? (Number(li.vatRate) as VatRate)
            : undefined,
          sumaBezDph: parseDecimalString(li.amountWithoutVat),
          sumaDph: parseDecimalString(li.vatAmount),
          sumaSpolu: parseDecimalString(li.amountTotal),
        })),
      };
      doc.fieldConfidence = mapFieldConfidenceToDocument(result.fieldConfidence);
      doc.confidence = aggregateConfidence(result.fieldConfidence);
      doc.history.push({ ts: nowIso(), user: 'system', akcia: 'AI extrakcia dokončená' });

      // Deterministická validácia po AI (§11.14) — má prioritu nad confidence.
      const buyerIco = result.buyer.ico;
      const existingDup = deps
        .getState()
        .documents.find(
          (d) =>
            d.tenantId === MOCK_TENANT_ID &&
            d.orgId === org.id &&
            d.id !== doc.id &&
            !!doc.extracted.dodavatel.ico &&
            d.extracted.dodavatel.ico === doc.extracted.dodavatel.ico &&
            d.extracted.cisloFaktury === doc.extracted.cisloFaktury &&
            ((d.extracted.datumDodania ?? d.extracted.datumVystavenia).slice(0, 7) ===
              (doc.extracted.datumDodania ?? doc.extracted.datumVystavenia).slice(0, 7) ||
              Math.abs(d.extracted.sumaSpolu - doc.extracted.sumaSpolu) <= 0.02),
        );

      doc.processingStatus = 'ready_for_review';
      if (!queue.documentTypes.includes(doc.typ)) {
        // Alias určuje frontu ešte pred AI. Výsledok extrakcie nesmie dokument
        // potichu pretypovať do nekompatibilnej fronty ani spustiť approval.
        // Doklad zachováme pre manuálne rozhodnutie, ale on aj príloha zostanú
        // v karanténe v organizácii/frontě určenej aliasom.
        doc.status = 'karantena';
        doc.quarantineReason = 'queue_type_mismatch';
        doc.history.push({
          ts: nowIso(),
          user: 'system',
          akcia: `Karanténa: typ ${doc.typ} nie je povolený vo fronte ${queue.name}; vyžaduje manuálnu kontrolu`,
        });
        attachment.status = 'quarantine';
        attachment.quarantineReason = 'queue_type_mismatch';
        attachment.documentId = doc.id;
      } else if (buyerIco && buyerIco !== org.ico) {
        // Alias ukazuje na org A, IČO odberateľa na inú — karanténa, nikdy
        // automatický presun (§11.7 bod 6).
        doc.status = 'karantena';
        doc.quarantineReason = 'buyer_ico_mismatch';
        doc.history.push({
          ts: nowIso(),
          user: 'system',
          akcia: 'Karanténa: IČO odberateľa nezodpovedá organizácii',
        });
        attachment.status = 'quarantine';
        attachment.quarantineReason = 'buyer_ico_mismatch';
        attachment.documentId = doc.id;
      } else if (existingDup) {
        // Účtovná duplicita — vytvorí sa, ale čaká na rozhodnutie (§11.11).
        doc.status = 'duplicita';
        doc.duplicateOfDocumentId = existingDup.id;
        doc.history.push({
          ts: nowIso(),
          user: 'system',
          akcia: `Označené ako možná duplicita dokladu ${existingDup.extracted.cisloFaktury}`,
        });
        attachment.status = 'document_created';
        attachment.documentId = doc.id;
      } else {
        const deterministicIssues = validateDocument(doc, org);
        if (deterministicIssues.length > 0) {
          doc.status = 'chyba';
          doc.history.push({
            ts: nowIso(),
            user: 'system',
            akcia: `Deterministická validácia: ${deterministicIssues
              .map((issue) => issue.code)
              .join(', ')}`,
          });
          attachment.status = 'document_created';
          attachment.documentId = doc.id;
        } else {
        doc.status = 'extrahovany';
        attachment.status = 'document_created';
        attachment.documentId = doc.id;
        }
      }
      createdDocs.push(doc);
    } catch (err) {
      // Poškodený súbor a pod. — príloha do karantény, doklad nevzniká (§11.8).
      run.status = 'failed';
      run.completedAt = nowIso();
      run.latencyMs = Math.max(0, Date.parse(run.completedAt) - Date.parse(run.startedAt!));
      run.errorCode = (err as { code?: string }).code ?? 'extraction_failed';
      run.errorMessage = err instanceof Error ? err.message : String(err);
      attachment.status = 'quarantine';
      attachment.quarantineReason = run.errorCode;
    }

    attachments.push(attachment);
    runs.push(run);
  }

  // Stav e-mailu podľa výsledkov príloh (§11.17)
  const okCount = attachments.filter((a) => a.status === 'document_created').length;
  const quarantineCount = attachments.filter((a) => a.status === 'quarantine').length;
  if (okCount > 0 && quarantineCount > 0) {
    email.status = 'partially_processed';
  } else if (quarantineCount > 0) {
    email.status = 'quarantine';
    email.quarantineReason = attachments.find((a) => a.quarantineReason)?.quarantineReason;
  } else if (attachments.every((a) => a.status === 'duplicate')) {
    email.status = 'processed'; // technický repeat — bez nového dokladu (§11.11)
  } else if (okCount === attachments.length && attachments.length > 0) {
    email.status = 'processed';
  } else {
    email.status = okCount > 0 ? 'partially_processed' : 'failed';
  }

  // Mock návrhy zaúčtovania pre nové doklady (§11.15)
  const suggestions = createdDocs.map((d) =>
    buildSuggestionForDocument({ documents: deps.getState().documents, codeLists: deps.getState().codeLists }, d),
  );

  commit(deps, email, attachments, createdDocs, runs, suggestions);
  return {
    inboundEmail: email,
    attachments,
    createdDocumentIds: createdDocs.map((d) => d.id),
  };
}

async function mkAttachment(
  email: InboundEmail,
  att: { fileName: string; mimeType: string; contentSeed: string },
  sha: string | undefined,
  status: InboundAttachment['status'],
  quarantineReason?: string,
  organizationId?: string,
): Promise<InboundAttachment> {
  const id = newId('att');
  return {
    id,
    tenantId: MOCK_TENANT_ID,
    inboundEmailId: email.id,
    organizationId,
    originalFileName: att.fileName,
    // pôvodné meno súboru sa ukladá oddelene; storage key je bezpečné UUID (§11.8)
    safeFileName: `${id}.bin`,
    declaredMimeType: att.mimeType,
    detectedMimeType: att.mimeType,
    byteSize: 100_000 + (att.contentSeed.length % 900) * 1000,
    sha256: sha ?? (await sha256Hex(att.contentSeed)),
    storageKey: organizationId
      ? `inbound/${MOCK_TENANT_ID}/${organizationId}/${email.id}/${id}/original`
      : undefined,
    status,
    quarantineReason,
    createdAt: nowIso(),
  };
}

function commit(
  deps: InboundDeps,
  email: InboundEmail,
  attachments: InboundAttachment[],
  docs: DocumentItem[],
  runs: ExtractionRun[],
  suggestions: ReturnType<typeof buildSuggestionForDocument>[] = [],
): void {
  const s = deps.getState();
  deps.setState({
    inboundEmails: [email, ...s.inboundEmails],
    inboundAttachments: [...attachments, ...s.inboundAttachments],
    documents: [...docs, ...s.documents],
    extractionRuns: [...runs, ...s.extractionRuns],
    suggestions: [...suggestions, ...s.suggestions],
  });
}

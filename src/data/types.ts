// Dátový model — SPEC §4, §11.13, §11.15, §11.17.
// Frontend `number` je prípustný pre mock Fázy 1; produkčný API kontrakt
// bude prenášať presné decimal strings (SPEC §11.9).

export type DocumentType = 'FP' | 'FV' | 'BV' | 'MZDY' | 'OZ' | 'PD';
// FP faktúra prijatá, FV faktúra vydaná, BV bankový výpis,
// MZDY mzdové podklady, OZ ostatný záväzok, PD pokladničný doklad

export type DocumentStatus =
  | 'novy' // prišiel e-mailom, čaká na extrakciu
  | 'extrahovany' // AI dokončila vyťaženie, čaká na kontrolu
  | 'na_kontrole' // otvorený účtovníkom, rozpracovaný
  | 'schvaleny' // skontrolovaný, pripravený na export
  | 'exportovany' // zahrnutý do XML exportu
  | 'chyba' // extrakcia zlyhala / nevalidné dáta
  | 'karantena' // nesúlad IČO odberateľa s organizáciou
  | 'duplicita' // rovnaký dodávateľ + číslo faktúry už existuje
  | 'zamietnuty';

// Technický stav spracovania — oddelený od účtovného workflow (SPEC §11.10)
export type ProcessingStatus =
  | 'received'
  | 'validating'
  | 'queued'
  | 'extracting'
  | 'normalizing'
  | 'ready_for_review'
  | 'failed_retryable'
  | 'failed_permanent';

/** Číselná sadzba z dokladu; UI ponúka aktuálne SK/CZ sadzby, historická sa však zachová. */
export type VatRate = number;

export interface Organization {
  id: string;
  tenantId: string;
  nazov: string; // "Alfa s.r.o."
  ico: string; // 8 cifier
  dic: string;
  icDph?: string; // "SK2020..."
  emailAlias: string; // primárny alias — generuje sa automaticky (SPEC §11.3)
  farba: string; // hex, farebný štítok organizácie v UI
  archived?: boolean; // organizácie s dokladmi sa nemažú, archivujú sa (SPEC §11.3)
}

export interface OrganizationBankAccount {
  id: string;
  tenantId: string;
  organizationId: string;
  label: string;
  iban: string;
  bic?: string;
  currency: 'EUR' | 'CZK' | 'USD';
  isDefault: boolean;
  active: boolean;
}

export type QueueKind =
  | 'received_invoices'
  | 'issued_invoices'
  | 'cash_documents'
  | 'bank_statements'
  | 'payroll'
  | 'other';

export interface DocumentQueue {
  id: string;
  tenantId: string;
  organizationId: string;
  name: string;
  kind: QueueKind;
  documentTypes: DocumentType[];
  importAlias?: string;
  active: boolean;
  features: {
    extraction: boolean;
    approval: boolean;
    validation: boolean;
    spamDetection: boolean;
    requireApprovalNote: boolean;
    autoAttachEmailAttachments: boolean;
  };
  warningThreshold?: number;
  automation: {
    minConfidence?: number;
    action?: 'move_to_validation' | 'send_to_erp';
  };
}

export interface VatBreakdownRow {
  sadzba: VatRate;
  zaklad: number;
  dph: number;
}

export interface DocumentLineItem {
  id: string;
  popis: string;
  mnozstvo?: number;
  jednotka?: string;
  jednotkovaCenaBezDph?: number;
  sadzbaDph?: VatRate;
  sumaBezDph?: number;
  sumaDph?: number;
  sumaSpolu?: number;
}

export interface DocumentSource {
  typ: 'email' | 'manual' | 'upload';
  inboundEmailId?: string;
  attachmentId?: string;
  /** Kľúč súboru v mock object-storage adaptéri (IndexedDB vo Fáze 1). */
  localFileKey?: string;
  mimeType?: 'application/pdf' | 'image/jpeg' | 'image/png' | 'image/webp' | 'application/xml';
  byteSize?: number;
  /** Formát zdroja klasifikovaný backendom (pdf | foto | peppol_xml | blocek_foto | mzdova_paska). */
  format?: string;
  odosielatel?: string;
  prijemcaAlias?: string;
  predmet?: string;
  povodnyNazovSuboru?: string;
}

export interface DocumentExtractedData {
  dodavatel: {
    nazov: string;
    ico?: string;
    dic?: string;
    icDph?: string;
    adresa?: string;
    iban?: string;
  };
  odberatel?: {
    nazov?: string;
    ico?: string;
    dic?: string;
    icDph?: string;
    adresa?: string;
  };
  cisloFaktury: string; // dodávateľské číslo
  variabilnySymbol?: string;
  konstantnySymbol?: string;
  specifickySymbol?: string;
  datumVystavenia: string;
  datumSplatnosti?: string;
  datumDodania?: string; // DUZP
  mena: 'EUR' | 'CZK' | 'USD';
  rozpisDph: VatBreakdownRow[];
  sumaSpolu: number;
  polozky?: DocumentLineItem[];
  textPolozky?: string; // stručný popis plnenia
}

export interface DocumentUcto {
  // vyplní účtovník (predvyplnené návrhom — návrh nikdy nenahrádza rozhodnutie)
  predkontaciaId?: string;
  clenenieDphId?: string;
  ciselnyRadId?: string;
  strediskoId?: string;
  /** Kód pokladne POHODA; povinný pri pokladničnom doklade. */
  pokladnaKod?: string;
  /** Smer pokladničného dokladu podľa voucher.xsd. */
  pokladnaTyp?: 'receipt' | 'expense';
  poznamka?: string;
}

export interface HistoryEntry {
  ts: string;
  user: string;
  akcia: string;
}

export interface CommentEntry {
  ts: string;
  user: string;
  text: string;
}

export interface DocumentItem {
  id: string;
  tenantId: string;
  orgId: string;
  queueId: string;
  typ: DocumentType;
  status: DocumentStatus;
  processingStatus: ProcessingStatus;
  /** Seed URL; ručne nahrané súbory sa načítajú cez zdroj.localFileKey. */
  pdfUrl: string;
  prijateDna: string; // ISO — kedy prišiel e-mail
  zdroj: DocumentSource;
  confidence: number; // 0–1, agregovaná istota AI extrakcie
  fieldConfidence?: Record<string, number>;
  extracted: DocumentExtractedData;
  ucto: DocumentUcto;
  history: HistoryEntry[];
  comments: CommentEntry[];
  exportId?: string;
  quarantineReason?: string; // napr. buyer_ico_mismatch (SPEC §11.7)
  duplicateOfDocumentId?: string; // účtovná duplicita (SPEC §11.11)
  notDuplicate?: boolean; // rozhodnutie „Nie je duplicita" sa ukladá (SPEC §11.11)
  appliedExtractionRunId?: string; // evidence/warnings patria k explicitne použitému behu
  version: number;
  approvedVersion?: number;
  approvedSnapshot?: ApprovedDocumentSnapshot;
  payment?: DocumentPaymentState;
}

export type PaymentStatus = 'unpaid' | 'to_pay' | 'payment_order' | 'partially_paid' | 'paid';

export interface DocumentPaymentState {
  status: PaymentStatus;
  amountPaid: number;
  executionDate?: string;
  paidAt?: string;
  markedBy?: string;
  qrPayloadHash?: string;
  qrDocumentVersion?: number;
}

export interface PaymentInstruction {
  documentId: string;
  documentVersion: number;
  direction: 'payable' | 'receivable';
  beneficiaryName: string;
  iban: string;
  bic?: string;
  amount: number;
  currency: 'EUR' | 'CZK' | 'USD';
  variableSymbol?: string;
  constantSymbol?: string;
  specificSymbol?: string;
  dueDate?: string;
  paymentNote?: string;
}

export interface ApprovedDocumentSnapshot {
  version: number;
  approvedAt: string;
  typ: DocumentType;
  extracted: DocumentExtractedData;
  ucto: DocumentUcto;
}

export type CodeListKind = 'predkontacie' | 'cleneniaDph' | 'ciselneRady' | 'strediska';

export type CodeListSource = 'manual' | 'pohoda';

export interface CodeListItem {
  id: string;
  tenantId: string;
  kod: string;
  nazov: string;
  orgId: string;
  source: CodeListSource;
  active: boolean;
  externalId?: string;
  agenda?: string;
  uctovnyRok?: string;
  syncedAt?: string;
}

export interface ExportBatch {
  id: string;
  tenantId: string;
  orgId: string;
  createdAt: string;
  user: string;
  documentIds: string[];
  xmlFileName: string;
  /** Nemenný XML snapshot vytvorený iba zo schválenej verzie dokladov. */
  xmlSnapshot?: string;
}

// ===== POHODA Mostík (SPEC modulu 4 §6–7) =====

export interface AgentInstallation {
  id: string;
  tenantId: string;
  name: string;
  hostname: string;
  createdAt: string;
  lastSeenAt?: string;
  agentVersion: string;
  status: 'connected' | 'revoked';
}

export interface AgentPairingCode {
  code: string;
  expiresAt: string;
  organizationId: string;
}

export interface PohodaCompanyLink {
  tenantId: string;
  organizationId: string;
  ico: string;
  dbName?: string;
  uctovnyRok?: string;
  preferredYear: 'latest' | string;
  matchedAt?: string;
  matchRule?: 'auto_ico' | 'manual';
}

export type ExportJobStatus = 'pending' | 'sent' | 'confirmed' | 'failed';
export type PohodaResultState = 'ok' | 'warning' | 'error';

export interface ExportJobDocumentResult {
  documentId: string;
  state: PohodaResultState;
  pohodaNumber?: string;
  message?: string;
}

export interface ExportJob {
  id: string;
  tenantId: string;
  organizationId: string;
  documentIds: string[];
  status: ExportJobStatus;
  idempotencyKey: string;
  requestXmlHash: string;
  responseMeta?: {
    perDocument?: ExportJobDocumentResult[];
    summary?: { ok: number; warning: number; error: number };
    [key: string]: unknown;
  };
  attempt: number;
  createdAt: string;
  createdBy: string;
  sentAt?: string;
  completedAt?: string;
  retryOfJobId?: string;
}

export interface AgentRelease {
  available: true;
  version: string;
  downloadUrl: string;
  sha256: string;
  fileSize: number;
  publishedAt: string;
  publisher: string;
  publisherThumbprint: string;
  minimumWindowsVersion: string;
  signed: true;
  signatureTrust: 'public' | 'self-signed';
  certificateUrl?: string;
  channel: 'production' | 'temporary';
}

export interface AgentReleaseUnavailable {
  available: false;
  reason: 'release_not_available' | 'release_metadata_invalid';
}

export type AgentReleaseState = AgentRelease | AgentReleaseUnavailable;

export type Role = 'uctovnik' | 'schvalovatel' | 'admin';

export type UserLanguage = 'sk';

export interface UserNotificationPreferences {
  email: boolean;
  inApp: boolean;
  comments: boolean;
  mentions: boolean;
}

export interface AppUser {
  id: string;
  tenantId: string;
  meno: string;
  email: string;
  rola: Role;
  jazyk: UserLanguage;
  notifikacie: UserNotificationPreferences;
}

// ===== E-mail aliasy a inbound pipeline (SPEC §11.17) =====

export type AliasStatus = 'active' | 'grace_period' | 'disabled';

export type InboundEmailStatus =
  | 'received'
  | 'queued'
  | 'processed'
  | 'partially_processed'
  | 'quarantine'
  | 'failed';

export type AttachmentStatus =
  | 'received'
  | 'ignored_inline'
  | 'stored'
  | 'queued'
  | 'processing'
  | 'document_created'
  | 'duplicate'
  | 'quarantine'
  | 'failed';

export interface OrganizationEmailAlias {
  id: string;
  tenantId: string;
  organizationId: string;
  queueId?: string;
  address: string;
  addressNormalized: string;
  localPart: string;
  domain: string;
  slugAtCreation: string;
  token: string;
  status: AliasStatus;
  isPrimary: boolean;
  providerRouteId?: string;
  createdAt: string;
  graceUntil?: string;
  disabledAt?: string;
}

export interface InboundEmail {
  id: string;
  /** Chýba pri nezaradenom karanténnom e-maile (ešte nepriradený tenantovi). */
  tenantId?: string;
  organizationId?: string;
  aliasId?: string;
  provider: string;
  providerMessageId: string;
  envelopeRecipients: string[];
  senderEmail?: string;
  senderName?: string;
  subject?: string;
  receivedAt: string;
  status: InboundEmailStatus;
  attachmentCount: number;
  rawMessageStorageKey?: string;
  quarantineReason?: string;
  processingErrorCode?: string;
  processingErrorMessage?: string;
  correlationId: string;
  createdAt: string;
}

export interface InboundAttachment {
  id: string;
  /** Chýba pri prílohe nezaradeného karanténneho e-mailu. */
  tenantId?: string;
  inboundEmailId: string;
  organizationId?: string;
  originalFileName: string;
  safeFileName: string;
  declaredMimeType?: string;
  detectedMimeType?: string;
  byteSize: number;
  sha256: string;
  storageKey?: string;
  status: AttachmentStatus;
  documentId?: string;
  quarantineReason?: string;
  createdAt: string;
}

// ===== AI extrakcia (SPEC §11.13, §11.17) =====

export interface ExtractionResult {
  schemaVersion: string;
  documentType: DocumentType | 'UNKNOWN';
  supplier: {
    nazov?: string;
    ico?: string;
    dic?: string;
    icDph?: string;
    adresa?: string;
    iban?: string;
  };
  buyer: {
    nazov?: string;
    ico?: string;
    dic?: string;
    icDph?: string;
    adresa?: string;
  };
  invoiceNumber?: string;
  variableSymbol?: string;
  constantSymbol?: string;
  specificSymbol?: string;
  issueDate?: string;
  taxDate?: string;
  dueDate?: string;
  currency?: 'EUR' | 'CZK' | 'USD' | string;
  lineItems: Array<{
    description?: string;
    quantity?: string;
    unit?: string;
    unitPriceWithoutVat?: string;
    vatRate?: '23' | '21' | '19' | '12' | '5' | '0' | string;
    amountWithoutVat?: string;
    vatAmount?: string;
    amountTotal?: string;
  }>;
  vatBreakdown: Array<{
    vatRate: string;
    base: string;
    vat: string;
    total?: string;
  }>;
  totalWithoutVat?: string;
  totalVat?: string;
  totalAmount?: string;
  fieldConfidence: Record<string, number>;
  evidence: Record<string, Array<{ page?: number; text?: string }>>;
  warnings: Array<{
    code: string;
    message: string;
    severity: 'info' | 'warning' | 'error';
  }>;
}

export interface ExtractionRun {
  id: string;
  tenantId: string;
  organizationId: string;
  documentId: string;
  provider: 'mock' | 'openai';
  model?: string;
  promptVersion: string;
  schemaVersion: string;
  status: 'queued' | 'running' | 'succeeded' | 'failed';
  result?: ExtractionResult;
  errorCode?: string;
  errorMessage?: string;
  latencyMs?: number;
  usage?: {
    inputTokens?: number;
    outputTokens?: number;
    estimatedCost?: string;
  };
  startedAt?: string;
  completedAt?: string;
  createdAt: string;
}

// ===== Návrh zaúčtovania (SPEC §11.15) =====

export type SuggestionSource =
  | 'manual_rule'
  | 'supplier_history'
  | 'organization_default'
  | 'ai'
  | 'none';

export interface AccountingSuggestion {
  tenantId: string;
  organizationId: string;
  documentId: string;
  predkontaciaId?: string;
  clenenieDphId?: string;
  ciselnyRadId?: string;
  strediskoId?: string;
  source: SuggestionSource;
  confidence: number;
  reason: string;
  basedOnDocumentId?: string;
  createdAt: string;
}

// ===== Simulácia prijatého e-mailu (SPEC §11.20) =====

export type SimulationScenario =
  | 'uspech'
  | 'nizka_istota'
  | 'duplicita'
  | 'ico_mismatch'
  | 'poskodeny_subor'
  | 'password_protected_pdf'
  | 'ambiguous_recipient'
  | 'nepodporovany_typ';

export interface SimulatedAttachmentInput {
  fileName: string;
  mimeType: string;
  /** deterministický obsah pre SHA-256 duplicate check v mocku */
  contentSeed: string;
}

export interface SimulateInboundEmailInput {
  recipientAlias: string;
  additionalRecipientAliases?: string[];
  sender: string;
  subject: string;
  attachments: SimulatedAttachmentInput[];
  scenario: SimulationScenario;
}

export interface SimulateInboundEmailResult {
  inboundEmail: InboundEmail;
  attachments: InboundAttachment[];
  createdDocumentIds: string[];
}

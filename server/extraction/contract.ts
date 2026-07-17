import { z } from 'zod';

export const EXTRACTION_PROMPT_VERSION = 'invoice-sk-cz-v2';
export const EXTRACTION_SCHEMA_VERSION = '2';
export const SUPPORTED_VAT_RATES = [23, 21, 19, 12, 5, 0] as const;
export const SUPPORTED_EXTRACTION_MIME_TYPES = [
  'application/pdf',
  'image/jpeg',
  'image/png',
  'image/webp',
  // XML (PEPPOL BIS 3.0) sa parsuje deterministicky, bez AI.
  'application/xml',
] as const;

const nullableText = z.string().max(2_000).nullable();
const nullableShortText = z.string().max(300).nullable();
const nullableDecimal = z.string().regex(/^-?\d+(?:[.,]\d+)?$/).nullable();
const nullableIsoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable();

const partyWireSchema = z.object({
  nazov: nullableShortText,
  ico: nullableShortText,
  dic: nullableShortText,
  icDph: nullableShortText,
  adresa: nullableText,
  iban: nullableShortText,
  bic: nullableShortText,
}).strict();

const buyerWireSchema = partyWireSchema.omit({ iban: true, bic: true }).strict();

const lineItemWireSchema = z.object({
  description: nullableText,
  quantity: nullableDecimal,
  unit: nullableShortText,
  unitPriceWithoutVat: nullableDecimal,
  vatRate: nullableDecimal,
  amountWithoutVat: nullableDecimal,
  vatAmount: nullableDecimal,
  amountTotal: nullableDecimal,
}).strict();

const evidenceItemWireSchema = z.object({
  page: z.number().int().positive().nullable(),
  text: nullableText,
}).strict();

// OpenAI strict Structured Outputs nepodporuje record/additionalProperties —
// slovníky sa prenášajú ako polia dvojíc a konvertujú vo fromWireResult.
const fieldConfidenceWireSchema = z.object({
  field: z.string().max(100),
  confidence: z.number().min(0).max(1),
}).strict();

const evidenceFieldWireSchema = z.object({
  field: z.string().max(100),
  items: z.array(evidenceItemWireSchema).max(20),
}).strict();

/** Všetky vlastnosti sú povinné; neznáma hodnota je null. To je stabilné pre Structured Outputs. */
export const extractionWireSchema = z.object({
  schemaVersion: z.string().max(20),
  documentType: z.enum(['FP', 'FV', 'BV', 'MZDY', 'OZ', 'PD', 'UNKNOWN']),
  supplier: partyWireSchema,
  buyer: buyerWireSchema,
  invoiceNumber: nullableShortText,
  orderNumber: nullableShortText,
  deliveryNoteNumber: nullableShortText,
  variableSymbol: nullableShortText,
  constantSymbol: nullableShortText,
  specificSymbol: nullableShortText,
  issueDate: nullableIsoDate,
  taxDate: nullableIsoDate,
  dueDate: nullableIsoDate,
  currency: nullableShortText,
  lineItems: z.array(lineItemWireSchema).max(500),
  vatBreakdown: z.array(z.object({
    vatRate: z.string().regex(/^-?\d+(?:[.,]\d+)?$/),
    base: z.string().regex(/^-?\d+(?:[.,]\d+)?$/),
    vat: z.string().regex(/^-?\d+(?:[.,]\d+)?$/),
    total: nullableDecimal,
  }).strict()).max(20),
  totalWithoutVat: nullableDecimal,
  totalVat: nullableDecimal,
  totalAmount: nullableDecimal,
  fieldConfidence: z.array(fieldConfidenceWireSchema).max(100),
  evidence: z.array(evidenceFieldWireSchema).max(100),
  warnings: z.array(z.object({
    code: z.string().max(100),
    message: z.string().max(1_000),
    severity: z.enum(['info', 'warning', 'error']),
  }).strict()).max(100),
}).strict();

export type ExtractionWireResult = z.infer<typeof extractionWireSchema>;

export interface ExtractionResult {
  schemaVersion: string;
  documentType: 'FP' | 'FV' | 'BV' | 'MZDY' | 'OZ' | 'PD' | 'UNKNOWN';
  supplier: SupplierPartyResult;
  buyer: BuyerPartyResult;
  invoiceNumber?: string;
  orderNumber?: string;
  deliveryNoteNumber?: string;
  variableSymbol?: string;
  constantSymbol?: string;
  specificSymbol?: string;
  issueDate?: string;
  taxDate?: string;
  dueDate?: string;
  currency?: string;
  lineItems: Array<{
    description?: string;
    quantity?: string;
    unit?: string;
    unitPriceWithoutVat?: string;
    vatRate?: string;
    amountWithoutVat?: string;
    vatAmount?: string;
    amountTotal?: string;
  }>;
  vatBreakdown: Array<{ vatRate: string; base: string; vat: string; total?: string }>;
  totalWithoutVat?: string;
  totalVat?: string;
  totalAmount?: string;
  fieldConfidence: Record<string, number>;
  evidence: Record<string, Array<{ page?: number; text?: string }>>;
  warnings: Array<{ code: string; message: string; severity: 'info' | 'warning' | 'error' }>;
}

interface BuyerPartyResult {
  nazov?: string;
  ico?: string;
  dic?: string;
  icDph?: string;
  adresa?: string;
}

interface SupplierPartyResult extends BuyerPartyResult { iban?: string; bic?: string }

function compactParty<T extends Record<string, string | null>>(party: T): Record<string, string> {
  return Object.fromEntries(Object.entries(party).filter(([, value]) => value !== null)) as Record<string, string>;
}

function withoutNulls<T extends Record<string, unknown>>(value: T): Record<string, unknown> {
  return Object.fromEntries(Object.entries(value).filter(([, item]) => item !== null));
}

export function fromWireResult(value: unknown): ExtractionResult {
  const parsed = extractionWireSchema.parse(value);
  return {
    schemaVersion: parsed.schemaVersion,
    documentType: parsed.documentType,
    supplier: compactParty(parsed.supplier),
    buyer: compactParty(parsed.buyer),
    ...withoutNulls({
      invoiceNumber: parsed.invoiceNumber,
      orderNumber: parsed.orderNumber,
      deliveryNoteNumber: parsed.deliveryNoteNumber,
      variableSymbol: parsed.variableSymbol,
      constantSymbol: parsed.constantSymbol,
      specificSymbol: parsed.specificSymbol,
      issueDate: parsed.issueDate,
      taxDate: parsed.taxDate,
      dueDate: parsed.dueDate,
      currency: parsed.currency,
      totalWithoutVat: parsed.totalWithoutVat,
      totalVat: parsed.totalVat,
      totalAmount: parsed.totalAmount,
    }),
    lineItems: parsed.lineItems.map((item) => withoutNulls(item)),
    vatBreakdown: parsed.vatBreakdown.map((item) => withoutNulls(item)) as ExtractionResult['vatBreakdown'],
    fieldConfidence: Object.fromEntries(
      parsed.fieldConfidence.map((entry) => [entry.field, entry.confidence]),
    ),
    evidence: Object.fromEntries(parsed.evidence.map((entry) => [
      entry.field,
      entry.items.map((item) => withoutNulls(item)),
    ])) as ExtractionResult['evidence'],
    warnings: parsed.warnings,
  } as ExtractionResult;
}

/** Runtime kontrola uloženého výsledku; akceptuje už skonvertované optional polia. */
export const extractionResultSchema: z.ZodType<ExtractionResult> = z.object({
  schemaVersion: z.string(),
  documentType: z.enum(['FP', 'FV', 'BV', 'MZDY', 'OZ', 'PD', 'UNKNOWN']),
  supplier: z.object({
    nazov: z.string().optional(), ico: z.string().optional(), dic: z.string().optional(),
    icDph: z.string().optional(), adresa: z.string().optional(), iban: z.string().optional(),
    bic: z.string().optional(),
  }),
  buyer: z.object({
    nazov: z.string().optional(), ico: z.string().optional(), dic: z.string().optional(),
    icDph: z.string().optional(), adresa: z.string().optional(),
  }),
  invoiceNumber: z.string().optional(), orderNumber: z.string().optional(),
  deliveryNoteNumber: z.string().optional(), variableSymbol: z.string().optional(),
  constantSymbol: z.string().optional(), specificSymbol: z.string().optional(),
  issueDate: z.string().optional(), taxDate: z.string().optional(), dueDate: z.string().optional(),
  currency: z.string().optional(),
  lineItems: z.array(z.object({
    description: z.string().optional(), quantity: z.string().optional(), unit: z.string().optional(),
    unitPriceWithoutVat: z.string().optional(), vatRate: z.string().optional(),
    amountWithoutVat: z.string().optional(), vatAmount: z.string().optional(), amountTotal: z.string().optional(),
  })),
  vatBreakdown: z.array(z.object({ vatRate: z.string(), base: z.string(), vat: z.string(), total: z.string().optional() })),
  totalWithoutVat: z.string().optional(), totalVat: z.string().optional(), totalAmount: z.string().optional(),
  fieldConfidence: z.record(z.number().min(0).max(1)),
  evidence: z.record(z.array(z.object({ page: z.number().optional(), text: z.string().optional() }))),
  warnings: z.array(z.object({ code: z.string(), message: z.string(), severity: z.enum(['info', 'warning', 'error']) })),
});

export interface ExtractionInput {
  documentId: string;
  mimeType: typeof SUPPORTED_EXTRACTION_MIME_TYPES[number];
  fileName: string;
  bytes: Uint8Array;
  organizationContext: { nazov: string; ico: string; dic?: string; icDph?: string };
  promptVersion: string;
  schemaVersion: string;
}

export interface ExtractionOutcome {
  result: ExtractionResult;
  model?: string;
  requestId?: string;
  usage?: { inputTokens?: number; outputTokens?: number };
}

export interface ServerDocumentExtractionProvider {
  readonly name: 'mock' | 'openai' | 'peppol' | 'sepa';
  extract(input: ExtractionInput): Promise<ExtractionOutcome>;
}

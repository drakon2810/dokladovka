// Runtime validačné schémy (zod) — SPEC §11.12/§11.13:
// odpoveď extraction providera sa nesmie zapísať do DocumentItem,
// kým neprejde deterministickou runtime validáciou.
import { z } from 'zod';
import { isValidIsoDate } from './validation/documentValidation';
import { validateIBAN } from '../lib/validate';

export const vatRateSchema = z.number().finite().min(0).max(100);

export const vatBreakdownRowSchema = z.object({
  sadzba: vatRateSchema,
  zaklad: z.number(),
  dph: z.number(),
});

export const documentTypeSchema = z.enum(['FP', 'FV', 'BV', 'MZDY', 'OZ', 'PD']);

const requiredIsoDateString = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/)
  .refine(isValidIsoDate);

export const createDocumentInputSchema = z.object({
  organizationId: z.string().trim().min(1),
  queueId: z.string().trim().min(1).optional(),
  typ: documentTypeSchema,
  mode: z.enum(['manual', 'upload']),
  supplierName: z.string().trim().max(200).default(''),
  invoiceNumber: z.string().trim().max(100).default(''),
  issueDate: requiredIsoDateString,
  taxDate: requiredIsoDateString.optional(),
  dueDate: requiredIsoDateString.optional(),
  currency: z.enum(['EUR', 'CZK', 'USD']),
  totalAmount: z.number().finite().min(0),
  vatRate: vatRateSchema,
});
export type CreateDocumentDataInput = z.infer<typeof createDocumentInputSchema>;

export const bankAccountInputSchema = z.object({
  organizationId: z.string().trim().min(1),
  label: z.string().trim().min(1).max(100),
  iban: z
    .string()
    .transform((value) => value.replace(/\s/g, '').toUpperCase())
    .refine(validateIBAN),
  bic: z
    .string()
    .trim()
    .toUpperCase()
    .regex(/^[A-Z]{6}[A-Z0-9]{2}(?:[A-Z0-9]{3})?$/)
    .optional()
    .or(z.literal('').transform(() => undefined)),
  currency: z.enum(['EUR', 'CZK', 'USD']),
  isDefault: z.boolean(),
});
export type BankAccountInput = z.infer<typeof bankAccountInputSchema>;

export const organizationInputSchema = z.object({
  nazov: z.string().trim().min(1, 'Názov je povinný'),
  // Prázdne IČO/DIČ je dovolené len pre FO nepodnikateľa (kontrola vo formulári/serveri).
  ico: z.string().regex(/^\d{8}$/, 'IČO musí mať presne 8 číslic').or(z.literal('')),
  dic: z.string().regex(/^\d{10}$/, 'DIČ musí mať 10 číslic').or(z.literal('')),
  icDph: z
    .string()
    .regex(/^SK\d{10}$/, 'IČ DPH musí mať tvar SK + 10 číslic')
    .optional()
    .or(z.literal('').transform(() => undefined)),
  farba: z.string().regex(/^#[0-9a-fA-F]{6}$/, 'Farba musí byť hex kód'),
  /** voliteľný návrh slugu — nikdy nie celá adresa (SPEC §11.19) */
  slugSuggestion: z.string().max(64).optional(),
  typSubjektu: z.enum(['company', 'fo_nepodnikatel']).default('company'),
  ulica: z.string().trim().max(200).optional().or(z.literal('').transform(() => undefined)),
  mesto: z.string().trim().max(120).optional().or(z.literal('').transform(() => undefined)),
  psc: z.string().trim().max(12).optional().or(z.literal('').transform(() => undefined)),
  krajina: z.string().trim().max(56).optional().or(z.literal('').transform(() => undefined)),
  senderWhitelist: z.array(z.string().trim().min(3).max(200)).max(200).optional(),
});
export type OrganizationInput = z.input<typeof organizationInputSchema>;

// E-mail alias — validácia formátu local-part@domain (SPEC §11.2/§11.3)
export const emailAliasSchema = z
  .string()
  .regex(
    /^[a-z0-9](?:[a-z0-9-]{0,62})@[a-z0-9.-]+\.[a-z]{2,}$/,
    'Neplatný formát e-mailovej adresy',
  )
  .refine((v) => v.split('@')[0].length <= 64, 'Local-part max 64 znakov');

const decimalString = z.string().regex(/^-?\d+(?:[.,]\d+)?$/).optional();
const isoDateString = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/)
  .refine(isValidIsoDate, 'Neplatný kalendárny dátum')
  .optional();

// Kontrakt AI extrakcie (SPEC §11.13) — stringové sumy, ISO dátumy po normalizácii
export const extractionResultSchema = z.object({
  schemaVersion: z.string(),
  documentType: z.union([documentTypeSchema, z.literal('UNKNOWN')]),
  supplier: z.object({
    nazov: z.string().optional(),
    ico: z.string().optional(),
    dic: z.string().optional(),
    icDph: z.string().optional(),
    adresa: z.string().optional(),
    iban: z.string().optional(),
  }),
  buyer: z.object({
    nazov: z.string().optional(),
    ico: z.string().optional(),
    dic: z.string().optional(),
    icDph: z.string().optional(),
    adresa: z.string().optional(),
  }),
  invoiceNumber: z.string().optional(),
  variableSymbol: z.string().optional(),
  constantSymbol: z.string().optional(),
  specificSymbol: z.string().optional(),
  issueDate: isoDateString,
  taxDate: isoDateString,
  dueDate: isoDateString,
  currency: z.string().optional(),
  lineItems: z.array(
    z.object({
      description: z.string().optional(),
      quantity: z.string().optional(),
      unit: z.string().optional(),
      unitPriceWithoutVat: decimalString,
      vatRate: z.string().optional(),
      amountWithoutVat: decimalString,
      vatAmount: decimalString,
      amountTotal: decimalString,
    }),
  ),
  vatBreakdown: z.array(
    z.object({
      vatRate: z.string(),
      base: z.string(),
      vat: z.string(),
      total: z.string().optional(),
    }),
  ),
  totalWithoutVat: decimalString,
  totalVat: decimalString,
  totalAmount: decimalString,
  fieldConfidence: z.record(z.number().min(0).max(1)),
  evidence: z.record(z.array(z.object({ page: z.number().optional(), text: z.string().optional() }))),
  warnings: z.array(
    z.object({
      code: z.string(),
      message: z.string(),
      severity: z.enum(['info', 'warning', 'error']),
    }),
  ),
});

export const simulateInboundEmailInputSchema = z.object({
  recipientAlias: z.string().trim().min(1),
  additionalRecipientAliases: z.array(z.string().trim().min(1)).max(4).optional(),
  sender: z.string().trim().min(1),
  subject: z.string(),
  attachments: z
    .array(
      z.object({
        fileName: z.string().min(1),
        mimeType: z.string().min(1),
        contentSeed: z.string(),
      }),
    )
    .min(0)
    .max(20), // MAX_ATTACHMENTS_PER_EMAIL (SPEC §11.8)
  scenario: z.enum([
    'uspech',
    'nizka_istota',
    'duplicita',
    'ico_mismatch',
    'poskodeny_subor',
    'password_protected_pdf',
    'ambiguous_recipient',
    'nepodporovany_typ',
  ]),
});

import type {
  ExtractionInput,
  ExtractionOutcome,
  ExtractionResult,
  ServerDocumentExtractionProvider,
} from './contract.js';

export interface MockExtractionHints {
  supplierName?: string;
  supplierIco?: string;
  buyerIco?: string;
  invoiceNumber?: string;
  issueDate?: string;
  taxDate?: string;
  dueDate?: string;
  currency?: string;
  totalAmount?: number;
  documentType?: string;
}

function addDays(value: string, days: number): string {
  const date = new Date(`${value}T00:00:00.000Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

export class MockServerDocumentExtractionProvider implements ServerDocumentExtractionProvider {
  readonly name = 'mock' as const;

  constructor(private readonly hints: MockExtractionHints = {}) {}

  async extract(input: ExtractionInput): Promise<ExtractionOutcome> {
    const issueDate = this.hints.issueDate ?? new Date().toISOString().slice(0, 10);
    const total = Number.isFinite(this.hints.totalAmount) ? Number(this.hints.totalAmount) : 0;
    const documentType = ['FP', 'FV', 'BV', 'MZDY', 'OZ', 'PD'].includes(this.hints.documentType ?? '')
      ? this.hints.documentType as ExtractionResult['documentType']
      : 'FP';
    return {
      result: {
        schemaVersion: input.schemaVersion,
        documentType,
        supplier: {
          nazov: this.hints.supplierName ?? 'Neznámy dodávateľ',
          ico: this.hints.supplierIco,
        },
        buyer: { nazov: input.organizationContext.nazov, ico: this.hints.buyerIco ?? input.organizationContext.ico },
        invoiceNumber: this.hints.invoiceNumber ?? '',
        issueDate,
        taxDate: this.hints.taxDate ?? issueDate,
        dueDate: this.hints.dueDate ?? addDays(issueDate, 14),
        currency: this.hints.currency ?? 'EUR',
        lineItems: [],
        vatBreakdown: [{ vatRate: '0', base: String(total), vat: '0', total: String(total) }],
        totalWithoutVat: String(total),
        totalVat: '0',
        totalAmount: String(total),
        fieldConfidence: {
          'supplier.nazov': 0.5,
          'buyer.ico': 0.9,
          invoiceNumber: this.hints.invoiceNumber ? 0.8 : 0.2,
          issueDate: 0.8,
          totalAmount: 0.8,
        },
        evidence: {},
        warnings: [],
      },
      model: 'deterministic-mock',
    };
  }
}

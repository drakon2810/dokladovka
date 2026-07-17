// Deterministický parser PEPPOL BIS Billing 3.0 (UBL 2.1 Invoice/CreditNote).
// Žiadne AI: dáta sú štruktúrované, extrakcia je bezplatná, okamžitá a confidence 1.0.
import { XMLParser } from 'fast-xml-parser';
import {
  EXTRACTION_SCHEMA_VERSION,
  type ExtractionInput,
  type ExtractionOutcome,
  type ExtractionResult,
  type ServerDocumentExtractionProvider,
} from './contract.js';
import { ExtractionProviderError } from './openaiProvider.js';

function asArray<T>(value: T | T[] | undefined): T[] {
  if (value === undefined || value === null) return [];
  return Array.isArray(value) ? value : [value];
}

/** cbc elementy majú buď priamu hodnotu, alebo objekt { '#text': ..., '@_attr': ... }. */
function text(value: unknown): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value === 'object') {
    const inner = (value as Record<string, unknown>)['#text'];
    return inner === undefined || inner === null ? undefined : String(inner).trim() || undefined;
  }
  const normalized = String(value).trim();
  return normalized || undefined;
}

function decimal(value: unknown): string | undefined {
  const raw = text(value);
  if (!raw) return undefined;
  return /^-?\d+(?:[.,]\d+)?$/.test(raw) ? raw : undefined;
}

function isoDate(value: unknown): string | undefined {
  const raw = text(value);
  return raw && /^\d{4}-\d{2}-\d{2}/.test(raw) ? raw.slice(0, 10) : undefined;
}

interface PartyFields {
  nazov?: string;
  ico?: string;
  dic?: string;
  icDph?: string;
  adresa?: string;
}

function parseParty(party: Record<string, any> | undefined): PartyFields {
  if (!party) return {};
  const legalEntity = asArray(party.PartyLegalEntity)[0] ?? {};
  const nazov = text(legalEntity.RegistrationName)
    ?? text(asArray(party.PartyName)[0]?.Name);

  // IČO: PartyLegalEntity/CompanyID (SK schemeID 0158) alebo PartyIdentification/ID.
  const idCandidates = [
    text(legalEntity.CompanyID),
    ...asArray(party.PartyIdentification).map((entry: any) => text(entry?.ID)),
  ].filter((value): value is string => !!value);
  const ico = idCandidates.map((value) => value.replace(/\s/g, '')).find((value) => /^\d{8}$/.test(value));

  // IČ DPH / DIČ: PartyTaxScheme/CompanyID (SKxxxxxxxxxx, CZxxxxxxxx alebo len číslice).
  const taxIds = asArray(party.PartyTaxScheme)
    .map((entry: any) => text(entry?.CompanyID)?.replace(/\s/g, '').toUpperCase())
    .filter((value): value is string => !!value);
  const icDph = taxIds.find((value) => /^(?:SK|CZ)/.test(value));
  const dic = taxIds.find((value) => /^\d{8,10}$/.test(value)) ?? (icDph?.startsWith('SK') ? icDph.slice(2) : undefined);

  const address = asArray(party.PostalAddress)[0];
  const adresa = address
    ? [
        [text(address.StreetName), text(address.BuildingNumber)].filter(Boolean).join(' '),
        [text(address.PostalZone), text(address.CityName)].filter(Boolean).join(' '),
        text(asArray(address.Country)[0]?.IdentificationCode),
      ].filter(Boolean).join('\n') || undefined
    : undefined;

  return { nazov, ico, dic, icDph, adresa };
}

function confidenceFor(fields: Record<string, unknown>): Record<string, number> {
  const confidence: Record<string, number> = {};
  for (const [key, value] of Object.entries(fields)) {
    if (value !== undefined && value !== '') confidence[key] = 1;
  }
  return confidence;
}

export class PeppolDocumentExtractionProvider implements ServerDocumentExtractionProvider {
  readonly name = 'peppol' as const;

  async extract(input: ExtractionInput): Promise<ExtractionOutcome> {
    let root: Record<string, any>;
    try {
      const parser = new XMLParser({
        ignoreAttributes: false,
        attributeNamePrefix: '@_',
        removeNSPrefix: true,
        parseTagValue: false,
        parseAttributeValue: false,
      });
      root = parser.parse(Buffer.from(input.bytes).toString('utf8'));
    } catch {
      throw new ExtractionProviderError('corrupted_file', 'XML súbor sa nedá spracovať', false);
    }

    const isCreditNote = !!root.CreditNote;
    const doc = root.Invoice ?? root.CreditNote;
    if (!doc) {
      throw new ExtractionProviderError('unsupported_xml', 'XML nie je PEPPOL BIS faktúra', false);
    }

    const supplierParty = asArray(doc.AccountingSupplierParty)[0]?.Party;
    const buyerParty = asArray(doc.AccountingCustomerParty)[0]?.Party;
    const supplier = parseParty(supplierParty);
    const buyer = parseParty(buyerParty);

    const paymentMeans = asArray(doc.PaymentMeans)[0];
    const iban = text(asArray(paymentMeans?.PayeeFinancialAccount)[0]?.ID)?.replace(/\s/g, '');
    const paymentId = text(paymentMeans?.PaymentID);
    // SK konvencia: PaymentID býva variabilný symbol (číslo), inak fallback na číslo faktúry.
    const variableSymbol = paymentId && /^\d{1,10}$/.test(paymentId) ? paymentId : undefined;

    const taxTotal = asArray(doc.TaxTotal)[0];
    const vatBreakdown = asArray(taxTotal?.TaxSubtotal).flatMap((subtotal: any) => {
      const base = decimal(subtotal?.TaxableAmount);
      const vat = decimal(subtotal?.TaxAmount);
      const rate = decimal(asArray(subtotal?.TaxCategory)[0]?.Percent) ?? '0';
      return base !== undefined && vat !== undefined ? [{ vatRate: rate, base, vat }] : [];
    });

    const monetary = asArray(doc.LegalMonetaryTotal)[0];
    const totalAmount = decimal(monetary?.TaxInclusiveAmount) ?? decimal(monetary?.PayableAmount);
    const totalWithoutVat = decimal(monetary?.TaxExclusiveAmount);
    const totalVat = decimal(taxTotal?.TaxAmount);

    const lines = asArray(isCreditNote ? doc.CreditNoteLine : doc.InvoiceLine).map((line: any) => {
      const item = asArray(line?.Item)[0] ?? {};
      const quantityNode = isCreditNote ? line?.CreditedQuantity : line?.InvoicedQuantity;
      return {
        description: text(item.Name) ?? text(item.Description),
        quantity: decimal(quantityNode),
        unit: typeof quantityNode === 'object' ? text(quantityNode?.['@_unitCode']) : undefined,
        unitPriceWithoutVat: decimal(asArray(line?.Price)[0]?.PriceAmount),
        vatRate: decimal(asArray(item.ClassifiedTaxCategory)[0]?.Percent),
        amountWithoutVat: decimal(line?.LineExtensionAmount),
        vatAmount: undefined,
        amountTotal: undefined,
      };
    });

    const invoiceNumber = text(doc.ID);
    const orderNumber = text(asArray(doc.OrderReference)[0]?.ID);
    const deliveryNoteNumber = text(asArray(doc.DespatchDocumentReference)[0]?.ID);
    const issueDate = isoDate(doc.IssueDate);
    const dueDate = isoDate(doc.DueDate) ?? isoDate(asArray(doc.PaymentMeans)[0]?.PaymentDueDate);
    const taxDate = isoDate(doc.TaxPointDate) ?? isoDate(asArray(doc.Delivery)[0]?.ActualDeliveryDate) ?? issueDate;
    const currency = text(doc.DocumentCurrencyCode);

    const result: ExtractionResult = {
      schemaVersion: EXTRACTION_SCHEMA_VERSION,
      documentType: 'FP',
      supplier: { ...supplier, iban },
      buyer,
      invoiceNumber,
      orderNumber,
      deliveryNoteNumber,
      variableSymbol,
      issueDate,
      taxDate,
      dueDate,
      currency,
      lineItems: lines,
      vatBreakdown,
      totalWithoutVat,
      totalVat,
      totalAmount,
      fieldConfidence: confidenceFor({
        'supplier.nazov': supplier.nazov,
        'supplier.ico': supplier.ico,
        'supplier.icDph': supplier.icDph,
        'buyer.nazov': buyer.nazov,
        'buyer.ico': buyer.ico,
        invoiceNumber,
        issueDate,
        taxDate,
        dueDate,
        totalAmount,
        vatBreakdown: vatBreakdown.length > 0 ? 'yes' : undefined,
      }),
      evidence: {},
      warnings: isCreditNote
        ? [{ code: 'peppol_credit_note', message: 'Dokument je dobropis (CreditNote) — skontrolujte znamienka súm', severity: 'warning' }]
        : [],
    };

    return { result, model: 'peppol-bis-3.0' };
  }
}

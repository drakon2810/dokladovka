import { describe, expect, it } from 'vitest';
import { classifyXml, looksLikeXml } from '../inbound/xmlClassifier.js';
import { PeppolDocumentExtractionProvider } from './peppolProvider.js';
import { EXTRACTION_SCHEMA_VERSION, extractionResultSchema, type ExtractionInput } from './contract.js';
import { normalizeExtractionResult, validateExtractionResult } from './normalize.js';

const UBL_INVOICE = `<?xml version="1.0" encoding="UTF-8"?>
<Invoice xmlns="urn:oasis:names:specification:ubl:schema:xsd:Invoice-2"
  xmlns:cac="urn:oasis:names:specification:ubl:schema:xsd:CommonAggregateComponents-2"
  xmlns:cbc="urn:oasis:names:specification:ubl:schema:xsd:CommonBasicComponents-2">
  <cbc:CustomizationID>urn:cen.eu:en16931:2017#compliant#urn:fdc:peppol.eu:2017:poacc:billing:3.0</cbc:CustomizationID>
  <cbc:ID>FA-2026-0042</cbc:ID>
  <cbc:IssueDate>2026-07-01</cbc:IssueDate>
  <cbc:DueDate>2026-07-15</cbc:DueDate>
  <cbc:InvoiceTypeCode>380</cbc:InvoiceTypeCode>
  <cbc:DocumentCurrencyCode>EUR</cbc:DocumentCurrencyCode>
  <cac:AccountingSupplierParty><cac:Party>
    <cac:PartyIdentification><cbc:ID schemeID="0158">11223344</cbc:ID></cac:PartyIdentification>
    <cac:PostalAddress>
      <cbc:StreetName>Hlavná</cbc:StreetName><cbc:BuildingNumber>1</cbc:BuildingNumber>
      <cbc:CityName>Bratislava</cbc:CityName><cbc:PostalZone>81101</cbc:PostalZone>
      <cac:Country><cbc:IdentificationCode>SK</cbc:IdentificationCode></cac:Country>
    </cac:PostalAddress>
    <cac:PartyTaxScheme><cbc:CompanyID>SK2021234567</cbc:CompanyID><cac:TaxScheme><cbc:ID>VAT</cbc:ID></cac:TaxScheme></cac:PartyTaxScheme>
    <cac:PartyLegalEntity><cbc:RegistrationName>Dodávateľ SK s.r.o.</cbc:RegistrationName><cbc:CompanyID schemeID="0158">11223344</cbc:CompanyID></cac:PartyLegalEntity>
  </cac:Party></cac:AccountingSupplierParty>
  <cac:AccountingCustomerParty><cac:Party>
    <cac:PartyTaxScheme><cbc:CompanyID>SK2020123456</cbc:CompanyID><cac:TaxScheme><cbc:ID>VAT</cbc:ID></cac:TaxScheme></cac:PartyTaxScheme>
    <cac:PartyLegalEntity><cbc:RegistrationName>Alfa Trade s.r.o.</cbc:RegistrationName><cbc:CompanyID schemeID="0158">36528221</cbc:CompanyID></cac:PartyLegalEntity>
  </cac:Party></cac:AccountingCustomerParty>
  <cac:Delivery><cbc:ActualDeliveryDate>2026-06-30</cbc:ActualDeliveryDate></cac:Delivery>
  <cac:PaymentMeans>
    <cbc:PaymentMeansCode>30</cbc:PaymentMeansCode>
    <cbc:PaymentID>20260042</cbc:PaymentID>
    <cac:PayeeFinancialAccount><cbc:ID>SK3112000000198742637541</cbc:ID></cac:PayeeFinancialAccount>
  </cac:PaymentMeans>
  <cac:TaxTotal>
    <cbc:TaxAmount currencyID="EUR">230.00</cbc:TaxAmount>
    <cac:TaxSubtotal>
      <cbc:TaxableAmount currencyID="EUR">1000.00</cbc:TaxableAmount>
      <cbc:TaxAmount currencyID="EUR">230.00</cbc:TaxAmount>
      <cac:TaxCategory><cbc:ID>S</cbc:ID><cbc:Percent>23</cbc:Percent><cac:TaxScheme><cbc:ID>VAT</cbc:ID></cac:TaxScheme></cac:TaxCategory>
    </cac:TaxSubtotal>
  </cac:TaxTotal>
  <cac:LegalMonetaryTotal>
    <cbc:LineExtensionAmount currencyID="EUR">1000.00</cbc:LineExtensionAmount>
    <cbc:TaxExclusiveAmount currencyID="EUR">1000.00</cbc:TaxExclusiveAmount>
    <cbc:TaxInclusiveAmount currencyID="EUR">1230.00</cbc:TaxInclusiveAmount>
    <cbc:PayableAmount currencyID="EUR">1230.00</cbc:PayableAmount>
  </cac:LegalMonetaryTotal>
  <cac:InvoiceLine>
    <cbc:ID>1</cbc:ID>
    <cbc:InvoicedQuantity unitCode="C62">10</cbc:InvoicedQuantity>
    <cbc:LineExtensionAmount currencyID="EUR">1000.00</cbc:LineExtensionAmount>
    <cac:Item><cbc:Name>Konzultačné služby</cbc:Name>
      <cac:ClassifiedTaxCategory><cbc:ID>S</cbc:ID><cbc:Percent>23</cbc:Percent><cac:TaxScheme><cbc:ID>VAT</cbc:ID></cac:TaxScheme></cac:ClassifiedTaxCategory>
    </cac:Item>
    <cac:Price><cbc:PriceAmount currencyID="EUR">100.00</cbc:PriceAmount></cac:Price>
  </cac:InvoiceLine>
</Invoice>`;

const CAMT053 = `<?xml version="1.0" encoding="UTF-8"?>
<Document xmlns="urn:iso:std:iso:20022:tech:xsd:camt.053.001.08"><BkToCstmrStmt/></Document>`;

function input(bytes: Uint8Array): ExtractionInput {
  return {
    documentId: 'doc-x', mimeType: 'application/xml', fileName: 'faktura.xml', bytes,
    organizationContext: { nazov: 'Alfa Trade s.r.o.', ico: '36528221' },
    promptVersion: 'invoice-sk-cz-v2', schemaVersion: EXTRACTION_SCHEMA_VERSION,
  };
}

describe('xmlClassifier', () => {
  it('rozpozná PEPPOL faktúru, SEPA výpis a neznáme XML', () => {
    expect(classifyXml(Buffer.from(UBL_INVOICE))).toBe('peppol_invoice');
    expect(classifyXml(Buffer.from(CAMT053))).toBe('sepa_camt053');
    expect(classifyXml(Buffer.from('<objednavka><cislo>1</cislo></objednavka>'))).toBe('unknown_xml');
  });

  it('looksLikeXml akceptuje BOM aj whitespace, odmieta binárky', () => {
    expect(looksLikeXml(Buffer.from('﻿  <?xml version="1.0"?><a/>'))).toBe(true);
    expect(looksLikeXml(Buffer.from('%PDF-1.7'))).toBe(false);
  });
});

describe('PeppolDocumentExtractionProvider', () => {
  it('extrahuje faktúru deterministicky s confidence 1.0', async () => {
    const provider = new PeppolDocumentExtractionProvider();
    const outcome = await provider.extract(input(Buffer.from(UBL_INVOICE)));
    const result = extractionResultSchema.parse(outcome.result);

    expect(outcome.model).toBe('peppol-bis-3.0');
    expect(result.documentType).toBe('FP');
    expect(result.supplier.nazov).toBe('Dodávateľ SK s.r.o.');
    expect(result.supplier.ico).toBe('11223344');
    expect(result.supplier.icDph).toBe('SK2021234567');
    expect(result.supplier.iban).toBe('SK3112000000198742637541');
    expect(result.buyer.nazov).toBe('Alfa Trade s.r.o.');
    expect(result.buyer.ico).toBe('36528221');
    expect(result.invoiceNumber).toBe('FA-2026-0042');
    expect(result.variableSymbol).toBe('20260042');
    expect(result.issueDate).toBe('2026-07-01');
    expect(result.taxDate).toBe('2026-06-30');
    expect(result.dueDate).toBe('2026-07-15');
    expect(result.currency).toBe('EUR');
    expect(result.totalAmount).toBe('1230.00');
    expect(result.vatBreakdown).toEqual([{ vatRate: '23', base: '1000.00', vat: '230.00' }]);
    expect(result.lineItems).toHaveLength(1);
    expect(result.lineItems[0]).toMatchObject({
      description: 'Konzultačné služby', quantity: '10', unit: 'C62',
      unitPriceWithoutVat: '100.00', vatRate: '23', amountWithoutVat: '1000.00',
    });
    expect(result.fieldConfidence.invoiceNumber).toBe(1);
  });

  it('výsledok prejde normalizáciou a validáciou bez chýb pre správne IČO', async () => {
    const provider = new PeppolDocumentExtractionProvider();
    const outcome = await provider.extract(input(Buffer.from(UBL_INVOICE)));
    const normalized = normalizeExtractionResult(outcome.result, 'doc-x', '2026-07-01');
    const issues = validateExtractionResult(outcome.result, normalized, { ico: '36528221' });
    expect(issues.filter((issue) => issue.severity === 'error')).toEqual([]);
    expect(normalized.totalAmount).toBe(1230);
    expect(normalized.confidence).toBe(1);
  });

  it('cudzie IČO odberateľa spustí buyer_ico_mismatch', async () => {
    const provider = new PeppolDocumentExtractionProvider();
    const outcome = await provider.extract(input(Buffer.from(UBL_INVOICE)));
    const normalized = normalizeExtractionResult(outcome.result, 'doc-x', '2026-07-01');
    const issues = validateExtractionResult(outcome.result, normalized, { ico: '99999999' });
    expect(issues.map((issue) => issue.code)).toContain('buyer_ico_mismatch');
  });

  it('ne-PEPPOL XML odmietne s unsupported_xml', async () => {
    const provider = new PeppolDocumentExtractionProvider();
    await expect(provider.extract(input(Buffer.from('<a><b/></a>')))).rejects.toMatchObject({ code: 'unsupported_xml' });
  });
});

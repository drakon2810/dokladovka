import { describe, expect, it } from 'vitest';
import { SepaStatementExtractionProvider } from './sepaProvider.js';
import { EXTRACTION_SCHEMA_VERSION, extractionResultSchema, type ExtractionInput } from './contract.js';
import { normalizeExtractionResult } from './normalize.js';

const CAMT053 = `<?xml version="1.0" encoding="UTF-8"?>
<Document xmlns="urn:iso:std:iso:20022:tech:xsd:camt.053.001.08">
 <BkToCstmrStmt>
  <GrpHdr><MsgId>MSG-1</MsgId><CreDtTm>2026-07-01T04:00:00</CreDtTm></GrpHdr>
  <Stmt>
   <Id>VYPIS-2026-06</Id>
   <CreDtTm>2026-07-01T04:00:00</CreDtTm>
   <FrToDt><FrDtTm>2026-06-01T00:00:00</FrDtTm><ToDtTm>2026-06-30T23:59:59</ToDtTm></FrToDt>
   <Acct>
    <Id><IBAN>SK9211000000002621340234</IBAN></Id>
    <Ccy>EUR</Ccy>
    <Ownr><Nm>Alfa Trade s.r.o.</Nm></Ownr>
    <Svcr><FinInstnId><Nm>Tatra banka, a.s.</Nm></FinInstnId></Svcr>
   </Acct>
   <Bal><Tp><CdOrPrtry><Cd>OPBD</Cd></CdOrPrtry></Tp><Amt Ccy="EUR">1500.00</Amt><CdtDbtInd>CRDT</CdtDbtInd></Bal>
   <Bal><Tp><CdOrPrtry><Cd>CLBD</Cd></CdOrPrtry></Tp><Amt Ccy="EUR">2115.00</Amt><CdtDbtInd>CRDT</CdtDbtInd></Bal>
   <Ntry>
    <Amt Ccy="EUR">1230.00</Amt><CdtDbtInd>CRDT</CdtDbtInd><Sts><Cd>BOOK</Cd></Sts>
    <BookgDt><Dt>2026-06-15</Dt></BookgDt>
    <NtryDtls><TxDtls>
     <RltdPties><Dbtr><Nm>Odberateľ Alfa, s.r.o.</Nm></Dbtr></RltdPties>
     <RmtInf><Ustrd>Uhrada faktury 2026-001</Ustrd></RmtInf>
    </TxDtls></NtryDtls>
   </Ntry>
   <Ntry>
    <Amt Ccy="EUR">615.00</Amt><CdtDbtInd>DBIT</CdtDbtInd><Sts><Cd>BOOK</Cd></Sts>
    <BookgDt><Dt>2026-06-20</Dt></BookgDt>
    <NtryDtls><TxDtls>
     <RltdPties><Cdtr><Nm>Elektro Svetlo s.r.o.</Nm></Cdtr></RltdPties>
     <RmtInf><Ustrd>EF-2026-0777</Ustrd></RmtInf>
    </TxDtls></NtryDtls>
   </Ntry>
  </Stmt>
 </BkToCstmrStmt>
</Document>`;

function input(bytes: Uint8Array): ExtractionInput {
  return {
    documentId: 'doc-bv', mimeType: 'application/xml', fileName: 'vypis.xml', bytes,
    organizationContext: { nazov: 'Alfa Trade s.r.o.', ico: '36528221' },
    promptVersion: 'invoice-sk-cz-v2', schemaVersion: EXTRACTION_SCHEMA_VERSION,
  };
}

describe('SepaStatementExtractionProvider', () => {
  it('parsuje výpis: účet, zostatky, transakcie so znamienkami', async () => {
    const provider = new SepaStatementExtractionProvider();
    const outcome = await provider.extract(input(Buffer.from(CAMT053)));
    const result = extractionResultSchema.parse(outcome.result);

    expect(outcome.model).toBe('camt.053');
    expect(result.documentType).toBe('BV');
    expect(result.supplier.nazov).toBe('Tatra banka, a.s.');
    expect(result.supplier.iban).toBe('SK9211000000002621340234');
    expect(result.buyer.nazov).toBe('Alfa Trade s.r.o.');
    expect(result.invoiceNumber).toBe('VYPIS-2026-06');
    expect(result.issueDate).toBe('2026-06-30');
    expect(result.currency).toBe('EUR');
    expect(result.totalAmount).toBe('2115.00');
    expect(result.lineItems).toHaveLength(2);
    expect(result.lineItems[0].description).toContain('Odberateľ Alfa');
    expect(result.lineItems[0].amountTotal).toBe('1230.00');
    expect(result.lineItems[1].description).toContain('Elektro Svetlo');
    expect(result.lineItems[1].amountTotal).toBe('-615.00');
    expect(result.warnings[0].code).toBe('sepa_statement_summary');
    expect(result.warnings[0].message).toContain('2 transakcií');
  });

  it('normalizácia zachová podpísané sumy transakcií', async () => {
    const provider = new SepaStatementExtractionProvider();
    const outcome = await provider.extract(input(Buffer.from(CAMT053)));
    const normalized = normalizeExtractionResult(outcome.result, 'doc-bv', '2026-06-30');
    const items = (normalized.extracted as any).polozky;
    expect(items[0].sumaSpolu).toBe(1230);
    expect(items[1].sumaSpolu).toBe(-615);
    expect(normalized.totalAmount).toBe(2115);
    expect(normalized.documentType).toBe('BV');
  });

  it('ne-camt XML odmietne', async () => {
    const provider = new SepaStatementExtractionProvider();
    await expect(provider.extract(input(Buffer.from('<Document><Iny/></Document>'))))
      .rejects.toMatchObject({ code: 'unsupported_xml' });
  });
});

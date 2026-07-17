// Deterministický parser SEPA výpisu ISO 20022 camt.053 → doklad typu BV.
// Transakcie sa mapujú na položky dokladu; sumy sú podpísané (kredit +, debet −).
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

function text(value: unknown): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value === 'object') {
    const inner = (value as Record<string, unknown>)['#text'];
    return inner === undefined || inner === null ? undefined : String(inner).trim() || undefined;
  }
  const normalized = String(value).trim();
  return normalized || undefined;
}

function isoDate(value: unknown): string | undefined {
  const raw = text(value);
  return raw && /^\d{4}-\d{2}-\d{2}/.test(raw) ? raw.slice(0, 10) : undefined;
}

function skDate(value: string | undefined): string {
  if (!value) return '';
  const [year, month, day] = value.split('-');
  return `${day}.${month}.${year}`;
}

interface SignedAmount { value: string; numeric: number }

/** Amt + CdtDbtInd → podpísaná suma (DBIT je záporný pohyb na účte). */
function signedAmount(amt: unknown, cdtDbtInd: unknown): SignedAmount | undefined {
  const raw = text(amt);
  if (!raw || !/^\d+(?:\.\d+)?$/.test(raw)) return undefined;
  const debit = text(cdtDbtInd) === 'DBIT';
  const value = debit ? `-${raw}` : raw;
  return { value, numeric: Number(value) };
}

function balanceOf(balances: any[], code: string): { amount?: SignedAmount; currency?: string } {
  const entry = balances.find((bal) => text(asArray(bal?.Tp)[0]?.CdOrPrtry?.Cd) === code);
  if (!entry) return {};
  return {
    amount: signedAmount(entry.Amt, entry.CdtDbtInd),
    currency: typeof entry.Amt === 'object' ? text(entry.Amt?.['@_Ccy']) : undefined,
  };
}

export class SepaStatementExtractionProvider implements ServerDocumentExtractionProvider {
  readonly name = 'sepa' as const;

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

    const statements = asArray(root.Document?.BkToCstmrStmt?.Stmt);
    const statement = statements[0];
    if (!statement) {
      throw new ExtractionProviderError('unsupported_xml', 'XML nie je bankový výpis camt.053', false);
    }

    const account = asArray(statement.Acct)[0] ?? {};
    const iban = text(account.Id?.IBAN)?.replace(/\s/g, '');
    const ownerName = text(asArray(account.Ownr)[0]?.Nm);
    const bankName = text(asArray(account.Svcr)[0]?.FinInstnId?.Nm) ?? 'Banka';
    const statementId = text(statement.Id) ?? text(statement.ElctrncSeqNb) ?? 'vypis';
    const createdAt = isoDate(statement.CreDtTm);
    const fromDate = isoDate(statement.FrToDt?.FrDtTm);
    const toDate = isoDate(statement.FrToDt?.ToDtTm) ?? createdAt;

    const balances = asArray(statement.Bal);
    const opening = balanceOf(balances, 'OPBD');
    const closing = balanceOf(balances, 'CLBD');
    const currency = closing.currency ?? opening.currency ?? text(account.Ccy) ?? 'EUR';

    const entries = asArray(statement.Ntry);
    let credits = 0;
    let debits = 0;
    const lineItems = entries.map((entry: any) => {
      const amount = signedAmount(entry.Amt, entry.CdtDbtInd);
      if (amount && amount.numeric >= 0) credits += 1;
      if (amount && amount.numeric < 0) debits += 1;
      const bookingDate = isoDate(asArray(entry.BookgDt)[0]?.Dt);
      const details = asArray(asArray(entry.NtryDtls)[0]?.TxDtls)[0] ?? {};
      const parties = asArray(details.RltdPties)[0] ?? {};
      const counterparty = amount && amount.numeric < 0
        ? text(asArray(parties.Cdtr)[0]?.Nm) ?? text(asArray(parties.Cdtr)[0]?.Pty?.Nm)
        : text(asArray(parties.Dbtr)[0]?.Nm) ?? text(asArray(parties.Dbtr)[0]?.Pty?.Nm);
      const remittance = asArray(asArray(details.RmtInf)[0]?.Ustrd).map((item) => text(item)).filter(Boolean).join(' ')
        || text(entry.AddtlNtryInf);
      const description = [skDate(bookingDate), counterparty, remittance].filter(Boolean).join(' — ')
        || 'Transakcia';
      return {
        description,
        quantity: undefined,
        unit: undefined,
        unitPriceWithoutVat: undefined,
        vatRate: undefined,
        amountWithoutVat: undefined,
        vatAmount: undefined,
        amountTotal: amount?.value,
      };
    });

    const result: ExtractionResult = {
      schemaVersion: EXTRACTION_SCHEMA_VERSION,
      documentType: 'BV',
      supplier: { nazov: bankName, iban },
      buyer: { nazov: ownerName },
      invoiceNumber: statementId,
      issueDate: toDate ?? createdAt,
      taxDate: toDate,
      currency,
      lineItems,
      vatBreakdown: [],
      // Konečný zostatok; záporný zostatok je legálny — deterministická validácia
      // ho označí warningom, doklad ostáva na kontrole.
      totalAmount: closing.amount?.value,
      fieldConfidence: Object.fromEntries(
        Object.entries({
          'supplier.nazov': bankName,
          'supplier.iban': iban,
          invoiceNumber: statementId,
          issueDate: toDate ?? createdAt,
          totalAmount: closing.amount?.value,
        }).filter(([, value]) => value !== undefined).map(([key]) => [key, 1]),
      ),
      evidence: {},
      warnings: [{
        code: 'sepa_statement_summary',
        message: `Výpis ${statementId}${fromDate ? ` za ${skDate(fromDate)} – ${skDate(toDate)}` : ''}: `
          + `${entries.length} transakcií (${credits} kredit, ${debits} debet), `
          + `počiatočný zostatok ${opening.amount?.value ?? '—'}, konečný ${closing.amount?.value ?? '—'} ${currency}`,
        severity: 'info',
      }],
    };

    return { result, model: 'camt.053' };
  }
}

// Abstrakcia AI extrakcie — SPEC §11.12.
// OpenAI API sa volá VÝHRADNE na backend/worker; v prehliadači existuje
// iba tento interface a mock adaptér.
// TODO: integration point — produkčný OpenAIDocumentExtractionProvider vo
// Fáze 2B použije na backend/worker Responses API + Structured Outputs,
// OPENAI_API_KEY nikdy v prehliadači. Obsah dokumentu je nedôveryhodný
// vstup: dáta, nie príkazy.
import type { DocumentType, ExtractionResult } from '../types';
import { extractionResultSchema } from '../schemas';

export interface ExtractionInput {
  documentId: string;
  mimeType: string;
  storageKey: string;
  organizationContext: {
    nazov: string;
    ico: string;
    dic?: string;
    icDph?: string;
  };
  promptVersion: string;
  schemaVersion: string;
}

export interface DocumentExtractionProvider {
  extract(input: ExtractionInput): Promise<ExtractionResult>;
}

export const EXTRACTION_PROMPT_VERSION = 'invoice-sk-v1';
export const EXTRACTION_SCHEMA_VERSION = '1';

/** Mock scenáre riadia tvar výsledku (SPEC §11.20). Mimo interface — iba mock. */
export interface MockExtractionHints {
  scenario:
    | 'uspech'
    | 'nizka_istota'
    | 'duplicita'
    | 'ico_mismatch'
    | 'poskodeny_subor'
    | 'password_protected_pdf'
    | 'ambiguous_recipient'
    | 'nepodporovany_typ';
  /** deterministický seed (odvodený z obsahu prílohy) */
  seed: number;
  fileName: string;
  /** pre scenár duplicity: dodávateľ + číslo existujúceho dokladu */
  duplicateOf?: { supplierName: string; supplierIco: string; invoiceNumber: string };
  /** pre scenár ico_mismatch: IČO odberateľa inej organizácie */
  mismatchBuyerIco?: string;
}

const MOCK_SUPPLIERS = [
  {
    nazov: 'Slovak Telekom, a.s.',
    ico: '35763469',
    dic: '2020273893',
    icDph: 'SK2020273893',
    iban: 'SK6511000000002628004523',
    adresa: 'Bajkalská 28, 817 62 Bratislava',
  },
  {
    nazov: 'ZSE Energia, a.s.',
    ico: '36677281',
    dic: '2022249295',
    icDph: 'SK2022249295',
    iban: 'SK5811000000002926860291',
    adresa: 'Čulenova 6, 816 47 Bratislava',
  },
  {
    nazov: 'Kancelárske potreby OFFICEO s.r.o.',
    ico: '44123123',
    dic: '2022676767',
    icDph: 'SK2022676767',
    iban: 'SK1309000000005044111222',
    adresa: 'Pri Šajbách 1, 831 06 Bratislava',
  },
  {
    nazov: 'METRO Cash & Carry SR s.r.o.',
    ico: '45952671',
    dic: '2023150056',
    icDph: 'SK2023150056',
    iban: 'SK6511000000002620798102',
    adresa: 'Senecká cesta 1881, 900 28 Ivanka pri Dunaji',
  },
] as const;

function iso(date: Date): string {
  return date.toISOString().slice(0, 10);
}

/**
 * Mock adaptér — deterministický výstup zo seedu, validovaný rovnakou
 * runtime schémou ako budúci OpenAI adaptér (SPEC §11.12/§11.13).
 */
export class MockDocumentExtractionProvider implements DocumentExtractionProvider {
  constructor(private readonly hints: MockExtractionHints) {}

  async extract(input: ExtractionInput): Promise<ExtractionResult> {
    const { hints } = this;
    if (hints.scenario === 'poskodeny_subor') {
      throw Object.assign(new Error('Súbor sa nepodarilo prečítať'), {
        code: 'corrupted_file',
      });
    }
    if (hints.scenario === 'password_protected_pdf') {
      throw Object.assign(new Error('PDF je chránené heslom'), {
        code: 'password_protected_pdf',
      });
    }

    const supplier = hints.duplicateOf
      ? {
          nazov: hints.duplicateOf.supplierName,
          ico: hints.duplicateOf.supplierIco,
          dic: `20${String(hints.seed % 100000000).padStart(8, '0')}`,
          icDph: `SK20${String(hints.seed % 100000000).padStart(8, '0')}`,
          iban: 'SK6511000000002628004523',
          adresa: 'Bratislava',
        }
      : MOCK_SUPPLIERS[hints.seed % MOCK_SUPPLIERS.length];

    const invoiceNumber =
      hints.duplicateOf?.invoiceNumber ?? `26${String(1000000 + (hints.seed % 9000000))}`;
    const low = hints.scenario === 'nizka_istota';
    const base = Math.round((50 + (hints.seed % 195000) / 100) * 100) / 100;
    const vat = Math.round(base * 0.23 * 100) / 100;
    const total = Math.round((base + vat) * 100) / 100;
    // Fixný demo anchor drží reset dát a unit testy reprodukovateľné.
    const today = new Date('2026-07-10T12:00:00.000Z');
    const issue = new Date(today);
    issue.setDate(issue.getDate() - 3);
    const due = new Date(today);
    due.setDate(due.getDate() + 11);

    const buyerIco = hints.mismatchBuyerIco ?? input.organizationContext.ico;

    const result: ExtractionResult = {
      schemaVersion: input.schemaVersion,
      documentType: 'FP',
      supplier,
      buyer: {
        nazov: input.organizationContext.nazov,
        ico: buyerIco,
        dic: input.organizationContext.dic,
        icDph: input.organizationContext.icDph,
      },
      invoiceNumber,
      variableSymbol: low ? undefined : invoiceNumber.replace(/\D/g, ''),
      issueDate: iso(issue),
      taxDate: low ? undefined : iso(issue),
      dueDate: iso(due),
      currency: 'EUR',
      lineItems: [
        {
          description: low ? 'Plnenie podľa prílohy' : 'Tovar a služby podľa faktúry',
          quantity: '1',
          unit: 'ks',
          unitPriceWithoutVat: base.toFixed(2),
          vatRate: '23',
          amountWithoutVat: base.toFixed(2),
          vatAmount: vat.toFixed(2),
          amountTotal: total.toFixed(2),
        },
      ],
      vatBreakdown: [
        { vatRate: '23', base: base.toFixed(2), vat: vat.toFixed(2), total: total.toFixed(2) },
      ],
      totalWithoutVat: base.toFixed(2),
      totalVat: vat.toFixed(2),
      totalAmount: total.toFixed(2),
      fieldConfidence: low
        ? {
            'supplier.nazov': 0.82,
            'supplier.ico': 0.55,
            invoiceNumber: 0.48,
            variableSymbol: 0.15,
            issueDate: 0.8,
            taxDate: 0.25,
            totalAmount: 0.62,
          }
        : {
            'supplier.nazov': 0.98,
            'supplier.ico': 0.97,
            invoiceNumber: 0.96,
            variableSymbol: 0.95,
            issueDate: 0.97,
            taxDate: 0.93,
            totalAmount: 0.99,
          },
      evidence: {
        invoiceNumber: [{ page: 1, text: `Faktúra č. ${invoiceNumber}` }],
        totalAmount: [{ page: 1, text: `Spolu na úhradu: ${total.toFixed(2)} EUR` }],
      },
      warnings: low
        ? [
            {
              code: 'low_confidence',
              message: 'Nízka istota extrakcie — skontrolujte polia.',
              severity: 'warning',
            },
          ]
        : [],
    };

    // Rovnaká deterministická runtime validácia ako pre produkčný adaptér:
    // nevalidný výstup sa nesmie zapísať do DocumentItem (SPEC §11.13).
    return extractionResultSchema.parse(result) as ExtractionResult;
  }
}

/** Agregovaná istota = minimum kritických polí (konzervatívne). */
export function aggregateConfidence(fieldConfidence: Record<string, number>): number {
  const values = Object.values(fieldConfidence);
  if (values.length === 0) return 0;
  const avg = values.reduce((s, v) => s + v, 0) / values.length;
  const min = Math.min(...values);
  return Math.round(((avg + min) / 2) * 100) / 100;
}

const DOCUMENT_FIELD_PATHS: Record<string, string> = {
  'supplier.nazov': 'dodavatel.nazov',
  'supplier.ico': 'dodavatel.ico',
  'supplier.dic': 'dodavatel.dic',
  'supplier.icDph': 'dodavatel.icDph',
  'supplier.adresa': 'dodavatel.adresa',
  'supplier.iban': 'dodavatel.iban',
  'buyer.nazov': 'odberatel.nazov',
  'buyer.ico': 'odberatel.ico',
  invoiceNumber: 'cisloFaktury',
  variableSymbol: 'variabilnySymbol',
  constantSymbol: 'konstantnySymbol',
  specificSymbol: 'specifickySymbol',
  issueDate: 'datumVystavenia',
  taxDate: 'datumDodania',
  dueDate: 'datumSplatnosti',
  totalAmount: 'sumaSpolu',
};

/** English extraction contract → normalizované cesty vo DocumentItem. */
export function mapFieldConfidenceToDocument(
  confidence: Record<string, number>,
): Record<string, number> {
  return Object.fromEntries(
    Object.entries(confidence).map(([path, value]) => [
      DOCUMENT_FIELD_PATHS[path] ??
        path
          .replace(/^supplier\./, 'dodavatel.')
          .replace(/^buyer\./, 'odberatel.')
          .replace(/^vatBreakdown/, 'rozpisDph')
          .replace(/^lineItems/, 'polozky'),
      value,
    ]),
  );
}

/** Mapovanie documentType z extrakcie na typ dokladu (UNKNOWN → FP ako bezpečný default na kontrolu). */
export function mapDocumentType(t: ExtractionResult['documentType']): DocumentType {
  return t === 'UNKNOWN' ? 'FP' : t;
}

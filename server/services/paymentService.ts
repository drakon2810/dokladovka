// Platobný kontúr: úhrady dokladov a automatické párovanie transakcií
// z bankového výpisu (SEPA camt.053) na otvorené prijaté faktúry podľa VS a sumy.
import { randomUUID } from 'node:crypto';
import type { Database, Queryable } from '../db/database.js';

export interface PaymentInput {
  tenantId: string;
  organizationId: string;
  documentId: string;
  amount: number;
  currency: string;
  paidOn: string; // ISO date
  source: 'manual' | 'bank_statement';
  bankStatementDocumentId?: string;
  note?: string;
  createdBy?: string;
}

function round2(value: number): number {
  return Math.round((value + Number.EPSILON) * 100) / 100;
}

export async function insertPayment(tx: Queryable, input: PaymentInput): Promise<string> {
  const id = randomUUID();
  await tx.query(
    `INSERT INTO document_payments
      (id, tenant_id, organization_id, document_id, amount, currency, paid_on, source,
       bank_statement_document_id, note, created_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
    [id, input.tenantId, input.organizationId, input.documentId, round2(input.amount), input.currency,
      input.paidOn, input.source, input.bankStatementDocumentId ?? null, input.note ?? null, input.createdBy ?? null],
  );
  return id;
}

export async function paidTotalFor(tx: Queryable, tenantId: string, documentId: string): Promise<number> {
  const result = await tx.query<{ total: string | number | null } & Record<string, unknown>>(
    'SELECT COALESCE(SUM(amount), 0) AS total FROM document_payments WHERE tenant_id=$1 AND document_id=$2',
    [tenantId, documentId],
  );
  return round2(Number(result.rows[0]?.total ?? 0));
}

interface OpenInvoiceRow extends Record<string, unknown> {
  id: string;
  total_amount: string | number | null;
  currency: string | null;
  extracted: any;
  paid: string | number | null;
}

interface StatementTransaction {
  popis?: string;
  sumaSpolu?: number;
}

export interface StatementMatchResult {
  matched: Array<{ documentId: string; amount: number; variableSymbol: string }>;
}

/**
 * Automatické párovanie: odchádzajúce transakcie výpisu (záporná suma) sa párujú
 * na otvorené FP/OZ doklady rovnakej organizácie cez variabilný symbol v popise
 * transakcie + zhodu sumy (do 2 centov voči zvyšku k úhrade alebo celkovej sume).
 * Konzervatívne: bez VS zhody sa nič nepáruje; jeden doklad max. raz na výpis.
 */
export async function matchStatementPayments(
  database: Database,
  input: { tenantId: string; organizationId: string; statementDocumentId: string },
): Promise<StatementMatchResult> {
  const statement = await database.query<{ extracted: any } & Record<string, unknown>>(
    'SELECT extracted FROM documents WHERE id=$1 AND tenant_id=$2 AND organization_id=$3',
    [input.statementDocumentId, input.tenantId, input.organizationId],
  );
  const extracted = statement.rows[0]?.extracted;
  if (!extracted) return { matched: [] };
  const transactions: StatementTransaction[] = Array.isArray(extracted.polozky) ? extracted.polozky : [];
  const outgoing = transactions.filter((item) => Number(item.sumaSpolu) < 0);
  if (outgoing.length === 0) return { matched: [] };

  const candidates = await database.query<OpenInvoiceRow>(
    `SELECT d.id, d.total_amount, d.currency, d.extracted,
            COALESCE((SELECT SUM(p.amount) FROM document_payments p
              WHERE p.tenant_id=d.tenant_id AND p.document_id=d.id), 0) AS paid
       FROM documents d
      WHERE d.tenant_id=$1 AND d.organization_id=$2
        AND d.document_type IN ('FP','OZ')
        AND d.status IN ('extrahovany','na_kontrole','schvaleny','exportovany')
      ORDER BY d.created_at DESC LIMIT 500`,
    [input.tenantId, input.organizationId],
  );

  const byVs = new Map<string, OpenInvoiceRow>();
  for (const row of candidates.rows) {
    const vs = String(row.extracted?.variabilnySymbol ?? '').replace(/\D/g, '');
    if (vs && !byVs.has(vs)) byVs.set(vs, row);
  }

  const statementDate = typeof extracted.datumVystavenia === 'string'
    ? extracted.datumVystavenia
    : new Date().toISOString().slice(0, 10);
  const matched: StatementMatchResult['matched'] = [];
  const usedDocuments = new Set<string>();

  for (const transaction of outgoing) {
    const description = String(transaction.popis ?? '');
    const amount = round2(Math.abs(Number(transaction.sumaSpolu)));
    // Kandidátne VS: číselné sekvencie 4–10 číslic v popise transakcie.
    const tokens = [...new Set(description.match(/\d{4,10}/g) ?? [])];
    for (const token of tokens) {
      const document = byVs.get(token);
      if (!document || usedDocuments.has(document.id)) continue;
      const total = round2(Number(document.total_amount ?? 0));
      const remaining = round2(total - round2(Number(document.paid ?? 0)));
      if (remaining <= 0) continue;
      if (Math.abs(amount - remaining) > 0.02 && Math.abs(amount - total) > 0.02) continue;

      await database.transaction(async (tx) => {
        await insertPayment(tx, {
          tenantId: input.tenantId,
          organizationId: input.organizationId,
          documentId: document.id,
          amount,
          currency: document.currency ?? 'EUR',
          paidOn: statementDate,
          source: 'bank_statement',
          bankStatementDocumentId: input.statementDocumentId,
          note: description.slice(0, 300),
        });
        await tx.query(
          `UPDATE documents SET history=history || $1::jsonb, updated_at=now()
            WHERE id=$2 AND tenant_id=$3`,
          [JSON.stringify([{
            ts: new Date().toISOString(),
            user: 'Systém',
            akcia: `Úhrada ${amount.toFixed(2)} ${document.currency ?? 'EUR'} automaticky spárovaná z bankového výpisu (VS ${token})`,
          }]), document.id, input.tenantId],
        );
      });
      usedDocuments.add(document.id);
      matched.push({ documentId: document.id, amount, variableSymbol: token });
      break;
    }
  }
  return { matched };
}

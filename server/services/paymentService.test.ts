import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import { createTestDatabase, seedTestUser } from '../testHelpers.js';
import { insertPayment, matchStatementPayments, paidTotalFor } from './paymentService.js';

const databases: Awaited<ReturnType<typeof createTestDatabase>>[] = [];
afterEach(async () => Promise.all(databases.splice(0).map((database) => database.close())));

async function insertInvoice(
  database: Awaited<ReturnType<typeof createTestDatabase>>,
  seeded: { tenantId: string; organizationId: string },
  input: { vs?: string; total: number; status?: string },
): Promise<string> {
  const id = randomUUID();
  await database.query(
    `INSERT INTO documents (id,tenant_id,organization_id,document_type,status,processing_status,extracted,accounting,total_amount,currency)
     VALUES ($1,$2,$3,'FP',$4,'ready_for_review',$5::jsonb,'{}'::jsonb,$6,'EUR')`,
    [id, seeded.tenantId, seeded.organizationId, input.status ?? 'na_kontrole',
      JSON.stringify({ dodavatel: { nazov: 'Dodávateľ' }, cisloFaktury: input.vs ?? '', variabilnySymbol: input.vs, sumaSpolu: input.total }),
      input.total],
  );
  return id;
}

async function insertStatement(
  database: Awaited<ReturnType<typeof createTestDatabase>>,
  seeded: { tenantId: string; organizationId: string },
  transactions: Array<{ popis: string; sumaSpolu: number }>,
): Promise<string> {
  const id = randomUUID();
  await database.query(
    `INSERT INTO documents (id,tenant_id,organization_id,document_type,status,processing_status,extracted,accounting,total_amount,currency)
     VALUES ($1,$2,$3,'BV','na_kontrole','ready_for_review',$4::jsonb,'{}'::jsonb,0,'EUR')`,
    [id, seeded.tenantId, seeded.organizationId,
      JSON.stringify({ dodavatel: { nazov: 'Banka' }, cisloFaktury: 'V-1', datumVystavenia: '2026-07-16', sumaSpolu: 0, polozky: transactions })],
  );
  return id;
}

describe('payment service', () => {
  it('spáruje odchádzajúce transakcie na otvorené faktúry podľa VS a sumy', async () => {
    const database = await createTestDatabase();
    databases.push(database);
    const seeded = await seedTestUser(database);
    const matching = await insertInvoice(database, seeded, { vs: '20260777', total: 615 });
    const wrongAmount = await insertInvoice(database, seeded, { vs: '20260888', total: 100 });
    const noVs = await insertInvoice(database, seeded, { total: 50 });
    const statementId = await insertStatement(database, seeded, [
      { popis: '12.07.2026 — Elektro Svetlo s.r.o. — EF-2026-0777 VS 20260777', sumaSpolu: -615 },
      { popis: '13.07.2026 — Iný dodávateľ — VS 20260888', sumaSpolu: -999 },
      { popis: '14.07.2026 — Prijatá platba', sumaSpolu: 1230 },
    ]);

    const result = await matchStatementPayments(database, {
      tenantId: seeded.tenantId, organizationId: seeded.organizationId, statementDocumentId: statementId,
    });
    expect(result.matched).toEqual([{ documentId: matching, amount: 615, variableSymbol: '20260777' }]);
    expect(await paidTotalFor(database, seeded.tenantId, matching)).toBe(615);
    expect(await paidTotalFor(database, seeded.tenantId, wrongAmount)).toBe(0);
    expect(await paidTotalFor(database, seeded.tenantId, noVs)).toBe(0);

    // Opakované spracovanie toho istého výpisu nevytvorí druhú úhradu (zvyšok je 0).
    const repeat = await matchStatementPayments(database, {
      tenantId: seeded.tenantId, organizationId: seeded.organizationId, statementDocumentId: statementId,
    });
    expect(repeat.matched).toEqual([]);
    expect(await paidTotalFor(database, seeded.tenantId, matching)).toBe(615);
  }, 90_000);

  it('čiastočná úhrada znižuje zvyšok a párovanie akceptuje doplatok', async () => {
    const database = await createTestDatabase();
    databases.push(database);
    const seeded = await seedTestUser(database);
    const invoice = await insertInvoice(database, seeded, { vs: '55550001', total: 1000 });
    await insertPayment(database, {
      tenantId: seeded.tenantId, organizationId: seeded.organizationId, documentId: invoice,
      amount: 400, currency: 'EUR', paidOn: '2026-07-10', source: 'manual',
    });
    expect(await paidTotalFor(database, seeded.tenantId, invoice)).toBe(400);

    const statementId = await insertStatement(database, seeded, [
      { popis: 'Doplatok VS 55550001', sumaSpolu: -600 },
    ]);
    const result = await matchStatementPayments(database, {
      tenantId: seeded.tenantId, organizationId: seeded.organizationId, statementDocumentId: statementId,
    });
    expect(result.matched).toHaveLength(1);
    expect(await paidTotalFor(database, seeded.tenantId, invoice)).toBe(1000);
  }, 90_000);
});

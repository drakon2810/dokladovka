import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createTestDatabase, seedTestUser, testConfig } from '../testHelpers.js';
import { insertPayment } from './paymentService.js';
import { suggestBankMovementAccounting } from './bankSuggestionService.js';

const databases: Awaited<ReturnType<typeof createTestDatabase>>[] = [];
afterEach(async () => Promise.all(databases.splice(0).map((database) => database.close())));

async function seedPredkontacia(
  database: Awaited<ReturnType<typeof createTestDatabase>>,
  seeded: { tenantId: string; organizationId: string },
  code: string,
  agenda?: string,
): Promise<string> {
  const id = randomUUID();
  await database.query(
    `INSERT INTO code_list_items (id,tenant_id,organization_id,kind,code,name,source,agenda)
     VALUES ($1,$2,$3,'predkontacie',$4,$4,'pohoda',$5)`,
    [id, seeded.tenantId, seeded.organizationId, code, agenda ?? null],
  );
  return id;
}

describe('autozaúčtovanie pohybov výpisu', () => {
  it('doplní predkontácie len pohybom bez zaúčtovania a cudzie id zahodí', async () => {
    const database = await createTestDatabase();
    databases.push(database);
    const seeded = await seedTestUser(database);
    const uhradaFv = await seedPredkontacia(database, seeded, 'Úhrada FV-tuz.', 'bankReceived');
    const dane = await seedPredkontacia(database, seeded, '538200', 'bankIssued');
    const rucne = await seedPredkontacia(database, seeded, '518/321');
    // Fakturová predkontácia sa do bankovej ponuky nesmie dostať vôbec.
    const fakturova = await seedPredkontacia(database, seeded, '518/321 FAKT', 'receivedInvoice');

    // Vydaná faktúra, ktorú pohyb č. 2 preukázateľne platí (VS + suma).
    const fvId = randomUUID();
    await database.query(
      `INSERT INTO documents (id,tenant_id,organization_id,document_type,status,processing_status,extracted,accounting,total_amount,currency)
       VALUES ($1,$2,$3,'FV','schvaleny','ready_for_review',$4::jsonb,'{}'::jsonb,9177.5,'EUR')`,
      [fvId, seeded.tenantId, seeded.organizationId,
        JSON.stringify({ dodavatel: { nazov: 'Naša firma' }, cisloFaktury: '260504300086', variabilnySymbol: '260504300086', sumaSpolu: 9177.5 })],
    );

    const statementId = randomUUID();
    await database.query(
      `INSERT INTO documents (id,tenant_id,organization_id,document_type,status,processing_status,extracted,accounting,total_amount,currency)
       VALUES ($1,$2,$3,'BV','na_kontrole','ready_for_review',$4::jsonb,$5::jsonb,22486.43,'EUR')`,
      [statementId, seeded.tenantId, seeded.organizationId,
        JSON.stringify({
          dodavatel: { nazov: 'UniCredit Bank', iban: 'SK0911110000001522620009' },
          cisloFaktury: 'V-101', cisloVypisu: '101', datumVystavenia: '2026-05-28', mena: 'EUR',
          sumaSpolu: 22486.43,
          polozky: [
            { id: 'm0', popis: 'Dan z financnych transakcii', sumaSpolu: -0.2 },
            { id: 'm1', popis: 'Uhrada FV c. 260504300086', vs: '260504300086', sumaSpolu: 9177.5 },
            { id: 'm2', popis: 'Najomne', sumaSpolu: -350, ucto: { predkontaciaId: rucne } },
          ],
        }),
        JSON.stringify({ bankUcetKod: 'PB' })],
    );
    await insertPayment(database, {
      tenantId: seeded.tenantId, organizationId: seeded.organizationId, documentId: fvId,
      amount: 9177.5, currency: 'EUR', paidOn: '2026-05-28', source: 'bank_statement',
      bankStatementDocumentId: statementId,
    });

    const parse = vi.fn().mockResolvedValue({
      output_parsed: {
        pohyby: [
          { index: 0, predkontaciaId: dane },
          { index: 1, predkontaciaId: uhradaFv },
          // Vymyslené id — nesmie sa zapísať.
          { index: 2, predkontaciaId: randomUUID() },
        ],
      },
    });
    const doplnene = await suggestBankMovementAccounting(database, testConfig(), {
      tenantId: seeded.tenantId, organizationId: seeded.organizationId, documentId: statementId,
    }, { parse });
    expect(doplnene).toBe(2);

    // Model dostal len pohyby bez predkontácie a k pohybu 1 spárovanú FV.
    const payload = JSON.parse((parse.mock.calls[0][0] as any).input[0].content[0].text);
    expect(payload.pohyby.map((pohyb: any) => pohyb.index)).toEqual([0, 1]);
    expect(payload.pohyby[1].sparovanyDoklad).toMatchObject({ typ: 'FV', cislo: '260504300086' });
    expect(payload.ciselnik.some((item: any) => item.id === uhradaFv)).toBe(true);
    // Ponuka nesie agendu a fakturové predkontácie v nej nie sú.
    expect(payload.ciselnik.find((item: any) => item.id === dane)?.agenda).toBe('bankIssued');
    expect(payload.ciselnik.some((item: any) => item.id === fakturova)).toBe(false);

    const ulozene = await database.query<Record<string, any>>(
      'SELECT extracted, history FROM documents WHERE id=$1', [statementId],
    );
    const polozky = ulozene.rows[0].extracted.polozky;
    expect(polozky[0].ucto.predkontaciaId).toBe(dane);
    expect(polozky[1].ucto.predkontaciaId).toBe(uhradaFv);
    // Ručne nastavená predkontácia ostáva nedotknutá.
    expect(polozky[2].ucto.predkontaciaId).toBe(rucne);
    expect(JSON.stringify(ulozene.rows[0].history)).toContain('AI doplnila predkontáciu 2 pohybom');
  }, 90_000);

  it('súbežná úprava účtovníka (zmena verzie) zahodí návrhy — ručná práca vyhráva', async () => {
    const database = await createTestDatabase();
    databases.push(database);
    const seeded = await seedTestUser(database);
    const dane = await seedPredkontacia(database, seeded, '538200');
    const statementId = randomUUID();
    await database.query(
      `INSERT INTO documents (id,tenant_id,organization_id,document_type,status,processing_status,extracted,accounting,total_amount,currency,version)
       VALUES ($1,$2,$3,'BV','na_kontrole','ready_for_review',$4::jsonb,'{}'::jsonb,0,'EUR',1)`,
      [statementId, seeded.tenantId, seeded.organizationId,
        JSON.stringify({
          dodavatel: { nazov: 'Banka' }, cisloFaktury: 'V-1', datumVystavenia: '2026-05-28', mena: 'EUR', sumaSpolu: 0,
          polozky: [{ id: 'm0', popis: 'Poplatok', sumaSpolu: -1 }],
        })],
    );
    // Účtovník uloží doklad POČAS behu AI — verzia sa zdvihne pod rukami.
    const parse = vi.fn().mockImplementation(async () => {
      await database.query('UPDATE documents SET version=version+1 WHERE id=$1', [statementId]);
      return { output_parsed: { pohyby: [{ index: 0, predkontaciaId: dane }] } };
    });
    expect(await suggestBankMovementAccounting(database, testConfig(), {
      tenantId: seeded.tenantId, organizationId: seeded.organizationId, documentId: statementId,
    }, { parse })).toBe(0);
    const ulozene = await database.query<Record<string, any>>('SELECT extracted FROM documents WHERE id=$1', [statementId]);
    expect(ulozene.rows[0].extracted.polozky[0].ucto?.predkontaciaId).toBeUndefined();
  }, 90_000);

  it('bez chýbajúcich pohybov sa AI vôbec nevolá', async () => {
    const database = await createTestDatabase();
    databases.push(database);
    const seeded = await seedTestUser(database);
    const predkontacia = await seedPredkontacia(database, seeded, '538200');
    const statementId = randomUUID();
    await database.query(
      `INSERT INTO documents (id,tenant_id,organization_id,document_type,status,processing_status,extracted,accounting,total_amount,currency)
       VALUES ($1,$2,$3,'BV','na_kontrole','ready_for_review',$4::jsonb,'{}'::jsonb,0,'EUR')`,
      [statementId, seeded.tenantId, seeded.organizationId,
        JSON.stringify({
          dodavatel: { nazov: 'Banka' }, cisloFaktury: 'V-1', datumVystavenia: '2026-05-28', mena: 'EUR', sumaSpolu: 0,
          polozky: [{ id: 'm0', popis: 'Poplatok', sumaSpolu: -1, ucto: { predkontaciaId: predkontacia } }],
        })],
    );
    const parse = vi.fn();
    expect(await suggestBankMovementAccounting(database, testConfig(), {
      tenantId: seeded.tenantId, organizationId: seeded.organizationId, documentId: statementId,
    }, { parse })).toBe(0);
    expect(parse).not.toHaveBeenCalled();
  }, 90_000);
});

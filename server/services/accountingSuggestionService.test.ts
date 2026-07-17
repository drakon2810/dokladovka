import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createTestDatabase, seedTestUser, testConfig } from '../testHelpers.js';
import { maybeAiAccountingSuggestion, rebuildAccountingSuggestion } from './accountingSuggestionService.js';

const databases: Awaited<ReturnType<typeof createTestDatabase>>[] = [];
afterEach(async () => Promise.all(databases.splice(0).map((database) => database.close())));

describe('accounting suggestions', () => {
  it('dodrží poradie manual rule > história v organizácii > organization default', async () => {
    const database = await createTestDatabase();
    databases.push(database);
    const seeded = await seedTestUser(database);
    const currentId = randomUUID();
    const historyId = randomUUID();
    const foreignOrgId = randomUUID();
    const foreignHistoryId = randomUUID();
    const pred = randomUUID();
    const dph = randomUUID();
    const series = randomUUID();
    const extracted = { dodavatel: { nazov: 'Rovnaký dodávateľ', ico: '11112222' }, cisloFaktury: '1', datumVystavenia: '2026-07-01', mena: 'EUR', rozpisDph: [], sumaSpolu: 0 };
    const accounting = { predkontaciaId: pred, clenenieDphId: dph, ciselnyRadId: series };

    await database.transaction(async (tx) => {
      await tx.query(`INSERT INTO organizations (id,tenant_id,name,ico,dic) VALUES ($1,$2,'Iná firma','99999999','2020999999')`, [foreignOrgId, seeded.tenantId]);
      for (const [id, kind, code] of [[pred, 'predkontacie', '518/321'], [dph, 'cleneniaDph', 'PD'], [series, 'ciselneRady', 'PF']] as const) {
        await tx.query(
          `INSERT INTO code_list_items (id,tenant_id,organization_id,kind,code,name,source)
           VALUES ($1,$2,$3,$4,$5,$5,'manual')`,
          [id, seeded.tenantId, seeded.organizationId, kind, code],
        );
      }
      const insertDocument = async (id: string, organizationId: string, status: string, number: string) => tx.query(
        `INSERT INTO documents
          (id,tenant_id,organization_id,document_type,status,processing_status,extracted,accounting,total_amount,currency)
         VALUES ($1,$2,$3,'FP',$4,'ready_for_review',$5::jsonb,$6::jsonb,0,'EUR')`,
        [id, seeded.tenantId, organizationId, status, JSON.stringify({ ...extracted, cisloFaktury: number }), JSON.stringify(accounting)],
      );
      await insertDocument(currentId, seeded.organizationId, 'na_kontrole', 'CURRENT');
      await insertDocument(historyId, seeded.organizationId, 'schvaleny', 'HISTORY');
      await insertDocument(foreignHistoryId, foreignOrgId, 'schvaleny', 'FOREIGN');
      await tx.query(
        `INSERT INTO organization_accounting_defaults
          (organization_id,tenant_id,predkontacia_id,clenenie_dph_id,ciselny_rad_id)
         VALUES ($1,$2,$3,$4,$5)`,
        [seeded.organizationId, seeded.tenantId, pred, dph, series],
      );
      await tx.query(
        `INSERT INTO accounting_rules
          (id,tenant_id,organization_id,supplier_ico,predkontacia_id,clenenie_dph_id,ciselny_rad_id)
         VALUES ($1,$2,$3,'11112222',$4,$5,$6)`,
        [randomUUID(), seeded.tenantId, seeded.organizationId, pred, dph, series],
      );
    });

    const input = { tenantId: seeded.tenantId, organizationId: seeded.organizationId, documentId: currentId, supplierIco: '11112222', supplierName: 'Rovnaký dodávateľ' };
    await rebuildAccountingSuggestion(database, input);
    expect((await database.query<{ source: string } & Record<string, unknown>>('SELECT source FROM accounting_suggestions WHERE document_id=$1', [currentId])).rows[0].source).toBe('manual_rule');

    await database.query('UPDATE accounting_rules SET active=false WHERE organization_id=$1', [seeded.organizationId]);
    await rebuildAccountingSuggestion(database, input);
    const history = (await database.query<{ source: string; based_on_document_id?: string } & Record<string, unknown>>('SELECT source,based_on_document_id FROM accounting_suggestions WHERE document_id=$1', [currentId])).rows[0];
    expect(history).toMatchObject({ source: 'supplier_history', based_on_document_id: historyId });

    await database.query(`UPDATE documents SET status='zamietnuty' WHERE id=$1`, [historyId]);
    await rebuildAccountingSuggestion(database, input);
    expect((await database.query<{ source: string } & Record<string, unknown>>('SELECT source FROM accounting_suggestions WHERE document_id=$1', [currentId])).rows[0].source).toBe('organization_default');
  }, 90_000);

  it('AI fallback vyberá len z aktívnych číselníkov a nikdy neprepíše deterministický návrh', async () => {
    const database = await createTestDatabase();
    databases.push(database);
    const seeded = await seedTestUser(database);
    const documentId = randomUUID();
    const pred = randomUUID();
    const dph = randomUUID();
    await database.query(
      `INSERT INTO documents (id,tenant_id,organization_id,document_type,status,processing_status,extracted,accounting,total_amount,currency)
       VALUES ($1,$2,$3,'FP','na_kontrole','ready_for_review','{}'::jsonb,'{}'::jsonb,100,'EUR')`,
      [documentId, seeded.tenantId, seeded.organizationId],
    );
    for (const [id, kind, code] of [[pred, 'predkontacie', '518/321'], [dph, 'cleneniaDph', 'PD']] as const) {
      await database.query(
        `INSERT INTO code_list_items (id,tenant_id,organization_id,kind,code,name,source)
         VALUES ($1,$2,$3,$4,$5,$5,'pohoda')`,
        [id, seeded.tenantId, seeded.organizationId, kind, code],
      );
    }
    const input = { tenantId: seeded.tenantId, organizationId: seeded.organizationId, documentId, supplierIco: '11112222', supplierName: 'Nový dodávateľ' };
    await rebuildAccountingSuggestion(database, input);

    // Model vráti platnú predkontáciu + vymyslené (neaktívne) clenenie — prejde len platné ID.
    const parser = {
      parse: vi.fn().mockResolvedValue({
        output_parsed: { predkontaciaId: pred, clenenieDphId: 'vymyslene-id', ciselnyRadId: null, confidence: 0.9, reason: 'Služby podľa položiek' },
      }),
    };
    const context = { documentType: 'FP', supplierName: 'Nový dodávateľ', totalAmount: 100, currency: 'EUR', lineDescriptions: ['Konzultácie'] };
    expect(await maybeAiAccountingSuggestion(database, testConfig(), input, context, parser)).toBe(true);
    const suggestion = (await database.query<Record<string, any>>('SELECT * FROM accounting_suggestions WHERE document_id=$1', [documentId])).rows[0];
    expect(suggestion.source).toBe('ai');
    expect(suggestion.predkontacia_id).toBe(pred);
    expect(suggestion.clenenie_dph_id).toBeNull();
    expect(Number(suggestion.confidence)).toBeLessThanOrEqual(0.8);

    // Deterministický návrh (source != none) sa AI fallbackom nikdy neprepíše.
    await database.query(`UPDATE accounting_suggestions SET source='supplier_history' WHERE document_id=$1`, [documentId]);
    expect(await maybeAiAccountingSuggestion(database, testConfig(), input, context, parser)).toBe(false);
    expect(parser.parse).toHaveBeenCalledTimes(1);
  }, 90_000);
});

import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { maybeAiAccountingSuggestion } from './accountingSuggestionService.js';
import { aiOdpoved, createTestDatabase, seedTestUser, testConfig } from '../testHelpers.js';

const databases: Awaited<ReturnType<typeof createTestDatabase>>[] = [];
afterEach(async () => Promise.all(databases.splice(0).map((database) => database.close())));

// Mostík ukladal do pamäte aj dobropisy, ale druh dokladu neposielal — všetko
// pristálo ako FP. Dobropis sa pritom účtuje opačným smerom a do sekcie C2, nie
// B1, takže ako príklad pre bežnú faktúru ťahal k zlej sekcii výkazu.
describe('pamäť rozhodnutí a druh dokladu', () => {
  it('dobropis neslúži ako príklad pre bežnú faktúru a naopak', async () => {
    const database = await createTestDatabase();
    databases.push(database);
    const seeded = await seedTestUser(database);
    const documentId = randomUUID();
    const pred = randomUUID();
    const predDobropis = randomUUID();
    const dph = randomUUID();
    await database.query(
      `INSERT INTO documents (id,tenant_id,organization_id,document_type,podtyp,status,processing_status,extracted,accounting,total_amount,currency)
       VALUES ($1,$2,$3,'FP','bezna','na_kontrole','ready_for_review',$4::jsonb,'{}'::jsonb,100,'EUR')`,
      [documentId, seeded.tenantId, seeded.organizationId,
        JSON.stringify({ dodavatel: { nazov: 'Servis s.r.o.' }, polozky: [{ popis: 'oprava vozidla' }] })],
    );
    for (const [id, kind, code] of [
      [pred, 'predkontacie', '518/321'], [predDobropis, 'predkontacie', '648/321'], [dph, 'cleneniaDph', 'PD'],
    ] as const) {
      await database.query(
        `INSERT INTO code_list_items (id,tenant_id,organization_id,kind,code,name,source)
         VALUES ($1,$2,$3,$4,$5,$5,'pohoda')`,
        [id, seeded.tenantId, seeded.organizationId, kind, code],
      );
    }
    // Ten istý dodávateľ, ten istý text — raz ako faktúra, raz ako dobropis.
    for (const [podtyp, predkontaciaId] of [['bezna', pred], ['dobropis', predDobropis]] as const) {
      await database.query(
        `INSERT INTO ucto_decisions
          (id,tenant_id,organization_id,supplier_name_normalized,line_text_normalized,
           predkontacia_id,clenenie_dph_id,source,document_type,podtyp)
         VALUES ($1,$2,$3,'servis s.r.o.','oprava vozidla',$4,$5,'import','FP',$6)`,
        [randomUUID(), seeded.tenantId, seeded.organizationId, predkontaciaId, dph, podtyp],
      );
    }

    const parser = {
      create: vi.fn().mockResolvedValue(aiOdpoved({
        predkontaciaId: pred, clenenieDphId: dph, clenenieKvKod: null, ciselnyRadId: null,
        confidence: 0.8, reason: 'Oprava vozidla',
      })),
    };
    await maybeAiAccountingSuggestion(database, testConfig(),
      { tenantId: seeded.tenantId, organizationId: seeded.organizationId, documentId, supplierName: 'Servis s.r.o.' },
      { documentType: 'FP', podtyp: 'bezna', supplierName: 'Servis s.r.o.', totalAmount: 100, currency: 'EUR',
        lineDescriptions: ['oprava vozidla'] }, parser);

    const payload = JSON.parse((parser.create.mock.calls[0][0] as any).input[0].content[0].text);
    const ucty = payload.priklady.map((p: { predkontaciaId: string }) => p.predkontaciaId);
    // Modelu ide iba príklad z bežnej faktúry; dobropisový účet 648/321 nie.
    expect(ucty).toContain(pred);
    expect(ucty).not.toContain(predDobropis);
  }, 90_000);
});

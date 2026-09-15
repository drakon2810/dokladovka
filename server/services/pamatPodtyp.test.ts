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

  // Agendy kategórie sú agendy korpusu (FP, FP-D, INT, VPD). Porovnávali sa
  // s typom dokladu, takže mzdám a pokladni nesedeli nikdy a dobropisu pustili
  // do ponuky kód, ktorý firma dáva len bežným faktúram.
  it('dobropis: kód z kategórie bežných faktúr nie je v ponuke ani na riadku', async () => {
    const database = await createTestDatabase();
    databases.push(database);
    const seeded = await seedTestUser(database);
    const kde = [seeded.tenantId, seeded.organizationId];
    const documentId = randomUUID();
    const [p518, p501, pn, pdsluz] = [randomUUID(), randomUUID(), randomUUID(), randomUUID()];
    for (const [id, kind, code] of [
      [p518, 'predkontacie', '518/321'], [p501, 'predkontacie', '501/321'], [pn, 'cleneniaDph', 'PN'], [pdsluz, 'cleneniaDph', 'PDsluz'],
    ] as const) {
      await database.query(
        `INSERT INTO code_list_items (id,tenant_id,organization_id,kind,code,name,source)
         VALUES ($1,$2,$3,$4,$5,$5,'pohoda')`,
        [id, ...kde, kind, code],
      );
    }
    // Dobropisy firma účtuje len s PN; PDsluz má iba na bežných faktúrach.
    for (const [agenda, clenenie] of [['FP-D', 'PN'], ['FP-D', 'PN'], ['FP', 'PDsluz'], ['FP', 'PDsluz']]) {
      await database.query(
        `INSERT INTO ucto_historia (id,tenant_id,organization_id,agenda,line_text_normalized,predkontacia_kod,clenenie_dph_kod,source,riadok_hash)
         VALUES ($1,$2,$3,$4,'servis tlaciarne','518/321',$5,'mdb',$6)`,
        [randomUUID(), ...kde, agenda, clenenie, randomUUID()],
      );
    }
    await database.query(
      `INSERT INTO ucto_kategorie
        (id,tenant_id,organization_id,nazov,popis,slovnik,predkontacia_kod,predkontacia_id,clenenie_dph_kod,clenenie_dph_id,agendy,pocet)
       VALUES ($1,$2,$3,'Služby','Servis','["servis"]'::jsonb,'518/321',$4,'PDsluz',$5,'["FP"]'::jsonb,10)`,
      [randomUUID(), ...kde, p518, pdsluz],
    );
    await database.query(
      `INSERT INTO documents (id,tenant_id,organization_id,document_type,podtyp,status,processing_status,extracted,accounting,total_amount,currency)
       VALUES ($1,$2,$3,'FP','dobropis','na_kontrole','ready_for_review','{}'::jsonb,'{}'::jsonb,-100,'EUR')`,
      [documentId, ...kde],
    );
    const parser = {
      create: vi.fn().mockResolvedValue(aiOdpoved({
        predkontaciaId: p518, clenenieDphId: pn, clenenieKvKod: null, ciselnyRadId: null, confidence: 0.8, reason: 'Dobropis servisu',
        riadky: [{ index: 1, predkontaciaId: p501, clenenieDphId: pdsluz, clenenieKvKod: null, podiel: null, podielDph: null }],
      })),
    };
    expect(await maybeAiAccountingSuggestion(database, testConfig(),
      { tenantId: seeded.tenantId, organizationId: seeded.organizationId, documentId, supplierName: 'Servis s.r.o.' },
      { documentType: 'FP', podtyp: 'dobropis', supplierName: 'Servis s.r.o.', totalAmount: -100, currency: 'EUR',
        lineDescriptions: ['servis tlaciarne', 'doprava'] }, parser)).toBe(true);

    const payload = JSON.parse((parser.create.mock.calls[0][0] as any).input[0].content[0].text);
    const ponuka = payload.ciselniky.cleneniaDph.map((item: { id: string }) => item.id);
    expect(ponuka).toContain(pn);
    expect(ponuka).not.toContain(pdsluz);
    // Riadok s kódom mimo ponuky ostáva — zdedí členenie hlavičky, suma sa nestratí.
    const riadky = (await database.query<Record<string, any>>(
      'SELECT riadky FROM accounting_suggestions WHERE document_id=$1', [documentId])).rows[0].riadky;
    expect(riadky).toHaveLength(1);
    expect(riadky[0]).toMatchObject({ index: 1, predkontaciaId: p501 });
    expect(riadky[0]).not.toHaveProperty('clenenieDphId');
  }, 90_000);

  it('mzdy: kategória interných dokladov predbehne rovnako zhodnú kategóriu faktúr', async () => {
    const database = await createTestDatabase();
    databases.push(database);
    const seeded = await seedTestUser(database);
    const kde = [seeded.tenantId, seeded.organizationId];
    const documentId = randomUUID();
    const pred = randomUUID();
    await database.query(
      `INSERT INTO code_list_items (id,tenant_id,organization_id,kind,code,name,source)
       VALUES ($1,$2,$3,'predkontacie','521/331','Mzdy','pohoda')`,
      [pred, ...kde],
    );
    // Faktúrová kategória je väčšia — bez zhody agendy by vyhrala počtom.
    for (const [nazov, agendy, pocet] of [['Mzdy faktúry', '["FP"]', 50], ['Mzdy interné', '["INT"]', 5]] as const) {
      await database.query(
        `INSERT INTO ucto_kategorie (id,tenant_id,organization_id,nazov,popis,slovnik,predkontacia_id,agendy,pocet)
         VALUES ($1,$2,$3,$4,'popis','["mzda"]'::jsonb,$5,$6::jsonb,$7)`,
        [randomUUID(), ...kde, nazov, pred, agendy, pocet],
      );
    }
    await database.query(
      `INSERT INTO documents (id,tenant_id,organization_id,document_type,status,processing_status,extracted,accounting,total_amount,currency)
       VALUES ($1,$2,$3,'MZDY','na_kontrole','ready_for_review','{}'::jsonb,'{}'::jsonb,1000,'EUR')`,
      [documentId, ...kde],
    );
    const parser = {
      create: vi.fn().mockResolvedValue(aiOdpoved({
        predkontaciaId: pred, clenenieDphId: null, clenenieKvKod: null, ciselnyRadId: null, confidence: 0.8, reason: 'Mzdy', riadky: null,
      })),
    };
    await maybeAiAccountingSuggestion(database, testConfig(),
      { tenantId: seeded.tenantId, organizationId: seeded.organizationId, documentId },
      { documentType: 'MZDY', totalAmount: 1000, currency: 'EUR', lineDescriptions: ['hruba mzda'] }, parser);

    const payload = JSON.parse((parser.create.mock.calls[0][0] as any).input[0].content[0].text);
    expect(payload.kategorie.map((kategoria: { nazov: string }) => kategoria.nazov)).toEqual(['Mzdy interné', 'Mzdy faktúry']);
  }, 90_000);
});

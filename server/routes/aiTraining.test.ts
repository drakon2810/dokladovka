import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { buildApp } from '../app.js';
import { createTestDatabase, seedTestUser, testConfig } from '../testHelpers.js';
import { MemoryObjectStorage } from '../storage.js';
import { rebuildAccountingSuggestion, updateRuleFeedback } from '../services/accountingSuggestionService.js';

const databases: Awaited<ReturnType<typeof createTestDatabase>>[] = [];
afterEach(async () => Promise.all(databases.splice(0).map((database) => database.close())));

function sessionHeaders(response: { headers: Record<string, unknown>; json(): any }) {
  const cookie = String(response.headers['set-cookie']).split(';')[0];
  const csrf = response.json().csrfToken as string;
  return { cookie, 'x-csrf-token': csrf };
}

describe('Tréning AI', () => {
  it('import preloží kódy, odmietne neplatné riadky, nezakladá duplicity a plní pamäť návrhov', async () => {
    const database = await createTestDatabase();
    databases.push(database);
    const seeded = await seedTestUser(database);
    const pred = randomUUID();
    const dph = randomUUID();
    const rad = randomUUID();
    for (const [id, kind, code] of [
      [pred, 'predkontacie', '518/321'], [dph, 'cleneniaDph', '19Ušt'], [rad, 'ciselneRady', 'PF'],
    ] as const) {
      await database.query(
        `INSERT INTO code_list_items (id,tenant_id,organization_id,kind,code,name,source)
         VALUES ($1,$2,$3,$4,$5,$5,'manual')`,
        [id, seeded.tenantId, seeded.organizationId, kind, code],
      );
    }
    const app = await buildApp({ database, storage: new MemoryObjectStorage(), config: testConfig(), logger: false });
    const login = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { email: seeded.email, password: seeded.password } });
    const headers = sessionHeaders(login);

    const rows = [
      { supplierIco: '35 763 469', supplierName: 'Slovak Telekom', lineText: 'Mesačný poplatok', predkontaciaKod: '518/321', clenenieDphKod: '19Ušt', ciselnyRadKod: 'PF', clenenieKvKod: 'B2' },
      { supplierIco: '11112222', supplierName: 'Neznámy kód', predkontaciaKod: '999' },
      { lineText: 'bez dodávateľa', predkontaciaKod: '518/321' },
    ];
    const first = await app.inject({
      method: 'PUT', url: `/api/organizations/${seeded.organizationId}/ai-training/import`, headers, payload: { rows },
    });
    expect(first.statusCode).toBe(200);
    expect(first.json()).toMatchObject({ imported: 1, duplicates: 0 });
    expect(first.json().rejected).toHaveLength(2);

    // Opakovaný import toho istého súboru: nič nové, jedna duplicita.
    const second = await app.inject({
      method: 'PUT', url: `/api/organizations/${seeded.organizationId}/ai-training/import`, headers, payload: { rows: [rows[0]] },
    });
    expect(second.json()).toMatchObject({ imported: 0, duplicates: 1 });

    const stats = await app.inject({
      method: 'GET', url: `/api/organizations/${seeded.organizationId}/ai-training/stats`, headers: { cookie: headers.cookie },
    });
    expect(stats.json()).toMatchObject({ schvalene: 0, importovane: 1 });

    // Importovaná história je zdrojom návrhu decision_memory vrátane KV.
    const documentId = randomUUID();
    await database.query(
      `INSERT INTO documents (id,tenant_id,organization_id,document_type,status,processing_status,extracted,accounting,total_amount,currency)
       VALUES ($1,$2,$3,'FP','na_kontrole','ready_for_review',$4::jsonb,'{}'::jsonb,30,'EUR')`,
      [documentId, seeded.tenantId, seeded.organizationId,
        JSON.stringify({ dodavatel: { nazov: 'Slovak Telekom', ico: '35763469' }, polozky: [{ popis: 'Mesačný poplatok' }] })],
    );
    await rebuildAccountingSuggestion(database, {
      tenantId: seeded.tenantId, organizationId: seeded.organizationId, documentId,
      supplierIco: '35763469', supplierName: 'Slovak Telekom',
    });
    const suggestion = (await database.query<Record<string, any>>(
      'SELECT source, confidence, predkontacia_id, clenenie_kv_kod FROM accounting_suggestions WHERE document_id=$1', [documentId],
    )).rows[0];
    expect(suggestion).toMatchObject({ source: 'decision_memory', predkontacia_id: pred, clenenie_kv_kod: 'B2' });
    expect(Number(suggestion.confidence)).toBeCloseTo(0.95);
  }, 120_000);

  it('AI navrhne pravidlá (len platné ID), potvrdené pravidlo navrhuje podľa kľúčových slov a 3 opravy ho deaktivujú', async () => {
    const database = await createTestDatabase();
    databases.push(database);
    const seeded = await seedTestUser(database);
    const pred = randomUUID();
    const dph = randomUUID();
    for (const [id, kind, code] of [[pred, 'predkontacie', '501/321'], [dph, 'cleneniaDph', 'PN']] as const) {
      await database.query(
        `INSERT INTO code_list_items (id,tenant_id,organization_id,kind,code,name,source)
         VALUES ($1,$2,$3,$4,$5,$5,'manual')`,
        [id, seeded.tenantId, seeded.organizationId, kind, code],
      );
    }
    for (let index = 0; index < 3; index += 1) {
      await database.query(
        `INSERT INTO ucto_decisions
          (id,tenant_id,organization_id,supplier_ico,supplier_name_normalized,line_text_normalized,
           predkontacia_id,clenenie_dph_id,source)
         VALUES ($1,$2,$3,'31322832','slovnaft',$4,$5,$6,'import')`,
        [randomUUID(), seeded.tenantId, seeded.organizationId, `nafta phm ${index}`, pred, dph],
      );
    }

    // Parser vráti jedno platné keyword pravidlo a jedno s vymysleným ID cieľa.
    const parser = {
      parse: vi.fn().mockResolvedValue({
        output_parsed: {
          pravidla: [
            { supplierIco: null, supplierName: null, klucoveSlova: ['PHM', 'nafta'], predkontaciaId: pred, clenenieDphId: dph, ciselnyRadId: null, strediskoId: null, clenenieKvKod: 'KN', dovod: 'Palivo sa účtuje rovnako' },
            { supplierIco: null, supplierName: null, klucoveSlova: ['obed'], predkontaciaId: 'vymyslene-id', clenenieDphId: null, ciselnyRadId: null, strediskoId: null, clenenieKvKod: null, dovod: 'Neplatné' },
          ],
        },
      }),
    };
    const app = await buildApp({ database, storage: new MemoryObjectStorage(), config: testConfig(), logger: false, aiRulesParser: parser });
    const login = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { email: seeded.email, password: seeded.password } });
    const headers = sessionHeaders(login);

    const analyze = await app.inject({
      method: 'POST', url: `/api/organizations/${seeded.organizationId}/ai-training/analyze`, headers, payload: {},
    });
    expect(analyze.statusCode).toBe(200);
    const proposals = analyze.json().pravidla;
    expect(proposals).toHaveLength(1);
    expect(proposals[0]).toMatchObject({ klucoveSlova: ['PHM', 'nafta'], predkontaciaId: pred, clenenieKvKod: 'KN' });

    const confirm = await app.inject({
      method: 'POST', url: `/api/organizations/${seeded.organizationId}/ai-training/rules`, headers, payload: { pravidla: proposals },
    });
    expect(confirm.statusCode).toBe(200);
    expect(confirm.json()).toMatchObject({ created: 1 });
    const ruleId = (await database.query<{ id: string } & Record<string, unknown>>(
      `SELECT id FROM accounting_rules WHERE organization_id=$1 AND origin='ai'`, [seeded.organizationId],
    )).rows[0].id;

    // Keyword pravidlo chytí aj úplne nového dodávateľa podľa textu položky.
    const documentId = randomUUID();
    await database.query(
      `INSERT INTO documents (id,tenant_id,organization_id,document_type,status,processing_status,extracted,accounting,total_amount,currency)
       VALUES ($1,$2,$3,'FP','na_kontrole','ready_for_review',$4::jsonb,'{}'::jsonb,60,'EUR')`,
      [documentId, seeded.tenantId, seeded.organizationId,
        JSON.stringify({ dodavatel: { nazov: 'Nová pumpa', ico: '99991111' }, polozky: [{ popis: 'Nafta PHM 50L' }] })],
    );
    const input = { tenantId: seeded.tenantId, organizationId: seeded.organizationId, documentId, supplierIco: '99991111', supplierName: 'Nová pumpa' };
    await rebuildAccountingSuggestion(database, input);
    const suggestion = (await database.query<Record<string, any>>(
      'SELECT source, rule_id, predkontacia_id, clenenie_kv_kod FROM accounting_suggestions WHERE document_id=$1', [documentId],
    )).rows[0];
    expect(suggestion).toMatchObject({ source: 'manual_rule', rule_id: ruleId, predkontacia_id: pred, clenenie_kv_kod: 'KN' });

    // Tri opravy po sebe: pravidlo sa deaktivuje a označí na kontrolu.
    for (let index = 0; index < 3; index += 1) {
      await updateRuleFeedback(database, { tenantId: seeded.tenantId, documentId, accounting: { predkontaciaId: 'ine-id' } });
    }
    const flagged = (await database.query<Record<string, any>>(
      'SELECT active, needs_review, corrections_count FROM accounting_rules WHERE id=$1', [ruleId],
    )).rows[0];
    expect(flagged).toMatchObject({ active: false, needs_review: true });
    expect(Number(flagged.corrections_count)).toBe(3);

    await rebuildAccountingSuggestion(database, input);
    const afterFlag = (await database.query<Record<string, any>>(
      'SELECT source FROM accounting_suggestions WHERE document_id=$1', [documentId],
    )).rows[0];
    expect(afterFlag.source).not.toBe('manual_rule');

    // Obnovenie účtovníkom: pravidlo znovu platí, počítadlo je vynulované.
    const activate = await app.inject({
      method: 'POST', url: `/api/organizations/${seeded.organizationId}/ai-training/rules/${ruleId}/activate`, headers, payload: {},
    });
    expect(activate.statusCode).toBe(200);
    await rebuildAccountingSuggestion(database, input);
    expect((await database.query<Record<string, any>>(
      'SELECT source FROM accounting_suggestions WHERE document_id=$1', [documentId],
    )).rows[0].source).toBe('manual_rule');
  }, 120_000);
});

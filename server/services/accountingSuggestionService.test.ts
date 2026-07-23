import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createTestDatabase, seedTestUser, testConfig } from '../testHelpers.js';
import { forgetUctoDecision, maybeAiAccountingSuggestion, rebuildAccountingSuggestion, recordUctoDecision, textSimilarity, updateRuleFeedback } from './accountingSuggestionService.js';

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

    // Členenie KV sa odvodzuje z kv_section zvoleného členenia DPH.
    await database.query(`UPDATE code_list_items SET kv_section='B2' WHERE id=$1`, [dph]);

    const input = { tenantId: seeded.tenantId, organizationId: seeded.organizationId, documentId: currentId, supplierIco: '11112222', supplierName: 'Rovnaký dodávateľ' };
    await rebuildAccountingSuggestion(database, input);
    const ruleSuggestion = (await database.query<{ source: string; clenenie_kv_kod?: string } & Record<string, unknown>>('SELECT source, clenenie_kv_kod FROM accounting_suggestions WHERE document_id=$1', [currentId])).rows[0];
    expect(ruleSuggestion).toMatchObject({ source: 'manual_rule', clenenie_kv_kod: 'B2' });

    await database.query('UPDATE accounting_rules SET active=false WHERE organization_id=$1', [seeded.organizationId]);
    await rebuildAccountingSuggestion(database, input);
    const history = (await database.query<{ source: string; based_on_document_id?: string } & Record<string, unknown>>('SELECT source,based_on_document_id FROM accounting_suggestions WHERE document_id=$1', [currentId])).rows[0];
    expect(history).toMatchObject({ source: 'supplier_history', based_on_document_id: historyId });

    await database.query(`UPDATE documents SET status='zamietnuty' WHERE id=$1`, [historyId]);
    await rebuildAccountingSuggestion(database, input);
    expect((await database.query<{ source: string } & Record<string, unknown>>('SELECT source FROM accounting_suggestions WHERE document_id=$1', [currentId])).rows[0].source).toBe('organization_default');
  }, 90_000);

  it('pamäť rozhodnutí: presná zhoda textu > dodávateľ > história; zabudnutie vracia históriu', async () => {
    const database = await createTestDatabase();
    databases.push(database);
    const seeded = await seedTestUser(database);
    const currentId = randomUUID();
    const historyId = randomUUID();
    const pred = randomUUID();
    const predHistoria = randomUUID();
    const dph = randomUUID();
    const series = randomUUID();
    for (const [id, kind, code] of [
      [pred, 'predkontacie', '501/321'], [predHistoria, 'predkontacie', '518/321'],
      [dph, 'cleneniaDph', 'PN'], [series, 'ciselneRady', 'PF'],
    ] as const) {
      await database.query(
        `INSERT INTO code_list_items (id,tenant_id,organization_id,kind,code,name,source)
         VALUES ($1,$2,$3,$4,$5,$5,'manual')`,
        [id, seeded.tenantId, seeded.organizationId, kind, code],
      );
    }
    const extracted = {
      dodavatel: { nazov: 'Slovnaft', ico: '31322832' },
      polozky: [{ popis: 'Nafta PHM 50L' }],
      cisloFaktury: '1', datumVystavenia: '2026-07-01', mena: 'EUR', rozpisDph: [], sumaSpolu: 60,
    };
    const insertDocument = async (id: string, status: string, accounting: Record<string, string>) => database.query(
      `INSERT INTO documents
        (id,tenant_id,organization_id,document_type,status,processing_status,extracted,accounting,total_amount,currency)
       VALUES ($1,$2,$3,'FP',$4,'ready_for_review',$5::jsonb,$6::jsonb,60,'EUR')`,
      [id, seeded.tenantId, seeded.organizationId, status, JSON.stringify(extracted), JSON.stringify(accounting)],
    );
    await insertDocument(currentId, 'na_kontrole', {});
    await insertDocument(historyId, 'schvaleny', { predkontaciaId: predHistoria, clenenieDphId: dph, ciselnyRadId: series });

    // Schválenie zapisuje do pamäte; opakované schválenie prepíše ten istý riadok.
    const decision = {
      tenantId: seeded.tenantId, organizationId: seeded.organizationId, documentId: historyId,
      extracted,
      accounting: { predkontaciaId: pred, clenenieDphId: dph, ciselnyRadId: series, clenenieKvKod: 'B3' },
    };
    await recordUctoDecision(database, { ...decision, accounting: { ...decision.accounting, clenenieKvKod: 'A1' } });
    await recordUctoDecision(database, decision);
    const rows = await database.query('SELECT clenenie_kv_kod FROM ucto_decisions WHERE document_id=$1', [historyId]);
    expect(rows.rows).toHaveLength(1);
    expect(rows.rows[0].clenenie_kv_kod).toBe('B3');

    const input = { tenantId: seeded.tenantId, organizationId: seeded.organizationId, documentId: currentId, supplierIco: '31322832', supplierName: 'Slovnaft' };
    const suggestionRow = async () => (await database.query<Record<string, any>>(
      'SELECT source, confidence, predkontacia_id, clenenie_kv_kod FROM accounting_suggestions WHERE document_id=$1', [currentId],
    )).rows[0];

    // Presná zhoda dodávateľa + textu položiek: 0.95, pamäť vyhráva nad históriou.
    await rebuildAccountingSuggestion(database, input);
    let suggestion = await suggestionRow();
    expect(suggestion).toMatchObject({ source: 'decision_memory', predkontacia_id: pred, clenenie_kv_kod: 'B3' });
    expect(Number(suggestion.confidence)).toBeCloseTo(0.95);

    // Iný text položiek: zhoda len podľa dodávateľa, 0.88.
    await database.query(
      `UPDATE documents SET extracted=$1::jsonb WHERE id=$2`,
      [JSON.stringify({ ...extracted, polozky: [{ popis: 'Umytie vozidla' }] }), currentId],
    );
    await rebuildAccountingSuggestion(database, input);
    suggestion = await suggestionRow();
    expect(suggestion).toMatchObject({ source: 'decision_memory', predkontacia_id: pred });
    expect(Number(suggestion.confidence)).toBeCloseTo(0.88);

    // Zabudnutie (zrušenie schválenia) — návrh padne späť na históriu dokladov.
    await forgetUctoDecision(database, seeded.tenantId, historyId);
    await rebuildAccountingSuggestion(database, input);
    suggestion = await suggestionRow();
    expect(suggestion).toMatchObject({ source: 'supplier_history', predkontacia_id: predHistoria });
  }, 90_000);

  it('neúplné pravidlo dodávateľa (len členenie DPH) nezatieni predkontáciu z pravidla kľúčového slova', async () => {
    const database = await createTestDatabase();
    databases.push(database);
    const seeded = await seedTestUser(database);
    const documentId = randomUUID();
    const pred = randomUUID();
    const dph = randomUUID();
    for (const [id, kind, code] of [[pred, 'predkontacie', '518100'], [dph, 'cleneniaDph', 'PD']] as const) {
      await database.query(
        `INSERT INTO code_list_items (id,tenant_id,organization_id,kind,code,name,source)
         VALUES ($1,$2,$3,$4,$5,$5,'manual')`,
        [id, seeded.tenantId, seeded.organizationId, kind, code],
      );
    }
    const extracted = {
      dodavatel: { nazov: 'Slovenská plavba a prístavy a.s.', ico: '35705671' },
      polozky: [{ popis: 'PB PODNÁJOM nehnuteľnosti - kancelárie / mes.' }],
      cisloFaktury: '1', datumVystavenia: '2026-07-01', mena: 'EUR', rozpisDph: [], sumaSpolu: 122,
    };
    await database.query(
      `INSERT INTO documents (id,tenant_id,organization_id,document_type,status,processing_status,extracted,accounting,total_amount,currency)
       VALUES ($1,$2,$3,'FP','na_kontrole','ready_for_review',$4::jsonb,'{}'::jsonb,122,'EUR')`,
      [documentId, seeded.tenantId, seeded.organizationId, JSON.stringify(extracted)],
    );
    // Pravidlo dodávateľa: iba členenie DPH (bez predkontácie).
    await database.query(
      `INSERT INTO accounting_rules (id,tenant_id,organization_id,supplier_ico,clenenie_dph_id,origin)
       VALUES ($1,$2,$3,'35705671',$4,'ai')`,
      [randomUUID(), seeded.tenantId, seeded.organizationId, dph],
    );
    // Pravidlo kľúčového slova: predkontácia pre „nájom".
    await database.query(
      `INSERT INTO accounting_rules (id,tenant_id,organization_id,keywords,predkontacia_id,origin)
       VALUES ($1,$2,$3,$4::jsonb,$5,'ai')`,
      [randomUUID(), seeded.tenantId, seeded.organizationId, JSON.stringify(['nájom']), pred],
    );

    const input = { tenantId: seeded.tenantId, organizationId: seeded.organizationId, documentId, supplierIco: '35705671', supplierName: 'Slovenská plavba a prístavy a.s.' };
    await rebuildAccountingSuggestion(database, input);
    const suggestion = (await database.query<Record<string, any>>(
      'SELECT source, predkontacia_id, clenenie_dph_id FROM accounting_suggestions WHERE document_id=$1', [documentId],
    )).rows[0];
    expect(suggestion).toMatchObject({ source: 'manual_rule', predkontacia_id: pred, clenenie_dph_id: dph });
  }, 90_000);

  it('VAT-only pravidlo doplní predkontáciu z pamäte (presná zhoda textu = istota, inak návrh)', async () => {
    const database = await createTestDatabase();
    databases.push(database);
    const seeded = await seedTestUser(database);
    const predA = randomUUID();
    const predB = randomUUID();
    const dph = randomUUID();
    for (const [id, kind, code] of [
      [predA, 'predkontacie', '518200 prepr.'], [predB, 'predkontacie', '518900 sklad'], [dph, 'cleneniaDph', 'PN'],
    ] as const) {
      await database.query(
        `INSERT INTO code_list_items (id,tenant_id,organization_id,kind,code,name,source)
         VALUES ($1,$2,$3,$4,$5,$5,'manual')`,
        [id, seeded.tenantId, seeded.organizationId, kind, code],
      );
    }
    // VAT-only pravidlo: dodávateľ CMA CGM → len členenie PN, bez predkontácie.
    await database.query(
      `INSERT INTO accounting_rules (id,tenant_id,organization_id,supplier_ico,clenenie_dph_id,clenenie_kv_kod,origin)
       VALUES ($1,$2,$3,'11112222',$4,'KN','ai')`,
      [randomUUID(), seeded.tenantId, seeded.organizationId, dph],
    );
    // Pamäť: „preprava" → 518200, novšie „sklad" → 518900 (dodávateľ účtuje rôzne).
    for (const [text, pred, offset] of [['preprava', predA, 2], ['sklad', predB, 1]] as const) {
      await database.query(
        `INSERT INTO ucto_decisions
          (id,tenant_id,organization_id,supplier_ico,supplier_name_normalized,line_text_normalized,predkontacia_id,clenenie_dph_id,source,created_at)
         VALUES ($1,$2,$3,'11112222','cma cgm',$4,$5,$6,'import',now() - ($7 || ' hours')::interval)`,
        [randomUUID(), seeded.tenantId, seeded.organizationId, text, pred, dph, offset],
      );
    }

    const mkDoc = async (id: string, popis: string) => database.query(
      `INSERT INTO documents (id,tenant_id,organization_id,document_type,status,processing_status,extracted,accounting,total_amount,currency)
       VALUES ($1,$2,$3,'FP','na_kontrole','ready_for_review',$4::jsonb,'{}'::jsonb,100,'EUR')`,
      [id, seeded.tenantId, seeded.organizationId,
        JSON.stringify({ dodavatel: { nazov: 'CMA CGM', ico: '11112222' }, polozky: [{ popis }] })],
    );

    // Presná zhoda textu „preprava" → účet 518200, istota ostáva 1.0.
    const docExact = randomUUID();
    await mkDoc(docExact, 'preprava');
    await rebuildAccountingSuggestion(database, { tenantId: seeded.tenantId, organizationId: seeded.organizationId, documentId: docExact, supplierIco: '11112222', supplierName: 'CMA CGM' });
    const exact = (await database.query<Record<string, any>>('SELECT source, predkontacia_id, clenenie_dph_id, clenenie_kv_kod, confidence FROM accounting_suggestions WHERE document_id=$1', [docExact])).rows[0];
    expect(exact).toMatchObject({ source: 'manual_rule', predkontacia_id: predA, clenenie_dph_id: dph, clenenie_kv_kod: 'KN' });
    expect(Number(exact.confidence)).toBeCloseTo(1);

    // Nový text bez presnej zhody → účet z posledného dokladu (518900), istota 0.85 (len návrh).
    const docNovy = randomUUID();
    await mkDoc(docNovy, 'nakladka tovaru');
    await rebuildAccountingSuggestion(database, { tenantId: seeded.tenantId, organizationId: seeded.organizationId, documentId: docNovy, supplierIco: '11112222', supplierName: 'CMA CGM' });
    const novy = (await database.query<Record<string, any>>('SELECT source, predkontacia_id, clenenie_dph_id, confidence FROM accounting_suggestions WHERE document_id=$1', [docNovy])).rows[0];
    expect(novy).toMatchObject({ source: 'manual_rule', predkontacia_id: predB, clenenie_dph_id: dph });
    expect(Number(novy.confidence)).toBeCloseTo(0.85);
  }, 90_000);

  it('spätná väzba pravidla: povinné doplnenie prázdneho poľa nie je oprava', async () => {
    const database = await createTestDatabase();
    databases.push(database);
    const seeded = await seedTestUser(database);
    const documentId = randomUUID();
    const ruleId = randomUUID();
    const pred = randomUUID();
    const dph = randomUUID();
    await database.query(
      `INSERT INTO documents (id,tenant_id,organization_id,document_type,status,processing_status,extracted,accounting,total_amount,currency)
       VALUES ($1,$2,$3,'FP','na_kontrole','ready_for_review','{}'::jsonb,'{}'::jsonb,50,'EUR')`,
      [documentId, seeded.tenantId, seeded.organizationId],
    );
    // Keyword pravidlo nesie len predkontáciu; členenie DPH nechalo prázdne.
    await database.query(
      `INSERT INTO accounting_rules (id,tenant_id,organization_id,keywords,predkontacia_id,origin)
       VALUES ($1,$2,$3,'["phm"]'::jsonb,$4,'ai')`,
      [ruleId, seeded.tenantId, seeded.organizationId, pred],
    );
    await database.query(
      `INSERT INTO accounting_suggestions
        (document_id,tenant_id,organization_id,predkontacia_id,clenenie_dph_id,source,confidence,reason,rule_id)
       VALUES ($1,$2,$3,$4,NULL,'manual_rule',1,'test',$5)`,
      [documentId, seeded.tenantId, seeded.organizationId, pred, ruleId],
    );

    // Účtovník ponechá predkontáciu z pravidla, doplní povinné členenie DPH.
    for (let index = 0; index < 3; index += 1) {
      await updateRuleFeedback(database, {
        tenantId: seeded.tenantId, documentId,
        accounting: { predkontaciaId: pred, clenenieDphId: dph },
      });
    }
    const rule = (await database.query<Record<string, any>>(
      'SELECT active, needs_review, corrections_count FROM accounting_rules WHERE id=$1', [ruleId],
    )).rows[0];
    expect(rule).toMatchObject({ active: true, needs_review: false });
    expect(Number(rule.corrections_count)).toBe(0);

    // Skutočná zmena predkontácie sa naopak započíta ako oprava.
    await updateRuleFeedback(database, {
      tenantId: seeded.tenantId, documentId, accounting: { predkontaciaId: randomUUID(), clenenieDphId: dph },
    });
    expect(Number((await database.query<Record<string, any>>(
      'SELECT corrections_count FROM accounting_rules WHERE id=$1', [ruleId],
    )).rows[0].corrections_count)).toBe(1);
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

  it('AI fallback dostane podobné príklady z pamäte (retrieval), beží na routovanom modeli a rešpektuje excluded', async () => {
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
    // Pamäť INÉHO dodávateľa s podobným textom — cascade ho podľa dodávateľa
    // nenájde (source='none'), ale retrieval ho ponúkne modelu ako príklad.
    const decisionId = randomUUID();
    await database.query(
      `INSERT INTO ucto_decisions
        (id,tenant_id,organization_id,supplier_ico,supplier_name_normalized,line_text_normalized,
         predkontacia_id,clenenie_dph_id,clenenie_kv_kod,source)
       VALUES ($1,$2,$3,'99998888','iny dodavatel','konzultacie k projektu',$4,$5,'B2','import')`,
      [decisionId, seeded.tenantId, seeded.organizationId, pred, dph],
    );

    const input = { tenantId: seeded.tenantId, organizationId: seeded.organizationId, documentId, supplierIco: '11112222', supplierName: 'Nový dodávateľ' };
    const parser = {
      parse: vi.fn().mockResolvedValue({
        output_parsed: { predkontaciaId: pred, clenenieDphId: dph, ciselnyRadId: null, confidence: 0.7, reason: 'Podľa príkladu' },
      }),
    };
    const context = { documentType: 'FP', supplierName: 'Nový dodávateľ', totalAmount: 100, currency: 'EUR', lineDescriptions: ['Konzultácie'] };

    await rebuildAccountingSuggestion(database, input);
    expect(await maybeAiAccountingSuggestion(database, testConfig(), input, context, parser)).toBe(true);
    const firstCall = parser.parse.mock.calls[0][0] as any;
    expect(firstCall.model).toBe('gpt-5.6-terra'); // routovaný fallback model
    const payload = JSON.parse(firstCall.input[0].content[0].text);
    expect(payload.priklady).toHaveLength(1);
    expect(payload.priklady[0]).toMatchObject({ predkontaciaId: pred });

    // Po vylúčení dodávateľa z učenia retrieval príklad už nepošle.
    await database.query('UPDATE ucto_decisions SET excluded=true WHERE id=$1', [decisionId]);
    await database.query('DELETE FROM accounting_suggestions WHERE document_id=$1', [documentId]);
    await rebuildAccountingSuggestion(database, input);
    expect(await maybeAiAccountingSuggestion(database, testConfig(), input, context, parser)).toBe(true);
    const secondPayload = JSON.parse((parser.parse.mock.calls[1][0] as any).input[0].content[0].text);
    expect(secondPayload.priklady).toHaveLength(0);
  }, 90_000);

  it('DPH kontrola po AI zahodí neplatiteľské odpočtové členenie mimo zúženej ponuky', async () => {
    const database = await createTestDatabase();
    databases.push(database);
    const seeded = await seedTestUser(database);
    const documentId = randomUUID();
    const pred = randomUUID();
    const bezOdp = randomUUID();
    const odpocet = randomUUID();
    await database.query(
      `INSERT INTO documents (id,tenant_id,organization_id,document_type,status,processing_status,extracted,accounting,total_amount,currency)
       VALUES ($1,$2,$3,'FP','na_kontrole','ready_for_review',$4::jsonb,'{}'::jsonb,100,'EUR')`,
      [documentId, seeded.tenantId, seeded.organizationId,
        JSON.stringify({ dodavatel: { nazov: 'Dodávateľ', ico: '11112222' }, polozky: [{ popis: 'Služba' }] })],
    );
    for (const [id, kind, code, name] of [
      [pred, 'predkontacie', '518/321', '518/321'],
      [bezOdp, 'cleneniaDph', 'BO', 'Bez nároku na odpočet'],
      [odpocet, 'cleneniaDph', '19Ušt', 'DPH 19% s odpočtom'],
    ] as const) {
      await database.query(
        `INSERT INTO code_list_items (id,tenant_id,organization_id,kind,code,name,source)
         VALUES ($1,$2,$3,$4,$5,$6,'pohoda')`,
        [id, seeded.tenantId, seeded.organizationId, kind, code, name],
      );
    }
    // Neplatiteľ s definovaným členením bez odpočtu → ponuka pre model sa zúži naň.
    await database.query(
      `INSERT INTO organization_dph_profiles (organization_id,tenant_id,platitel_dph,clenenie_bez_odpoctu_id)
       VALUES ($1,$2,'neplatitel',$3)`,
      [seeded.organizationId, seeded.tenantId, bezOdp],
    );

    const input = { tenantId: seeded.tenantId, organizationId: seeded.organizationId, documentId, supplierIco: '11112222', supplierName: 'Dodávateľ' };
    await rebuildAccountingSuggestion(database, input);
    // Model (nepoctivo) vráti aktívne odpočtové členenie mimo zúženej ponuky.
    const parser = {
      parse: vi.fn().mockResolvedValue({
        output_parsed: { predkontaciaId: pred, clenenieDphId: odpocet, ciselnyRadId: null, confidence: 0.8, reason: 'Odpočet' },
      }),
    };
    const context = { documentType: 'FP', supplierName: 'Dodávateľ', totalAmount: 100, currency: 'EUR', lineDescriptions: ['Služba'] };
    // DPH poradca odpočet neplatiteľa zablokuje → návrh sa nezapíše.
    expect(await maybeAiAccountingSuggestion(database, testConfig(), input, context, parser)).toBe(false);
    expect((await database.query<Record<string, any>>(
      'SELECT source FROM accounting_suggestions WHERE document_id=$1', [documentId],
    )).rows[0].source).toBe('none');
  }, 90_000);
});

describe('textSimilarity', () => {
  it('koeficient prekrytia tokenov, ignoruje diakritiku a krátke slová', () => {
    expect(textSimilarity('mesačný prenájom kancelárie', 'mesacny prenajom kancelarie')).toBeCloseTo(1);
    expect(textSimilarity('nafta phm', 'umytie vozidla')).toBe(0);
    expect(textSimilarity('', 'čokoľvek')).toBe(0);
    // čiastočné prekrytie: {prenajom, kancelarie} ∩ {prenajom, auta} = 1 z min(2,2)
    expect(textSimilarity('prenajom kancelarie', 'prenajom auta')).toBeCloseTo(0.5);
  });
});

import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { aiOdpoved, createTestDatabase, seedTestUser, testConfig } from '../testHelpers.js';
import { forgetUctoDecision, maybeAiAccountingSuggestion, rebuildAccountingSuggestion, recordUctoDecision, textSimilarity, updateRuleFeedback, zuzPonukuPredkontacii } from './accountingSuggestionService.js';

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
    const rows = await database.query('SELECT clenenie_kv_kod, polozky_ucto FROM ucto_decisions WHERE document_id=$1', [historyId]);
    expect(rows.rows).toHaveLength(1);
    expect(rows.rows[0].clenenie_kv_kod).toBe('B3');
    // Položky bez vlastného zaúčtovania nevyrábajú prázdny jsonb zápis.
    expect(rows.rows[0].polozky_ucto).toBeNull();

    // Per-riadkové zaúčtovanie z ItemsSection sa ukladá ako zásoba pre seed typov položiek.
    await recordUctoDecision(database, {
      ...decision,
      extracted: {
        ...extracted,
        polozky: [
          { popis: 'Nafta PHM 50L', sadzbaDph: 23, ucto: { predkontaciaId: pred, clenenieDphId: dph } },
          { popis: 'Žuvačky', sadzbaDph: 23 },
        ],
      },
    });
    const perLine = await database.query<{ polozky_ucto: any }>(
      'SELECT polozky_ucto FROM ucto_decisions WHERE document_id=$1', [historyId],
    );
    const zapisy = typeof perLine.rows[0].polozky_ucto === 'string'
      ? JSON.parse(perLine.rows[0].polozky_ucto)
      : perLine.rows[0].polozky_ucto;
    // Iba riadky s vlastným zaúčtovaním; popis je normalizovaný.
    expect(zapisy).toEqual([
      { popis: 'nafta phm 50l', sadzbaDph: 23, predkontaciaId: pred, clenenieDphId: dph },
    ]);
    // Obnova pôvodného zápisu — zvyšok testu počíta s pôvodným textom položiek.
    await recordUctoDecision(database, decision);

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

  it('AI analýza vyberá len z aktívnych číselníkov; prepíše slabé zdroje, úplné pravidlo nie', async () => {
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
      create: vi.fn().mockResolvedValue(aiOdpoved({ clenenieKvKod: null, predkontaciaId: pred, clenenieDphId: 'vymyslene-id', ciselnyRadId: null, confidence: 0.9, reason: 'Služby podľa položiek' })),
    };
    const context = { documentType: 'FP', supplierName: 'Nový dodávateľ', totalAmount: 100, currency: 'EUR', lineDescriptions: ['Konzultácie'] };
    expect(await maybeAiAccountingSuggestion(database, testConfig(), input, context, parser)).toBe(true);
    const suggestion = (await database.query<Record<string, any>>('SELECT * FROM accounting_suggestions WHERE document_id=$1', [documentId])).rows[0];
    expect(suggestion.source).toBe('ai');
    expect(suggestion.predkontacia_id).toBe(pred);
    expect(suggestion.clenenie_dph_id).toBeNull();
    expect(Number(suggestion.confidence)).toBeLessThanOrEqual(0.8);

    // Slabé deterministické zdroje (pamäť/história) AI analýza nahradí…
    await database.query(`UPDATE accounting_suggestions SET source='supplier_history' WHERE document_id=$1`, [documentId]);
    expect(await maybeAiAccountingSuggestion(database, testConfig(), input, context, parser)).toBe(true);
    expect(parser.create).toHaveBeenCalledTimes(2);
    // …ale pravidlo účtovníka, ktoré určilo účet, DPH aj KV, je záväzné celé.
    await database.query(
      `UPDATE accounting_suggestions SET source='manual_rule', clenenie_dph_id=$2, clenenie_kv_kod='B2' WHERE document_id=$1`,
      [documentId, dph],
    );
    expect(await maybeAiAccountingSuggestion(database, testConfig(), input, context, parser)).toBe(false);
    expect(parser.create).toHaveBeenCalledTimes(2);
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

    // Textové pravidlá (globálne + firemné) idú modelu spolu s príkladmi.
    await database.query(
      `INSERT INTO ai_instructions (id,scope,nazov,text,faza) VALUES ($1,'global','Globálne','Konzultácie účtuj na 518.','both')`,
      [randomUUID()],
    );
    await database.query(
      `INSERT INTO ai_instructions (id,scope,tenant_id,organization_id,nazov,text,faza)
       VALUES ($1,'organization',$2,$3,'Firemné','Táto firma používa stredisko SPRAVA.','accounting')`,
      [randomUUID(), seeded.tenantId, seeded.organizationId],
    );

    const input = { tenantId: seeded.tenantId, organizationId: seeded.organizationId, documentId, supplierIco: '11112222', supplierName: 'Nový dodávateľ' };
    const parser = {
      create: vi.fn().mockResolvedValue(aiOdpoved({ clenenieKvKod: null, predkontaciaId: pred, clenenieDphId: dph, ciselnyRadId: null, confidence: 0.7, reason: 'Podľa príkladu' })),
    };
    const context = { documentType: 'FP', supplierName: 'Nový dodávateľ', totalAmount: 100, currency: 'EUR', lineDescriptions: ['Konzultácie'] };

    await rebuildAccountingSuggestion(database, input);
    expect(await maybeAiAccountingSuggestion(database, testConfig(), input, context, parser)).toBe(true);
    const firstCall = parser.create.mock.calls[0][0] as any;
    expect(firstCall.model).toBe('gpt-5.6-terra'); // routovaný fallback model
    const payload = JSON.parse(firstCall.input[0].content[0].text);
    expect(payload.priklady).toHaveLength(1);
    expect(payload.priklady[0]).toMatchObject({ predkontaciaId: pred });
    expect(payload.pravidla).toContain('Konzultácie účtuj na 518.');
    expect(payload.pravidla.indexOf('Konzultácie účtuj na 518.'))
      .toBeLessThan(payload.pravidla.indexOf('Táto firma používa stredisko SPRAVA.'));

    // Po vylúčení dodávateľa z učenia retrieval príklad už nepošle.
    await database.query('UPDATE ucto_decisions SET excluded=true WHERE id=$1', [decisionId]);
    await database.query('DELETE FROM accounting_suggestions WHERE document_id=$1', [documentId]);
    await rebuildAccountingSuggestion(database, input);
    expect(await maybeAiAccountingSuggestion(database, testConfig(), input, context, parser)).toBe(true);
    const secondPayload = JSON.parse((parser.create.mock.calls[1][0] as any).input[0].content[0].text);
    expect(secondPayload.priklady).toHaveLength(0);
  }, 90_000);

  it('FV: pamäť ide podľa odberateľa a nikdy nesiaha do prijatých faktúr', async () => {
    const database = await createTestDatabase();
    databases.push(database);
    const seeded = await seedTestUser(database);
    const pred = randomUUID();
    const dph = randomUUID();
    for (const [id, kind, code] of [[pred, 'predkontacie', '602/311'], [dph, 'cleneniaDph', 'UD']] as const) {
      await database.query(
        `INSERT INTO code_list_items (id,tenant_id,organization_id,kind,code,name,source)
         VALUES ($1,$2,$3,$4,$5,$5,'pohoda')`,
        [id, seeded.tenantId, seeded.organizationId, kind, code],
      );
    }
    // Pamäť PRIJATÝCH faktúr sesterskej firmy rovnakého mena — reálny prípad,
    // v ktorom FV preberala nákupnú DPH schému.
    await database.query(
      `INSERT INTO ucto_decisions
        (id,tenant_id,organization_id,supplier_name_normalized,line_text_normalized,predkontacia_id,clenenie_dph_id,clenenie_kv_kod,source)
       VALUES ($1,$2,$3,'ags bratislava','stahovanie',$4,$5,'KN','import')`,
      [randomUUID(), seeded.tenantId, seeded.organizationId, pred, dph],
    );
    const extracted = {
      dodavatel: { nazov: 'AGS Bratislava', ico: '35761571' },
      odberatel: { nazov: 'Kaczynska Sarah' },
      polozky: [{ popis: 'stahovanie' }],
    };
    const mkFv = async (id: string) => database.query(
      `INSERT INTO documents (id,tenant_id,organization_id,document_type,status,processing_status,extracted,accounting,total_amount,currency)
       VALUES ($1,$2,$3,'FV','na_kontrole','ready_for_review',$4::jsonb,'{}'::jsonb,100,'EUR')`,
      [id, seeded.tenantId, seeded.organizationId, JSON.stringify(extracted)],
    );
    const fv1 = randomUUID();
    await mkFv(fv1);
    // Extrakcia posiela ako „dodávateľa" vlastnú firmu — kľúčom FV je odberateľ,
    // takže FP pamäť mena „ags bratislava" sa NESMIE použiť.
    const input1 = { tenantId: seeded.tenantId, organizationId: seeded.organizationId, documentId: fv1, supplierIco: '35761571', supplierName: 'AGS Bratislava' };
    await rebuildAccountingSuggestion(database, input1);
    expect((await database.query<Record<string, any>>(
      'SELECT source FROM accounting_suggestions WHERE document_id=$1', [fv1],
    )).rows[0].source).toBe('none');

    // Schválená FV sa uloží pod odberateľom a druhá FV toho istého zákazníka ju nájde.
    await recordUctoDecision(database, {
      tenantId: seeded.tenantId, organizationId: seeded.organizationId, documentId: fv1,
      documentType: 'FV', extracted,
      accounting: { predkontaciaId: pred, clenenieDphId: dph, clenenieKvKod: 'D2' },
    });
    const ulozene = (await database.query<Record<string, any>>(
      'SELECT supplier_name_normalized, document_type FROM ucto_decisions WHERE document_id=$1', [fv1],
    )).rows[0];
    expect(ulozene).toMatchObject({ supplier_name_normalized: 'kaczynska sarah', document_type: 'FV' });

    const fv2 = randomUUID();
    await mkFv(fv2);
    await rebuildAccountingSuggestion(database, { ...input1, documentId: fv2 });
    const navrh = (await database.query<Record<string, any>>(
      'SELECT source, predkontacia_id, clenenie_kv_kod FROM accounting_suggestions WHERE document_id=$1', [fv2],
    )).rows[0];
    expect(navrh).toMatchObject({ source: 'decision_memory', predkontacia_id: pred, clenenie_kv_kod: 'D2' });
  }, 90_000);

  it('AI analýza: denník agendy a odberateľ v prompte, KV od modelu, pravidlo prepíše model', async () => {
    const database = await createTestDatabase();
    databases.push(database);
    const seeded = await seedTestUser(database);
    const documentId = randomUUID();
    const pred = randomUUID();
    const predPravidlo = randomUUID();
    const dph = randomUUID();
    await database.query(
      `INSERT INTO documents (id,tenant_id,organization_id,document_type,status,processing_status,extracted,accounting,total_amount,currency)
       VALUES ($1,$2,$3,'FV','na_kontrole','ready_for_review',$4::jsonb,'{}'::jsonb,2299.49,'EUR')`,
      [documentId, seeded.tenantId, seeded.organizationId,
        JSON.stringify({ dodavatel: { nazov: 'AGS Bratislava' }, odberatel: { nazov: 'Kaczynska Sarah' }, polozky: [{ popis: 'Door to door removal service' }] })],
    );
    for (const [id, kind, code] of [
      [pred, 'predkontacie', '602100 sťahov.-tuz.'], [predPravidlo, 'predkontacie', '602200'], [dph, 'cleneniaDph', 'UD'],
    ] as const) {
      await database.query(
        `INSERT INTO code_list_items (id,tenant_id,organization_id,kind,code,name,source)
         VALUES ($1,$2,$3,$4,$5,$5,'pohoda')`,
        [id, seeded.tenantId, seeded.organizationId, kind, code],
      );
    }
    // Denník: 3 riadky FV histórie s rovnakým zaúčtovaním (prax firmy) + FP šum,
    // ktorý sa do FV denníka nesmie dostať.
    for (let index = 0; index < 3; index += 1) {
      await database.query(
        `INSERT INTO ucto_historia
          (id,tenant_id,organization_id,agenda,line_text_normalized,predkontacia_kod,predkontacia_id,clenenie_dph_kod,clenenie_dph_id,clenenie_kv_kod,source,riadok_hash)
         VALUES ($1,$2,$3,'FV','door to door removal service','602100 sťahov.-tuz.',$4,'UD',$5,'D2','mdb',$6)`,
        [randomUUID(), seeded.tenantId, seeded.organizationId, pred, dph, randomUUID()],
      );
    }
    await database.query(
      `INSERT INTO ucto_historia
        (id,tenant_id,organization_id,agenda,line_text_normalized,predkontacia_kod,source,riadok_hash)
       VALUES ($1,$2,$3,'FP','nakup kancelarskych potrieb','501300','mdb',$4)`,
      [randomUUID(), seeded.tenantId, seeded.organizationId, randomUUID()],
    );

    const parser = {
      create: vi.fn().mockResolvedValue(aiOdpoved({ predkontaciaId: pred, clenenieDphId: dph, clenenieKvKod: 'D2', ciselnyRadId: null, confidence: 0.9, reason: 'Podľa denníka' })),
    };
    const context = {
      documentType: 'FV', supplierName: 'AGS Bratislava', supplierIco: '35761571',
      odberatel: { nazov: 'Kaczynska Sarah' },
      totalAmount: 2299.49, currency: 'EUR',
      lineDescriptions: ['Door to door removal service'],
      polozky: [{ popis: 'Door to door removal service', sadzbaDph: 23, suma: 2275.5 }],
    };
    const input = { tenantId: seeded.tenantId, organizationId: seeded.organizationId, documentId, supplierName: 'AGS Bratislava' };
    expect(await maybeAiAccountingSuggestion(database, testConfig(), input, context, parser)).toBe(true);

    const body = parser.create.mock.calls[0][0] as any;
    // Web search je zapnutý — model si smie overiť výklad zákona.
    expect(body.tools).toEqual([{ type: 'web_search' }]);
    const payload = JSON.parse(body.input[0].content[0].text);
    expect(payload.dokument.odberatel).toMatchObject({ nazov: 'Kaczynska Sarah' });
    expect(payload.dokument.polozky[0]).toMatchObject({ sadzbaDph: 23 });
    // Sadzba DPH samostatne: rozhoduje medzi tuzemským a zahraničným členením,
    // ktoré má firma v denníku obidve pre tú istú službu.
    expect(payload.dokument.sadzbyDphNaDoklade).toEqual([23]);
    // Denník nesie len FV riadky, zoskupené s počtom výskytov.
    expect(payload.dennik).toHaveLength(1);
    expect(payload.dennik[0]).toMatchObject({ predkontaciaKod: '602100 sťahov.-tuz.', clenenieKvKod: 'D2', pocet: 3 });

    let suggestion = (await database.query<Record<string, any>>('SELECT * FROM accounting_suggestions WHERE document_id=$1', [documentId])).rows[0];
    // KV od modelu sa uloží; zhoda s denníkom (3×, podobný text) pustí istotu nad 0.8.
    expect(suggestion).toMatchObject({ source: 'ai', predkontacia_id: pred, clenenie_dph_id: dph, clenenie_kv_kod: 'D2' });
    expect(Number(suggestion.confidence)).toBeCloseTo(0.9);
    expect(String(suggestion.reason)).toContain('denníka');

    // Pravidlo účtovníka pre odberateľa je záväzné — prepíše predkontáciu aj KV modelu.
    await database.query(
      `INSERT INTO accounting_rules (id,tenant_id,organization_id,supplier_name_normalized,predkontacia_id,clenenie_kv_kod,origin)
       VALUES ($1,$2,$3,'Kaczynska Sarah',$4,'A1','manual')`,
      [randomUUID(), seeded.tenantId, seeded.organizationId, predPravidlo],
    );
    expect(await maybeAiAccountingSuggestion(database, testConfig(), input, context, parser)).toBe(true);
    suggestion = (await database.query<Record<string, any>>('SELECT * FROM accounting_suggestions WHERE document_id=$1', [documentId])).rows[0];
    expect(suggestion).toMatchObject({ predkontacia_id: predPravidlo, clenenie_dph_id: dph, clenenie_kv_kod: 'A1' });
    expect(String(suggestion.reason)).toContain('Pravidlo');
  }, 90_000);

  it('web search: preambula pred tool callom nezhodí návrh a prázdna odpoveď nezmaže deterministický', async () => {
    const database = await createTestDatabase();
    databases.push(database);
    const seeded = await seedTestUser(database);
    const documentId = randomUUID();
    const pred = randomUUID();
    const stredisko = randomUUID();
    await database.query(
      `INSERT INTO documents (id,tenant_id,organization_id,document_type,status,processing_status,extracted,accounting,total_amount,currency)
       VALUES ($1,$2,$3,'FP','na_kontrole','ready_for_review',$4::jsonb,'{}'::jsonb,100,'EUR')`,
      [documentId, seeded.tenantId, seeded.organizationId,
        JSON.stringify({ dodavatel: { nazov: 'Nový dodávateľ', ico: '11112222' }, polozky: [{ popis: 'Služba' }] })],
    );
    for (const [id, kind, code] of [[pred, 'predkontacie', '518/321'], [stredisko, 'strediska', 'SPRAVA']] as const) {
      await database.query(
        `INSERT INTO code_list_items (id,tenant_id,organization_id,kind,code,name,source)
         VALUES ($1,$2,$3,$4,$5,$5,'pohoda')`,
        [id, seeded.tenantId, seeded.organizationId, kind, code],
      );
    }
    const input = { tenantId: seeded.tenantId, organizationId: seeded.organizationId, documentId, supplierIco: '11112222', supplierName: 'Nový dodávateľ' };
    const context = { documentType: 'FP', supplierName: 'Nový dodávateľ', totalAmount: 100, currency: 'EUR', lineDescriptions: ['Služba'] };

    // Model pred web searchom vypíše preambulu — SDK by na nej pri responses.parse()
    // spadlo (JSON.parse celého textu), návrh musí prejsť z FINÁLNEJ správy.
    const sPreambulou = {
      create: vi.fn().mockResolvedValue(aiOdpoved(
        { clenenieKvKod: null, predkontaciaId: pred, clenenieDphId: null, ciselnyRadId: null, confidence: 0.7, reason: 'Overené na webe' },
        'Najprv si overím, ktorá sekcia KV pre toto plnenie platí.',
      )),
    };
    expect(await maybeAiAccountingSuggestion(database, testConfig(), input, context, sPreambulou)).toBe(true);
    expect((await database.query<Record<string, any>>(
      'SELECT source, predkontacia_id FROM accounting_suggestions WHERE document_id=$1', [documentId],
    )).rows[0]).toMatchObject({ source: 'ai', predkontacia_id: pred });

    // Deterministický návrh so strediskom + model, ktorý nič nespozná (samé null):
    // prenesené stredisko nesmie stačiť na prepis dobrého návrhu.
    await database.query(
      `UPDATE accounting_suggestions SET source='partner_default', confidence=0.9, predkontacia_id=$2, stredisko_id=$3
        WHERE document_id=$1`,
      [documentId, pred, stredisko],
    );
    const prazdny = {
      create: vi.fn().mockResolvedValue(aiOdpoved(
        { clenenieKvKod: null, predkontaciaId: null, clenenieDphId: null, ciselnyRadId: null, confidence: 0.2, reason: 'Neviem' },
      )),
    };
    expect(await maybeAiAccountingSuggestion(database, testConfig(), input, context, prazdny)).toBe(false);
    const zachovany = (await database.query<Record<string, any>>(
      'SELECT source, predkontacia_id, stredisko_id FROM accounting_suggestions WHERE document_id=$1', [documentId],
    )).rows[0];
    expect(zachovany).toMatchObject({ source: 'partner_default', predkontacia_id: pred, stredisko_id: stredisko });

    // Model, ktorý vráti LEN číselný rad, tiež nie je zaúčtovanie — rad dopĺňa
    // nastavenie firmy, takže by sa ním dobrý návrh prepísať nemal.
    const radId = randomUUID();
    await database.query(
      `INSERT INTO code_list_items (id,tenant_id,organization_id,kind,code,name,source,agenda)
       VALUES ($1,$2,$3,'ciselneRady','2026','2026','pohoda','prijate_faktury')`,
      [radId, seeded.tenantId, seeded.organizationId],
    );
    const lenRad = {
      create: vi.fn().mockResolvedValue(aiOdpoved(
        { clenenieKvKod: null, predkontaciaId: null, clenenieDphId: null, ciselnyRadId: radId, confidence: 0.4, reason: 'Neviem účet' },
      )),
    };
    expect(await maybeAiAccountingSuggestion(database, testConfig(), input, context, lenRad)).toBe(false);
    expect((await database.query<Record<string, any>>(
      'SELECT source, predkontacia_id FROM accounting_suggestions WHERE document_id=$1', [documentId],
    )).rows[0]).toMatchObject({ source: 'partner_default', predkontacia_id: pred });

    // Model/účet bez podpory web searchu nesmie zhodiť návrh — zopakuje sa bez
    // nástroja. Iná chyba (timeout, rate limit) sa NEopakuje, aby sa čakanie
    // na doklad nezdvojnásobilo.
    const bezWebu = {
      create: vi.fn()
        .mockRejectedValueOnce(Object.assign(new Error('Tool web_search is not supported with this model'), { status: 400 }))
        .mockResolvedValue(aiOdpoved(
          { clenenieKvKod: null, predkontaciaId: pred, clenenieDphId: null, ciselnyRadId: null, confidence: 0.6, reason: 'Bez webu' },
        )),
    };
    expect(await maybeAiAccountingSuggestion(database, testConfig(), input, context, bezWebu)).toBe(true);
    expect(bezWebu.create).toHaveBeenCalledTimes(2);
    expect((bezWebu.create.mock.calls[0][0] as any).tools).toEqual([{ type: 'web_search' }]);
    expect((bezWebu.create.mock.calls[1][0] as any).tools).toBeUndefined();

    const timeout = { create: vi.fn().mockRejectedValue(Object.assign(new Error('Request timed out'), { status: 408 })) };
    await expect(maybeAiAccountingSuggestion(database, testConfig(), input, context, timeout)).rejects.toThrow('timed out');
    expect(timeout.create).toHaveBeenCalledTimes(1);
  }, 90_000);

  it('predvoľba partnera len so strediskom nezablokuje účet z ďalších zdrojov', async () => {
    const database = await createTestDatabase();
    databases.push(database);
    const seeded = await seedTestUser(database);
    const documentId = randomUUID();
    const pred = randomUUID();
    const dph = randomUUID();
    const stredisko = randomUUID();
    for (const [id, kind, code] of [
      [pred, 'predkontacie', '518/321'], [dph, 'cleneniaDph', 'PD'], [stredisko, 'strediska', 'SPRAVA'],
    ] as const) {
      await database.query(
        `INSERT INTO code_list_items (id,tenant_id,organization_id,kind,code,name,source)
         VALUES ($1,$2,$3,$4,$5,$5,'pohoda')`,
        [id, seeded.tenantId, seeded.organizationId, kind, code],
      );
    }
    await database.query(
      `INSERT INTO documents (id,tenant_id,organization_id,document_type,status,processing_status,extracted,accounting,total_amount,currency)
       VALUES ($1,$2,$3,'FP','na_kontrole','ready_for_review',$4::jsonb,'{}'::jsonb,100,'EUR')`,
      [documentId, seeded.tenantId, seeded.organizationId,
        JSON.stringify({ dodavatel: { nazov: 'Partner s.r.o.', ico: '11112222' }, polozky: [{ popis: 'Služba' }] })],
    );
    // Partner má vyplnené LEN stredisko — účet a DPH musia prísť z predvolieb firmy.
    await database.query(
      `INSERT INTO partners (id,tenant_id,organization_id,name,name_normalized,ico,default_stredisko_id)
       VALUES ($1,$2,$3,'Partner s.r.o.','partner s.r.o.','11112222',$4)`,
      [randomUUID(), seeded.tenantId, seeded.organizationId, stredisko],
    );
    await database.query(
      `INSERT INTO organization_accounting_defaults (organization_id,tenant_id,predkontacia_id,clenenie_dph_id)
       VALUES ($1,$2,$3,$4)`,
      [seeded.organizationId, seeded.tenantId, pred, dph],
    );

    await rebuildAccountingSuggestion(database, {
      tenantId: seeded.tenantId, organizationId: seeded.organizationId, documentId,
      supplierIco: '11112222', supplierName: 'Partner s.r.o.',
    });
    const navrh = (await database.query<Record<string, any>>(
      'SELECT source, predkontacia_id, clenenie_dph_id, stredisko_id FROM accounting_suggestions WHERE document_id=$1', [documentId],
    )).rows[0];
    // Účet z predvolieb organizácie a zároveň stredisko od partnera.
    expect(navrh).toMatchObject({
      source: 'organization_default', predkontacia_id: pred, clenenie_dph_id: dph, stredisko_id: stredisko,
    });
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
      create: vi.fn().mockResolvedValue(aiOdpoved({ clenenieKvKod: null, predkontaciaId: pred, clenenieDphId: odpocet, ciselnyRadId: null, confidence: 0.8, reason: 'Odpočet' })),
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

describe('zuzPonukuPredkontacii', () => {
  const rozvrh = (pocet: number, specialny: { index: number; nazov: string }) =>
    Array.from({ length: pocet }, (_, i) => ({
      id: `p${i}`,
      kod: String(100000 + i),
      nazov: i === specialny.index ? specialny.nazov : 'Ostatné služby',
    }));

  it('nájde predkontáciu hlboko za hranicou bývalého LIMIT 300', () => {
    const vybrane = zuzPonukuPredkontacii(rozvrh(800, { index: 700, nazov: 'PHM nafta' }), 'nafta diesel tankovanie', []);
    expect(vybrane.map((item) => item.id)).toContain('p700');
    expect(vybrane.length).toBeLessThanOrEqual(25);
  });

  it('predkontácie z príkladov účtovníka sú v ponuke aj bez textovej zhody', () => {
    const priklad = { text: 'nesuvisiaci text', predkontaciaId: 'p512', podobnost: 0.4 };
    const vybrane = zuzPonukuPredkontacii(rozvrh(800, { index: 700, nazov: 'PHM nafta' }), 'nafta', [priklad]);
    expect(vybrane.map((item) => item.id)).toContain('p512');
  });

  it('krátky rozvrh sa nezužuje', () => {
    const vsetky = rozvrh(10, { index: 3, nazov: 'PHM nafta' });
    expect(zuzPonukuPredkontacii(vsetky, 'nafta', [])).toEqual(vsetky);
  });
});

describe('predvolený číselný rad', () => {
  // Pamäť dodávateľa ani história číselný rad často nenesú (import histórie bez
  // stĺpca) — bez samostatného doplnenia ostávalo pole v editore prázdne.
  async function pripravFirmu() {
    const database = await createTestDatabase();
    databases.push(database);
    const seeded = await seedTestUser(database);
    const documentId = randomUUID();
    const pouzivany = randomUUID();
    const nepouzivany = randomUUID();
    const pokladnicny = randomUUID();
    await database.transaction(async (tx) => {
      // Dva rady prijatých faktúr: jeden POHODA reálne používa (číslo 2026248),
      // druhý stojí na 00001. Tretí patrí pokladni — nesmie sa ponúknuť pre FP.
      for (const [id, code, agenda, lastNumber] of [
        [pouzivany, '2026', 'prijate_faktury', '2026248'],
        [nepouzivany, '26XX', 'prijate_faktury', '00001'],
        [pokladnicny, '26PK', 'pokladna', '26PK017'],
      ] as const) {
        await tx.query(
          `INSERT INTO code_list_items (id,tenant_id,organization_id,kind,code,name,source,agenda,last_number)
           VALUES ($1,$2,$3,'ciselneRady',$4,$4,'pohoda',$5,$6)`,
          [id, seeded.tenantId, seeded.organizationId, code, agenda, lastNumber],
        );
      }
      await tx.query(
        `INSERT INTO documents
          (id,tenant_id,organization_id,document_type,status,processing_status,extracted,accounting,total_amount,currency)
         VALUES ($1,$2,$3,'FP','na_kontrole','ready_for_review',$4::jsonb,'{}'::jsonb,0,'EUR')`,
        [documentId, seeded.tenantId, seeded.organizationId,
          JSON.stringify({ dodavatel: { nazov: 'Nový dodávateľ', ico: '11112222' }, cisloFaktury: 'X1', datumVystavenia: '2026-07-01', mena: 'EUR', rozpisDph: [], sumaSpolu: 0 })],
      );
    });
    return { database, seeded, documentId, pouzivany, nepouzivany, pokladnicny };
  }

  const navrh = async (database: any, seeded: any, documentId: string) => {
    await rebuildAccountingSuggestion(database, {
      tenantId: seeded.tenantId, organizationId: seeded.organizationId, documentId,
      supplierIco: '11112222', supplierName: 'Nový dodávateľ',
    });
    const row = await database.query<{ ciselny_rad_id: string | null } & Record<string, unknown>>(
      'SELECT ciselny_rad_id FROM accounting_suggestions WHERE document_id=$1', [documentId],
    );
    return row.rows[0]?.ciselny_rad_id ?? null;
  };

  // Tri scenáre v jednom teste zámerne: každý vlastný beh znamená ďalšiu
  // databázu a tento súbor je najpomalší v sade.
  it('automat vyberie reálne používaný rad, nastavenie účtovníka ho prebije', async () => {
    const { database, seeded, documentId, pouzivany, nepouzivany, pokladnicny } = await pripravFirmu();

    // 1) Automat: vyhrá rad s najvyšším číslom z POHODY, nie nepoužitý.
    expect(await navrh(database, seeded, documentId)).toBe(pouzivany);

    // 2) Nastavenie účtovníka má prednosť pred automatikou.
    await database.query(
      `INSERT INTO organization_series_defaults (organization_id,tenant_id,document_type,ciselny_rad_id)
       VALUES ($1,$2,'FP',$3)`,
      [seeded.organizationId, seeded.tenantId, nepouzivany],
    );
    expect(await navrh(database, seeded, documentId)).toBe(nepouzivany);

    // 3) Rad inej agendy sa neponúkne ani keď rady prijatých faktúr vypadnú.
    await database.query('DELETE FROM organization_series_defaults');
    await database.query(`UPDATE code_list_items SET active=false WHERE agenda='prijate_faktury'`);
    expect(await navrh(database, seeded, documentId)).not.toBe(pokladnicny);
  }, 90_000);
});

describe('AI nevyberá číselný rad', () => {
  // Reálny prípad: pokladničnému dokladu model vybral rad prijatých faktúr
  // (dostával celý zoznam radov) a prepísal tým nastavenie firmy.
  it('rad pokladničného dokladu určí nastavenie firmy, nie model', async () => {
    const database = await createTestDatabase();
    databases.push(database);
    const seeded = await seedTestUser(database);
    const documentId = randomUUID();
    const pred = randomUUID();
    const radPokladna = randomUUID();
    const radFaktury = randomUUID();

    await database.transaction(async (tx) => {
      await tx.query(
        `INSERT INTO documents (id,tenant_id,organization_id,document_type,status,processing_status,extracted,accounting,total_amount,currency)
         VALUES ($1,$2,$3,'PD','na_kontrole','ready_for_review','{}'::jsonb,'{}'::jsonb,216.1,'EUR')`,
        [documentId, seeded.tenantId, seeded.organizationId],
      );
      await tx.query(
        `INSERT INTO code_list_items (id,tenant_id,organization_id,kind,code,name,source)
         VALUES ($1,$2,$3,'predkontacie','501/211','Nákup','pohoda')`,
        [pred, seeded.tenantId, seeded.organizationId],
      );
      for (const [id, code, agenda] of [
        [radPokladna, '26HP', 'pokladna'],
        [radFaktury, '2026', 'prijate_faktury'],
      ] as const) {
        await tx.query(
          `INSERT INTO code_list_items (id,tenant_id,organization_id,kind,code,name,source,agenda)
           VALUES ($1,$2,$3,'ciselneRady',$4,$4,'pohoda',$5)`,
          [id, seeded.tenantId, seeded.organizationId, code, agenda],
        );
      }
    });

    const input = { tenantId: seeded.tenantId, organizationId: seeded.organizationId, documentId, supplierName: 'HUKE s. r. o.' };
    // Model si vypýta rad prijatých faktúr — pre pokladničný doklad nesprávne.
    const parser = {
      create: vi.fn().mockResolvedValue(aiOdpoved({ clenenieKvKod: null, predkontaciaId: pred, clenenieDphId: null, ciselnyRadId: radFaktury, confidence: 0.7, reason: 'Nákup' })),
    };
    const context = { documentType: 'PD', supplierName: 'HUKE s. r. o.', totalAmount: 216.1, currency: 'EUR', lineDescriptions: ['Espresso'] };
    expect(await maybeAiAccountingSuggestion(database, testConfig(), input, context, parser)).toBe(true);
    const suggestion = (await database.query<Record<string, any>>('SELECT * FROM accounting_suggestions WHERE document_id=$1', [documentId])).rows[0];
    expect(suggestion.ciselny_rad_id).toBe(radPokladna);
  }, 90_000);
});

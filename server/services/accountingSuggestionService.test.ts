import { createHash, randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { aiOdpoved, createTestDatabase, seedTestUser, testConfig } from '../testHelpers.js';
import { forgetUctoDecision, maybeAiAccountingSuggestion, mesiacZNazvu, otazkaPraxe, rebuildAccountingSuggestion, recordUctoDecision, textSimilarity, updateRuleFeedback, zuzPonukuPredkontacii } from './accountingSuggestionService.js';
import { prepocitajPravidla } from './uctoPravidlaService.js';

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
    // Doklad, ktorý nikto nedelil, je tiež dvojica: „táto položka išla na tento
    // účet" je informácia, nie jej absencia. Kým sa písali len riadky s vlastným
    // zaúčtovaním, malo použiteľnú dvojicu 14 zo 107 schválených dokladov.
    const nerozdeleny = typeof rows.rows[0].polozky_ucto === 'string'
      ? JSON.parse(rows.rows[0].polozky_ucto) : rows.rows[0].polozky_ucto;
    expect(nerozdeleny.spolu).toBe(60);
    expect(nerozdeleny.polozky).toHaveLength(1);
    // Riadok bez vlastného zaúčtovania dedí hlavičku — tak ho vyexportuje POHODA.
    expect(nerozdeleny.polozky[0]).toMatchObject({
      index: 0, popis: 'nafta phm 50l', predkontaciaId: pred, clenenieDphId: dph,
      clenenieKvKod: 'B3', vlastne: false,
    });

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
    // Obe položky, nielen tá s vlastným zaúčtovaním; popis je normalizovaný.
    // Príznak vlastne odlišuje rozhodnutie účtovníka od zdedenej hlavičky.
    expect(zapisy.polozky).toHaveLength(2);
    expect(zapisy.polozky[0]).toMatchObject({
      popis: 'nafta phm 50l', sadzbaDph: 23, predkontaciaId: pred, clenenieDphId: dph, vlastne: true,
    });
    expect(zapisy.polozky[1]).toMatchObject({
      popis: 'žuvačky', sadzbaDph: 23, predkontaciaId: pred, clenenieDphId: dph, vlastne: false,
    });
    // Obnova pôvodného zápisu — zvyšok testu počíta s pôvodným textom položiek.
    await recordUctoDecision(database, decision);

    const input = { tenantId: seeded.tenantId, organizationId: seeded.organizationId, documentId: currentId, supplierIco: '31322832', supplierName: 'Slovnaft' };
    const suggestionRow = async () => (await database.query<Record<string, any>>(
      'SELECT source, confidence, predkontacia_id, clenenie_kv_kod FROM accounting_suggestions WHERE document_id=$1', [currentId],
    )).rows[0];

    // Presná zhoda dodávateľa + textu položiek vyhráva nad históriou. Jedno
    // potvrdenie však doklad nepredvyplní — na to treba päť rovnakých.
    await rebuildAccountingSuggestion(database, input);
    let suggestion = await suggestionRow();
    expect(suggestion).toMatchObject({ source: 'decision_memory', predkontacia_id: pred, clenenie_kv_kod: 'B3' });
    expect(Number(suggestion.confidence)).toBeLessThan(0.9);

    const kopie = [randomUUID(), randomUUID(), randomUUID(), randomUUID()];
    for (const kopia of kopie) {
      await database.query(
        `INSERT INTO ucto_decisions
          (id,tenant_id,organization_id,supplier_ico,supplier_name_normalized,line_text_normalized,
           predkontacia_id,clenenie_dph_id,ciselny_rad_id,stredisko_id,clenenie_kv_kod,source,document_type,podtyp)
         SELECT $1,tenant_id,organization_id,supplier_ico,supplier_name_normalized,line_text_normalized,
                predkontacia_id,clenenie_dph_id,ciselny_rad_id,stredisko_id,clenenie_kv_kod,source,document_type,podtyp
           FROM ucto_decisions WHERE document_id=$2`,
        [kopia, historyId],
      );
    }
    await rebuildAccountingSuggestion(database, input);
    suggestion = await suggestionRow();
    expect(Number(suggestion.confidence)).toBeCloseTo(0.95);
    await database.query('DELETE FROM ucto_decisions WHERE id = ANY($1)', [kopie]);

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

  // Pravidlo z otázky R09 vybral účtovník. Tri opravy ho vypli rovnako ako AI
  // pravidlo — rozhodnutie človeka ticho zmizlo a návrhy sa vrátili k hádaniu.
  it('spätná väzba pravidla: pravidlo od človeka po 3 opravách ostane aktívne na kontrolu, AI pravidlo sa vypne', async () => {
    const database = await createTestDatabase();
    databases.push(database);
    const seeded = await seedTestUser(database);
    const documentId = randomUUID();
    const pred = randomUUID();
    await database.query(
      `INSERT INTO documents (id,tenant_id,organization_id,document_type,status,processing_status,extracted,accounting,total_amount,currency)
       VALUES ($1,$2,$3,'FP','na_kontrole','ready_for_review','{}'::jsonb,'{}'::jsonb,50,'EUR')`,
      [documentId, seeded.tenantId, seeded.organizationId],
    );
    await database.query(
      `INSERT INTO accounting_suggestions (document_id,tenant_id,organization_id,predkontacia_id,source,confidence,reason)
       VALUES ($1,$2,$3,$4,'manual_rule',1,'test')`,
      [documentId, seeded.tenantId, seeded.organizationId, pred],
    );
    const pravidlo = async (origin: string, dovodSource: string | null) => {
      const ruleId = randomUUID();
      await database.query(
        `INSERT INTO accounting_rules (id,tenant_id,organization_id,supplier_ico,predkontacia_id,origin,dovod,dovod_source)
         VALUES ($1,$2,$3,'31386946',$4,$5,'dôvod',$6)`,
        [ruleId, seeded.tenantId, seeded.organizationId, pred, origin, dovodSource],
      );
      await database.query('UPDATE accounting_suggestions SET rule_id=$2 WHERE document_id=$1', [documentId, ruleId]);
      for (let index = 0; index < 3; index += 1) {
        await updateRuleFeedback(database, {
          tenantId: seeded.tenantId, documentId, accounting: { predkontaciaId: randomUUID() },
        });
      }
      const row = (await database.query<Record<string, any>>(
        'SELECT active, needs_review, corrections_count FROM accounting_rules WHERE id=$1', [ruleId],
      )).rows[0];
      return { ...row, corrections_count: Number(row.corrections_count) };
    };

    expect(await pravidlo('manual', 'human')).toEqual({ active: true, needs_review: true, corrections_count: 3 });
    // AI pravidlo, ktorého dôvod potvrdil človek, je tiež rozhodnutie človeka.
    expect(await pravidlo('ai', 'human')).toEqual({ active: true, needs_review: true, corrections_count: 3 });
    expect(await pravidlo('ai', 'ai_draft')).toEqual({ active: false, needs_review: true, corrections_count: 3 });
    expect(await pravidlo('ai', null)).toEqual({ active: false, needs_review: true, corrections_count: 3 });
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
    // Denník: 5 riadkov FV histórie s rovnakým zaúčtovaním (prax firmy — päť je
    // hranica predvyplnenia) + FP šum, ktorý sa do FV denníka nesmie dostať.
    for (let index = 0; index < 5; index += 1) {
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
      documentType: 'FV', supplierName: 'AGS Bratislava', supplierIco: '35761571', supplierKrajina: 'SK',
      odberatel: { nazov: 'Kaczynska Sarah', krajina: 'PL' },
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
    expect(payload.dokument.odberatel).toMatchObject({ nazov: 'Kaczynska Sarah', krajina: 'PL' });
    // Krajina dodávateľa: nenulová sadzba na zahraničnom doklade je cudzia daň,
    // nie tuzemské plnenie — bez tohto poľa to model z promptu nevyčíta.
    expect(payload.dokument.dodavatelKrajina).toBe('SK');
    expect(payload.dokument.polozky[0]).toMatchObject({ sadzbaDph: 23 });
    // Sadzba DPH samostatne: rozhoduje medzi tuzemským a zahraničným členením,
    // ktoré má firma v denníku obidve pre tú istú službu.
    expect(payload.dokument.sadzbyDphNaDoklade).toEqual([23]);
    // Zhrnutie dokladu: jediny text, ktory ma doklad bez poloziek.
    expect(payload.dokument.zhrnutie).toBe('Door to door removal service');
    // Denník nesie len FV riadky, zoskupené s počtom výskytov.
    expect(payload.dennik).toHaveLength(1);
    expect(payload.dennik[0]).toMatchObject({ predkontaciaKod: '602100 sťahov.-tuz.', clenenieKvKod: 'D2', pocet: 5 });

    let suggestion = (await database.query<Record<string, any>>('SELECT * FROM accounting_suggestions WHERE document_id=$1', [documentId])).rows[0];
    // KV od modelu sa uloží; zhoda s denníkom (5×, podobný text) pustí istotu nad 0.8.
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

  // Sekcia KV, ktorú nikto nedodal. Stĺpec kv_section z POHODY je v SK verzii
  // vždy prázdny — classificationVAT.xsd nesie sectionInVATLedgerStatement s
  // poznámkou „pouze CZ verze", Kontrolní hlášení je český výkaz. Sekcia sa
  // preto berie z praxe firmy, a nutne pre TÚ ISTÚ agendu: to isté členenie má
  // na prijatej faktúre B2 a na bločku B3.
  it('sekciu KV podľa praxe firmy, keď ju nedodal nikto iný', async () => {
    const database = await createTestDatabase();
    databases.push(database);
    const seeded = await seedTestUser(database);
    const kde = [seeded.tenantId, seeded.organizationId];
    const documentId = randomUUID();
    const pred = randomUUID();
    const dph = randomUUID();
    await database.query(
      `INSERT INTO documents (id,tenant_id,organization_id,document_type,status,processing_status,extracted,accounting,total_amount,currency)
       VALUES ($1,$2,$3,'FP','na_kontrole','ready_for_review','{}'::jsonb,'{}'::jsonb,120,'EUR')`,
      [documentId, ...kde],
    );
    for (const [id, kind, kod] of [[pred, 'predkontacie', '501200'], [dph, 'cleneniaDph', 'PD']] as const) {
      await database.query(
        `INSERT INTO code_list_items (id,tenant_id,organization_id,kind,code,name,source)
         VALUES ($1,$2,$3,$4,$5,$5,'pohoda')`,
        [id, ...kde, kind, kod],
      );
    }
    // Štyri riadky FP s tým istým členením a sekciou B2 — to je prax.
    for (let i = 0; i < 4; i += 1) {
      await database.query(
        `INSERT INTO ucto_historia
          (id,tenant_id,organization_id,agenda,line_text_normalized,predkontacia_kod,predkontacia_id,
           clenenie_dph_kod,clenenie_dph_id,clenenie_kv_kod,source,riadok_hash)
         VALUES ($1,$2,$3,'FP','kancelarske potreby','501200',$4,'PD',$5,'B2','mdb',$6)`,
        [randomUUID(), ...kde, pred, dph, randomUUID()],
      );
    }
    const parser = {
      // Model sekciu NEVRÁTI — inak by sa prax firmy vôbec nepýtala.
      create: vi.fn().mockResolvedValue(aiOdpoved({
        predkontaciaId: pred, clenenieDphId: dph, clenenieKvKod: null,
        ciselnyRadId: null, confidence: 0.6, reason: 'Kancelárske potreby',
      })),
    };
    const input = { tenantId: seeded.tenantId, organizationId: seeded.organizationId, documentId, supplierName: 'Papier s.r.o.' };
    const context = {
      documentType: 'FP', supplierName: 'Papier s.r.o.', supplierKrajina: 'SK',
      totalAmount: 120, currency: 'EUR',
      lineDescriptions: ['Kancelárske potreby'],
      polozky: [{ popis: 'Kancelárske potreby', sadzbaDph: 23, suma: 120 }],
    };
    expect(await maybeAiAccountingSuggestion(database, testConfig(), input, context, parser)).toBe(true);
    const navrh = (await database.query<Record<string, any>>(
      'SELECT clenenie_kv_kod FROM accounting_suggestions WHERE document_id=$1', [documentId],
    )).rows[0];
    expect(navrh.clenenie_kv_kod).toBe('B2');
  }, 90_000);

  // Bloček sa často prečíta bez položiek, ale s rozpisom DPH. Sadzby sa zbierali
  // VÝLUČNE z položiek, takže model dostal prázdny zoznam — a prompt mu prázdny
  // zoznam vysvetľuje ako „na doklade nie je daň". DECATHLON tak dostal PN/KN
  // napriek rozpisu 23 % / 8,05 / 1,85. Bez položiek zmizlo aj zhrnutie: krok
  // účtovania nedostal ani slovo o tom, čo sa kúpilo.
  it('doklad bez položiek nesie sadzby z rozpisu DPH aj zhrnutie', async () => {
    const database = await createTestDatabase();
    databases.push(database);
    const seeded = await seedTestUser(database);
    const documentId = randomUUID();
    const pred = randomUUID();
    await database.query(
      `INSERT INTO documents (id,tenant_id,organization_id,document_type,status,processing_status,extracted,accounting,total_amount,currency)
       VALUES ($1,$2,$3,'PD','na_kontrole','ready_for_review',$4::jsonb,'{}'::jsonb,9.90,'EUR')`,
      [documentId, seeded.tenantId, seeded.organizationId,
        JSON.stringify({ dodavatel: { nazov: 'DECATHLON' }, polozky: [] })],
    );
    await database.query(
      `INSERT INTO code_list_items (id,tenant_id,organization_id,kind,code,name,source)
       VALUES ($1,$2,$3,'predkontacie','501600 Auto','501600 Auto','pohoda')`,
      [pred, seeded.tenantId, seeded.organizationId],
    );
    const parser = {
      create: vi.fn().mockResolvedValue(aiOdpoved({
        predkontaciaId: pred, clenenieDphId: null, clenenieKvKod: null,
        ciselnyRadId: null, confidence: 0.5, reason: 'Bloček',
      })),
    };
    const context = {
      documentType: 'PD', supplierName: 'DECATHLON', supplierKrajina: 'SK',
      totalAmount: 9.9, currency: 'EUR',
      lineDescriptions: ['Nákup športového tovaru'],
      polozky: [],
      sadzbyRozpisu: [23],
    };
    const input = { tenantId: seeded.tenantId, organizationId: seeded.organizationId, documentId, supplierName: 'DECATHLON' };
    expect(await maybeAiAccountingSuggestion(database, testConfig(), input, context, parser)).toBe(true);

    const payload = JSON.parse((parser.create.mock.calls[0][0] as any).input[0].content[0].text);
    expect(payload.dokument.polozky).toEqual([]);
    // Sadzba z rozpisu sa k modelu dostane aj bez jedinej položky.
    expect(payload.dokument.sadzbyDphNaDoklade).toEqual([23]);
    // A doklad si nesie aspoň to, čo sa na ňom kúpilo.
    expect(payload.dokument.zhrnutie).toBe('Nákup športového tovaru');
  }, 90_000);

  // ALPINA DF260200 (platené meranie): položka prišla so sumou S DPH (549,99),
  // kým predchodca toho istého dodávateľa v „doklady" niesol základ (420).
  // Model porovnal nesúmerné čísla a notebook zaradil nad hranicu 500 €.
  it('položka nesie základ ako v dôkazoch aj sumu s DPH, pomenované zvlášť', async () => {
    const database = await createTestDatabase();
    databases.push(database);
    const seeded = await seedTestUser(database);
    const documentId = randomUUID();
    const pred = randomUUID();
    await database.query(
      `INSERT INTO documents (id,tenant_id,organization_id,document_type,status,processing_status,extracted,accounting,total_amount,currency)
       VALUES ($1,$2,$3,'FP','na_kontrole','ready_for_review','{}'::jsonb,'{}'::jsonb,549.99,'EUR')`,
      [documentId, seeded.tenantId, seeded.organizationId],
    );
    await database.query(
      `INSERT INTO code_list_items (id,tenant_id,organization_id,kind,code,name,source)
       VALUES ($1,$2,$3,'predkontacie','32110Drobný HM','Drobný HM do 500€','pohoda')`,
      [pred, seeded.tenantId, seeded.organizationId],
    );
    const parser = {
      create: vi.fn().mockResolvedValue(aiOdpoved({
        predkontaciaId: pred, clenenieDphId: null, clenenieKvKod: null, ciselnyRadId: null, confidence: 0.5, reason: 'Notebook',
      })),
    };
    const context = {
      documentType: 'FP', supplierName: 'wabez', totalAmount: 549.99, currency: 'EUR',
      lineDescriptions: ['Notebook', 'Kábel'],
      polozky: [
        { popis: 'Notebook', sadzbaDph: 23, suma: 549.99 }, { popis: 'Kábel', suma: 3 },
        // Riadok vytlačený bez DPH so sadzbou: základ z extrakcie, nie delenie sadzbou.
        { popis: 'Monitor', sadzbaDph: 23, suma: 480, zaklad: 480 },
      ],
    };
    const input = { tenantId: seeded.tenantId, organizationId: seeded.organizationId, documentId, supplierName: 'wabez' };
    expect(await maybeAiAccountingSuggestion(database, testConfig(), input, context, parser)).toBe(true);

    const payload = JSON.parse((parser.create.mock.calls[0][0] as any).input[0].content[0].text);
    expect(payload.dokument.polozky).toEqual([
      { index: 0, popis: 'Notebook', sadzbaDph: 23, suma: 447.15, sumaSDph: 549.99 },
      // Bez sadzby sa základ nedá odvodiť — ide len suma s DPH.
      { index: 1, popis: 'Kábel', sumaSDph: 3 },
      { index: 2, popis: 'Monitor', sadzbaDph: 23, suma: 480, sumaSDph: 480 },
    ]);
  }, 90_000);

  it('zahraničná faktúra: odpočet cudzej dane sa neuloží a sekcia A1 na FP vypadne', async () => {
    const database = await createTestDatabase();
    databases.push(database);
    const seeded = await seedTestUser(database);
    const documentId = randomUUID();
    const pred = randomUUID();
    const dphTuzemske = randomUUID();
    const dphBezOdpoctu = randomUUID();
    // Rakúska diaľničná známka: dodávateľ z AT účtuje vlastných 20 %.
    await database.query(
      `INSERT INTO documents (id,tenant_id,organization_id,document_type,status,processing_status,extracted,accounting,total_amount,currency)
       VALUES ($1,$2,$3,'FP','na_kontrole','ready_for_review',$4::jsonb,'{}'::jsonb,106.8,'EUR')`,
      [documentId, seeded.tenantId, seeded.organizationId, JSON.stringify({
        dodavatel: { nazov: 'Autobahnen- und Schnellstraßen-Finanzierungs-AG', icDph: 'ATU43143200', krajina: 'AT' },
        rozpisDph: [{ sadzba: 20, zaklad: 89, dph: 17.8 }],
        sumaSpolu: 106.8,
        polozky: [{ popis: 'Annual vignette Car 2026' }],
      })],
    );
    for (const [id, kind, code, name] of [
      [pred, 'predkontacie', '518900', 'ost.sl.s DPH'],
      [dphTuzemske, 'cleneniaDph', 'PD', 'Tuzemské plnenia'],
      [dphBezOdpoctu, 'cleneniaDph', 'UN', 'Nezahrnované do priznania'],
    ] as const) {
      await database.query(
        `INSERT INTO code_list_items (id,tenant_id,organization_id,kind,code,name,source)
         VALUES ($1,$2,$3,$4,$5,$6,'pohoda')`,
        [id, seeded.tenantId, seeded.organizationId, kind, code, name],
      );
    }
    const context = {
      documentType: 'FP',
      supplierName: 'Autobahnen- und Schnellstraßen-Finanzierungs-AG',
      supplierIcDph: 'ATU43143200',
      supplierKrajina: 'AT',
      totalAmount: 106.8,
      currency: 'EUR',
      lineDescriptions: ['Annual vignette Car 2026'],
      polozky: [{ popis: 'Annual vignette Car 2026', sadzbaDph: 20, suma: 106.8 }],
    };
    const input = {
      tenantId: seeded.tenantId,
      organizationId: seeded.organizationId,
      documentId,
      supplierName: 'Autobahnen- und Schnellstraßen-Finanzierungs-AG',
    };

    // Model navrhne tuzemské plnenie s odpočtom — DPH poradca to zablokuje,
    // takže sa taký návrh vôbec neuloží (a účtovníkovi sa nepredvyplní).
    const tuzemsky = {
      create: vi.fn().mockResolvedValue(aiOdpoved({
        predkontaciaId: pred, clenenieDphId: dphTuzemske, clenenieKvKod: 'A1',
        ciselnyRadId: null, confidence: 0.72, reason: 'Podľa denníka',
      })),
    };
    expect(await maybeAiAccountingSuggestion(database, testConfig(), input, context, tuzemsky)).toBe(false);
    expect((await database.query('SELECT 1 FROM accounting_suggestions WHERE document_id=$1', [documentId])).rows).toHaveLength(0);

    // Členenie bez odpočtu prejde, ale sekcia A1 hlási DODÁVATEĽ — na prijatej
    // faktúre neexistuje, takže sa zahodí. Firma prax pri tomto členení nemá,
    // a plnenie bez odpočtu do kontrolného výkazu nejde: KN. Cudzia daň doň
    // nepatrí tak či tak.
    const bezOdpoctu = {
      create: vi.fn().mockResolvedValue(aiOdpoved({
        predkontaciaId: pred, clenenieDphId: dphBezOdpoctu, clenenieKvKod: 'A1',
        ciselnyRadId: null, confidence: 0.72, reason: 'Cudzia daň sa neodpočítava',
      })),
    };
    expect(await maybeAiAccountingSuggestion(database, testConfig(), input, context, bezOdpoctu)).toBe(true);
    const suggestion = (await database.query<Record<string, any>>(
      'SELECT * FROM accounting_suggestions WHERE document_id=$1', [documentId])).rows[0];
    expect(suggestion).toMatchObject({ source: 'ai', predkontacia_id: pred, clenenie_dph_id: dphBezOdpoctu });
    expect(suggestion.clenenie_kv_kod).toBe('KN');
  }, 90_000);

  it('denník: riadky tej istej protistrany idú do promptu prvé, aj keď text sedí menej', async () => {
    const database = await createTestDatabase();
    databases.push(database);
    const seeded = await seedTestUser(database);
    const documentId = randomUUID();
    const pred = randomUUID();
    const dph = randomUUID();
    await database.query(
      `INSERT INTO documents (id,tenant_id,organization_id,document_type,status,processing_status,extracted,accounting,total_amount,currency)
       VALUES ($1,$2,$3,'FV','na_kontrole','ready_for_review',$4::jsonb,'{}'::jsonb,79.67,'EUR')`,
      [documentId, seeded.tenantId, seeded.organizationId,
        JSON.stringify({ dodavatel: { nazov: 'AGS Bratislava' }, odberatel: { nazov: 'Milena Pribis' }, polozky: [{ popis: 'Skladovanie v Bratislave' }] })],
    );
    await database.query(
      `INSERT INTO code_list_items (id,tenant_id,organization_id,kind,code,name,source)
       VALUES ($1,$2,$3,'predkontacie','602200','602200 sklad.-tuz.','pohoda'),
              ($4,$2,$3,'cleneniaDph','UD','UD','pohoda')`,
      [pred, seeded.tenantId, seeded.organizationId, dph],
    );
    // Firma účtuje skladovanie firmám do KV A1 (viac riadkov aj bližší text),
    // súkromnej osobe Milene Pribis do D2. Rozhoduje protistrana, nie text.
    const historia = [
      ...Array.from({ length: 6 }, (_, index) => ['cisco systems slovakia', `skladovanie sk 0${index + 1}.2026`, 'A1'] as const),
      ...(['skladné january', 'skladné february', 'skladné march'] as const).map((text) => ['milena pribis', text, 'D2'] as const),
    ];
    for (const [protistrana, text, kv] of historia) {
      await database.query(
        `INSERT INTO ucto_historia
          (id,tenant_id,organization_id,agenda,supplier_name_normalized,line_text_normalized,predkontacia_kod,predkontacia_id,clenenie_dph_kod,clenenie_dph_id,clenenie_kv_kod,source,riadok_hash)
         VALUES ($1,$2,$3,'FV',$4,$5,'602200 sklad.-tuz.',$6,'UD',$7,$8,'mdb',$9)`,
        [randomUUID(), seeded.tenantId, seeded.organizationId, protistrana, text, pred, dph, kv, randomUUID()],
      );
    }

    const parser = {
      create: vi.fn().mockResolvedValue(aiOdpoved({ predkontaciaId: pred, clenenieDphId: dph, clenenieKvKod: 'D2', ciselnyRadId: null, confidence: 0.9, reason: 'Denník protistrany' })),
    };
    const context = {
      documentType: 'FV', supplierName: 'AGS Bratislava', supplierIco: '35761571',
      odberatel: { nazov: 'Milena Pribis' },
      totalAmount: 79.67, currency: 'EUR',
      lineDescriptions: ['Skladovanie v Bratislave'],
      polozky: [{ popis: 'Skladovanie v Bratislave', sadzbaDph: 23, suma: 64.77 }],
    };
    const input = { tenantId: seeded.tenantId, organizationId: seeded.organizationId, documentId, supplierName: 'AGS Bratislava' };
    expect(await maybeAiAccountingSuggestion(database, testConfig(), input, context, parser)).toBe(true);

    const payload = JSON.parse((parser.create.mock.calls[0][0] as any).input[0].content[0].text);
    expect(payload.dennik[0]).toMatchObject({ clenenieKvKod: 'D2', tejProtistrany: true });
    expect(payload.dennik.filter((riadok: any) => riadok.tejProtistrany)).toHaveLength(3);
    // Riadky iných odberateľov ostávajú v denníku ako porovnanie, len nižšie.
    expect(payload.dennik.some((riadok: any) => riadok.clenenieKvKod === 'A1' && !riadok.tejProtistrany)).toBe(true);
  }, 90_000);

  // Ostrý prípad Guretruck: firma má 16 zo 16 dokladov na TACHpopl., pravidlo
  // to vie — a doklad ho aj tak nedostal. Korpus je pomenovaný adresárom POHODY
  // („guretruck"), faktúra tlačí obchodné meno s právnou formou
  // („Guretruck, S. L."), a najdiPravidlo porovnáva mená presnou rovnosťou.
  // Španielsky dodávateľ navyše nemá IČO, takže druhá vetva lookupu je mŕtva.
  // Mlčali tým naraz všetky kanály viazané na protistranu. Karta partnera obe
  // mená spojí: nájde sa podľa IČ DPH a nesie meno z adresára.
  it('protistrana sa kľúčuje kartou z adresára, nie menom z faktúry', async () => {
    const database = await createTestDatabase();
    databases.push(database);
    const seeded = await seedTestUser(database);
    const documentId = randomUUID();
    const pred = randomUUID();
    const dph = randomUUID();
    const kde = [seeded.tenantId, seeded.organizationId];

    await database.query(
      `INSERT INTO documents (id,tenant_id,organization_id,document_type,status,processing_status,extracted,accounting,total_amount,currency)
       VALUES ($1,$2,$3,'FP','na_kontrole','ready_for_review',$4::jsonb,'{}'::jsonb,220,'EUR')`,
      [documentId, ...kde, JSON.stringify({
        dodavatel: { nazov: 'Guretruck, S. L.', icDph: 'ESB20720611' },
        polozky: [{ popis: 'FEE (assistance fee)' }, { popis: 'Telephonic transfer to the card' }],
      })],
    );
    await database.query(
      `INSERT INTO code_list_items (id,tenant_id,organization_id,kind,code,name,source)
       VALUES ($1,$2,$3,'predkontacie','TACHpopl.','TACHpopl.','pohoda'),
              ($4,$2,$3,'cleneniaDph','PN','PN','pohoda')`,
      [pred, ...kde, dph],
    );
    // Karta z adresára POHODY: iné meno než na faktúre, ale to isté IČ DPH.
    await database.query(
      `INSERT INTO partners (id,tenant_id,organization_id,name,name_normalized,ic_dph,source)
       VALUES ($1,$2,$3,'GURETRUCK','guretruck','ESB20720611','auto')`,
      [randomUUID(), ...kde],
    );
    // Korpus pomenovaný adresárom — štyri doklady, všetky na TACHpopl.
    for (const cislo of ['ZF1', 'ZF2', 'ZF3', 'ZF4']) {
      await database.query(
        `INSERT INTO ucto_historia
          (id,tenant_id,organization_id,agenda,doklad_cislo,datum,supplier_name_normalized,
           line_text_normalized,predkontacia_kod,predkontacia_id,clenenie_dph_kod,clenenie_dph_id,
           riadok_index,source,riadok_hash)
         VALUES ($1,$2,$3,'FP',$4,'2026-05-10','guretruck','nabitie + poplatok',
                 'TACHpopl.',$5,'PN',$6,0,'mdb',$7)`,
        [randomUUID(), ...kde, cislo, pred, dph, randomUUID()],
      );
    }
    expect(await prepocitajPravidla(database, {
      tenantId: seeded.tenantId, organizationId: seeded.organizationId,
    })).toMatchObject({ pravidiel: 1 });

    const parser = {
      create: vi.fn().mockResolvedValue(aiOdpoved({
        predkontaciaId: pred, clenenieDphId: dph, clenenieKvKod: 'KN',
        ciselnyRadId: null, confidence: 0.9, reason: 'Pravidlo protistrany',
      })),
    };
    const context = {
      documentType: 'FP', supplierName: 'Guretruck, S. L.',
      totalAmount: 220, currency: 'EUR',
      lineDescriptions: ['FEE (assistance fee)', 'Telephonic transfer to the card'],
    };
    // ZÁMERNE bez supplierIcDph: workerService pri návrhu po extrakcii posiela
    // len meno a IČO. Karta sa preto musí nájsť z DOKLADU, inak oprava beží
    // naprázdno presne tak, ako bežala v ostrej prevádzke.
    const input = {
      tenantId: seeded.tenantId, organizationId: seeded.organizationId, documentId,
      supplierName: 'Guretruck, S. L.',
    };
    expect(await maybeAiAccountingSuggestion(database, testConfig(), input, context, parser)).toBe(true);

    // Bez karty by pravidlo v prompte nebolo vôbec — meno z faktúry sa
    // s menom z adresára presnou rovnosťou nikdy nestretne.
    const payload = JSON.parse((parser.create.mock.calls[0][0] as any).input[0].content[0].text);
    expect(payload.pravidlo).toMatchObject({ dokladov: 4, zhoda: 4, predkontaciaKod: 'TACHpopl.' });
  }, 90_000);

  // Ostrý prípad ČSOB Leasing: protistrana má DVE praxe na prijatých faktúrach —
  // upomienky (544-Zml. pokuty, veľa dokladov) a výkupy vozidiel
  // (042/321100Obst.maj., päť dokladov). Text novej faktúry („Predajná cena
  // nájomcovi") nesedí ani s jedným, takže podobnosť je všade 0 a počty rovnaké:
  // komparátor vráti 0, stabilný sort ponechá poradie z databázy a päť slotov
  // protistrany zhltnú upomienky. Výkupy sa do denníka nedostali vôbec.
  it('denník: päť slotov protistrany si nerozoberie jedna prax', async () => {
    const database = await createTestDatabase();
    databases.push(database);
    const seeded = await seedTestUser(database);
    const documentId = randomUUID();
    const pokuty = randomUUID();
    const majetok = randomUUID();
    const dph = randomUUID();
    const kde = [seeded.tenantId, seeded.organizationId];

    await database.query(
      `INSERT INTO documents (id,tenant_id,organization_id,document_type,status,processing_status,extracted,accounting,total_amount,currency)
       VALUES ($1,$2,$3,'FP','na_kontrole','ready_for_review',$4::jsonb,'{}'::jsonb,35424,'EUR')`,
      [documentId, ...kde, JSON.stringify({
        dodavatel: { nazov: 'ČSOB Leasing, a.s.', ico: '35704713' },
        polozky: [{ popis: 'Predajná cena nájomcovi' }],
      })],
    );
    await database.query(
      `INSERT INTO code_list_items (id,tenant_id,organization_id,kind,code,name,source)
       VALUES ($1,$2,$3,'predkontacie','544-Zml. pokuty','544-Zml. pokuty','pohoda'),
              ($4,$2,$3,'predkontacie','042/321100Obst.maj.','042/321100Obst.maj.','pohoda'),
              ($5,$2,$3,'cleneniaDph','PD','PD','pohoda')`,
      [pokuty, ...kde, majetok, dph],
    );
    // Poradie zámerne ako z Postgresu: upomienky prvé, výkupy až za nimi.
    const riadok = (text: string, pk: string, pkId: string) => database.query(
      `INSERT INTO ucto_historia
        (id,tenant_id,organization_id,agenda,doklad_cislo,datum,supplier_name_normalized,supplier_ico,
         line_text_normalized,predkontacia_kod,predkontacia_id,clenenie_dph_kod,clenenie_dph_id,source,riadok_hash)
       VALUES ($1,$2,$3,'FP',$4,'2026-04-08','čsob leasing, a.s.','35704713',$5,$6,$7,'PD',$8,'mdb',$9)`,
      [randomUUID(), ...kde, randomUUID().slice(0, 8), text, pk, pkId, dph, randomUUID()],
    );
    for (let index = 0; index < 8; index += 1) {
      await riadok(`úroky z omeškania upomienka ${index}`, '544-Zml. pokuty', pokuty);
    }
    for (let index = 0; index < 5; index += 1) {
      await riadok(`kúpa ojazdene vozidlo - leasingová zmluva ${index}`, '042/321100Obst.maj.', majetok);
    }

    const parser = {
      create: vi.fn().mockResolvedValue(aiOdpoved({
        predkontaciaId: majetok, clenenieDphId: dph, clenenieKvKod: 'B2',
        ciselnyRadId: null, confidence: 0.9, reason: 'Denník protistrany',
      })),
    };
    const context = {
      documentType: 'FP', supplierName: 'ČSOB Leasing, a.s.', supplierIco: '35704713',
      totalAmount: 35424, currency: 'EUR', lineDescriptions: ['Predajná cena nájomcovi'],
    };
    const input = {
      tenantId: seeded.tenantId, organizationId: seeded.organizationId, documentId,
      supplierName: 'ČSOB Leasing, a.s.', supplierIco: '35704713',
    };
    expect(await maybeAiAccountingSuggestion(database, testConfig(), input, context, parser)).toBe(true);

    // Obe praxe protistrany musia byť v denníku vidieť, nielen tá početnejšia.
    const payload = JSON.parse((parser.create.mock.calls[0][0] as any).input[0].content[0].text);
    const kody = payload.dennik.filter((r: any) => r.tejProtistrany).map((r: any) => r.predkontaciaKod);
    expect(kody).toContain('042/321100Obst.maj.');
    expect(kody).toContain('544-Zml. pokuty');
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

  it('členenie určené pravidlom pri čítaní dokladu AI neprepíše', async () => {
    const database = await createTestDatabase();
    databases.push(database);
    const seeded = await seedTestUser(database);
    const documentId = randomUUID();
    const pred = randomUUID();
    const zPravidla = randomUUID();
    const zDennika = randomUUID();
    for (const [id, kind, code] of [
      [pred, 'predkontacie', '602100 sťah.-zahr.'],
      [zPravidla, 'cleneniaDph', 'UNodpS'], [zDennika, 'cleneniaDph', 'UDzahr'],
    ] as const) {
      await database.query(
        `INSERT INTO code_list_items (id,tenant_id,organization_id,kind,code,name,source)
         VALUES ($1,$2,$3,$4,$5,$5,'pohoda')`,
        [id, seeded.tenantId, seeded.organizationId, kind, code],
      );
    }
    // Extrakcia prečítala na doklade „§ 48 ods. 8" a podľa pravidla účtovníka
    // uložila UNodpS. Model tento text v prompte nemá (v položke je len
    // „Standard destination service"), takže ide za väčšinou v denníku.
    await database.query(
      `INSERT INTO documents (id,tenant_id,organization_id,document_type,status,processing_status,extracted,accounting,total_amount,currency)
       VALUES ($1,$2,$3,'FV','na_kontrole','ready_for_review',$4::jsonb,$5::jsonb,2950,'EUR')`,
      [documentId, seeded.tenantId, seeded.organizationId,
        JSON.stringify({ dodavatel: { nazov: 'AGS' }, odberatel: { nazov: 'RAINIER' }, polozky: [{ popis: 'Standard destination service' }] }),
        JSON.stringify({ clenenieDphId: zPravidla, clenenieKvKod: 'KN' })],
    );
    const parser = {
      create: vi.fn().mockResolvedValue(aiOdpoved(
        { clenenieKvKod: 'A1', predkontaciaId: pred, clenenieDphId: zDennika, ciselnyRadId: null, confidence: 0.8, reason: 'Podľa denníka' },
      )),
    };
    const context = {
      documentType: 'FV', supplierName: 'AGS', odberatel: { nazov: 'RAINIER' },
      totalAmount: 2950, currency: 'EUR', lineDescriptions: ['Standard destination service'],
    };
    const input = { tenantId: seeded.tenantId, organizationId: seeded.organizationId, documentId, supplierName: 'AGS' };
    expect(await maybeAiAccountingSuggestion(database, testConfig(), input, context, parser)).toBe(true);
    const navrh = (await database.query<Record<string, any>>(
      'SELECT predkontacia_id, clenenie_dph_id, clenenie_kv_kod FROM accounting_suggestions WHERE document_id=$1', [documentId],
    )).rows[0];
    // Členenie aj KV ostávajú z pravidla; predkontáciu, ktorú doklad nemal, doplní model.
    expect(navrh).toMatchObject({ clenenie_dph_id: zPravidla, clenenie_kv_kod: 'KN', predkontacia_id: pred });
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
    expect(vybrane[0].id).toBe('p700');
  });

  // Účet bez jediného spoločného slova s dokladom prežije, ak sa číselník zmestí.
  // Presne toto padlo na bločku MANGI: AGS má pre pokladňu 61 predkontácií,
  // „repre" nemá s textom „stravovanie a nápoje" spoločný token, dostal skóre 0
  // a pevný strop 25 riadkov ho z ponuky vyhodil. Model nevyberal zle — správnu
  // možnosť nikdy nevidel.
  it('celý číselník agendy prejde: účet s nulovou zhodou ostáva v ponuke', () => {
    const vsetky = rozvrh(400, { index: 380, nazov: 'repre' });
    const vybrane = zuzPonukuPredkontacii(vsetky, 'stravovanie a napoje', []);
    expect(vybrane).toHaveLength(400);
    expect(vybrane.map((item) => item.id)).toContain('p380');
  });

  // Strop je v znakoch, nie v riadkoch: reže sa až chvost, ktorý sa do promptu
  // nezmestí, a najlepší kandidát ostáva prvý.
  it('neúmerne veľký rozvrh sa oreže, poradie ostáva', () => {
    const vsetky = rozvrh(3000, { index: 2500, nazov: 'PHM nafta' });
    const vybrane = zuzPonukuPredkontacii(vsetky, 'nafta diesel', []);
    expect(vybrane.length).toBeLessThan(3000);
    expect(vybrane[0].id).toBe('p2500');
  });

  it('predkontácie z príkladov účtovníka sú v ponuke aj bez textovej zhody', () => {
    const priklad = { text: 'nesuvisiaci text', predkontaciaId: 'p512', podobnost: 0.4 };
    const vybrane = zuzPonukuPredkontacii(rozvrh(800, { index: 700, nazov: 'PHM nafta' }), 'nafta', [priklad]);
    expect(vybrane.map((item) => item.id)).toContain('p512');
  });

  it('krátky rozvrh sa nezužuje, len zoradí', () => {
    const vsetky = rozvrh(10, { index: 3, nazov: 'PHM nafta' });
    const vybrane = zuzPonukuPredkontacii(vsetky, 'nafta', []);
    // Nič sa nestratí — zmení sa len poradie, zhoda ide navrch.
    expect([...vybrane].sort((a, b) => a.id.localeCompare(b.id)))
      .toEqual([...vsetky].sort((a, b) => a.id.localeCompare(b.id)));
    expect(vybrane[0].id).toBe('p3');
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

describe('kód radu v čísle dokladu', () => {
  // Skutočný prípad RCI: rad 2611 „Prijaté faktúry" mal 162 dokladov
  // (last_number 2611162), rad 2612 „Prijaté dobropisy" dva (261200002).
  // POHODA píše do čísla aj kód radu, takže porovnanie celého reťazca dalo
  // 261 200 002 > 2 611 162 a prijatá faktúra chodila do dobropisov.
  it('vyhrá rad s vyšším počítadlom, nie s dlhším odsadením núl', async () => {
    const database = await createTestDatabase();
    databases.push(database);
    const seeded = await seedTestUser(database);
    const documentId = randomUUID();
    const faktury = randomUUID();
    const dobropisy = randomUUID();
    for (const [id, code, name, lastNumber] of [
      [faktury, '2611', 'Prijaté faktúry', '2611162'],
      [dobropisy, '2612', 'Prijaté dobropisy', '261200002'],
    ] as const) {
      await database.query(
        `INSERT INTO code_list_items (id,tenant_id,organization_id,kind,code,name,source,agenda,last_number)
         VALUES ($1,$2,$3,'ciselneRady',$4,$5,'pohoda','prijate_faktury',$6)`,
        [id, seeded.tenantId, seeded.organizationId, code, name, lastNumber],
      );
    }
    await database.query(
      `INSERT INTO documents
        (id,tenant_id,organization_id,document_type,status,processing_status,extracted,accounting,total_amount,currency)
       VALUES ($1,$2,$3,'FP','na_kontrole','ready_for_review',$4::jsonb,'{}'::jsonb,0,'EUR')`,
      [documentId, seeded.tenantId, seeded.organizationId,
        JSON.stringify({ dodavatel: { nazov: 'SERMAV GRUP SRL' }, cisloFaktury: '2527', datumVystavenia: '2026-08-10', mena: 'EUR', rozpisDph: [], sumaSpolu: 850 })],
    );
    await rebuildAccountingSuggestion(database, {
      tenantId: seeded.tenantId, organizationId: seeded.organizationId, documentId,
      supplierName: 'SERMAV GRUP SRL',
    });
    const row = await database.query<{ ciselny_rad_id: string | null } & Record<string, unknown>>(
      'SELECT ciselny_rad_id FROM accounting_suggestions WHERE document_id=$1', [documentId],
    );
    expect(row.rows[0]?.ciselny_rad_id).toBe(faktury);
  }, 90_000);
});

describe('mesačné číselné rady', () => {
  // Reálny prípad: firma vedie rad na každý mesiac. Júlovej faktúre automatika
  // pridelila júnový rad (naposledy použitý) a POHODA jej dala číslo z neho.
  it('doklad dostane rad svojho mesiaca, nie naposledy použitý', async () => {
    const database = await createTestDatabase();
    databases.push(database);
    const seeded = await seedTestUser(database);
    const documentId = randomUUID();
    const jun = randomUUID();
    const jul = randomUUID();
    for (const [id, code, name, lastNumber] of [
      [jun, '26060', 'Vydané faktúry jún', '260604300119'],
      [jul, '26070', 'Vydané faktúry júl', '00001'],
    ] as const) {
      await database.query(
        `INSERT INTO code_list_items (id,tenant_id,organization_id,kind,code,name,source,agenda,last_number)
         VALUES ($1,$2,$3,'ciselneRady',$4,$5,'pohoda','vydane_faktury',$6)`,
        [id, seeded.tenantId, seeded.organizationId, code, name, lastNumber],
      );
    }
    await database.query(
      `INSERT INTO documents (id,tenant_id,organization_id,document_type,status,processing_status,extracted,accounting,total_amount,currency)
       VALUES ($1,$2,$3,'FV','na_kontrole','ready_for_review',$4::jsonb,'{}'::jsonb,2299.49,'EUR')`,
      [documentId, seeded.tenantId, seeded.organizationId,
        JSON.stringify({ dodavatel: { nazov: 'AGS' }, odberatel: { nazov: 'Kaczynska Sarah' }, datumVystavenia: '2026-07-12', polozky: [{ popis: 'sťahovanie' }] })],
    );

    await rebuildAccountingSuggestion(database, {
      tenantId: seeded.tenantId, organizationId: seeded.organizationId, documentId, supplierName: 'AGS',
    });
    expect((await database.query<Record<string, any>>(
      'SELECT ciselny_rad_id FROM accounting_suggestions WHERE document_id=$1', [documentId],
    )).rows[0].ciselny_rad_id).toBe(jul);

    // Nastavenie účtovníka ostáva silnejšie než mesiac dokladu.
    await database.query(
      `INSERT INTO organization_series_defaults (organization_id,tenant_id,document_type,ciselny_rad_id)
       VALUES ($1,$2,'FV',$3)`,
      [seeded.organizationId, seeded.tenantId, jun],
    );
    await rebuildAccountingSuggestion(database, {
      tenantId: seeded.tenantId, organizationId: seeded.organizationId, documentId, supplierName: 'AGS',
    });
    expect((await database.query<Record<string, any>>(
      'SELECT ciselny_rad_id FROM accounting_suggestions WHERE document_id=$1', [documentId],
    )).rows[0].ciselny_rad_id).toBe(jun);
  }, 90_000);

  it('mesiacZNazvu berie celé slovo, nie podreťazec', () => {
    expect(mesiacZNazvu('Vydané faktúry jún')).toBe(6);
    expect(mesiacZNazvu('Vydané faktúry júl')).toBe(7);
    expect(mesiacZNazvu('Vydané faktúry máj')).toBe(5);
    expect(mesiacZNazvu('Majetok')).toBeUndefined();
    expect(mesiacZNazvu('Prijaté faktúry')).toBeUndefined();
    expect(mesiacZNazvu(undefined)).toBeUndefined();
  });
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
  // Reálny prípad: španielsky dodávateľ, služba bez DPH. Model zákon vyhodnotil
  // správne (§69 ods. 3), ale DDsl§69 + KV B1 patria na SAMOSTATNÝ interný
  // doklad — firma ich použila 194× a ani raz na prijatej faktúre. Ponuka mu
  // taký kód nesmie dať do ruky.
  it('členenie, ktoré firma na tejto agende nikdy nepoužila, sa modelu neponúkne', async () => {
    const database = await createTestDatabase();
    databases.push(database);
    const seeded = await seedTestUser(database);
    const documentId = randomUUID();
    const pred = randomUUID();
    const pn = randomUUID();
    const ddsl = randomUUID();
    await database.query(
      `INSERT INTO documents (id,tenant_id,organization_id,document_type,status,processing_status,extracted,accounting,total_amount,currency)
       VALUES ($1,$2,$3,'FP','na_kontrole','ready_for_review',$4::jsonb,'{}'::jsonb,480,'EUR')`,
      [documentId, seeded.tenantId, seeded.organizationId,
        JSON.stringify({ dodavatel: { nazov: 'Taller ESP S.L.' }, polozky: [{ popis: 'reparacion vehiculo' }] })],
    );
    for (const [id, kind, code] of [
      [pred, 'predkontacie', '518/321'], [pn, 'cleneniaDph', 'PN'], [ddsl, 'cleneniaDph', 'DDsl§69'],
    ] as const) {
      await database.query(
        `INSERT INTO code_list_items (id,tenant_id,organization_id,kind,code,name,source)
         VALUES ($1,$2,$3,$4,$5,$5,'pohoda')`,
        [id, seeded.tenantId, seeded.organizationId, kind, code],
      );
    }
    // História firmy: PN chodí na prijatých faktúrach, DDsl§69 iba na interných.
    for (const [agenda, kod, dphId] of [
      ['FP', 'PN', pn], ['FP', 'PN', pn], ['INT', 'DDsl§69', ddsl], ['INT', 'DDsl§69', ddsl],
    ] as const) {
      await database.query(
        `INSERT INTO ucto_historia
          (id,tenant_id,organization_id,agenda,line_text_normalized,predkontacia_kod,predkontacia_id,clenenie_dph_kod,clenenie_dph_id,source,riadok_hash)
         VALUES ($1,$2,$3,$4,'oprava vozidla','518/321',$5,$6,$7,'mdb',$8)`,
        [randomUUID(), seeded.tenantId, seeded.organizationId, agenda, pred, kod, dphId, randomUUID()],
      );
    }

    const parser = {
      create: vi.fn().mockResolvedValue(aiOdpoved({
        predkontaciaId: pred, clenenieDphId: pn, clenenieKvKod: 'KN', ciselnyRadId: null,
        confidence: 0.8, reason: 'Prijatá faktúra mimo priznania',
      })),
    };
    const context = { documentType: 'FP', supplierName: 'Taller ESP S.L.', supplierKrajina: 'ES',
      totalAmount: 480, currency: 'EUR', lineDescriptions: ['reparacion vehiculo'] };
    expect(await maybeAiAccountingSuggestion(database, testConfig(),
      { tenantId: seeded.tenantId, organizationId: seeded.organizationId, documentId, supplierName: 'Taller ESP S.L.' },
      context, parser)).toBe(true);

    const payload = JSON.parse((parser.create.mock.calls[0][0] as any).input[0].content[0].text);
    const ponuka = payload.ciselniky.cleneniaDph.map((item: { kod: string }) => item.kod);
    expect(ponuka).toContain('PN');
    expect(ponuka).not.toContain('DDsl§69');
  }, 90_000);

  // Adversarialna kontrola nasla, ze prve zuzenie odoberalo aj SPRAVNY kod:
  // prva nadobudacia faktura z EU je legitimny prvy vyskyt, nie omyl.
  it('kod, ktory firma nepouzila nikde, ostane v ponuke', async () => {
    const database = await createTestDatabase();
    databases.push(database);
    const seeded = await seedTestUser(database);
    const documentId = randomUUID();
    const pred = randomUUID();
    const pn = randomUUID();
    const ddsl = randomUUID();
    const nadEU = randomUUID();
    await database.query(
      `INSERT INTO documents (id,tenant_id,organization_id,document_type,status,processing_status,extracted,accounting,total_amount,currency)
       VALUES ($1,$2,$3,'FP','na_kontrole','ready_for_review',$4::jsonb,'{}'::jsonb,500,'EUR')`,
      [documentId, seeded.tenantId, seeded.organizationId,
        JSON.stringify({ dodavatel: { nazov: 'EU Dodavatel GmbH' }, polozky: [{ popis: 'tovar z DE' }] })],
    );
    for (const [id, kind, code] of [
      [pred, 'predkontacie', '501/321'], [pn, 'cleneniaDph', 'PN'],
      [ddsl, 'cleneniaDph', 'DDsl§69'], [nadEU, 'cleneniaDph', 'PDnadEU'],
    ] as const) {
      await database.query(
        `INSERT INTO code_list_items (id,tenant_id,organization_id,kind,code,name,source)
         VALUES ($1,$2,$3,$4,$5,$5,'pohoda')`,
        [id, seeded.tenantId, seeded.organizationId, kind, code],
      );
    }
    // PN chodi na FP, DDsl§69 iba na INT, PDnadEU nikde.
    for (const [agenda, kod, dphId] of [
      ['FP', 'PN', pn], ['FP', 'PN', pn], ['INT', 'DDsl§69', ddsl], ['INT', 'DDsl§69', ddsl],
    ] as const) {
      await database.query(
        `INSERT INTO ucto_historia
          (id,tenant_id,organization_id,agenda,line_text_normalized,predkontacia_kod,predkontacia_id,clenenie_dph_kod,clenenie_dph_id,source,riadok_hash)
         VALUES ($1,$2,$3,$4,'tovar','501/321',$5,$6,$7,'mdb',$8)`,
        [randomUUID(), seeded.tenantId, seeded.organizationId, agenda, pred, kod, dphId, randomUUID()],
      );
    }

    const parser = {
      create: vi.fn().mockResolvedValue(aiOdpoved({
        predkontaciaId: pred, clenenieDphId: nadEU, clenenieKvKod: null, ciselnyRadId: null,
        confidence: 0.8, reason: 'Nadobudnutie tovaru z EU',
      })),
    };
    await maybeAiAccountingSuggestion(database, testConfig(),
      { tenantId: seeded.tenantId, organizationId: seeded.organizationId, documentId, supplierName: 'EU Dodavatel GmbH' },
      { documentType: 'FP', supplierName: 'EU Dodavatel GmbH', supplierKrajina: 'DE',
        totalAmount: 500, currency: 'EUR', lineDescriptions: ['tovar z DE'] }, parser);

    const payload = JSON.parse((parser.create.mock.calls[0][0] as any).input[0].content[0].text);
    const ponuka = payload.ciselniky.cleneniaDph.map((item: { kod: string }) => item.kod);
    // Dokazane patri inam -> preč. Nepoužité nikde -> ostáva.
    expect(ponuka).not.toContain('DDsl§69');
    expect(ponuka).toContain('PDnadEU');
    expect(ponuka).toContain('PN');
    // Model vidí aj počet použití, nielen kratší zoznam.
    expect(payload.ciselniky.cleneniaDph.find((i: { kod: string }) => i.kod === 'PN'))
      .toMatchObject({ pouziteNaTomtoTypeDokladu: 2 });
  }, 90_000);

  // Poistka pre neplatiteľa DPH z ponuky iba VYBERÁ — keby zúženie vyhodilo
  // členenie bez nároku na odpočet, ticho by sa zmenila na no-op a model by
  // dostal na výber výhradne odpočtové kódy.
  it('členenie bez nároku na odpočet zúženie neodstráni', async () => {
    const database = await createTestDatabase();
    databases.push(database);
    const seeded = await seedTestUser(database);
    const documentId = randomUUID();
    const pred = randomUUID();
    const pd = randomUUID();
    const bezOdpoctu = randomUUID();
    await database.query(
      `INSERT INTO documents (id,tenant_id,organization_id,document_type,status,processing_status,extracted,accounting,total_amount,currency)
       VALUES ($1,$2,$3,'FP','na_kontrole','ready_for_review',$4::jsonb,'{}'::jsonb,100,'EUR')`,
      [documentId, seeded.tenantId, seeded.organizationId,
        JSON.stringify({ dodavatel: { nazov: 'Dodavatel' }, polozky: [{ popis: 'sluzba' }] })],
    );
    for (const [id, kind, code] of [
      [pred, 'predkontacie', '518/321'], [pd, 'cleneniaDph', 'PD'], [bezOdpoctu, 'cleneniaDph', 'PB'],
    ] as const) {
      await database.query(
        `INSERT INTO code_list_items (id,tenant_id,organization_id,kind,code,name,source)
         VALUES ($1,$2,$3,$4,$5,$5,'pohoda')`,
        [id, seeded.tenantId, seeded.organizationId, kind, code],
      );
    }
    // História je plná odpočtového PD; PB v nej nie je ani raz.
    for (let index = 0; index < 3; index += 1) {
      await database.query(
        `INSERT INTO ucto_historia
          (id,tenant_id,organization_id,agenda,line_text_normalized,predkontacia_kod,predkontacia_id,clenenie_dph_kod,clenenie_dph_id,source,riadok_hash)
         VALUES ($1,$2,$3,'FP','sluzba','518/321',$4,'PD',$5,'mdb',$6)`,
        [randomUUID(), seeded.tenantId, seeded.organizationId, pred, pd, randomUUID()],
      );
    }
    await database.query(
      `INSERT INTO organization_dph_profiles (organization_id,tenant_id,platitel_dph,clenenie_bez_odpoctu_id)
       VALUES ($1,$2,'neplatitel',$3)`,
      [seeded.organizationId, seeded.tenantId, bezOdpoctu],
    );

    const parser = {
      create: vi.fn().mockResolvedValue(aiOdpoved({
        predkontaciaId: pred, clenenieDphId: bezOdpoctu, clenenieKvKod: null, ciselnyRadId: null,
        confidence: 0.8, reason: 'Neplatiteľ DPH',
      })),
    };
    await maybeAiAccountingSuggestion(database, testConfig(),
      { tenantId: seeded.tenantId, organizationId: seeded.organizationId, documentId, supplierName: 'Dodavatel' },
      { documentType: 'FP', supplierName: 'Dodavatel', totalAmount: 100, currency: 'EUR', lineDescriptions: ['sluzba'] },
      parser);

    const payload = JSON.parse((parser.create.mock.calls[0][0] as any).input[0].content[0].text);
    const ponuka = payload.ciselniky.cleneniaDph.map((item: { kod: string }) => item.kod);
    // Poistka zafungovala: v ponuke ostalo LEN členenie bez nároku na odpočet.
    expect(ponuka).toEqual(['PB']);
  }, 90_000);

  // Simulacia na realnych datach: pri agende bez historie (prvy ostatny zavazok
  // firmy) ma KAZDY kod tu=0 a inde>0. Bez tejto poistky by ponuka spadla na
  // kody nepouzite nikde — teda na jediny nespravny.
  // Zuzenie ponuky samo osebe nic nezakazuje: pokyny DPH profilu piu modelu
  // to iste id doslovne do promptu ("pouzi clenenie DPH s id ...") a
  // onlyActiveIds kontroluje iba active=true. Bez vynutenia by DDsl§69
  // skoncilo na prijatej fakture rovnako ako predtym, len tichsie.
  it('kód patriaci na iný doklad sa zahodí, aj keď ho model vráti napriek zúženiu', async () => {
    const database = await createTestDatabase();
    databases.push(database);
    const seeded = await seedTestUser(database);
    const documentId = randomUUID();
    const pred = randomUUID();
    const pn = randomUUID();
    const ddsl = randomUUID();
    await database.query(
      `INSERT INTO documents (id,tenant_id,organization_id,document_type,status,processing_status,extracted,accounting,total_amount,currency)
       VALUES ($1,$2,$3,'FP','na_kontrole','ready_for_review',$4::jsonb,'{}'::jsonb,480,'EUR')`,
      [documentId, seeded.tenantId, seeded.organizationId,
        JSON.stringify({ dodavatel: { nazov: 'ES Dodavatel' }, polozky: [{ popis: 'sluzba' }] })],
    );
    for (const [id, kind, code] of [
      [pred, 'predkontacie', '518/321'], [pn, 'cleneniaDph', 'PN'], [ddsl, 'cleneniaDph', 'DDsl§69'],
    ] as const) {
      await database.query(
        `INSERT INTO code_list_items (id,tenant_id,organization_id,kind,code,name,source)
         VALUES ($1,$2,$3,$4,$5,$5,'pohoda')`,
        [id, seeded.tenantId, seeded.organizationId, kind, code],
      );
    }
    for (const [agenda, kod, dphId] of [
      ['FP', 'PN', pn], ['FP', 'PN', pn], ['INT', 'DDsl§69', ddsl], ['INT', 'DDsl§69', ddsl],
    ] as const) {
      await database.query(
        `INSERT INTO ucto_historia
          (id,tenant_id,organization_id,agenda,line_text_normalized,predkontacia_kod,predkontacia_id,clenenie_dph_kod,clenenie_dph_id,source,riadok_hash)
         VALUES ($1,$2,$3,$4,'sluzba','518/321',$5,$6,$7,'mdb',$8)`,
        [randomUUID(), seeded.tenantId, seeded.organizationId, agenda, pred, kod, dphId, randomUUID()],
      );
    }

    // Model kód vráti napriek tomu, že v ponuke nebol — presne to, čo mu
    // pokyny DPH profilu vedia podsunúť aj s id.
    const parser = {
      create: vi.fn().mockResolvedValue(aiOdpoved({
        predkontaciaId: pred, clenenieDphId: ddsl, clenenieKvKod: 'B1', ciselnyRadId: null,
        confidence: 0.9, reason: 'Samozdanenie podľa §69',
      })),
    };
    expect(await maybeAiAccountingSuggestion(database, testConfig(),
      { tenantId: seeded.tenantId, organizationId: seeded.organizationId, documentId, supplierName: 'ES Dodavatel' },
      { documentType: 'FP', supplierName: 'ES Dodavatel', supplierKrajina: 'ES',
        totalAmount: 480, currency: 'EUR', lineDescriptions: ['sluzba'] }, parser)).toBe(true);

    const navrh = (await database.query<Record<string, any>>(
      'SELECT * FROM accounting_suggestions WHERE document_id=$1', [documentId],
    )).rows[0];
    // Kód sa na doklad nedostal ani cez odpoveď modelu.
    expect(navrh.clenenie_dph_id).not.toBe(ddsl);
    // A s ním nešla do kontrolného výkazu ani sekcia B1.
    expect(navrh.clenenie_kv_kod).not.toBe('B1');
  }, 90_000);

  it('agenda bez histórie sa nezužuje, hoci firma inde účtuje', async () => {
    const database = await createTestDatabase();
    databases.push(database);
    const seeded = await seedTestUser(database);
    const documentId = randomUUID();
    const pred = randomUUID();
    const pn = randomUUID();
    const un = randomUUID();
    const novy = randomUUID();
    await database.query(
      `INSERT INTO documents (id,tenant_id,organization_id,document_type,status,processing_status,extracted,accounting,total_amount,currency)
       VALUES ($1,$2,$3,'OZ','na_kontrole','ready_for_review',$4::jsonb,'{}'::jsonb,200,'EUR')`,
      [documentId, seeded.tenantId, seeded.organizationId,
        JSON.stringify({ dodavatel: { nazov: 'Veritel' }, polozky: [{ popis: 'zavazok' }] })],
    );
    for (const [id, kind, code] of [
      [pred, 'predkontacie', '379/321'], [pn, 'cleneniaDph', 'PN'],
      [un, 'cleneniaDph', 'UN'], [novy, 'cleneniaDph', 'PNnikde'],
    ] as const) {
      await database.query(
        `INSERT INTO code_list_items (id,tenant_id,organization_id,kind,code,name,source)
         VALUES ($1,$2,$3,$4,$5,$5,'pohoda')`,
        [id, seeded.tenantId, seeded.organizationId, kind, code],
      );
    }
    // História existuje, ale iba na FP a INT — na OZ ani riadok.
    for (const [agenda, kod, dphId] of [
      ['FP', 'PN', pn], ['INT', 'UN', un],
    ] as const) {
      await database.query(
        `INSERT INTO ucto_historia
          (id,tenant_id,organization_id,agenda,line_text_normalized,predkontacia_kod,predkontacia_id,clenenie_dph_kod,clenenie_dph_id,source,riadok_hash)
         VALUES ($1,$2,$3,$4,'nieco','379/321',$5,$6,$7,'mdb',$8)`,
        [randomUUID(), seeded.tenantId, seeded.organizationId, agenda, pred, kod, dphId, randomUUID()],
      );
    }

    const parser = {
      create: vi.fn().mockResolvedValue(aiOdpoved({
        predkontaciaId: pred, clenenieDphId: pn, clenenieKvKod: null, ciselnyRadId: null,
        confidence: 0.7, reason: 'Ostatný záväzok',
      })),
    };
    await maybeAiAccountingSuggestion(database, testConfig(),
      { tenantId: seeded.tenantId, organizationId: seeded.organizationId, documentId, supplierName: 'Veritel' },
      { documentType: 'OZ', supplierName: 'Veritel', totalAmount: 200, currency: 'EUR', lineDescriptions: ['zavazok'] },
      parser);

    const payload = JSON.parse((parser.create.mock.calls[0][0] as any).input[0].content[0].text);
    const ponuka = payload.ciselniky.cleneniaDph.map((item: { kod: string }) => item.kod);
    // Nič sa neodobralo — účtovník má na výber všetko, čo firma má.
    expect(ponuka).toEqual(expect.arrayContaining(['PN', 'UN', 'PNnikde']));
  }, 90_000);

  it('bez histórie na tejto agende sa ponuka členení nezúži', async () => {
    const database = await createTestDatabase();
    databases.push(database);
    const seeded = await seedTestUser(database);
    const documentId = randomUUID();
    const pn = randomUUID();
    const ddsl = randomUUID();
    const pred = randomUUID();
    await database.query(
      `INSERT INTO documents (id,tenant_id,organization_id,document_type,status,processing_status,extracted,accounting,total_amount,currency)
       VALUES ($1,$2,$3,'FP','na_kontrole','ready_for_review',$4::jsonb,'{}'::jsonb,100,'EUR')`,
      [documentId, seeded.tenantId, seeded.organizationId,
        JSON.stringify({ dodavatel: { nazov: 'Nová firma' }, polozky: [{ popis: 'sluzba' }] })],
    );
    await database.query(
      `INSERT INTO code_list_items (id,tenant_id,organization_id,kind,code,name,source)
       VALUES ($1,$2,$3,'predkontacie','518/321','518/321','pohoda')`,
      [pred, seeded.tenantId, seeded.organizationId],
    );
    for (const [id, code] of [[pn, 'PN'], [ddsl, 'DDsl§69']] as const) {
      await database.query(
        `INSERT INTO code_list_items (id,tenant_id,organization_id,kind,code,name,source)
         VALUES ($1,$2,$3,'cleneniaDph',$4,$4,'pohoda')`,
        [id, seeded.tenantId, seeded.organizationId, code],
      );
    }
    const parser = {
      create: vi.fn().mockResolvedValue(aiOdpoved({
        predkontaciaId: pred, clenenieDphId: pn, clenenieKvKod: null, ciselnyRadId: null,
        confidence: 0.7, reason: 'Bez histórie',
      })),
    };
    await maybeAiAccountingSuggestion(database, testConfig(),
      { tenantId: seeded.tenantId, organizationId: seeded.organizationId, documentId, supplierName: 'Nová firma' },
      { documentType: 'FP', supplierName: 'Nová firma', totalAmount: 100, currency: 'EUR', lineDescriptions: ['sluzba'] },
      parser);

    const payload = JSON.parse((parser.create.mock.calls[0][0] as any).input[0].content[0].text);
    const ponuka = payload.ciselniky.cleneniaDph.map((item: { kod: string }) => item.kod);
    // Nová firma nemá čím zúžiť — dostane celý číselník, inak by nemala z čoho vybrať.
    expect(ponuka).toEqual(expect.arrayContaining(['PN', 'DDsl§69']));
  }, 90_000);

});

// Rozdelený doklad. Účtovník ho vie rozpísať v položkách a export ho do POHODY
// prenesie už dávno — chýbalo len to, že AI riadky nikdy nevyplnila. Podklad je
// účtovný denník: doklady Print-Office idú u ALPINY 8 z 9 na 501400 + 513100 +
// 548002, pričom 513100 je reprezentácia BEZ nároku na odpočet DPH.
describe('návrh rozpisu po riadkoch', () => {
  it('dá modelu účty rozpadu, uloží overené riadky a zvyšok zahodí', async () => {
    const database = await createTestDatabase();
    databases.push(database);
    const seeded = await seedTestUser(database);
    const kde = [seeded.tenantId, seeded.organizationId];

    const predk = new Map<string, string>();
    for (const [kod, ucet] of [['501/321', '501400'], ['513/321', '513100'], ['548/321', '548002']] as const) {
      const id = randomUUID();
      predk.set(kod, id);
      await database.query(
        `INSERT INTO code_list_items (id,tenant_id,organization_id,kind,code,name,source,ucet_md,ucet_dal)
         VALUES ($1,$2,$3,'predkontacie',$4,$4,'pohoda',$5,'321100')`,
        [id, ...kde, kod, ucet],
      );
    }
    const dphPlny = randomUUID();
    const dphBezOdpoctu = randomUUID();
    for (const [id, kod] of [[dphPlny, 'PD'], [dphBezOdpoctu, 'UNodp']] as const) {
      await database.query(
        `INSERT INTO code_list_items (id,tenant_id,organization_id,kind,code,name,source)
         VALUES ($1,$2,$3,'cleneniaDph',$4,$4,'pohoda')`,
        [id, ...kde, kod],
      );
    }

    // Tri doklady rovnako rozpísané — to je prah, od ktorého sa rozpad považuje
    // za prax firmy, nie za jednorazové rozúčtovanie.
    for (const cislo of ['26FP001', '26FP002', '26FP003']) {
      for (const ucet of ['501400', '513100', '548002', '343100']) {
        await database.query(
          `INSERT INTO ucto_dennik (id,tenant_id,organization_id,externalny_id,agenda,doklad_cislo,
             ucet_md,ucet_dal,partner_nazov)
           VALUES ($1,$2,$3,$4,'Prijaté faktúry',$5,$6,'321100','Print-Office s.r.o.')`,
          [randomUUID(), ...kde, `${cislo}-${ucet}`, cislo, ucet],
        );
      }
    }

    const documentId = randomUUID();
    await database.query(
      `INSERT INTO documents (id,tenant_id,organization_id,document_type,status,processing_status,extracted,accounting,total_amount,currency)
       VALUES ($1,$2,$3,'FP','na_kontrole','ready_for_review','{}'::jsonb,'{}'::jsonb,240,'EUR')`,
      [documentId, ...kde],
    );

    const parser = {
      create: vi.fn().mockResolvedValue(aiOdpoved({
        predkontaciaId: predk.get('501/321'), clenenieDphId: dphPlny,
        clenenieKvKod: 'B2', ciselnyRadId: null, confidence: 0.95,
        reason: 'Kancelárske potreby s reprezentáciou',
        riadky: [
          // Jediný platný: iný účet než hlavička, oba kódy z ponuky.
          { index: 1, predkontaciaId: predk.get('513/321'), clenenieDphId: dphBezOdpoctu, clenenieKvKod: 'KN' },
          // Zhodné s hlavičkou vo VŠETKOM — prázdny riadok znamená „ako doklad".
          { index: 0, predkontaciaId: predk.get('501/321'), clenenieDphId: null, clenenieKvKod: null },
          // Položka s takým indexom na doklade nie je.
          { index: 9, predkontaciaId: predk.get('548/321'), clenenieDphId: null, clenenieKvKod: null },
          // Druhý návrh na ten istý riadok.
          { index: 1, predkontaciaId: predk.get('548/321'), clenenieDphId: null, clenenieKvKod: null },
          // Predkontácia, ktorú model nedostal v ponuke.
          { index: 2, predkontaciaId: randomUUID(), clenenieDphId: null, clenenieKvKod: null },
          // Podiel 1 = celá položka, nie rez. Model to tak píše, a kým sa to
          // bralo ako časť rezu, riadok vypadol — na tom padlo VŠETKÝCH 16
          // rozpisov v meraní ALPINY.
          { index: 2, predkontaciaId: predk.get('548/321'), clenenieDphId: null, clenenieKvKod: null, podiel: 1 },
          // A nula znamená to isté. Model použil obe — najprv jednotku, po jej
          // oprave nulu — takže sa neoveruje hodnota, ale trieda: rez je podiel
          // striktne medzi 0 a 1.
          { index: 3, predkontaciaId: predk.get('513/321'), clenenieDphId: null, clenenieKvKod: null, podiel: 0 },
        ],
      })),
    };
    const input = { tenantId: seeded.tenantId, organizationId: seeded.organizationId, documentId, supplierName: 'Print-Office s.r.o.' };
    const context = {
      documentType: 'FP', supplierName: 'Print-Office s.r.o.', totalAmount: 240, currency: 'EUR',
      lineDescriptions: ['Toner do tlačiarne', 'Káva pre klientov', 'Poštovné', 'Voda pre vodičov'],
      polozky: [
        { popis: 'Toner do tlačiarne', sadzbaDph: 23, suma: 120 },
        { popis: 'Káva pre klientov', sadzbaDph: 23, suma: 60 },
        { popis: 'Poštovné', sadzbaDph: 23, suma: 60 },
        { popis: 'Voda pre vodičov', sadzbaDph: 23, suma: 20 },
      ],
    };
    expect(await maybeAiAccountingSuggestion(database, testConfig(), input, context, parser)).toBe(true);

    const payload = JSON.parse((parser.create.mock.calls[0][0] as any).input[0].content[0].text);
    // Model nevie účtovať na účet — ku každému účtu rozpadu musí dostať
    // predkontácie, ktoré naň účtujú, inak nemá z čoho vybrať.
    expect(payload.rozdelenie).toMatchObject({ pocet: 3, spolu: 3 });
    expect(payload.rozdelenie.ucty.map((polozka: any) => polozka.ucet)).toEqual(['501400', '513100', '548002']);
    expect(payload.rozdelenie.ucty[1].predkontacie[0]).toMatchObject({ kod: '513/321' });
    // Index ide do promptu explicitne — podľa neho sa odpoveď priraďuje späť.
    expect(payload.dokument.polozky.map((polozka: any) => polozka.index)).toEqual([0, 1, 2, 3]);

    const suggestion = (await database.query<Record<string, any>>(
      'SELECT * FROM accounting_suggestions WHERE document_id=$1', [documentId],
    )).rows[0];
    expect(suggestion.riadky).toEqual([
      // Káva nesie DPH a na doklade sa odpočítava: faktúra ide do B2 celá, aj
      // s položkou bez nároku. Sekciu dedí z hlavičky, KN od modelu neplatí.
      { index: 1, popis: 'Káva pre klientov', predkontaciaId: predk.get('513/321'), clenenieDphId: dphBezOdpoctu },
      // Podiel 1 aj 0 prejdú ako celá položka, nie ako neúplný rez.
      { index: 2, popis: 'Poštovné', predkontaciaId: predk.get('548/321') },
      { index: 3, popis: 'Voda pre vodičov', predkontaciaId: predk.get('513/321') },
    ]);
    // Rozdelený doklad sa nepredvyplní sám — istota ostáva pod hranicou 0,9.
    expect(Number(suggestion.confidence)).toBeLessThan(0.9);
    expect(suggestion.reason).toContain('spravidla delí');
    expect(suggestion.reason).toContain('501400 + 513100 + 548002');
  }, 90_000);
});

// Faktúra Print-Office DF260169: hlavička „repre / PD / B2", tri položky —
// kancelárske potreby (501400, PD, B2), reprezentácia (513100, PN, KN)
// a vratný obal (548002, PN, KN). Reprezentácia má TÚ ISTÚ predkontáciu ako
// hlavička a líši sa len daňovým režimom. Kým sa riadok zahadzoval podľa
// zhodnej predkontácie, práve táto položka vypadla — a s ňou aj to, že do
// priznania ani do kontrolného výkazu nepatrí.
describe('riadok, ktorý sa od hlavičky líši len režimom DPH', () => {
  it('ostane v návrhu aj pri zhodnej predkontácii', async () => {
    const database = await createTestDatabase();
    databases.push(database);
    const seeded = await seedTestUser(database);
    const kde = [seeded.tenantId, seeded.organizationId];

    const repre = randomUUID();
    const kancelarske = randomUUID();
    for (const [id, kod, ucet] of [[repre, 'repre', '513100'], [kancelarske, 'kancelár.potreby', '501400']] as const) {
      await database.query(
        `INSERT INTO code_list_items (id,tenant_id,organization_id,kind,code,name,source,ucet_md,ucet_dal)
         VALUES ($1,$2,$3,'predkontacie',$4,$4,'pohoda',$5,'321100')`,
        [id, ...kde, kod, ucet],
      );
    }
    const dphPd = randomUUID();
    const dphPn = randomUUID();
    for (const [id, kod] of [[dphPd, 'PD'], [dphPn, 'PN']] as const) {
      await database.query(
        `INSERT INTO code_list_items (id,tenant_id,organization_id,kind,code,name,source)
         VALUES ($1,$2,$3,'cleneniaDph',$4,$4,'pohoda')`,
        [id, ...kde, kod],
      );
    }
    for (const cislo of ['26FP101', '26FP102', '26FP103']) {
      for (const ucet of ['501400', '513100', '343100']) {
        await database.query(
          `INSERT INTO ucto_dennik (id,tenant_id,organization_id,externalny_id,agenda,doklad_cislo,
             ucet_md,ucet_dal,partner_nazov)
           VALUES ($1,$2,$3,$4,'Prijaté faktúry',$5,$6,'321100','Print-Office s.r.o.')`,
          [randomUUID(), ...kde, `${cislo}-${ucet}`, cislo, ucet],
        );
      }
    }
    const documentId = randomUUID();
    await database.query(
      `INSERT INTO documents (id,tenant_id,organization_id,document_type,status,processing_status,extracted,accounting,total_amount,currency)
       VALUES ($1,$2,$3,'FP','na_kontrole','ready_for_review','{}'::jsonb,'{}'::jsonb,242.77,'EUR')`,
      [documentId, ...kde],
    );

    const parser = {
      create: vi.fn().mockResolvedValue(aiOdpoved({
        predkontaciaId: repre, clenenieDphId: dphPd, clenenieKvKod: 'B2',
        ciselnyRadId: null, confidence: 0.9, reason: 'Reprezentácia s kancelárskymi potrebami',
        riadky: [
          { index: 0, predkontaciaId: kancelarske, clenenieDphId: dphPd, clenenieKvKod: 'B2' },
          // Tá istá predkontácia ako hlavička, ale mimo priznania.
          { index: 1, predkontaciaId: repre, clenenieDphId: dphPn, clenenieKvKod: 'KN' },
        ],
      })),
    };
    const input = { tenantId: seeded.tenantId, organizationId: seeded.organizationId, documentId, supplierName: 'Print-Office s.r.o.' };
    const context = {
      documentType: 'FP', supplierName: 'Print-Office s.r.o.', totalAmount: 242.77, currency: 'EUR',
      lineDescriptions: ['kancelárske potreby', 'spese di rappresentanza'],
      polozky: [
        { popis: 'kancelárske potreby', sadzbaDph: 23, suma: 61.13 },
        { popis: 'spese di rappresentanza', sadzbaDph: 0, suma: 165.44 },
      ],
    };
    expect(await maybeAiAccountingSuggestion(database, testConfig(), input, context, parser)).toBe(true);

    const riadky = (await database.query<Record<string, any>>(
      'SELECT riadky FROM accounting_suggestions WHERE document_id=$1', [documentId],
    )).rows[0].riadky as Array<Record<string, unknown>>;
    expect(riadky).toHaveLength(2);
    expect(riadky[1]).toEqual({
      index: 1, popis: 'spese di rappresentanza',
      predkontaciaId: repre, clenenieDphId: dphPn, clenenieKvKod: 'KN',
    });
  }, 90_000);
});

// Tá istá faktúra Print-Office, ale s chybou, ktorú model spravil naozaj:
// hlavička „repre / PD / KN" — účet reprezentácie s členením, ktoré odpočet
// UPLATŇUJE. Riadky reprezentácie nevrátil vôbec, tie teda hlavičku zdedili
// a s ňou aj odpočet 15,51 €, ktorý § 49 ods. 7 písm. a) zakazuje. Na doklade
// to nebolo vidieť: sekcia KN doň napísala, že do kontrolného výkazu nejde.
describe('odpočet na účte, na ktorom firma neodpočítava', () => {
  type TestDatabase = Awaited<ReturnType<typeof createTestDatabase>>;
  const repre = randomUUID();
  const kancelarske = randomUUID();
  const dphPd = randomUUID();
  const dphPn = randomUUID();

  const ciselnik = async (database: TestDatabase, kde: string[]) => {
    for (const [id, kod, ucet] of [[repre, 'repre', '513100'], [kancelarske, 'kancelár.potreby', '501400']] as const) {
      await database.query(
        `INSERT INTO code_list_items (id,tenant_id,organization_id,kind,code,name,source,ucet_md,ucet_dal)
         VALUES ($1,$2,$3,'predkontacie',$4,$4,'pohoda',$5,'321100')`,
        [id, ...kde, kod, ucet],
      );
    }
    for (const [id, kod, nazov] of [
      [dphPd, 'PD', 'Tuzemské plnenia'],
      // Názov je jediné, z čoho sa „bez nároku na odpočet" dá prečítať —
      // POHODA ho v číselníku píše presne takto.
      [dphPn, 'PN', 'Nezahrňovať do priznania DPH'],
    ] as const) {
      await database.query(
        `INSERT INTO code_list_items (id,tenant_id,organization_id,kind,code,name,source)
         VALUES ($1,$2,$3,'cleneniaDph',$4,$5,'pohoda')`,
        [id, ...kde, kod, nazov],
      );
    }
  };

  // Tri faktúry tak, ako ich účtovník zaúčtoval: hlavička kancelárske potreby
  // s odpočtom, reprezentácia až na POLOŽKE a bez odpočtu. Na hlavičke účet
  // „repre" nestojí ani raz — presne preto ho clenenieZUctu nevidí.
  const historia = async (database: TestDatabase, kde: string[]) => {
    for (const cislo of ['26FP301', '26FP302', '26FP303']) {
      for (const [ucet, predkontaciaId, clenenie, clenenieId, kv, index, text] of [
        ['kancelár.potreby', kancelarske, 'PD', dphPd, 'B2', 0, 'kancelarske potreby'],
        ['repre', repre, 'PN', dphPn, 'KN', 1, 'kava a caj'],
      ] as const) {
        await database.query(
          `INSERT INTO ucto_historia
            (id,tenant_id,organization_id,agenda,doklad_cislo,datum,supplier_name_normalized,
             line_text_normalized,predkontacia_kod,predkontacia_id,clenenie_dph_kod,clenenie_dph_id,
             clenenie_kv_kod,riadok_index,source,riadok_hash)
           VALUES ($1,$2,$3,'FP',$4,'2026-05-10','print office',$5,$6,$7,$8,$9,$10,$11,'mdb',$12)`,
          [randomUUID(), ...kde, cislo, text, ucet, predkontaciaId, clenenie, clenenieId, kv, index, randomUUID()],
        );
      }
    }
  };

  const doklad = async (database: TestDatabase, kde: string[]) => {
    const documentId = randomUUID();
    await database.query(
      `INSERT INTO documents (id,tenant_id,organization_id,document_type,status,processing_status,extracted,accounting,total_amount,currency)
       VALUES ($1,$2,$3,'FP','na_kontrole','ready_for_review','{}'::jsonb,'{}'::jsonb,170.65,'EUR')`,
      [documentId, ...kde],
    );
    return documentId;
  };

  const kontext = {
    documentType: 'FP', supplierName: 'Print-Office s.r.o.', totalAmount: 170.65, currency: 'EUR',
    lineDescriptions: ['zošit herlitz', 'káva nescafé gold'],
    polozky: [
      { popis: 'Zošit Herlitz 524', sadzbaDph: 23, suma: 0.4 },
      { popis: 'Káva NESCAFÉ GOLD instantná 200 g', sadzbaDph: 19, suma: 12.49 },
    ],
  };

  const navrhDokladu = async (database: TestDatabase, documentId: string) => (
    await database.query<Record<string, any>>(
      `SELECT predkontacia_id, clenenie_dph_id, clenenie_kv_kod, riadky
         FROM accounting_suggestions WHERE document_id=$1`,
      [documentId],
    )).rows[0];

  it('prepíše členenie hlavičky, a riadky ju zdedia už bez odpočtu', async () => {
    const database = await createTestDatabase();
    databases.push(database);
    const seeded = await seedTestUser(database);
    const kde = [seeded.tenantId, seeded.organizationId];
    await ciselnik(database, kde);
    await historia(database, kde);
    const documentId = await doklad(database, kde);

    const parser = {
      create: vi.fn().mockResolvedValue(aiOdpoved({
        predkontaciaId: repre, clenenieDphId: dphPd, clenenieKvKod: 'KN',
        ciselnyRadId: null, confidence: 0.9, reason: 'Kancelárske potreby s reprezentáciou',
        riadky: [{ index: 0, predkontaciaId: kancelarske, clenenieDphId: dphPd, clenenieKvKod: 'B2' }],
      })),
    };
    const input = { tenantId: seeded.tenantId, organizationId: seeded.organizationId, documentId, supplierName: 'Print-Office s.r.o.' };
    // Vysvetlenie nakešované k predošlému (deterministickému) návrhu.
    await database.query(
      `INSERT INTO accounting_suggestions (document_id,tenant_id,organization_id,source,confidence,reason,vysvetlenia)
       VALUES ($1,$2,$3,'organization_default',0.5,'Predvoľba.','{"dph":{"text":"staré","zdroje":[]}}'::jsonb)`,
      [documentId, seeded.tenantId, seeded.organizationId],
    );
    expect(await maybeAiAccountingSuggestion(database, testConfig(), input, kontext, parser)).toBe(true);

    const navrh = await navrhDokladu(database, documentId);
    expect(navrh.predkontacia_id).toBe(repre);
    expect(navrh.clenenie_dph_id).toBe(dphPn);
    expect(navrh.clenenie_kv_kod).toBe('KN');

    // Stopa hovorí, čo vybral model a kto to zmenil — „Prečo" to potom
    // vysvetlí bez ďalšieho volania modelu. Staré vysvetlenie k novému návrhu nepatrí.
    const stopa = (await database.query<Record<string, any>>(
      `SELECT t.model, t.odpoved, t.zmeny, t.istota, s.vysvetlenia
         FROM accounting_suggestions s JOIN ucto_navrh_stopa t ON t.id::text=s.stopa_id WHERE s.document_id=$1`,
      [documentId],
    )).rows[0];
    expect(stopa.vysvetlenia).toBeNull();
    expect(stopa.model).toBe(testConfig().openai.accountingModel);
    expect(stopa.odpoved).toMatchObject({ predkontaciaId: repre, clenenieDphId: dphPd, clenenieKvKod: 'KN' });
    expect(stopa.zmeny).toContainEqual({ pole: 'clenenieDphId', z: dphPd, na: dphPn, dovod: 'ucet_bez_odpoctu' });
    expect(stopa.istota).toMatchObject({ modelu: 0.9, strop: expect.any(Number), dovod: expect.any(String) });
  }, 90_000);

  // Sekcia B2 patrila odpočtovému členeniu, ktoré model vybral. Keď ho účet
  // prepíše na členenie bez nároku, B2 ostala visieť: hlavička PN / B2 bez
  // jediného odpočtu. Sekcia sa preto určí nanovo podľa praxe nového členenia.
  it('po prepise na členenie bez nároku neostane v hlavičke sekcia B2 modelu', async () => {
    const database = await createTestDatabase();
    databases.push(database);
    const seeded = await seedTestUser(database);
    const kde = [seeded.tenantId, seeded.organizationId];
    await ciselnik(database, kde);
    await historia(database, kde);
    const documentId = await doklad(database, kde);

    const parser = {
      create: vi.fn().mockResolvedValue(aiOdpoved({
        predkontaciaId: repre, clenenieDphId: dphPd, clenenieKvKod: 'B2',
        ciselnyRadId: null, confidence: 0.9, reason: 'Reprezentácia',
      })),
    };
    const input = { tenantId: seeded.tenantId, organizationId: seeded.organizationId, documentId, supplierName: 'Print-Office s.r.o.' };
    expect(await maybeAiAccountingSuggestion(database, testConfig(), input, kontext, parser)).toBe(true);

    const navrh = await navrhDokladu(database, documentId);
    expect(navrh.clenenie_dph_id).toBe(dphPn);
    expect(navrh.clenenie_kv_kod).toBe('KN');
    const stopa = (await database.query<Record<string, any>>(
      `SELECT t.zmeny FROM accounting_suggestions s JOIN ucto_navrh_stopa t ON t.id::text=s.stopa_id WHERE s.document_id=$1`,
      [documentId],
    )).rows[0];
    expect(stopa.zmeny).toContainEqual({ pole: 'clenenieKvKod', z: 'B2', na: 'KN', dovod: 'kv_bez_odpoctu' });
  }, 90_000);

  // To isté, keď členenie bez nároku vybral model sám alebo ho dalo iné
  // pravidlo (členenie podľa účtu): sekcia B2 k nemu nepatrí, kým ju firma pri
  // tom členení naozaj nepoužíva. ROFA: repre / PN / B2 bez jediného odpočtu.
  it('členenie bez nároku v hlavičke nedostane sekciu B2 modelu, ak ju firma pri ňom nepoužíva', async () => {
    const database = await createTestDatabase();
    databases.push(database);
    const seeded = await seedTestUser(database);
    const kde = [seeded.tenantId, seeded.organizationId];
    await ciselnik(database, kde);
    await historia(database, kde);
    const documentId = await doklad(database, kde);

    const parser = {
      create: vi.fn().mockResolvedValue(aiOdpoved({
        predkontaciaId: repre, clenenieDphId: dphPn, clenenieKvKod: 'B2',
        ciselnyRadId: null, confidence: 0.9, reason: 'Reprezentácia',
      })),
    };
    const input = { tenantId: seeded.tenantId, organizationId: seeded.organizationId, documentId, supplierName: 'Print-Office s.r.o.' };
    expect(await maybeAiAccountingSuggestion(database, testConfig(), input, kontext, parser)).toBe(true);

    const navrh = await navrhDokladu(database, documentId);
    expect(navrh.clenenie_dph_id).toBe(dphPn);
    expect(navrh.clenenie_kv_kod).toBe('KN');
  }, 90_000);

  it('prepíše členenie riadku, aj keď hlavička odpočet uplatňuje', async () => {
    const database = await createTestDatabase();
    databases.push(database);
    const seeded = await seedTestUser(database);
    const kde = [seeded.tenantId, seeded.organizationId];
    await ciselnik(database, kde);
    await historia(database, kde);
    const documentId = await doklad(database, kde);

    const parser = {
      create: vi.fn().mockResolvedValue(aiOdpoved({
        predkontaciaId: kancelarske, clenenieDphId: dphPd, clenenieKvKod: 'B2',
        ciselnyRadId: null, confidence: 0.9, reason: 'Kancelárske potreby',
        // Účet reprezentácie model trafil, daňový režim k nemu nie.
        riadky: [{ index: 1, predkontaciaId: repre, clenenieDphId: dphPd, clenenieKvKod: 'B2' }],
      })),
    };
    const input = { tenantId: seeded.tenantId, organizationId: seeded.organizationId, documentId, supplierName: 'Print-Office s.r.o.' };
    expect(await maybeAiAccountingSuggestion(database, testConfig(), input, kontext, parser)).toBe(true);

    const navrh = await navrhDokladu(database, documentId);
    // Hlavička je v poriadku a ostáva, opravuje sa len riadok.
    expect(navrh.clenenie_dph_id).toBe(dphPd);
    expect(navrh.riadky).toEqual([{
      index: 1, popis: 'Káva NESCAFÉ GOLD instantná 200 g',
      predkontaciaId: repre, clenenieDphId: dphPn,
    }]);
    // Stopa nesie aj zmeny na riadku — s indexom položky, aby ich „Prečo"
    // nepriradilo hlavičke.
    const zmeny = (await database.query<Record<string, any>>(
      `SELECT t.zmeny FROM accounting_suggestions s JOIN ucto_navrh_stopa t ON t.id::text=s.stopa_id WHERE s.document_id=$1`,
      [documentId],
    )).rows[0].zmeny;
    expect(zmeny).toContainEqual({ pole: 'clenenieDphId', index: 1, z: dphPd, na: dphPn, dovod: 'ucet_bez_odpoctu' });
    // Sekcia riadku sa nemení: dedí B2 hlavičky, ako mala od modelu.
    expect(zmeny.some((zmena: { pole: string; index?: number }) => zmena.pole === 'clenenieKvKod' && zmena.index === 1)).toBe(false);
    expect(zmeny.filter((zmena: { index?: number }) => zmena.index === undefined)).toEqual([]);
  }, 90_000);

  // Hlavička PD, no každá položka prešla na účet bez odpočtu: na doklade sa
  // neodpočítava nič a do B2 nepatrí — POHODA by ho vykázala celý bez odpočtu.
  it('doklad, na ktorom po riadkoch neostal odpočet, ide do KN celý', async () => {
    const database = await createTestDatabase();
    databases.push(database);
    const seeded = await seedTestUser(database);
    const kde = [seeded.tenantId, seeded.organizationId];
    await ciselnik(database, kde);
    await historia(database, kde);
    const documentId = await doklad(database, kde);
    const parser = {
      create: vi.fn().mockResolvedValue(aiOdpoved({
        predkontaciaId: kancelarske, clenenieDphId: dphPd, clenenieKvKod: 'B2',
        ciselnyRadId: null, confidence: 0.9, reason: 'Pohostenie',
        riadky: [
          { index: 0, predkontaciaId: repre, clenenieDphId: dphPd, clenenieKvKod: 'B2' },
          { index: 1, predkontaciaId: repre, clenenieDphId: dphPd, clenenieKvKod: 'B2' },
        ],
      })),
    };
    const input = { tenantId: seeded.tenantId, organizationId: seeded.organizationId, documentId, supplierName: 'Print-Office s.r.o.' };
    expect(await maybeAiAccountingSuggestion(database, testConfig(), input, kontext, parser)).toBe(true);

    const navrh = await navrhDokladu(database, documentId);
    expect(navrh.clenenie_kv_kod).toBe('KN');
    expect((navrh.riadky as Array<Record<string, unknown>>).map((riadok) => [riadok.clenenieDphId, riadok.clenenieKvKod]))
      .toEqual([[dphPn, undefined], [dphPn, undefined]]);
  }, 90_000);

  // Sekcia KV patrí dokladu, nie riadku. Faktúra, z ktorej sa aspoň časť
  // odpočítava, ide do B2 celá — aj so základom a daňou položky bez nároku.
  // Do KN patrí len položka bez dane. Tak účtujú všetky firmy v histórii
  // (riadky PN s DPH pod hlavičkou PD/B2 majú B2, riadky bez DPH KN).
  it('riadok bez nároku s DPH dedí sekciu dokladu, riadok bez dane ide do KN', async () => {
    const database = await createTestDatabase();
    databases.push(database);
    const seeded = await seedTestUser(database);
    const kde = [seeded.tenantId, seeded.organizationId];
    await ciselnik(database, kde);
    await historia(database, kde);
    const documentId = await doklad(database, kde);
    const parser = {
      create: vi.fn().mockResolvedValue(aiOdpoved({
        predkontaciaId: kancelarske, clenenieDphId: dphPd, clenenieKvKod: 'B2',
        ciselnyRadId: null, confidence: 0.9, reason: 'Kancelárske potreby s pohostením',
        riadky: [
          { index: 1, predkontaciaId: repre, clenenieDphId: dphPd, clenenieKvKod: 'B2' },
          { index: 2, predkontaciaId: repre, clenenieDphId: dphPd, clenenieKvKod: 'B2' },
        ],
      })),
    };
    const input = { tenantId: seeded.tenantId, organizationId: seeded.organizationId, documentId, supplierName: 'Print-Office s.r.o.' };
    expect(await maybeAiAccountingSuggestion(database, testConfig(), input, {
      ...kontext,
      lineDescriptions: [...kontext.lineDescriptions, 'vratný obal'],
      polozky: [...kontext.polozky, { popis: 'Vratný obal', sadzbaDph: 0, suma: 0.5 }],
    }, parser)).toBe(true);

    const navrh = await navrhDokladu(database, documentId);
    expect(navrh.riadky).toEqual([
      { index: 1, popis: 'Káva NESCAFÉ GOLD instantná 200 g', predkontaciaId: repre, clenenieDphId: dphPn },
      { index: 2, popis: 'Vratný obal', predkontaciaId: repre, clenenieDphId: dphPn, clenenieKvKod: 'KN' },
    ]);
  }, 90_000);

  // Dobropis z roku 2026 k plneniu z roku 2024 nesie pôvodných 20 %. Sadzba sa
  // posudzovala dňom dobropisu, kde 20 % slovenská nie je, a riadok s daňou
  // odišiel do KN — z opravy vo výkaze ostala len časť.
  it('dobropis posúdi slovenskú sadzbu dňom pôvodného plnenia', async () => {
    const database = await createTestDatabase();
    databases.push(database);
    const seeded = await seedTestUser(database);
    const kde = [seeded.tenantId, seeded.organizationId];
    await ciselnik(database, kde);
    await historia(database, kde);
    const riadokDobropisu = async (povodnyDoklad?: { cislo: string; datumPlnenia: string }) => {
      const documentId = await doklad(database, kde);
      await database.query(`UPDATE documents SET podtyp='dobropis', extracted=$2::jsonb WHERE id=$1`, [documentId,
        JSON.stringify({ datumVystavenia: '2026-03-10', datumDodania: '2026-03-10', ...(povodnyDoklad ? { povodnyDoklad } : {}) })]);
      const parser = {
        create: vi.fn().mockResolvedValue(aiOdpoved({
          predkontaciaId: kancelarske, clenenieDphId: dphPd, clenenieKvKod: 'C2',
          ciselnyRadId: null, confidence: 0.9, reason: 'Dobropis kancelárskych potrieb s pohostením',
          riadky: [{ index: 1, predkontaciaId: repre, clenenieDphId: dphPd, clenenieKvKod: 'C2' }],
        })),
      };
      const input = { tenantId: seeded.tenantId, organizationId: seeded.organizationId, documentId, supplierName: 'Print-Office s.r.o.' };
      expect(await maybeAiAccountingSuggestion(database, testConfig(), input, {
        ...kontext,
        podtyp: 'dobropis',
        polozky: [kontext.polozky[0], { ...kontext.polozky[1], sadzbaDph: 20 }],
      }, parser)).toBe(true);
      return (await navrhDokladu(database, documentId)).riadky[0];
    };

    // Riadok bez nároku s daňou dedí sekciu opravy dokladu.
    expect(await riadokDobropisu({ cislo: '24FP118', datumPlnenia: '2024-11-20' })).toEqual({
      index: 1, popis: 'Káva NESCAFÉ GOLD instantná 200 g', predkontaciaId: repre, clenenieDphId: dphPn,
    });
    // Bez pôvodného plnenia rozhoduje deň dobropisu ako doteraz: 20 % v roku 2026 nie je slovenská sadzba.
    expect(await riadokDobropisu()).toMatchObject({ predkontaciaId: repre, clenenieDphId: dphPn, clenenieKvKod: 'KN' });
  }, 90_000);

  // Stopa pribúdala riadkom za každé volanie modelu a nikto ju nemazal. Staré
  // stopy dokladu sa zmažú — okrem tej, na ktorú ukazuje zapísaná oprava.
  it('nechá len aktuálnu stopu dokladu a stopu, na ktorú ukazuje oprava', async () => {
    const database = await createTestDatabase();
    databases.push(database);
    const seeded = await seedTestUser(database);
    const kde = [seeded.tenantId, seeded.organizationId];
    await ciselnik(database, kde);
    await historia(database, kde);
    const documentId = await doklad(database, kde);
    const parser = {
      create: vi.fn().mockResolvedValue(aiOdpoved({
        predkontaciaId: kancelarske, clenenieDphId: dphPd, clenenieKvKod: 'B2',
        ciselnyRadId: null, confidence: 0.9, reason: 'Kancelárske potreby',
      })),
    };
    const input = { tenantId: seeded.tenantId, organizationId: seeded.organizationId, documentId, supplierName: 'Print-Office s.r.o.' };
    const stopy = async () => (await database.query<{ id: string }>(
      'SELECT id::text AS id FROM ucto_navrh_stopa WHERE document_id=$1 ORDER BY created_at', [documentId])).rows.map((row) => row.id);

    expect(await maybeAiAccountingSuggestion(database, testConfig(), input, kontext, parser)).toBe(true);
    const [prva] = await stopy();
    await database.query(
      `INSERT INTO ucto_opravy (id,tenant_id,organization_id,document_id,navrhnute,schvalene,zmenene,stopa_id)
       VALUES ($1,$2,$3,$4,'{}'::jsonb,'{}'::jsonb,'{}'::text[],$5)`,
      [randomUUID(), ...kde, documentId, prva],
    );
    expect(await maybeAiAccountingSuggestion(database, testConfig(), input, kontext, parser)).toBe(true);
    expect(await maybeAiAccountingSuggestion(database, testConfig(), input, kontext, parser)).toBe(true);
    const aktualna = (await database.query<{ stopa_id: string }>(
      'SELECT stopa_id FROM accounting_suggestions WHERE document_id=$1', [documentId])).rows[0].stopa_id;
    expect((await stopy()).sort()).toEqual([prva, aktualna].sort());
  }, 90_000);

  // Zberný účet služieb nesie oba režimy: 518100 ost.sl. má u ALPINY jednu
  // nedaňovú položku z ôsmich, 518-nájom ťah jedenásť z dvadsiatich deviatich.
  // Kým stačil VÝSKYT troch nedaňových dokladov, oba prepadli ako neodpočtové
  // a faktúry PACCAR, ACCONTI aj Wabez prišli o odpočet, ktorý im patrí.
  it('účet, na ktorom firma väčšinou odpočítava, odpočet nestratí', async () => {
    const database = await createTestDatabase();
    databases.push(database);
    const seeded = await seedTestUser(database);
    const kde = [seeded.tenantId, seeded.organizationId];
    await ciselnik(database, kde);
    const documentId = await doklad(database, kde);

    const riadok = async (cislo: string, index: number, clenenie: string, clenenieId: string, kv: string) =>
      database.query(
        `INSERT INTO ucto_historia
          (id,tenant_id,organization_id,agenda,doklad_cislo,datum,supplier_name_normalized,
           line_text_normalized,predkontacia_kod,predkontacia_id,clenenie_dph_kod,clenenie_dph_id,
           clenenie_kv_kod,riadok_index,source,riadok_hash)
         VALUES ($1,$2,$3,'FP',$4,'2026-05-10','ktokoľvek','sluzba','kancelár.potreby',$5,$6,$7,$8,$9,'mdb',$10)`,
        [randomUUID(), ...kde, cislo, kancelarske, clenenie, clenenieId, kv, index, randomUUID()],
      );
    // Dvadsať dokladov s odpočtom proti štyrom bez neho: nedaňové prekročia
    // hranicu troch dokladov, prevahu na účte však nemajú ani zďaleka.
    for (let poradie = 0; poradie < 20; poradie += 1) {
      await riadok(`26FP5${poradie}`, 0, 'PD', dphPd, 'B2');
      await riadok(`26FP5${poradie}`, 1, 'PD', dphPd, 'B2');
    }
    for (let poradie = 0; poradie < 4; poradie += 1) {
      await riadok(`26FP6${poradie}`, 0, 'PD', dphPd, 'B2');
      await riadok(`26FP6${poradie}`, 1, 'PN', dphPn, 'KN');
    }

    const parser = {
      create: vi.fn().mockResolvedValue(aiOdpoved({
        predkontaciaId: kancelarske, clenenieDphId: dphPd, clenenieKvKod: 'B2',
        ciselnyRadId: null, confidence: 0.9, reason: 'Bežná služba', riadky: null,
      })),
    };
    const input = { tenantId: seeded.tenantId, organizationId: seeded.organizationId, documentId, supplierName: 'Ktokoľvek s.r.o.' };
    expect(await maybeAiAccountingSuggestion(database, testConfig(), input, kontext, parser)).toBe(true);

    const navrh = await navrhDokladu(database, documentId);
    expect(navrh.clenenie_dph_id).toBe(dphPd);
    expect(navrh.clenenie_kv_kod).toBe('B2');
  }, 90_000);

  it('rozpor „odpočet + KN" rozhodne v prospech neodpočtu aj bez histórie', async () => {
    const database = await createTestDatabase();
    databases.push(database);
    const seeded = await seedTestUser(database);
    const kde = [seeded.tenantId, seeded.organizationId];
    await ciselnik(database, kde);
    const documentId = await doklad(database, kde);

    const parser = {
      create: vi.fn().mockResolvedValue(aiOdpoved({
        predkontaciaId: repre, clenenieDphId: dphPd, clenenieKvKod: 'KN',
        ciselnyRadId: null, confidence: 0.9, reason: 'Reprezentácia', riadky: null,
      })),
    };
    const input = { tenantId: seeded.tenantId, organizationId: seeded.organizationId, documentId, supplierName: 'Print-Office s.r.o.' };
    expect(await maybeAiAccountingSuggestion(database, testConfig(), input, kontext, parser)).toBe(true);

    const navrh = await navrhDokladu(database, documentId);
    expect(navrh.clenenie_dph_id).toBe(dphPn);
    expect(navrh.clenenie_kv_kod).toBe('KN');
  }, 90_000);

  // Dovoz tovaru: daň sa platí colnému úradu a odpočítava sa z colného
  // rozhodnutia, ktoré do kontrolného výkazu nepatrí. PDtovar s KN je teda
  // zákonná dvojica (v knihách klientov 9 hlavičiek OZ) — odpočet sa rušiť nesmie.
  it('dovoz tovaru s KN si odpočet ponechá', async () => {
    const database = await createTestDatabase();
    databases.push(database);
    const seeded = await seedTestUser(database);
    const kde = [seeded.tenantId, seeded.organizationId];
    await ciselnik(database, kde);
    const dphTovar = randomUUID();
    await database.query(
      `INSERT INTO code_list_items (id,tenant_id,organization_id,kind,code,name,source)
       VALUES ($1,$2,$3,'cleneniaDph','PDtovar','Dovoz tovaru','pohoda')`,
      [dphTovar, ...kde],
    );
    const documentId = randomUUID();
    await database.query(
      `INSERT INTO documents (id,tenant_id,organization_id,document_type,status,processing_status,extracted,accounting,total_amount,currency)
       VALUES ($1,$2,$3,'OZ','na_kontrole','ready_for_review','{}'::jsonb,'{}'::jsonb,170.65,'EUR')`,
      [documentId, ...kde],
    );

    const parser = {
      create: vi.fn().mockResolvedValue(aiOdpoved({
        predkontaciaId: kancelarske, clenenieDphId: dphTovar, clenenieKvKod: 'KN',
        ciselnyRadId: null, confidence: 0.9, reason: 'Colné rozhodnutie', riadky: null,
      })),
    };
    const input = { tenantId: seeded.tenantId, organizationId: seeded.organizationId, documentId, supplierName: 'Colný úrad Bratislava' };
    expect(await maybeAiAccountingSuggestion(database, testConfig(), input,
      { ...kontext, documentType: 'OZ', supplierName: 'Colný úrad Bratislava' }, parser)).toBe(true);

    const navrh = await navrhDokladu(database, documentId);
    expect(navrh.clenenie_dph_id).toBe(dphTovar);
    expect(navrh.clenenie_kv_kod).toBe('KN');
  }, 90_000);
});

// Položka, ktorú účtovník nechal tak, dedí v POHODE kódy hlavičky a import ich
// zapíše na riadok (uctoHistoriaXml). V korpuse sa potom tvári ako rozhodnutie
// o tej položke. Presne tak sa „kuchynské utierky" dostali na účet
// reprezentácie: jediný riadok, ktorý o nich korpus mal, zdedil hlavičku repre
// z faktúry DF260134 — a model ho poslušne zopakoval („pri kuchynských
// utierkach zachovávam históriu", zo skutočného návrhu).
describe('riadok histórie, ktorý zaúčtovanie iba zdedil', () => {
  it('označí sa ako zdedený a doklad nepredvyplní', async () => {
    const database = await createTestDatabase();
    databases.push(database);
    const seeded = await seedTestUser(database);
    const kde = [seeded.tenantId, seeded.organizationId];

    const repre = randomUUID();
    const kancelarske = randomUUID();
    for (const [id, kod, ucet] of [[repre, 'repre', '513100'], [kancelarske, 'kancelár.potreby', '501400']] as const) {
      await database.query(
        `INSERT INTO code_list_items (id,tenant_id,organization_id,kind,code,name,source,ucet_md,ucet_dal)
         VALUES ($1,$2,$3,'predkontacie',$4,$4,'pohoda',$5,'321100')`,
        [id, ...kde, kod, ucet],
      );
    }
    const dphPd = randomUUID();
    const dphPn = randomUUID();
    for (const [id, kod, nazov] of [
      [dphPd, 'PD', 'Tuzemské plnenia'], [dphPn, 'PN', 'Nezahrňovať do priznania DPH'],
    ] as const) {
      await database.query(
        `INSERT INTO code_list_items (id,tenant_id,organization_id,kind,code,name,source)
         VALUES ($1,$2,$3,'cleneniaDph',$4,$5,'pohoda')`,
        [id, ...kde, kod, nazov],
      );
    }

    // Tri faktúry rovnakého tvaru: hlavička kancelárske potreby, voda prenesená
    // na reprezentáciu (rozhodnutie) a utierky ponechané na hlavičke (dedenie).
    for (const cislo of ['26FP401', '26FP402', '26FP403']) {
      for (const [index, text, ucet, predkontaciaId, clenenie, clenenieId, kv] of [
        [0, 'kancelárske a hygienické potreby', 'kancelár.potreby', kancelarske, 'PD', dphPd, 'B2'],
        [1, 'pramenitá voda rajec jemne sýtená 12 x 0,5 l', 'repre', repre, 'PN', dphPn, 'KN'],
        [2, 'kuchynské utierky 3-vrstvové harmony professional', 'kancelár.potreby', kancelarske, 'PD', dphPd, 'B2'],
      ] as const) {
        await database.query(
          `INSERT INTO ucto_historia
            (id,tenant_id,organization_id,agenda,doklad_cislo,datum,supplier_name_normalized,
             line_text_normalized,predkontacia_kod,predkontacia_id,clenenie_dph_kod,clenenie_dph_id,
             clenenie_kv_kod,riadok_index,source,riadok_hash)
           VALUES ($1,$2,$3,'FP',$4,'2026-05-10','print office',$5,$6,$7,$8,$9,$10,$11,'mdb',$12)`,
          [randomUUID(), ...kde, cislo, text, ucet, predkontaciaId, clenenie, clenenieId, kv, index, randomUUID()],
        );
      }
    }

    const documentId = randomUUID();
    await database.query(
      `INSERT INTO documents (id,tenant_id,organization_id,document_type,status,processing_status,extracted,accounting,total_amount,currency)
       VALUES ($1,$2,$3,'FP','na_kontrole','ready_for_review','{}'::jsonb,'{}'::jsonb,18.40,'EUR')`,
      [documentId, ...kde],
    );

    const parser = {
      create: vi.fn().mockResolvedValue(aiOdpoved({
        predkontaciaId: kancelarske, clenenieDphId: dphPd, clenenieKvKod: 'B2',
        ciselnyRadId: null, confidence: 0.9, reason: 'Podľa denníka', riadky: null,
      })),
    };
    const input = { tenantId: seeded.tenantId, organizationId: seeded.organizationId, documentId, supplierName: 'Print-Office s.r.o.' };
    const context = {
      documentType: 'FP', supplierName: 'Print-Office s.r.o.', totalAmount: 18.4, currency: 'EUR',
      lineDescriptions: ['Kuchynské utierky 3-vrstvové HARMONY Professional'],
      polozky: [{ popis: 'Kuchynské utierky 3-vrstvové HARMONY Professional', sadzbaDph: 23, suma: 14.96 }],
    };
    expect(await maybeAiAccountingSuggestion(database, testConfig(), input, context, parser)).toBe(true);

    const payload = JSON.parse((parser.create.mock.calls[0][0] as any).input[0].content[0].text);
    const utierky = payload.dennik.find((riadok: any) => String(riadok.text).includes('utierky'));
    const voda = payload.dennik.find((riadok: any) => String(riadok.text).includes('voda'));
    expect(utierky.zdedene).toBe(true);
    // Voda sa od hlavičky líši účtom aj režimom — to účtovník naozaj rozhodol.
    expect(voda.zdedene).toBeUndefined();

    // A zdedený riadok nesmie doklad predvyplniť: strop istoty ostáva na 0.8,
    // teda pod hranicou 0.9, a doklad otvorí účtovník.
    const navrh = (await database.query<Record<string, any>>(
      'SELECT confidence FROM accounting_suggestions WHERE document_id=$1', [documentId],
    )).rows[0];
    expect(Number(navrh.confidence)).toBe(0.8);
  }, 90_000);
});

// Rad podľa protistrany platí až od troch dokladov. U nového dodávateľa
// rozhodoval posledný krok — rad s najvyšším číslom — a ten o tuzemsku nevie
// nič: slovenská faktúra od Mgr. Saliniovej (2 doklady v korpuse) dostala
// ZF260415, teda rad, ktorý firma sama nazvala zahraničným.
describe('číselný rad nového dodávateľa podľa krajiny', () => {
  type TestDatabase = Awaited<ReturnType<typeof createTestDatabase>>;
  const df = randomUUID();
  const zf = randomUUID();
  const pred = randomUUID();

  const pripravit = async (database: TestDatabase, kde: string[], posledne: [string, string]) => {
    await database.query(
      `INSERT INTO code_list_items (id,tenant_id,organization_id,kind,code,name,source,ucet_md,ucet_dal)
       VALUES ($1,$2,$3,'predkontacie','518100','518100 ost.sl.','pohoda','518100','321100')`,
      [pred, ...kde],
    );
    for (const [id, kod, nazov, last] of [
      [df, 'DF260', 'Prijaté faktúry SK', posledne[0]],
      [zf, 'ZF260', 'Prijaté faktúry zahraničné', posledne[1]],
    ] as const) {
      await database.query(
        `INSERT INTO code_list_items (id,tenant_id,organization_id,kind,code,name,source,agenda,last_number)
         VALUES ($1,$2,$3,'ciselneRady',$4,$5,'pohoda','prijate_faktury',$6)`,
        [id, ...kde, kod, nazov, last],
      );
    }
    const documentId = randomUUID();
    await database.query(
      `INSERT INTO documents (id,tenant_id,organization_id,document_type,status,processing_status,extracted,accounting,total_amount,currency)
       VALUES ($1,$2,$3,'FP','na_kontrole','ready_for_review','{}'::jsonb,'{}'::jsonb,90,'EUR')`,
      [documentId, ...kde],
    );
    return documentId;
  };

  const radDokladu = async (database: TestDatabase, documentId: string) => (
    await database.query<Record<string, any>>(
      'SELECT ciselny_rad_id FROM accounting_suggestions WHERE document_id=$1', [documentId],
    )).rows[0]?.ciselny_rad_id;

  const parser = () => ({
    // Rad model nevyberá — určuje ho nastavenie firmy, nie úsudok AI.
    create: vi.fn().mockResolvedValue(aiOdpoved({
      predkontaciaId: pred, clenenieDphId: null, clenenieKvKod: null,
      ciselnyRadId: null, confidence: 0.8, reason: 'Preklad', riadky: null,
    })),
  });

  it('slovenský dodávateľ nedostane zahraničný rad ani keď má vyššie číslo', async () => {
    const database = await createTestDatabase();
    databases.push(database);
    const seeded = await seedTestUser(database);
    const kde = [seeded.tenantId, seeded.organizationId];
    // Presne stav ALPINY: zahraničný rad je ďalej (414 proti 209).
    const documentId = await pripravit(database, kde, ['DF260209', 'ZF260414']);

    const input = { tenantId: seeded.tenantId, organizationId: seeded.organizationId, documentId, supplierName: 'Mgr. Ida Saliniová' };
    const context = {
      documentType: 'FP', supplierName: 'Mgr. Ida Saliniová', supplierIco: '17851289',
      supplierKrajina: 'SK', datumVystavenia: '2026-07-21', totalAmount: 90, currency: 'EUR',
      lineDescriptions: ['Preklad - 6 normostrán'],
    };
    expect(await maybeAiAccountingSuggestion(database, testConfig(), input, context, parser())).toBe(true);
    expect(await radDokladu(database, documentId)).toBe(df);
  }, 90_000);

  it('zahraničný dodávateľ dostane zahraničný rad ani keď má nižšie číslo', async () => {
    const database = await createTestDatabase();
    databases.push(database);
    const seeded = await seedTestUser(database);
    const kde = [seeded.tenantId, seeded.organizationId];
    // Opačne než vyššie: bez krajiny by vyhral tuzemský rad.
    const documentId = await pripravit(database, kde, ['DF260900', 'ZF260010']);

    const input = { tenantId: seeded.tenantId, organizationId: seeded.organizationId, documentId, supplierName: 'Q8Truck' };
    const context = {
      documentType: 'FP', supplierName: 'Q8Truck', supplierKrajina: 'IT',
      datumVystavenia: '2026-07-21', totalAmount: 90, currency: 'EUR',
      lineDescriptions: ['pedaggio'],
    };
    expect(await maybeAiAccountingSuggestion(database, testConfig(), input, context, parser())).toBe(true);
    expect(await radDokladu(database, documentId)).toBe(zf);
  }, 90_000);
});

// Delenie PHM nie je vec jednej firmy ani jej histórie. Zákon dáva firme na
// výber (§ 19 ods. 2 písm. l) ZDP: paušál 80 %, kniha jázd, alebo 100 %
// služobne) a ktoré vozidlo jazdí aj súkromne, na faktúre nestojí — dve firmy
// s tou istou faktúrou účtujú inak a obe správne. Preto to nie je odhad
// z histórie, ale nastavenie klienta, ktoré platí od PRVÉHO dokladu.
describe('rozrezanie podľa pravidla pre autá z profilu klienta', () => {
  const rezPhm = async (pravidloNavyse: Record<string, unknown>, extracted: Record<string, unknown>) => {
    const database = await createTestDatabase();
    databases.push(database);
    const seeded = await seedTestUser(database);
    const kde = [seeded.tenantId, seeded.organizationId];

    const phm = randomUUID();
    const nadspotreba = randomUUID();
    for (const [id, kod, ucet] of [
      [phm, 'PHM-501200', '501200'], [nadspotreba, 'PHM-Nadspotreba', '501201'],
    ] as const) {
      await database.query(
        `INSERT INTO code_list_items (id,tenant_id,organization_id,kind,code,name,source,ucet_md,ucet_dal)
         VALUES ($1,$2,$3,'predkontacie',$4,$4,'pohoda',$5,'321100')`,
        [id, ...kde, kod, ucet],
      );
    }
    const dphPd = randomUUID();
    const dphPn = randomUUID();
    for (const [id, kod, nazov] of [
      [dphPd, 'PD', 'Tuzemské plnenia'], [dphPn, 'PN', 'Nezahrňovať do priznania DPH'],
    ] as const) {
      await database.query(
        `INSERT INTO code_list_items (id,tenant_id,organization_id,kind,code,name,source)
         VALUES ($1,$2,$3,'cleneniaDph',$4,$5,'pohoda')`,
        [id, ...kde, kod, nazov],
      );
    }
    // Nastavenie klienta: základ 80/20, daň 50/50 (od 2026 § 85n), oba účty.
    await database.query(
      `INSERT INTO organization_dph_profiles (organization_id,tenant_id,pravidla_aut)
       VALUES ($2,$1,$3::jsonb)`,
      [seeded.tenantId, seeded.organizationId, JSON.stringify([{
        kategoria: 'Osobné auto', percento: 80, percentoDph: 50,
        klucoveSlova: ['natural 95', 'premiová nafta'],
        predkontaciaId: phm, predkontaciaNedanovaId: nadspotreba, clenenieDphNedanoveId: dphPn,
        ...pravidloNavyse,
      }])],
    );

    const documentId = randomUUID();
    await database.query(
      `INSERT INTO documents (id,tenant_id,organization_id,document_type,status,processing_status,extracted,accounting,total_amount,currency)
       VALUES ($1,$2,$3,'FP','na_kontrole','ready_for_review',$4::jsonb,'{}'::jsonb,270,'EUR')`,
      [documentId, ...kde, JSON.stringify(extracted)],
    );

    const parser = {
      // Model o delení nevie nič a priradí všetko na jeden účet — nastavenie
      // klienta ho na tých položkách prebije.
      create: vi.fn().mockResolvedValue(aiOdpoved({
        predkontaciaId: phm, clenenieDphId: dphPd, clenenieKvKod: 'B2',
        ciselnyRadId: null, confidence: 0.8, reason: 'Palivo', riadky: null,
      })),
    };
    const input = { tenantId: seeded.tenantId, organizationId: seeded.organizationId, documentId, supplierName: 'Nová čerpacia karta s.r.o.' };
    const context = {
      documentType: 'FP', supplierName: 'Nová čerpacia karta s.r.o.', totalAmount: 270, currency: 'EUR',
      lineDescriptions: ['Natural 95', 'Premiová nafta', 'Nafta'],
      polozky: [
        { popis: 'Natural 95', sadzbaDph: 23, suma: 69.4 },
        { popis: 'Premiová nafta', sadzbaDph: 23, suma: 100.01 },
        { popis: 'Nafta', sadzbaDph: 23, suma: 100.09 },
      ],
    };
    expect(await maybeAiAccountingSuggestion(database, testConfig(), input, context, parser)).toBe(true);

    const riadky = (await database.query<Record<string, any>>(
      'SELECT riadky FROM accounting_suggestions WHERE document_id=$1', [documentId],
    )).rows[0].riadky as Array<Record<string, any>> | null;
    const zmeny = (await database.query<Record<string, any>>(
      `SELECT t.zmeny FROM accounting_suggestions s JOIN ucto_navrh_stopa t ON t.id::text=s.stopa_id WHERE s.document_id=$1`,
      [documentId],
    )).rows[0]?.zmeny as Array<Record<string, unknown>> | undefined;
    return { riadky, zmeny, phm, nadspotreba, dphPn };
  };

  it('rozreže palivo osobného auta a naftu do ťahača nechá celú', async () => {
    const { riadky: vysledok, zmeny, phm, nadspotreba, dphPn } = await rezPhm({}, {});
    const riadky = vysledok!;
    expect(zmeny).toContainEqual({ pole: 'riadok', index: 0, z: null, na: phm, dovod: 'rez_podla_profilu' });
    expect(zmeny).toContainEqual({ pole: 'riadok', index: 1, z: null, na: phm, dovod: 'rez_podla_profilu' });
    // Dve položky × dve časti; nafta do ťahača sa nedelí a v rozpise nie je.
    expect(riadky.map((riadok) => [riadok.index, riadok.predkontaciaId, riadok.podiel, riadok.podielDph])).toEqual([
      [0, phm, 0.8, 0.5],
      [0, nadspotreba, 0.2, 0.5],
      [1, phm, 0.8, 0.5],
      [1, nadspotreba, 0.2, 0.5],
    ]);
    // Nedaňová časť má vlastné členenie, no nesie polovicu dane — faktúra ide do
    // B2 celá, sekciu dedí z hlavičky (ALPINA DF260181: 13,17 základu, 7,57 dane).
    expect(riadky[1]).toMatchObject({ clenenieDphId: dphPn });
    expect(riadky[1].clenenieKvKod).toBeUndefined();
  }, 90_000);

  // Daň 50/50 pri osobnom aute zaviedol od 1. 1. 2026 § 85n. Pravidlo s dátumom
  // platnosti nesmie rozrezať decembrové tankovanie z roku 2025.
  it('pravidlo s dátumom platnosti nereže plnenie spred neho', async () => {
    const { riadky } = await rezPhm({ platnostOd: '2026-01-01' }, { datumDodania: '2025-12-15', datumVystavenia: '2026-01-05' });
    expect((riadky ?? []).some((riadok) => riadok.podiel != null)).toBe(false);
  }, 90_000);
});

// Rozrezanie položky: rovnaký index vo viacerých riadkoch, podiely dokopy 1.
// Neúplná skupina sa zahadzuje CELÁ — jedna časť bez súrodencov by z dokladu
// odkrojila kus sumy a zvyšok by sa stratil.
describe('návrh rozrezania položky', () => {
  it('prijme skupinu, ktorá dá celok, a neúplnú zahodí', async () => {
    const database = await createTestDatabase();
    databases.push(database);
    const seeded = await seedTestUser(database);
    const kde = [seeded.tenantId, seeded.organizationId];

    const phm = randomUUID();
    const nadspotreba = randomUUID();
    for (const [id, kod, ucet] of [[phm, 'PHM-501200', '501200'], [nadspotreba, 'PHM-Nadspotreba', '501201']] as const) {
      await database.query(
        `INSERT INTO code_list_items (id,tenant_id,organization_id,kind,code,name,source,ucet_md,ucet_dal)
         VALUES ($1,$2,$3,'predkontacie',$4,$4,'pohoda',$5,'321100')`,
        [id, ...kde, kod, ucet],
      );
    }
    const dphPd = randomUUID();
    const dphPn = randomUUID();
    for (const [id, kod] of [[dphPd, 'PD'], [dphPn, 'PN']] as const) {
      await database.query(
        `INSERT INTO code_list_items (id,tenant_id,organization_id,kind,code,name,source)
         VALUES ($1,$2,$3,'cleneniaDph',$4,$4,'pohoda')`,
        [id, ...kde, kod],
      );
    }
    for (const cislo of ['26FP201', '26FP202', '26FP203']) {
      for (const ucet of ['501200', '501201', '343100']) {
        await database.query(
          `INSERT INTO ucto_dennik (id,tenant_id,organization_id,externalny_id,agenda,doklad_cislo,
             ucet_md,ucet_dal,partner_nazov)
           VALUES ($1,$2,$3,$4,'Prijaté faktúry',$5,$6,'321100','Up Déjeuner, s. r. o.')`,
          [randomUUID(), ...kde, `${cislo}-${ucet}`, cislo, ucet],
        );
      }
    }
    const documentId = randomUUID();
    await database.query(
      `INSERT INTO documents (id,tenant_id,organization_id,document_type,status,processing_status,extracted,accounting,total_amount,currency)
       VALUES ($1,$2,$3,'FP','na_kontrole','ready_for_review','{}'::jsonb,'{}'::jsonb,202.67,'EUR')`,
      [documentId, ...kde],
    );

    const parser = {
      create: vi.fn().mockResolvedValue(aiOdpoved({
        predkontaciaId: phm, clenenieDphId: dphPd, clenenieKvKod: 'B2',
        ciselnyRadId: null, confidence: 0.9, reason: 'PHM s nadspotrebou',
        riadky: [
          // Natural 95: základ 80/20, daň polovicou — auto sa používa aj súkromne.
          { index: 1, predkontaciaId: phm, clenenieDphId: dphPd, clenenieKvKod: 'B2', podiel: 0.8, podielDph: 0.5 },
          { index: 1, predkontaciaId: nadspotreba, clenenieDphId: dphPn, clenenieKvKod: null, podiel: 0.2, podielDph: 0.5 },
          // Nafta: jediná časť, súčet nedá celok — celá skupina von.
          { index: 0, predkontaciaId: nadspotreba, clenenieDphId: dphPn, clenenieKvKod: null, podiel: 0.2, podielDph: null },
          // AdBlue: jediná časť, ale skoro celá položka — to nie je rez, to je
          // 'celá položka' napísaná ako podiel. Riadok má ostať, nie vypadnúť.
          { index: 2, predkontaciaId: nadspotreba, clenenieDphId: dphPn, clenenieKvKod: null, podiel: 0.99, podielDph: null },
        ],
      })),
    };
    const input = { tenantId: seeded.tenantId, organizationId: seeded.organizationId, documentId, supplierName: 'Up Déjeuner, s. r. o.' };
    const context = {
      documentType: 'FP', supplierName: 'Up Déjeuner, s. r. o.', totalAmount: 202.67, currency: 'EUR',
      lineDescriptions: ['Nafta', 'Natural 95', 'AdBlue'],
      polozky: [{ popis: 'Nafta', sadzbaDph: 23, suma: 123.11 }, { popis: 'Natural 95', sadzbaDph: 23, suma: 81 },
        { popis: 'AdBlue', sadzbaDph: 23, suma: 20 }],
    };
    expect(await maybeAiAccountingSuggestion(database, testConfig(), input, context, parser)).toBe(true);

    const riadky = (await database.query<Record<string, any>>(
      'SELECT riadky FROM accounting_suggestions WHERE document_id=$1', [documentId],
    )).rows[0].riadky as Array<Record<string, unknown>>;
    // Ostali dve časti Naturalu; nafta s jedinou pätinovou časťou vypadla,
    // AdBlue s jedinou takmer celou ostalo — už ako celý riadok, nie ako rez.
    expect(riadky.map((riadok) => [riadok.index, riadok.podiel, riadok.podielDph])).toEqual([
      [1, 0.8, 0.5], [1, 0.2, 0.5], [2, undefined, undefined],
    ]);
    expect(riadky[1].predkontaciaId).toBe(nadspotreba);
    const zmeny = (await database.query<Record<string, any>>(
      `SELECT t.zmeny FROM accounting_suggestions s JOIN ucto_navrh_stopa t ON t.id::text=s.stopa_id WHERE s.document_id=$1`,
      [documentId],
    )).rows[0].zmeny;
    expect(zmeny).toContainEqual({ pole: 'riadok', index: 0, z: nadspotreba, na: null, dovod: 'rez_neuplny' });
  }, 90_000);

  // Súčet podielov sa overoval PRED filtrom, ktorý zahodí časť s predkontáciou
  // mimo ponuky. Skupina 0,4 + 0,3 + 0,3 tak prešla ako celok a po zahodení
  // tretej časti ostalo 0,7 — doklad ticho stratil 30 % sumy. A podiel dane sa
  // kontroloval len v súčte, takže -1 a 2 prešli a doklad dostal zápornú daň.
  it('rez s neznámou predkontáciou ani so zápornou daňou neprejde po častiach', async () => {
    const database = await createTestDatabase();
    databases.push(database);
    const seeded = await seedTestUser(database);
    const kde = [seeded.tenantId, seeded.organizationId];

    const ucet = randomUUID();
    await database.query(
      `INSERT INTO code_list_items (id,tenant_id,organization_id,kind,code,name,source,ucet_md,ucet_dal)
       VALUES ($1,$2,$3,'predkontacie','501200','501200','pohoda','501200','321100')`,
      [ucet, ...kde],
    );
    const documentId = randomUUID();
    await database.query(
      `INSERT INTO documents (id,tenant_id,organization_id,document_type,status,processing_status,extracted,accounting,total_amount,currency)
       VALUES ($1,$2,$3,'FP','na_kontrole','ready_for_review','{}'::jsonb,'{}'::jsonb,100,'EUR')`,
      [documentId, ...kde],
    );

    const parser = {
      create: vi.fn().mockResolvedValue(aiOdpoved({
        predkontaciaId: ucet, clenenieDphId: null, clenenieKvKod: null,
        ciselnyRadId: null, confidence: 0.9, reason: 'Rez',
        riadky: [
          // Položka 0: súčet dá 1, ale tretia časť má ID, ktoré v ponuke nie je.
          { index: 0, predkontaciaId: ucet, clenenieDphId: null, clenenieKvKod: null, podiel: 0.4, podielDph: 0.4 },
          { index: 0, predkontaciaId: ucet, clenenieDphId: null, clenenieKvKod: null, podiel: 0.3, podielDph: 0.3 },
          { index: 0, predkontaciaId: 'neexistujuce-id', clenenieDphId: null, clenenieKvKod: null, podiel: 0.3, podielDph: 0.3 },
          // Položka 1: podiely sedia, ale daň je -1 a 2. Súčet je jednotka.
          { index: 1, predkontaciaId: ucet, clenenieDphId: null, clenenieKvKod: null, podiel: 0.5, podielDph: -1 },
          { index: 1, predkontaciaId: ucet, clenenieDphId: null, clenenieKvKod: null, podiel: 0.5, podielDph: 2 },
        ],
      })),
    };
    const input = { tenantId: seeded.tenantId, organizationId: seeded.organizationId, documentId, supplierName: 'Test' };
    const context = {
      documentType: 'FP', supplierName: 'Test', totalAmount: 100, currency: 'EUR',
      lineDescriptions: ['Prvá', 'Druhá'],
      polozky: [{ popis: 'Prvá', sadzbaDph: 23, suma: 50 }, { popis: 'Druhá', sadzbaDph: 23, suma: 50 }],
    };
    expect(await maybeAiAccountingSuggestion(database, testConfig(), input, context, parser)).toBe(true);

    const riadky = (await database.query<Record<string, any>>(
      'SELECT riadky FROM accounting_suggestions WHERE document_id=$1', [documentId],
    )).rows[0].riadky as Array<Record<string, unknown>> | null;
    // Ani jeden rez neprejde: doklad radšej ostane nerozdelený, než rozdelený
    // na 70 % sumy alebo so zápornou daňou.
    const rezy = (riadky ?? []).filter((riadok) => riadok.podiel != null);
    expect(rezy).toEqual([]);
  }, 90_000);
});

// Sekcia KV riadku bez nároku ide s faktúrou do B2 len vtedy, keď nesie
// SLOVENSKÚ daň. Časť rezu bez podielu dane a položka s cudzou sadzbou (rakúskych
// 20 % v roku 2026) do kontrolného výkazu nepatria — ostávajú v KN.
describe('sekcia KV časti bez dane a cudzej sadzby', () => {
  it('časť rezu bez podielu dane aj položka s cudzou sadzbou ostanú v KN', async () => {
    const database = await createTestDatabase();
    databases.push(database);
    const seeded = await seedTestUser(database);
    const kde = [seeded.tenantId, seeded.organizationId];
    const [phm, nadspotreba, dphPd, dphPn] = [randomUUID(), randomUUID(), randomUUID(), randomUUID()];
    for (const [id, kod, ucet] of [[phm, 'PHM-501200', '501200'], [nadspotreba, 'PHM-Nadspotreba', '501201']] as const) {
      await database.query(
        `INSERT INTO code_list_items (id,tenant_id,organization_id,kind,code,name,source,ucet_md,ucet_dal)
         VALUES ($1,$2,$3,'predkontacie',$4,$4,'pohoda',$5,'321100')`,
        [id, ...kde, kod, ucet],
      );
    }
    for (const [id, kod, nazov] of [[dphPd, 'PD', 'Tuzemské plnenia'], [dphPn, 'PN', 'Nezahrňovať do priznania DPH']] as const) {
      await database.query(
        `INSERT INTO code_list_items (id,tenant_id,organization_id,kind,code,name,source)
         VALUES ($1,$2,$3,'cleneniaDph',$4,$5,'pohoda')`,
        [id, ...kde, kod, nazov],
      );
    }
    const documentId = randomUUID();
    await database.query(
      `INSERT INTO documents (id,tenant_id,organization_id,document_type,status,processing_status,extracted,accounting,total_amount,currency)
       VALUES ($1,$2,$3,'FP','na_kontrole','ready_for_review','{}'::jsonb,'{}'::jsonb,135,'EUR')`,
      [documentId, ...kde],
    );
    const parser = {
      create: vi.fn().mockResolvedValue(aiOdpoved({
        predkontaciaId: phm, clenenieDphId: dphPd, clenenieKvKod: 'B2', ciselnyRadId: null, confidence: 0.8, reason: 'Palivo',
        riadky: [
          { index: 0, predkontaciaId: phm, clenenieDphId: dphPd, clenenieKvKod: 'B2', podiel: 0.8, podielDph: 1 },
          { index: 0, predkontaciaId: nadspotreba, clenenieDphId: dphPn, clenenieKvKod: 'KN', podiel: 0.2, podielDph: 0 },
          { index: 1, predkontaciaId: nadspotreba, clenenieDphId: dphPn, clenenieKvKod: 'KN' },
        ],
      })),
    };
    const input = { tenantId: seeded.tenantId, organizationId: seeded.organizationId, documentId, supplierName: 'Palivová karta s.r.o.' };
    const context = {
      documentType: 'FP', supplierName: 'Palivová karta s.r.o.', supplierKrajina: 'SK', datumVystavenia: '2026-07-01',
      totalAmount: 135, currency: 'EUR', lineDescriptions: ['Natural 95', 'Mýto AT'],
      polozky: [{ popis: 'Natural 95', sadzbaDph: 23, suma: 123 }, { popis: 'Mýto AT', sadzbaDph: 20, suma: 12 }],
    };
    expect(await maybeAiAccountingSuggestion(database, testConfig(), input, context, parser)).toBe(true);

    const riadky = (await database.query<Record<string, any>>(
      'SELECT riadky FROM accounting_suggestions WHERE document_id=$1', [documentId],
    )).rows[0].riadky as Array<Record<string, unknown>>;
    expect(riadky.map((riadok) => [riadok.index, riadok.predkontaciaId, riadok.clenenieKvKod])).toEqual([
      [0, phm, 'B2'], [0, nadspotreba, 'KN'], [1, nadspotreba, 'KN'],
    ]);
  }, 90_000);
});

// ALPINA 26PK497 (platené meranie): model dal riadkom 1 a 2 správny účet, ale do
// „podiel" vpísal ich podiel na doklade (0,16 a 0,19 z 1,00 €) — skopíroval
// podielDokladu z dôkazov. Jedna časť na položku neprešla ako rez a riadky
// vypadli aj so správnym účtom. Časť, ktorej podiel je presne podiel položky
// na doklade, je celá položka.
describe('osamotený podiel rovný podielu položky na doklade', () => {
  it('ostane ako celá položka, skutočný neúplný rez vypadne', async () => {
    const database = await createTestDatabase();
    databases.push(database);
    const seeded = await seedTestUser(database);
    const kde = [seeded.tenantId, seeded.organizationId];
    const [parkovne, nedanove] = [randomUUID(), randomUUID()];
    for (const [id, kod] of [[parkovne, '379700-PK-parkovne'], [nedanove, '379700-PK-nedanove']] as const) {
      await database.query(
        `INSERT INTO code_list_items (id,tenant_id,organization_id,kind,code,name,source,ucet_md,ucet_dal)
         VALUES ($1,$2,$3,'predkontacie',$4,$4,'pohoda','512100','379700')`,
        [id, ...kde, kod],
      );
    }
    const documentId = randomUUID();
    await database.query(
      `INSERT INTO documents (id,tenant_id,organization_id,document_type,status,processing_status,extracted,accounting,total_amount,currency)
       VALUES ($1,$2,$3,'OZ','na_kontrole','ready_for_review','{}'::jsonb,'{}'::jsonb,1,'EUR')`,
      [documentId, ...kde],
    );
    const parser = {
      create: vi.fn().mockResolvedValue(aiOdpoved({
        predkontaciaId: parkovne, clenenieDphId: null, clenenieKvKod: null,
        ciselnyRadId: null, confidence: 0.8, reason: 'Parkovné s nedaňovou časťou',
        riadky: [
          { index: 1, predkontaciaId: nedanove, clenenieDphId: null, clenenieKvKod: null, podiel: 0.128, podielDph: null },
          { index: 2, predkontaciaId: nedanove, clenenieDphId: null, clenenieKvKod: null, podiel: 0.152, podielDph: null },
          // Položka 0 tvorí 0,65 dokladu, model z nej odkrojil 0,5 — to je neúplný rez.
          { index: 0, predkontaciaId: nedanove, clenenieDphId: null, clenenieKvKod: null, podiel: 0.5, podielDph: null },
          // Položka 3 tvorí presne 0,2 dokladu, ale 0,2 je okrúhly rez 80/20 — ostáva neúplným rezom.
          { index: 3, predkontaciaId: nedanove, clenenieDphId: null, clenenieKvKod: null, podiel: 0.2, podielDph: null },
        ],
      })),
    };
    const input = { tenantId: seeded.tenantId, organizationId: seeded.organizationId, documentId, supplierName: 'Parkovisko' };
    const context = {
      documentType: 'OZ', supplierName: 'Parkovisko', totalAmount: 1, currency: 'EUR',
      lineDescriptions: ['parkovné', 'nedaňová časť', 'dph nedaňovo', 'palivo'],
      polozky: [
        { popis: 'parkovné (daňová časť 80 %)', sadzbaDph: 0, suma: 0.52 },
        { popis: 'parkovné (nedaňová časť 20 %)', sadzbaDph: 0, suma: 0.128 },
        { popis: 'dph nedaňovo', sadzbaDph: 0, suma: 0.152 },
        { popis: 'palivo', sadzbaDph: 0, suma: 0.2 },
      ],
    };
    expect(await maybeAiAccountingSuggestion(database, testConfig(), input, context, parser)).toBe(true);

    const riadky = (await database.query<Record<string, any>>(
      'SELECT riadky FROM accounting_suggestions WHERE document_id=$1', [documentId],
    )).rows[0].riadky as Array<Record<string, unknown>>;
    expect(riadky.map((riadok) => [riadok.index, riadok.predkontaciaId, riadok.podiel])).toEqual([
      [1, nedanove, undefined], [2, nedanove, undefined],
    ]);
  }, 90_000);
});

// Číselný rad podľa protistrany. ALPINA má tuzemský rad DF260 a zahraničný
// ZF260 a rozhoduje o nich dodávateľ. Automatika ich rozsudzovala podľa
// posledného čísla, takže slovenskej faktúre od Up Déjeuner dávala ZF260
// (posledné 395) namiesto DF260 (202) — a doklad by v POHODE dostal číslo
// z radu zahraničných faktúr.
describe('číselný rad sa berie podľa protistrany', () => {
  it('vyberie rad, ktorý firma tejto protistrane naozaj dáva', async () => {
    const database = await createTestDatabase();
    databases.push(database);
    const seeded = await seedTestUser(database);
    const kde = [seeded.tenantId, seeded.organizationId];

    const rady = new Map<string, string>();
    for (const [kod, nazov, posledne] of [
      ['DF260', 'Prijaté faktúry SK', 'DF260202'],
      ['ZF260', 'Prijaté faktúry zahraničné', 'ZF260395'],
    ] as const) {
      const id = randomUUID();
      rady.set(kod, id);
      await database.query(
        `INSERT INTO code_list_items (id,tenant_id,organization_id,kind,code,name,source,agenda,last_number)
         VALUES ($1,$2,$3,'ciselneRady',$4,$5,'pohoda','prijate_faktury',$6)`,
        [id, ...kde, kod, nazov, posledne],
      );
    }
    // Korpus: tuzemský dodávateľ chodí v DF260, zahraničný v ZF260.
    const doKorpusu = async (dodavatel: string, prefix: string, pocet: number) => {
      for (let poradie = 1; poradie <= pocet; poradie += 1) {
        await database.query(
          `INSERT INTO ucto_historia
            (id,tenant_id,organization_id,agenda,doklad_cislo,supplier_name_normalized,
             line_text_normalized,predkontacia_kod,source,riadok_hash)
           VALUES ($1,$2,$3,'FP',$4,$5,'sluzba','518/321','mdb',$6)`,
          [randomUUID(), ...kde, `${prefix}${100 + poradie}`, dodavatel, randomUUID()],
        );
      }
    };
    await doKorpusu('up déjeuner, s. r. o.', 'DF260', 5);
    await doKorpusu('q8truck international', 'ZF260', 9);

    const rad = async (dodavatel: string) => {
      const documentId = randomUUID();
      await database.query(
        `INSERT INTO documents (id,tenant_id,organization_id,document_type,status,processing_status,extracted,accounting,total_amount,currency)
         VALUES ($1,$2,$3,'FP','na_kontrole','ready_for_review',$4::jsonb,'{}'::jsonb,100,'EUR')`,
        [documentId, ...kde, JSON.stringify({ dodavatel: { nazov: dodavatel } })],
      );
      await database.transaction(async (tx) => rebuildAccountingSuggestion(tx, {
        tenantId: seeded.tenantId, organizationId: seeded.organizationId, documentId, supplierName: dodavatel,
      }));
      const row = (await database.query<Record<string, any>>(
        `SELECT c.code FROM accounting_suggestions s
           LEFT JOIN code_list_items c ON c.id=s.ciselny_rad_id
          WHERE s.document_id=$1`, [documentId],
      )).rows[0];
      return row?.code as string | undefined;
    };

    expect(await rad('Up Déjeuner, s. r. o.')).toBe('DF260');
    expect(await rad('Q8Truck International')).toBe('ZF260');
    // Neznámy dodávateľ korpus nemá — ostáva pôvodná automatika podľa čísla.
    expect(await rad('Nikdy nevidená s.r.o.')).toBe('ZF260');
  }, 90_000);
});

// Meranie na ALPINE ukázalo rozpis 0 zo 16: model nerozdelil ani jeden doklad,
// ktorý účtovník rozdelil. Vetva rozdeľovania sa totiž viazala na „rozdelenie"
// z účtovného denníka, kým dôkaz o tomto type rozpisu je inde — v položkách
// predošlých dokladov tej istej protistrany. Typický prípad: DPH z cudzieho
// diaľničného poplatku ide na vlastný nedaňový účet, a v denníku to ako vzor
// vidieť nie je.
describe('doklady histórie idú do promptu celé', () => {
  async function firma() {
    const database = await createTestDatabase();
    databases.push(database);
    const seeded = await seedTestUser(database);
    const kde = [seeded.tenantId, seeded.organizationId];
    const predkontacia = async (code: string): Promise<[string, string]> => {
      const id = randomUUID();
      await database.query(
        `INSERT INTO code_list_items (id,tenant_id,organization_id,kind,code,name,source)
         VALUES ($1,$2,$3,'predkontacie',$4,$4,'pohoda')`,
        [id, ...kde, code],
      );
      return [id, code];
    };
    const riadok = (doklad: { cislo: string; datum: string }, index: number, text: string,
      suma: number | null, dph: number | null, [id, kod]: [string, string]) => database.query(
      `INSERT INTO ucto_historia
        (id,tenant_id,organization_id,agenda,doklad_cislo,datum,supplier_name_normalized,
         line_text_normalized,suma,suma_dph,predkontacia_id,predkontacia_kod,riadok_index,source,riadok_hash)
       VALUES ($1,$2,$3,'FP',$4,$5,'f.a.i. service',$6,$7,$8,$9,$10,$11,'mdb',$12)`,
      [randomUUID(), ...kde, doklad.cislo, doklad.datum, text, suma, dph, id, kod, index, randomUUID()],
    );
    const navrhni = async (predkontaciaId: string,
      kontext: Omit<Parameters<typeof maybeAiAccountingSuggestion>[3], 'documentType' | 'supplierName'>,
      pohodaNumber: string | null = null) => {
      const documentId = randomUUID();
      await database.query(
        `INSERT INTO documents (id,tenant_id,organization_id,document_type,status,processing_status,extracted,accounting,total_amount,currency,pohoda_number)
         VALUES ($1,$2,$3,'FP','na_kontrole','ready_for_review','{}'::jsonb,'{}'::jsonb,200,'EUR',$4)`,
        [documentId, ...kde, pohodaNumber],
      );
      const parser = {
        create: vi.fn().mockResolvedValue(aiOdpoved({
          predkontaciaId, clenenieDphId: null, clenenieKvKod: null, ciselnyRadId: null, confidence: 0.8, reason: 'x',
        })),
      };
      const input = { tenantId: seeded.tenantId, organizationId: seeded.organizationId, documentId, supplierName: 'F.A.I. Service' };
      await maybeAiAccountingSuggestion(database, testConfig(), input,
        { documentType: 'FP', supplierName: 'F.A.I. Service', ...kontext }, parser);
      return { input, prompt: JSON.parse((parser.create.mock.calls[0][0] as any).input[0].content[0].text) };
    };
    return { database, seeded, predkontacia, riadok, navrhni };
  }

  it('pošle celý doklad protistrany so sumami a podielmi, zapíše stopu a deterministický návrh ju zruší', async () => {
    const { database, seeded, predkontacia, riadok, navrhni } = await firma();
    const POPLATOK = await predkontacia('379700-auto popl.');
    const NEDANOVE = await predkontacia('379700-PK-nedaňové');
    const doklad = { cislo: '26FP300', datum: '2026-05-10' };
    // Vlastný text hlavičky: s textom prvej položky by doklad nebol isto celý.
    await riadok(doklad, 0, 'diaľničné poplatky', 200, 0, POPLATOK);
    await riadok(doklad, 1, 'dialničná známka', 166.67, 0, POPLATOK);
    await riadok(doklad, 2, 'dph', 33.33, 0, NEDANOVE);
    const prikladId = randomUUID();
    await database.query(
      `INSERT INTO ucto_decisions (id,tenant_id,organization_id,supplier_name_normalized,line_text_normalized,predkontacia_id,source,document_type)
       VALUES ($1,$2,$3,'f.a.i. service','dialničná známka | dph',$4,'import','FP')`,
      [prikladId, seeded.tenantId, seeded.organizationId, POPLATOK[0]],
    );
    const { input, prompt } = await navrhni(POPLATOK[0], {
      totalAmount: 200, currency: 'EUR',
      lineDescriptions: ['dialničná známka', 'dph'],
      polozky: [{ popis: 'dialničná známka', suma: 166.67 }, { popis: 'dph', suma: 33.33 }],
    });

    // Denník je prázdny, takže „rozdelenie" chýba — a napriek tomu má model
    // v ruke, ako sa doklady tejto protistrany rozpisujú.
    expect(prompt.rozdelenie).toBeUndefined();
    expect(prompt.rozuctovanie).toBeUndefined();
    // Dôkaz a ponuka musia sedieť: kód, ktorý model vidí v dokladoch, musí
    // mať aj na výber. Inak ho nemôže vrátiť — a keby vrátil, overenie ho zahodí.
    expect(prompt.ciselniky.predkontacie.map((item: any) => item.id)).toContain(NEDANOVE[0]);
    // Daňová časť nesie kódy hlavičky — účtovník prehodil len tú nedaňovú,
    // takže prvý riadok je zdedený. Z dokladu kvôli tomu nevypadáva: pomer
    // 166,67 : 33,33 sa bez neho prečítať nedá.
    expect(prompt.doklady).toEqual([{
      ref: 'FP|26FP300|2026-05-10', agenda: 'FP', datum: '2026-05-10', tejProtistrany: true, podobnost: 1,
      hlavicka: { text: 'diaľničné poplatky', predkontaciaKod: POPLATOK[1], predkontaciaId: POPLATOK[0] },
      vsetkyPolozky: true,
      suma: 200,
      polozky: [
        { riadok: 1, text: 'dialničná známka', suma: 166.67, sumaDph: 0, podielDokladu: 0.8334, predkontaciaKod: POPLATOK[1], predkontaciaId: POPLATOK[0], zdedene: true },
        { riadok: 2, text: 'dph', suma: 33.33, sumaDph: 0, podielDokladu: 0.1667, predkontaciaKod: NEDANOVE[1], predkontaciaId: NEDANOVE[0] },
      ],
    }]);
    // „podiel" je v odpovedi zlomok rezanej položky. Podiel dokladu pod tým istým
    // menom model odpisoval do odpovede a overenie rozpis zahodilo.
    expect(JSON.stringify(prompt)).not.toContain('"podiel"');

    // Stopa: presne tie doklady, ktoré odišli modelu, s riadkami korpusu a hashom poslaného JSON-u.
    const stopaId = async () => (await database.query<Record<string, any>>(
      'SELECT stopa_id FROM accounting_suggestions WHERE document_id=$1', [input.documentId],
    )).rows[0]?.stopa_id;
    const stopa = (await database.query<Record<string, any>>('SELECT * FROM ucto_navrh_stopa WHERE id=$1', [await stopaId()])).rows[0];
    expect(stopa).toMatchObject({ document_id: input.documentId, as_of: null, agendy: ['FP'], zakladna: false, priklady: [prikladId] });
    expect(stopa.doklady.map((item: any) => item.ref)).toEqual(prompt.doklady.map((item: any) => item.ref));
    expect(stopa.doklady[0].hash).toBe(createHash('sha256').update(JSON.stringify(prompt.doklady[0])).digest('hex'));
    const hashe = (await database.query<Record<string, any>>(
      'SELECT riadok_hash FROM ucto_historia WHERE organization_id=$1', [seeded.organizationId],
    )).rows.map((row) => row.riadok_hash);
    expect(stopa.doklady[0].riadky).toHaveLength(3);
    expect(hashe).toEqual(expect.arrayContaining(stopa.doklady[0].riadky));

    await rebuildAccountingSuggestion(database, input);
    expect(await stopaId()).toBeNull();
  }, 90_000);

  // Predchodca bral najviac 24 riadkov: dvadsaťriadkový doklad vytlačil ďalší
  // na štyri riadky, ktoré sa tvárili ako doklad rezaný vcelku.
  it('doklad s 30 položkami príde celý a doklad po návrate z POHODY nevidí sám seba', async () => {
    const { predkontacia, riadok, navrhni } = await firma();
    const MATERIAL = await predkontacia('501/321');
    const REPRE = await predkontacia('513/321');
    const velky = { cislo: '26FP400', datum: '2026-04-01' };
    await riadok(velky, 0, 'material a obcerstvenie', null, null, MATERIAL);
    for (let index = 1; index <= 30; index += 1) {
      await riadok(velky, index, `polozka ${index}`, index, index * 0.23, index % 3 === 0 ? REPRE : MATERIAL);
    }
    // Ten istý doklad po prenose do POHODY a rovnaké číslo o rok skôr — iný doklad.
    for (const datum of ['2026-06-01', '2025-06-01']) await riadok({ cislo: '26FP500', datum }, 0, 'material', 50, null, MATERIAL);

    const { prompt } = await navrhni(MATERIAL[0],
      { datumVystavenia: '2026-06-01', totalAmount: 50, currency: 'EUR', lineDescriptions: ['material'] }, '26FP500');
    const refy = prompt.doklady.map((item: any) => item.ref);
    expect(refy).toContain('FP|26FP500|2025-06-01');
    expect(refy).not.toContain('FP|26FP500|2026-06-01');
    const cely = prompt.doklady.find((item: any) => item.ref === 'FP|26FP400|2026-04-01');
    expect(cely.polozky).toHaveLength(30);
    for (const pole of ['podielDokladu', 'podielDphDokladu']) {
      expect(Math.abs(cely.polozky.reduce((spolu: number, polozka: any) => spolu + polozka[pole], 0) - 1)).toBeLessThan(0.001);
    }
  }, 90_000);
});

// Ustálené pravidlo protistrany dvíha istotu nad hranicu predvyplnenia. Kým
// takého pravidla nebolo, bola opatrnosť jediná možnosť a rozdelený doklad
// zostal na 0,8 — účtovník musel klikať pri každom. Keď firma robí to isté
// v deviatich dokladoch z desiatich, chráni to už len pred pohodlím.
describe('istota pri ustálenom pravidle protistrany', () => {
  async function priprava(
    dokladov: number,
    zhoda: number,
    moznosti: {
      dph?: { pravidlo: string; navrh: string }; konflikt?: boolean; dennik?: number; priklad?: boolean; pravidloDph?: string;
      /** Pravidlo DPH vznikne, kým model beží (účtovník vybral prax na inom doklade). */
      pravidloPocasBehu?: string;
    } = {},
  ) {
    const database = await createTestDatabase();
    databases.push(database);
    const seeded = await seedTestUser(database);
    const kde = [seeded.tenantId, seeded.organizationId];
    const predkontacia = randomUUID();
    await database.query(
      `INSERT INTO code_list_items (id,tenant_id,organization_id,kind,code,name,source)
       VALUES ($1,$2,$3,'predkontacie','518/321','518/321','pohoda')`,
      [predkontacia, ...kde],
    );
    const clenenia = new Map<string, string>();
    for (const kod of moznosti.dph ? ['PD', 'PN'] : []) {
      clenenia.set(kod, randomUUID());
      await database.query(
        `INSERT INTO code_list_items (id,tenant_id,organization_id,kind,code,name,source)
         VALUES ($1,$2,$3,'cleneniaDph',$4,$4,'pohoda')`,
        [clenenia.get(kod), ...kde, kod],
      );
    }
    // Riadky denníka tej istej protistrany s rovnakým textom a účtom.
    for (let index = 0; index < (moznosti.dennik ?? 0); index++) {
      await database.query(
        `INSERT INTO ucto_historia
          (id,tenant_id,organization_id,agenda,doklad_cislo,datum,supplier_name_normalized,line_text_normalized,
           predkontacia_id,predkontacia_kod,riadok_index,source,riadok_hash)
         VALUES ($1,$2,$3,'FP',$4,'2026-03-10','preprava s.r.o.','preprava tovaru',$5,'518/321',0,'mdb',$6)`,
        [randomUUID(), ...kde, `D${index}`, predkontacia, randomUUID()],
      );
    }
    // Jediný potvrdený doklad s takmer rovnakým textom.
    if (moznosti.priklad) {
      await database.query(
        `INSERT INTO ucto_decisions
          (id,tenant_id,organization_id,supplier_name_normalized,line_text_normalized,predkontacia_id,source,document_type)
         VALUES ($1,$2,$3,'preprava s.r.o.','preprava tovaru',$4,'approved','FP')`,
        [randomUUID(), ...kde, predkontacia],
      );
    }
    // Pravidlo účtovníka pre DPH protistrany — o spore rozhodol človek.
    const pravidloDph = (kod: string) => database.query(
      `INSERT INTO accounting_rules (id,tenant_id,organization_id,supplier_name_normalized,clenenie_dph_id,origin)
       VALUES ($1,$2,$3,'preprava s.r.o.',$4,'manual')`,
      [randomUUID(), ...kde, clenenia.get(kod)],
    );
    if (moznosti.pravidloDph) await pravidloDph(moznosti.pravidloDph);
    const variant = (clenenieDphKod: string, pocet: number) =>
      ({ predkontaciaKod: '518/321', clenenieDphKod, tvar: [], dokladov: pocet, od: '2025-01-05', do: '2025-12-20' });
    await database.query(
      `INSERT INTO ucto_pravidla
        (id,tenant_id,organization_id,agenda,protistrana,dokladov,zhoda,predkontacia_kod,clenenie_dph_kod,rozpis,konflikt,varianty)
       VALUES ($1,$2,$3,'FP','preprava s.r.o.',$4,$5,'518/321',$6,'[]'::jsonb,$7,$8::jsonb)`,
      [randomUUID(), ...kde, dokladov, zhoda, moznosti.dph?.pravidlo ?? null, moznosti.konflikt === true,
        JSON.stringify(moznosti.konflikt ? [variant('PD', 30), variant('PN', 28)] : [])],
    );
    const documentId = randomUUID();
    await database.query(
      `INSERT INTO documents (id,tenant_id,organization_id,document_type,status,processing_status,extracted,accounting,total_amount,currency)
       VALUES ($1,$2,$3,'FP','na_kontrole','ready_for_review','{}'::jsonb,'{}'::jsonb,100,'EUR')`,
      [documentId, ...kde],
    );
    const parser = {
      create: vi.fn().mockResolvedValue(aiOdpoved({
        predkontaciaId: predkontacia, clenenieDphId: moznosti.dph ? clenenia.get(moznosti.dph.navrh) : null,
        clenenieKvKod: null, ciselnyRadId: null, confidence: 0.99, reason: 'Preprava',
      })),
    };
    // Pravidlo vznikne, keď už návrh pravidlá prečítal, no otázku ešte nezapísal
    // (pri zápise behu modelu) — ako výber praxe na inom doklade počas behu.
    const pocasBehu = moznosti.pravidloPocasBehu ? new Proxy(database, {
      get(target, prop) {
        if (prop === 'query') {
          return async (sql: string, params?: unknown[]) => {
            if (params?.includes('navrh-zauctovania-v1')) await pravidloDph(moznosti.pravidloPocasBehu!);
            return target.query(sql, params as never);
          };
        }
        const hodnota = Reflect.get(target, prop);
        return typeof hodnota === 'function' ? hodnota.bind(target) : hodnota;
      },
    }) : database;
    await maybeAiAccountingSuggestion(
      pocasBehu, testConfig(),
      { tenantId: seeded.tenantId, organizationId: seeded.organizationId, documentId, supplierName: 'Preprava s.r.o.' },
      {
        documentType: 'FP', supplierName: 'Preprava s.r.o.', totalAmount: 100, currency: 'EUR',
        lineDescriptions: ['preprava tovaru'], polozky: [{ popis: 'preprava tovaru', suma: 100 }],
      },
      parser,
    );
    const navrh = (await database.query<Record<string, any>>(
      'SELECT confidence, reason, otazka FROM accounting_suggestions WHERE document_id=$1', [documentId],
    )).rows[0];
    return { ...navrh, clenenia, predkontacia, prompt: JSON.parse((parser.create.mock.calls[0][0] as any).input[0].content[0].text) };
  }

  it('pri 58 zo 60 pustí návrh nad hranicu a povie prečo', async () => {
    const navrh = await priprava(60, 58);
    expect(Number(navrh.confidence)).toBeGreaterThanOrEqual(0.9);
    expect(navrh.reason).toContain('58 z 60');
  }, 90_000);

  // Rozhodnutie vlastníka: na predvyplnenie stačí päť dokladov — ale všetkých
  // rovnakých. 4 z 5 je zvyk s výnimkou, nie ustálené pravidlo.
  it('päť rovnakých dokladov predvyplní, 4 z 5 nie', async () => {
    expect(Number((await priprava(5, 5)).confidence)).toBeGreaterThanOrEqual(0.9);
    expect(Number((await priprava(5, 4)).confidence)).toBeLessThan(0.9);
  }, 120_000);

  it('denník predvyplní až pri piatich rovnakých riadkoch', async () => {
    expect(Number((await priprava(3, 2, { dennik: 5 })).confidence)).toBeGreaterThanOrEqual(0.9);
    expect(Number((await priprava(3, 2, { dennik: 4 })).confidence)).toBeLessThan(0.9);
  }, 120_000);

  // Spor praxí protistrany: nech sa zhoduje denník či kategória, doklad sa
  // nepredvyplní — firma robí u tejto protistrany dve rôzne veci.
  it('spor praxí nepredvyplní ani so zhodou v denníku', async () => {
    expect(Number((await priprava(60, 58, { konflikt: true, dennik: 6 })).confidence)).toBeLessThan(0.9);
  }, 90_000);

  // Jeden schválený podobný doklad je príklad, nie prax firmy.
  it('jeden potvrdený podobný doklad nepredvyplní', async () => {
    expect(Number((await priprava(3, 2, { priklad: true })).confidence)).toBeLessThan(0.9);
  }, 90_000);

  it('pri 6 z 10 ostáva pod hranicou — to je zvyk, nie pravidlo', async () => {
    const navrh = await priprava(10, 6);
    expect(Number(navrh.confidence)).toBeLessThan(0.9);
  }, 90_000);

  // Zhoda len v účte by s istotou 0.95 predvyplnila odpočet, aký firma
  // u protistrany neuplatňuje: pravidlo A/PD, model A/PN.
  it('pravidlo A/PD a návrh A/PN ostáva pod hranicou, A/PD nad ňou', async () => {
    expect(Number((await priprava(60, 58, { dph: { pravidlo: 'PD', navrh: 'PN' } })).confidence)).toBeLessThan(0.9);
    expect(Number((await priprava(60, 58, { dph: { pravidlo: 'PD', navrh: 'PD' } })).confidence)).toBeGreaterThanOrEqual(0.9);
  }, 120_000);

  // R09: firma účtuje protistranu dvoma spôsobmi s inou daňou — hádať nemá
  // kto. Účtovník dostane obe podoby s id číselníka, aby vybral jedným klikom.
  it('spor praxí v DPH dá účtovníkovi otázku s oboma podobami', async () => {
    const navrh = await priprava(60, 58, { konflikt: true, dph: { pravidlo: 'PD', navrh: 'PD' } });
    expect(Number(navrh.confidence)).toBeLessThan(0.9);
    expect(navrh.otazka).toEqual({
      spor: 'dph',
      varianty: [
        expect.objectContaining({ predkontaciaId: navrh.predkontacia, clenenieDphId: navrh.clenenia.get('PD'), dokladov: 30,
          kody: expect.objectContaining({ clenenieDph: 'PD' }) }),
        expect.objectContaining({ predkontaciaId: navrh.predkontacia, clenenieDphId: navrh.clenenia.get('PN'), clenenieKvKod: 'KN', dokladov: 28 }),
      ],
    });
  }, 90_000);

  it('keď o DPH protistrany rozhodlo pravidlo účtovníka, otázka nevznikne', async () => {
    const navrh = await priprava(60, 58, { konflikt: true, dph: { pravidlo: 'PD', navrh: 'PD' }, pravidloDph: 'PD' });
    expect(navrh.otazka).toBeNull();
  }, 90_000);

  // Účtovník vybral prax na inom doklade protistrany, kým model bežal nad týmto:
  // pravidlo-protistrany otázky zrušilo, no dobehnutý návrh ju zapísal späť.
  it('pravidlo DPH vzniknuté počas behu modelu otázku nezapíše', async () => {
    const navrh = await priprava(60, 58, { konflikt: true, dph: { pravidlo: 'PD', navrh: 'PD' }, pravidloPocasBehu: 'PD' });
    expect(navrh.otazka).toBeNull();
  }, 90_000);

  it('pravidlo s viacerými praxami ide modelu s podobami a istotu nedvíha', async () => {
    const navrh = await priprava(60, 58, { konflikt: true });
    expect(Number(navrh.confidence)).toBeLessThan(0.9);
    expect(navrh.prompt.pravidlo).toMatchObject({
      konflikt: true,
      varianty: [{ clenenieDphKod: 'PD', dokladov: 30, od: '2025-01-05' }, { clenenieDphKod: 'PN', dokladov: 28 }],
    });
  }, 90_000);
});

// Otázka z podôb praxe — čistá funkcia: preklad kódov na id číselníka firmy,
// zlúčenie podôb s rovnakou hlavičkou a len strana DPH, na ktorej je spor.
describe('otázka pri spore praxí', () => {
  const predkontacie = [{ id: 'p-518', kod: '518/321' }, { id: 'p-513', kod: '513 - Repre' }];
  const clenenia = [{ id: 'd-pd', kod: 'PD' }, { id: 'd-pn', kod: 'PN' }, { id: 'd-dd', kod: 'DDsl§69' }];
  const variant = (pred: string, dph: string, kv: string, dokladov: number, od = '2026-01-01', doDna = '2026-06-30') =>
    ({ predkontaciaKod: pred, clenenieDphKod: dph, clenenieKvKod: kv, tvar: [], dokladov, od, do: doDna });

  it('ponúkne podoby sporu v DPH preložené na id a zlúči rovnakú hlavičku', () => {
    expect(otazkaPraxe({ konflikt: true, varianty: [
      variant('518/321', 'PD', 'B2', 4),
      variant('518/321', 'PD', 'B2', 2, '2025-10-01', '2026-02-01'),
      variant('513 - Repre', 'PN', '', 3),
      // Predkontácia, ktorú firma už nemá, sa neponúkne.
      variant('999', 'PD', 'B2', 5),
      // Druhý doklad samozdanenia nie je podoba sporu.
      variant('518/321', 'DDsl§69', 'B1', 4),
    ] }, predkontacie, clenenia)).toEqual({ spor: 'dph', varianty: [
      { predkontaciaId: 'p-518', clenenieDphId: 'd-pd', clenenieKvKod: 'B2', dokladov: 6, od: '2025-10-01', do: '2026-06-30',
        kody: { predkontacia: '518/321', clenenieDph: 'PD', clenenieKv: 'B2' } },
      { predkontaciaId: 'p-513', clenenieDphId: 'd-pn', clenenieKvKod: 'KN', dokladov: 3, od: '2026-01-01', do: '2026-06-30',
        kody: { predkontacia: '513 - Repre', clenenieDph: 'PN', clenenieKv: 'KN' } },
    ] });
  });

  it('bez sporu v DPH alebo s jedinou preložiteľnou podobou otázku nedá', () => {
    expect(otazkaPraxe({ konflikt: false, varianty: [variant('518/321', 'PD', 'B2', 4), variant('513 - Repre', 'PN', 'KN', 3)] },
      predkontacie, clenenia)).toBeUndefined();
    expect(otazkaPraxe({ konflikt: true, varianty: [variant('518/321', 'PD', 'B2', 4), variant('513 - Repre', 'PD', 'B2', 3)] },
      predkontacie, clenenia)).toBeUndefined();
    expect(otazkaPraxe({ konflikt: true, varianty: [variant('518/321', 'PD', 'B2', 4), variant('999', 'PN', 'KN', 3)] },
      predkontacie, clenenia)).toBeUndefined();
  });
});

// Reťaz účet → členenie → sekcia KV skladá hlavičku z troch samostatných
// väčšín. Účet A firma účtuje vždy s PD a KN, ale PD nesie na iných účtoch B2:
// návrh dostal A/PD/B2, akú firma nikdy nemala, a denník ju predvyplnil.
describe('kombinácia hlavičky, ktorú firma ešte nemala', () => {
  it('polia nemení, ale doklad nepredvyplní a povie prečo', async () => {
    const database = await createTestDatabase();
    databases.push(database);
    const seeded = await seedTestUser(database);
    const kde = [seeded.tenantId, seeded.organizationId];
    const [ucet, iny, pd] = [randomUUID(), randomUUID(), randomUUID()];
    for (const [id, kind, kod] of [[ucet, 'predkontacie', 'A-oprava'], [iny, 'predkontacie', 'B-material'], [pd, 'cleneniaDph', 'PD']]) {
      await database.query(
        `INSERT INTO code_list_items (id,tenant_id,organization_id,kind,code,name,source)
         VALUES ($1,$2,$3,$4,$5,$5,'pohoda')`,
        [id, ...kde, kind, kod],
      );
    }
    // Účet A: päť dokladov, vždy PD a KN. PD na inom účte: 50 dokladov s B2.
    await database.query(
      `INSERT INTO ucto_historia
        (id,tenant_id,organization_id,agenda,doklad_cislo,datum,supplier_name_normalized,line_text_normalized,
         predkontacia_id,predkontacia_kod,clenenie_dph_id,clenenie_dph_kod,clenenie_kv_kod,riadok_index,source,riadok_hash)
       SELECT 'h' || n, $1, $2, 'FP', 'D' || n, '2026-03-10',
              CASE WHEN n <= 5 THEN 'servis s.r.o.' ELSE 'stavebniny s.r.o.' END,
              CASE WHEN n <= 5 THEN 'oprava vozidla' ELSE 'stavebny material ' || n END,
              CASE WHEN n <= 5 THEN $3 ELSE $4 END, CASE WHEN n <= 5 THEN 'A-oprava' ELSE 'B-material' END,
              $5, 'PD', CASE WHEN n <= 5 THEN 'KN' ELSE 'B2' END, 0, 'mdb', 'hash' || n
         FROM generate_series(1, 55) AS n`,
      [...kde, ucet, iny, pd],
    );
    const documentId = randomUUID();
    await database.query(
      `INSERT INTO documents (id,tenant_id,organization_id,document_type,status,processing_status,extracted,accounting,total_amount,currency)
       VALUES ($1,$2,$3,'FP','na_kontrole','ready_for_review','{}'::jsonb,'{}'::jsonb,100,'EUR')`,
      [documentId, ...kde],
    );
    // Model trafí účet a členenie ani sekciu nepovie — doplní ich reťaz.
    const parser = {
      create: vi.fn().mockResolvedValue(aiOdpoved({
        predkontaciaId: ucet, clenenieDphId: null, clenenieKvKod: null,
        ciselnyRadId: null, confidence: 0.99, reason: 'Oprava vozidla',
      })),
    };
    await maybeAiAccountingSuggestion(
      database, testConfig(),
      { tenantId: seeded.tenantId, organizationId: seeded.organizationId, documentId, supplierName: 'Servis s.r.o.' },
      {
        documentType: 'FP', supplierName: 'Servis s.r.o.', totalAmount: 100, currency: 'EUR',
        lineDescriptions: ['oprava vozidla'], polozky: [{ popis: 'oprava vozidla', suma: 100 }],
      },
      parser,
    );
    const navrh = (await database.query<Record<string, any>>(
      'SELECT predkontacia_id, clenenie_dph_id, clenenie_kv_kod, confidence, reason FROM accounting_suggestions WHERE document_id=$1',
      [documentId],
    )).rows[0];
    // Polia ostávajú, ako ich reťaz dala — zriedkavá operácia nie je chyba.
    expect(navrh).toMatchObject({ predkontacia_id: ucet, clenenie_dph_id: pd, clenenie_kv_kod: 'B2' });
    expect(Number(navrh.confidence)).toBeLessThan(0.9);
    expect(navrh.reason).toContain('ešte nepoužila');
  }, 90_000);
});

// Meranie ALPINY: model vybral správnu predkontáciu a hneď si k nej vybral
// členenie, aké firma na tom účte nikdy nemala — 518-nájom ťah má PD v 32
// dokladoch z 32, a návrh dal PN. Keď je účet vybraný, členenie z neho
// spravidla vyplýva; model sa tam neháda s dokladom, ale sám so sebou.
describe('členenie DPH podľa účtu, keď firma iné nemala', () => {
  async function navrhSHistoriou(historia: Array<{ clenenie: string; dokladov: number }>) {
    const database = await createTestDatabase();
    databases.push(database);
    const seeded = await seedTestUser(database);
    const kde = [seeded.tenantId, seeded.organizationId];
    const predkontacia = randomUUID();
    const pd = randomUUID();
    const pn = randomUUID();
    await database.query(
      `INSERT INTO code_list_items (id,tenant_id,organization_id,kind,code,name,source)
       VALUES ($1,$2,$3,'predkontacie','518-nájom ťah','518-nájom ťah','pohoda')`,
      [predkontacia, ...kde],
    );
    for (const [id, kod] of [[pd, 'PD'], [pn, 'PN']] as const) {
      await database.query(
        `INSERT INTO code_list_items (id,tenant_id,organization_id,kind,code,name,source)
         VALUES ($1,$2,$3,'cleneniaDph',$4,$4,'pohoda')`,
        [id, ...kde, kod],
      );
    }
    let cislo = 0;
    for (const { clenenie, dokladov } of historia) {
      for (let index = 0; index < dokladov; index += 1) {
        cislo += 1;
        await database.query(
          `INSERT INTO ucto_historia
            (id,tenant_id,organization_id,agenda,doklad_cislo,datum,supplier_name_normalized,
             line_text_normalized,predkontacia_kod,clenenie_dph_kod,riadok_index,source,riadok_hash)
           VALUES ($1,$2,$3,'FP',$4,'2026-03-10','paccar','nájom ťahača','518-nájom ťah',$5,0,'mdb',$6)`,
          [randomUUID(), ...kde, `26FP${cislo}`, clenenie, randomUUID()],
        );
      }
    }
    const documentId = randomUUID();
    await database.query(
      `INSERT INTO documents (id,tenant_id,organization_id,document_type,status,processing_status,extracted,accounting,total_amount,currency)
       VALUES ($1,$2,$3,'FP','na_kontrole','ready_for_review','{}'::jsonb,'{}'::jsonb,100,'EUR')`,
      [documentId, ...kde],
    );
    // Model trafí účet a k nemu si vyberie PN.
    const parser = {
      create: vi.fn().mockResolvedValue(aiOdpoved({
        predkontaciaId: predkontacia, clenenieDphId: pn, clenenieKvKod: null,
        ciselnyRadId: null, confidence: 0.8, reason: 'Nájom ťahača',
      })),
    };
    await maybeAiAccountingSuggestion(
      database, testConfig(),
      { tenantId: seeded.tenantId, organizationId: seeded.organizationId, documentId, supplierName: 'Paccar' },
      {
        documentType: 'FP', supplierName: 'Paccar', totalAmount: 100, currency: 'EUR',
        lineDescriptions: ['nájom ťahača'], polozky: [{ popis: 'nájom ťahača', suma: 100 }],
      },
      parser,
    );
    const navrh = (await database.query<Record<string, any>>(
      'SELECT predkontacia_id, clenenie_dph_id FROM accounting_suggestions WHERE document_id=$1', [documentId],
    )).rows[0];
    return { navrh, pd, pn, predkontacia };
  }

  it('bez jedinej výnimky v histórii prebije odpoveď modelu', async () => {
    const { navrh, pd, predkontacia } = await navrhSHistoriou([{ clenenie: 'PD', dokladov: 8 }]);
    // Účet ostáva ten, ktorý vybral model — berie sa mu len to, čo z účtu plynie.
    expect(navrh.predkontacia_id).toBe(predkontacia);
    expect(navrh.clenenie_dph_id).toBe(pd);
  }, 90_000);

  it('kde prax firmy kolíše, rozhoduje ďalej model', async () => {
    const { navrh, pn } = await navrhSHistoriou([
      { clenenie: 'PD', dokladov: 6 }, { clenenie: 'PN', dokladov: 4 },
    ]);
    expect(navrh.clenenie_dph_id).toBe(pn);
  }, 90_000);

  it('štyri doklady sú náhoda, nie prax — model ostáva', async () => {
    const { navrh, pn } = await navrhSHistoriou([{ clenenie: 'PD', dokladov: 4 }]);
    expect(navrh.clenenie_dph_id).toBe(pn);
  }, 90_000);
});

// ROFA SLOVENSKO: na vydaných faktúrach mala sebakontrola DPH 0 zo 4 a KV 0 zo 4.
// Model navrhol UD so sekciou KN. KN je jediná zlá sekcia, ktorú zákonná
// kontrola prepustí na každom doklade, a kvPreClenenie sa na návrh modelu ani
// nepozrelo. Potom pravidlo „odpočet + KN" — písané pre PRIJATÉ faktúry — vzalo
// UD za odpočtové a prepísalo ho na členenie bez nároku. Jedna chyba ťahala druhú.
describe('vydaná faktúra so sekciou KN od modelu', () => {
  async function navrhFv(historiaA1: number) {
    const database = await createTestDatabase();
    databases.push(database);
    const seeded = await seedTestUser(database);
    const kde = [seeded.tenantId, seeded.organizationId];
    const tovar = randomUUID();
    const ud = randomUUID();
    const un = randomUUID();
    await database.query(
      `INSERT INTO code_list_items (id,tenant_id,organization_id,kind,code,name,source,agenda)
       VALUES ($1,$2,$3,'predkontacie','604100 - tovar','604100 - tovar','pohoda','vydane_faktury')`,
      [tovar, ...kde],
    );
    for (const [id, kod, nazov] of [
      [ud, 'UD', 'Tuzemské plnenia'],
      [un, 'UN', 'Nezahrňovať do priznania DPH'],
    ] as const) {
      await database.query(
        `INSERT INTO code_list_items (id,tenant_id,organization_id,kind,code,name,source)
         VALUES ($1,$2,$3,'cleneniaDph',$4,$5,'pohoda')`,
        [id, ...kde, kod, nazov],
      );
    }
    for (let index = 0; index < historiaA1; index += 1) {
      await database.query(
        `INSERT INTO ucto_historia
          (id,tenant_id,organization_id,agenda,doklad_cislo,datum,supplier_name_normalized,
           line_text_normalized,predkontacia_kod,predkontacia_id,clenenie_dph_kod,clenenie_dph_id,
           clenenie_kv_kod,riadok_index,source,riadok_hash)
         VALUES ($1,$2,$3,'FV',$4,'2026-03-10','vurup','chemikalie','604100 - tovar',$5,'UD',$6,'A1',0,'mdb',$7)`,
        [randomUUID(), ...kde, `2026FV${index}`, tovar, ud, randomUUID()],
      );
    }
    const documentId = randomUUID();
    await database.query(
      `INSERT INTO documents (id,tenant_id,organization_id,document_type,status,processing_status,extracted,accounting,total_amount,currency)
       VALUES ($1,$2,$3,'FV','na_kontrole','ready_for_review','{}'::jsonb,'{}'::jsonb,1230,'EUR')`,
      [documentId, ...kde],
    );
    const parser = {
      create: vi.fn().mockResolvedValue(aiOdpoved({
        predkontaciaId: tovar, clenenieDphId: ud, clenenieKvKod: 'KN',
        ciselnyRadId: null, confidence: 0.8, reason: 'Predaj chemikálií', riadky: null,
      })),
    };
    await maybeAiAccountingSuggestion(
      database, testConfig(),
      { tenantId: seeded.tenantId, organizationId: seeded.organizationId, documentId },
      {
        documentType: 'FV', totalAmount: 1230, currency: 'EUR',
        odberatel: { nazov: 'VÚRUP, a.s.', ico: '31347701' },
        lineDescriptions: ['laboratórne chemikálie'], polozky: [{ popis: 'laboratórne chemikálie', suma: 1230 }],
      },
      parser,
    );
    const navrh = (await database.query<Record<string, any>>(
      'SELECT clenenie_dph_id, clenenie_kv_kod FROM accounting_suggestions WHERE document_id=$1', [documentId],
    )).rows[0];
    return { navrh, ud, un };
  }

  it('KN od modelu ustúpi prevažujúcej praxi firmy — doklad ostane vo výkaze', async () => {
    const { navrh, ud } = await navrhFv(8);
    expect(navrh.clenenie_kv_kod).toBe('A1');
    expect(navrh.clenenie_dph_id).toBe(ud);
  }, 90_000);

  // Firma bez histórie vydaných faktúr: prax nemá čím KN nahradiť. Sekcia ostane
  // na účtovníkovi, ale UD sa nesmie zmeniť na členenie bez nároku — pravidlo
  // o odpočte na vydanú faktúru nepatrí.
  it('bez histórie ostane UD — pravidlo o odpočte sa vydanej faktúry netýka', async () => {
    const { navrh, ud } = await navrhFv(0);
    expect(navrh.clenenie_dph_id).toBe(ud);
  }, 90_000);
});

// Stopa rozhodnutia musí povedať, ČO sekciu KV naozaj určilo. Pravidlo účtovníka
// so sekciou, ktorá k druhu dokladu nepatrí (A1 na prijatej faktúre), sa nepoužije
// — a zmena sa mu nesmie pripísať. Úprava sekcie podľa druhu dokladu (pokladňa
// do 1 000 € dostane B3 namiesto B2) je samostatná udalosť.
describe('dôvod zmeny sekcie KV v stope', () => {
  async function navrh(moznosti: { typ: 'FP' | 'PD'; pravidloKv?: string; modelKv: string | null }) {
    const database = await createTestDatabase();
    databases.push(database);
    const seeded = await seedTestUser(database);
    const kde = [seeded.tenantId, seeded.organizationId];
    const [ucet, pd] = [randomUUID(), randomUUID()];
    await database.query(
      `INSERT INTO code_list_items (id,tenant_id,organization_id,kind,code,name,source)
       VALUES ($1,$2,$3,'predkontacie','518/321','518/321','pohoda')`, [ucet, ...kde]);
    await database.query(
      `INSERT INTO code_list_items (id,tenant_id,organization_id,kind,code,name,source,kv_section)
       VALUES ($1,$2,$3,'cleneniaDph','PD','Tuzemské plnenia','pohoda','B2')`, [pd, ...kde]);
    if (moznosti.pravidloKv) {
      await database.query(
        `INSERT INTO accounting_rules (id,tenant_id,organization_id,supplier_ico,clenenie_kv_kod,origin)
         VALUES ($1,$2,$3,'11112222',$4,'manual')`, [randomUUID(), ...kde, moznosti.pravidloKv]);
    }
    const documentId = randomUUID();
    await database.query(
      `INSERT INTO documents (id,tenant_id,organization_id,document_type,status,processing_status,extracted,accounting,total_amount,currency)
       VALUES ($1,$2,$3,$4,'na_kontrole','ready_for_review','{}'::jsonb,$5::jsonb,100,'EUR')`,
      [documentId, ...kde, moznosti.typ, JSON.stringify(moznosti.typ === 'PD' ? { pokladnaTyp: 'expense' } : {})]);
    const parser = {
      create: vi.fn().mockResolvedValue(aiOdpoved({
        predkontaciaId: ucet, clenenieDphId: pd, clenenieKvKod: moznosti.modelKv,
        ciselnyRadId: null, confidence: 0.8, reason: 'Servis',
      })),
    };
    const input = { tenantId: seeded.tenantId, organizationId: seeded.organizationId, documentId, supplierIco: '11112222', supplierName: 'Servis s.r.o.' };
    await maybeAiAccountingSuggestion(database, testConfig(), input, {
      documentType: moznosti.typ, supplierName: 'Servis s.r.o.', supplierIco: '11112222', totalAmount: 100, currency: 'EUR',
      lineDescriptions: ['servis'], polozky: [{ popis: 'servis', suma: 100 }],
      ...(moznosti.typ === 'PD' ? { pokladnaTyp: 'expense' as const } : {}),
    }, parser);
    const stopa = (await database.query<Record<string, any>>(
      'SELECT zmeny FROM ucto_navrh_stopa WHERE document_id=$1', [documentId])).rows[0];
    const zmeny = typeof stopa?.zmeny === 'string' ? JSON.parse(stopa.zmeny) : stopa?.zmeny ?? [];
    return zmeny.find((zmena: { pole: string }) => zmena.pole === 'clenenieKvKod');
  }

  it('nepoužité pravidlo sa nevydáva za dôvod', async () => {
    expect(await navrh({ typ: 'FP', pravidloKv: 'A1', modelKv: null }))
      .toMatchObject({ z: null, na: 'B2', dovod: 'kv_podla_praxe_a_druhu' });
  }, 90_000);

  it('B2 na pokladni do limitu je úprava podľa druhu dokladu', async () => {
    expect(await navrh({ typ: 'PD', modelKv: 'B2' }))
      .toMatchObject({ z: 'B2', na: 'B3', dovod: 'kv_podla_druhu' });
  }, 90_000);
});

// Beh AI v logu dokladu = model sa naozaj volal. Chyba prípravy (databáza pred
// volaním) nie je neúspešné volanie modelu, a zlyhaný zápis logu nesmie zahodiť
// návrh, za ktorý sa už zaplatilo.
describe('záznam behu AI návrhu', () => {
  async function priprava(zlyha: RegExp) {
    const database = await createTestDatabase();
    databases.push(database);
    const seeded = await seedTestUser(database);
    const kde = [seeded.tenantId, seeded.organizationId];
    const ucet = randomUUID();
    await database.query(
      `INSERT INTO code_list_items (id,tenant_id,organization_id,kind,code,name,source)
       VALUES ($1,$2,$3,'predkontacie','518/321','518/321','pohoda')`, [ucet, ...kde]);
    const documentId = randomUUID();
    await database.query(
      `INSERT INTO documents (id,tenant_id,organization_id,document_type,status,processing_status,extracted,accounting,total_amount,currency)
       VALUES ($1,$2,$3,'FP','na_kontrole','ready_for_review','{}'::jsonb,'{}'::jsonb,100,'EUR')`, [documentId, ...kde]);
    // Databáza, ktorá zlyhá len na vybranom príkaze — zvyšok beží normálne.
    const chybna = new Proxy(database, {
      get(target, prop) {
        if (prop === 'query') {
          return (sql: string, params?: unknown[]) => (zlyha.test(sql)
            ? Promise.reject(new Error('databáza nedostupná'))
            : target.query(sql, params as never));
        }
        const hodnota = Reflect.get(target, prop);
        return typeof hodnota === 'function' ? hodnota.bind(target) : hodnota;
      },
    });
    const parser = {
      create: vi.fn().mockResolvedValue(aiOdpoved({
        predkontaciaId: ucet, clenenieDphId: null, clenenieKvKod: null, ciselnyRadId: null, confidence: 0.8, reason: 'Servis',
      })),
    };
    const input = { tenantId: seeded.tenantId, organizationId: seeded.organizationId, documentId, supplierName: 'Servis s.r.o.' };
    const kontext = {
      documentType: 'FP', supplierName: 'Servis s.r.o.', totalAmount: 100, currency: 'EUR',
      lineDescriptions: ['servis'], polozky: [{ popis: 'servis', suma: 100 }],
    };
    const behy = async () => (await database.query<Record<string, any>>(
      'SELECT status, error_code FROM extraction_runs WHERE document_id=$1', [documentId])).rows;
    return { database, chybna, parser, input, kontext, documentId, behy };
  }

  it('chyba pred volaním modelu sa nezapíše ako neúspešný beh AI', async () => {
    const { chybna, parser, input, kontext, behy } = await priprava(/FROM ucto_pravidla/);
    await expect(maybeAiAccountingSuggestion(chybna as never, testConfig(), input, kontext, parser)).rejects.toThrow();
    expect(parser.create).not.toHaveBeenCalled();
    expect(await behy()).toEqual([]);
  }, 90_000);

  it('zlyhaný zápis behu návrh nezahodí', async () => {
    const { database, chybna, parser, input, kontext, documentId } = await priprava(/INSERT INTO extraction_runs/);
    expect(await maybeAiAccountingSuggestion(chybna as never, testConfig(), input, kontext, parser)).toBe(true);
    const navrh = (await database.query<Record<string, any>>(
      'SELECT source FROM accounting_suggestions WHERE document_id=$1', [documentId])).rows[0];
    expect(navrh?.source).toBe('ai');
  }, 90_000);
});

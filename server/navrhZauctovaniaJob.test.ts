import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DphAuditor } from './services/dphAuditService.js';
import { aiOdpoved, createTestDatabase, seedTestUser, testConfig } from './testHelpers.js';
import { NAVRH_KIND, processNextJob } from './workerService.js';

const databases: Awaited<ReturnType<typeof createTestDatabase>>[] = [];
afterEach(async () => Promise.all(databases.splice(0).map((database) => database.close())));

// Zmena druhu dokladu (FP → dobropis) prepočítala len rad v návrhu; predkontácia,
// DPH aj dôvod ostali z analýzy pôvodného druhu. Job nového návrhu ich postaví
// znova — z uloženého dokladu, príloha sa už nečíta.
describe('job nového návrhu zaúčtovania', () => {
  it('AI návrh vznikne pre aktuálny druh, uzavretý doklad sa nechá, výpadok AI sa opakuje', async () => {
    const database = await createTestDatabase();
    databases.push(database);
    const seeded = await seedTestUser(database);
    const kde = { tenantId: seeded.tenantId, organizationId: seeded.organizationId };

    const pred = randomUUID();
    await database.query(
      `INSERT INTO code_list_items (id,tenant_id,organization_id,kind,code,name,source)
       VALUES ($1,$2,$3,'predkontacie','518/321','Služby','pohoda'),
              ($4,$2,$3,'cleneniaDph','PD','Tuzemské plnenia','pohoda')`,
      [pred, kde.tenantId, kde.organizationId, randomUUID()],
    );
    const rad = async (kod: string, nazov: string, ext: string) => {
      const id = randomUUID();
      await database.query(
        `INSERT INTO code_list_items (id,tenant_id,organization_id,kind,code,name,source,agenda,external_id,accounting_year)
         VALUES ($1,$2,$3,'ciselneRady',$4,$5,'pohoda','prijate_faktury',$6,'2026')`,
        [id, kde.tenantId, kde.organizationId, kod, nazov, ext],
      );
      return id;
    };
    const faktury = await rad('F26', 'Prijaté faktúry', '100');
    const dobropisy = await rad('D26', 'Prijaté dobropisy', '101');
    // Rad je jediná stopa, ktorý druh job naozaj čítal: bežná faktúra má
    // v histórii rad F26, dobropis D26.
    for (const [agenda, ext, cislo] of [['FP', '100', 'F261'], ['FP', '100', 'F262'], ['FP-D', '101', 'D261']]) {
      await database.query(
        `INSERT INTO ucto_historia
          (id,tenant_id,organization_id,agenda,doklad_cislo,datum,supplier_name_normalized,line_text_normalized,
           predkontacia_kod,riadok_index,source,riadok_hash,rad_external_id,rad_kod)
         VALUES ($1,$2,$3,$4,$5,'2026-03-10'::date,'dodavatel','sluzba','518/321',0,'mdb',$6,$7,$8)`,
        [randomUUID(), kde.tenantId, kde.organizationId, agenda, cislo, randomUUID(), ext, cislo.slice(0, 3)],
      );
    }

    // Doklad už prepnutý na dobropis — tak ho job nájde po zmene druhu.
    const doklad = async (status: string) => {
      const id = randomUUID();
      await database.query(
        `INSERT INTO documents (id,tenant_id,organization_id,document_type,podtyp,status,processing_status,extracted,accounting,total_amount,currency)
         VALUES ($1,$2,$3,'FP','dobropis',$4,'ready_for_review',$5::jsonb,'{}'::jsonb,-12.3,'EUR')`,
        [id, kde.tenantId, kde.organizationId, status, JSON.stringify({
          dodavatel: { nazov: 'Dodavatel s.r.o.', ico: '11112222', krajina: 'SK' },
          datumVystavenia: '2026-04-02',
          textPolozky: 'Oprava služby',
          polozky: [{ popis: 'oprava služby', sadzbaDph: 23, sumaSpolu: -12.3 }],
          rozpisDph: [{ sadzba: 23, zaklad: -10, dph: -2.3 }],
        })],
      );
      return id;
    };
    const job = async (documentId: string) => {
      const id = randomUUID();
      await database.query(
        `INSERT INTO processing_jobs (id,tenant_id,organization_id,document_id,kind,status,correlation_id,payload)
         VALUES ($1,$2,$3,$4,$5,'queued','test','{}'::jsonb)`,
        [id, kde.tenantId, kde.organizationId, documentId, NAVRH_KIND],
      );
      return id;
    };
    const stavJobu = async (id: string) => (await database.query<Record<string, any>>(
      'SELECT status, error_code FROM processing_jobs WHERE id=$1', [id],
    )).rows[0];
    const navrh = async (documentId: string) => (await database.query<Record<string, any>>(
      'SELECT source, predkontacia_id, ciselny_rad_id FROM accounting_suggestions WHERE document_id=$1', [documentId],
    )).rows[0];

    // Model navrhne rad bežnej faktúry — rad však nie je jeho úsudok.
    // Zámok jobu pri volaní AI návrhu — kontrola DPH pred ním smie trvať dve
    // volania modelu a zámok by bez obnovy prekročil okno zaseknutého behu.
    let zamokCerstvy: unknown;
    const parser = {
      create: vi.fn(async () => {
        zamokCerstvy = (await database.query<Record<string, any>>(
          `SELECT locked_at > now() - interval '1 minute' AS cerstvy FROM processing_jobs WHERE status='running'`)).rows[0]?.cerstvy;
        return {
          ...aiOdpoved({
            clenenieKvKod: null, predkontaciaId: pred, clenenieDphId: null, ciselnyRadId: faktury, confidence: 0.8, reason: 'Oprava služby',
          }, 'Overujem sekciu KV.'),
          usage: { input_tokens: 100, input_tokens_details: { cached_tokens: 40 }, output_tokens: 20, total_tokens: 120 },
        };
      }),
    };
    const otvoreny = await doklad('na_kontrole');
    // Verdikt kontroly DPH z čias, keď bol doklad bežnou faktúrou, aj s už
    // uzavretým rozporom — nový druh ho musí posúdiť znova.
    await database.query(
      `INSERT INTO dph_audit (document_id,tenant_id,organization_id,verdikt,odporucana_kv_sekcia,dovod,istota,rozhodnutie)
       VALUES ($1,$2,$3,'neisty','B2','Bežná faktúra s odpočtom',0.6,'ponechane')`,
      [otvoreny, kde.tenantId, kde.organizationId],
    );
    let auditovane: any;
    const dphAuditor = new DphAuditor(testConfig().openai, {
      parse: async (body: any) => {
        auditovane = JSON.parse(body.input[0].content[0].text);
        // Dlhé volanie modelu: zámok zostarne za okno zaseknutého behu.
        await database.query(`UPDATE processing_jobs SET locked_at = now() - interval '1 hour' WHERE status='running'`);
        return { output_parsed: { verdikt: 'nesuhlasi', odporucaneClenenieKod: null, odporucanaKvSekcia: 'KN', dovod: 'Opravná faktúra.', istota: 0.95 } };
      },
    });
    const otvorenyJob = await job(otvoreny);
    expect(await processNextJob(database, testConfig(), 'test-worker', { aiParser: parser, dphAuditor })).toBe(true);
    expect(await stavJobu(otvorenyJob)).toMatchObject({ status: 'succeeded' });
    expect(await navrh(otvoreny)).toMatchObject({ source: 'ai', predkontacia_id: pred, ciselny_rad_id: dobropisy });
    expect(parser.create).toHaveBeenCalledTimes(1);
    expect(zamokCerstvy).toBe(true);
    // Beh návrhu je v logu behov dokladu so spotrebou, aby cena dokladu
    // zahŕňala aj najdrahšie volanie — a výsledok extrakcie ostal nedotknutý.
    const behy = async (documentId: string) => (await database.query<Record<string, any>>(
      'SELECT status, prompt_version, usage, result, error_code FROM extraction_runs WHERE document_id=$1', [documentId],
    )).rows;
    expect(await behy(otvoreny)).toEqual([{
      status: 'succeeded', prompt_version: 'navrh-zauctovania-v1', result: null, error_code: null,
      usage: { inputTokens: 100, cachedTokens: 40, outputTokens: 20, reasoningTokens: null, webSearchCalls: 1 },
    }]);
    expect(auditovane.doklad.podtyp).toBe('dobropis');
    expect((await database.query<Record<string, any>>(
      'SELECT dovod, rozhodnutie FROM dph_audit WHERE document_id=$1', [otvoreny])).rows).toEqual([
      { dovod: 'Opravná faktúra.', rozhodnutie: null },
    ]);

    // Exportovaný doklad: job skončí bez práce, návrh nevznikne.
    parser.create.mockClear();
    const exportovany = await doklad('exportovany');
    const exportJob = await job(exportovany);
    expect(await processNextJob(database, testConfig(), 'test-worker', { aiParser: parser })).toBe(true);
    expect(await stavJobu(exportJob)).toMatchObject({ status: 'succeeded' });
    expect(parser.create).not.toHaveBeenCalled();
    expect(await navrh(exportovany)).toBeUndefined();

    // AI nie je nakonfigurovaná: job prejde s deterministickým návrhom.
    const bezAi = await doklad('na_kontrole');
    const bezAiJob = await job(bezAi);
    expect(await processNextJob(database, testConfig(), 'test-worker')).toBe(true);
    expect(await stavJobu(bezAiJob)).toMatchObject({ status: 'succeeded' });
    expect((await navrh(bezAi))?.source).not.toBe('ai');

    // Prechodný výpadok modelu: job sa vráti do fronty na ďalší pokus.
    const vypadok = { create: vi.fn().mockRejectedValue(new Error('Request timed out')) };
    const vypadokDoklad = await doklad('na_kontrole');
    const vypadokJob = await job(vypadokDoklad);
    expect(await processNextJob(database, testConfig(), 'test-worker', { aiParser: vypadok })).toBe(true);
    expect(await stavJobu(vypadokJob)).toMatchObject({ status: 'queued', error_code: 'processing_failed' });
    // Výpadok je vidieť v behoch dokladu, nie len v jobe.
    expect(await behy(vypadokDoklad)).toEqual([expect.objectContaining({ status: 'failed', error_code: 'navrh_zlyhal', usage: null })]);
  }, 120_000);

  // Zmena druhu počas bežiaceho jobu zaradí ďalší. Druhá slučka workera ho
  // nesmie spustiť súbežne: starý job by zapísal návrh (aj verdikt DPH) starého
  // druhu až po novom a ten by ostal posledný.
  it('čakajúci job dokladu nebeží súbežne s jeho bežiacim jobom', async () => {
    const database = await createTestDatabase();
    databases.push(database);
    const seeded = await seedTestUser(database);
    const documentId = randomUUID();
    await database.query(
      `INSERT INTO documents (id,tenant_id,organization_id,document_type,status,processing_status,extracted,accounting,total_amount,currency)
       VALUES ($1,$2,$3,'FP','exportovany','ready_for_review','{}'::jsonb,'{}'::jsonb,1,'EUR')`,
      [documentId, seeded.tenantId, seeded.organizationId],
    );
    const [bezi, caka] = [randomUUID(), randomUUID()];
    await database.query(
      `INSERT INTO processing_jobs (id,tenant_id,organization_id,document_id,kind,status,locked_at,correlation_id,payload)
       VALUES ($1,$3,$4,$5,$6,'running',now(),'test','{}'::jsonb), ($2,$3,$4,$5,$6,'queued',NULL,'test','{}'::jsonb)`,
      [bezi, caka, seeded.tenantId, seeded.organizationId, documentId, NAVRH_KIND],
    );
    const stav = async (id: string) => (await database.query<Record<string, any>>(
      'SELECT status FROM processing_jobs WHERE id=$1', [id])).rows[0].status;

    expect(await processNextJob(database, testConfig(), 'druha-slucka')).toBe(false);
    expect(await stav(caka)).toBe('queued');
    await database.query(`UPDATE processing_jobs SET status='succeeded' WHERE id=$1`, [bezi]);
    expect(await processNextJob(database, testConfig(), 'druha-slucka')).toBe(true);
    expect(await stav(caka)).toBe('succeeded');
  }, 60_000);
});

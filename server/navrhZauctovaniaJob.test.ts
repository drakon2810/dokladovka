import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
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
       VALUES ($1,$2,$3,'predkontacie','518/321','Služby','pohoda')`,
      [pred, kde.tenantId, kde.organizationId],
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
    const parser = {
      create: vi.fn().mockResolvedValue(aiOdpoved({
        clenenieKvKod: null, predkontaciaId: pred, clenenieDphId: null, ciselnyRadId: faktury, confidence: 0.8, reason: 'Oprava služby',
      })),
    };
    const otvoreny = await doklad('na_kontrole');
    const otvorenyJob = await job(otvoreny);
    expect(await processNextJob(database, testConfig(), 'test-worker', { aiParser: parser })).toBe(true);
    expect(await stavJobu(otvorenyJob)).toMatchObject({ status: 'succeeded' });
    expect(await navrh(otvoreny)).toMatchObject({ source: 'ai', predkontacia_id: pred, ciselny_rad_id: dobropisy });
    expect(parser.create).toHaveBeenCalledTimes(1);

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
  }, 120_000);
});

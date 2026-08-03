import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { maybeAiAccountingSuggestion } from '../services/accountingSuggestionService.js';
import {
  agregujHistoriu,
  analyzujUctovnyProfil,
  listUctoKategorie,
} from '../services/uctoProfileService.js';
import {
  backfillHistoryFromDecisions,
  historyStats,
  importUctoHistory,
} from '../services/uctoHistoryService.js';
import { createTestDatabase, seedTestUser, testConfig } from '../testHelpers.js';

const databases: Awaited<ReturnType<typeof createTestDatabase>>[] = [];
afterEach(async () => Promise.all(databases.splice(0).map((database) => database.close())));

async function seedCodeLists(
  database: Awaited<ReturnType<typeof createTestDatabase>>,
  seeded: { tenantId: string; organizationId: string },
  kody: Array<[string, string]>,
): Promise<Map<string, string>> {
  const ids = new Map<string, string>();
  for (const [kind, code] of kody) {
    const id = randomUUID();
    await database.query(
      `INSERT INTO code_list_items (id,tenant_id,organization_id,kind,code,name,source)
       VALUES ($1,$2,$3,$4,$5,$5,'pohoda')`,
      [id, seeded.tenantId, seeded.organizationId, kind, code],
    );
    ids.set(`${kind}:${code}`, id);
  }
  return ids;
}

describe('účtovný profil firmy', () => {
  it('import histórie je idempotentný, neznámy kód ostane ako text', async () => {
    const database = await createTestDatabase();
    databases.push(database);
    const seeded = await seedTestUser(database);
    await seedCodeLists(database, seeded, [['predkontacie', '518/321'], ['cleneniaDph', 'PD']]);

    const rows = [
      { agenda: 'FP' as const, lineText: 'Preprava tovaru Koper', predkontaciaKod: '518/321', clenenieDphKod: 'PD', clenenieKvKod: 'B2', suma: 120 },
      { agenda: 'PD' as const, lineText: 'Kolok', predkontaciaKod: 'NEEXISTUJE', clenenieDphKod: 'PD' },
      { agenda: 'FP' as const, lineText: 'Riadok bez zaúčtovania' },
    ];
    const prvy = await importUctoHistory(database, { ...seeded, rows, source: 'mdb' });
    expect(prvy).toMatchObject({ imported: 2, duplicates: 0, bezKodu: 1 });

    // Opakovaný import tej istej dávky nezaloží duplicity.
    const druhy = await importUctoHistory(database, { ...seeded, rows, source: 'mdb' });
    expect(druhy).toMatchObject({ imported: 0, duplicates: 2 });

    // Riadok s neznámym kódom sa NEZAHODÍ — kód ostane, id je prázdne.
    const neznamy = await database.query<Record<string, any>>(
      `SELECT predkontacia_kod, predkontacia_id FROM ucto_historia WHERE line_text_normalized='kolok'`,
    );
    expect(neznamy.rows[0]).toMatchObject({ predkontacia_kod: 'NEEXISTUJE', predkontacia_id: null });

    const stats = await historyStats(database, seeded.tenantId, seeded.organizationId);
    expect(stats.spolu).toBe(2);
    expect(stats.podlaAgendy.map((item) => item.agenda).sort()).toEqual(['FP', 'PD']);
  }, 90_000);

  it('backfill preklopí pamäť rozhodnutí do korpusu a agregácia nájde prevažujúce zaúčtovanie', async () => {
    const database = await createTestDatabase();
    databases.push(database);
    const seeded = await seedTestUser(database);
    const ids = await seedCodeLists(database, seeded, [
      ['predkontacie', '518/321'], ['predkontacie', '501/321'], ['cleneniaDph', 'PD'],
    ]);
    for (const [text, predkontacia] of [
      ['preprava tovaru', '518/321'], ['preprava tovaru', '518/321'], ['preprava tovaru', '501/321'],
    ] as const) {
      await database.query(
        `INSERT INTO ucto_decisions (id,tenant_id,organization_id,supplier_name_normalized,
           line_text_normalized,predkontacia_id,clenenie_dph_id,source)
         VALUES ($1,$2,$3,'dodavatel',$4,$5,$6,'import')`,
        [randomUUID(), seeded.tenantId, seeded.organizationId, text,
          ids.get(`predkontacie:${predkontacia}`), ids.get('cleneniaDph:PD')],
      );
    }
    const backfill = await backfillHistoryFromDecisions(database, seeded.tenantId, seeded.organizationId);
    // Každé rozhodnutie je samostatný výskyt — početnosť sa nesmie stratiť.
    expect(backfill.imported).toBe(3);
    // Opakovaný backfill nič nepridá.
    expect((await backfillHistoryFromDecisions(database, seeded.tenantId, seeded.organizationId)).imported).toBe(0);

    const agregat = await agregujHistoriu(database, seeded.tenantId, seeded.organizationId);
    expect(agregat).toHaveLength(1);
    expect(agregat[0].text).toBe('preprava tovaru');
    expect(agregat[0].pocet).toBe(3);
    // Prevažujúce zaúčtovanie je 2× 518, menšinové 1× 501 — konflikt ostáva vidieť.
    expect(agregat[0].kombinacie[0]).toMatchObject({ predkontaciaKod: '518/321', pocet: 2 });
    expect(agregat[0].kombinacie).toHaveLength(2);
  }, 90_000);

  it('analýza uloží kategórie a zahodí účet, ktorý model vymyslel', async () => {
    const database = await createTestDatabase();
    databases.push(database);
    const seeded = await seedTestUser(database);
    const ids = await seedCodeLists(database, seeded, [['predkontacie', '518/321'], ['cleneniaDph', 'PD']]);
    for (let index = 0; index < 6; index += 1) {
      await importUctoHistory(database, {
        ...seeded,
        rows: [{ agenda: 'FP', lineText: `Preprava tovaru ${index}`, predkontaciaKod: '518/321', clenenieDphKod: 'PD' }],
        source: 'mdb',
      });
    }
    const parser = {
      parse: vi.fn().mockResolvedValue({
        output_parsed: {
          kategorie: [
            {
              nazov: 'Preprava a špedícia', popis: 'Doprava tovaru', slovnik: ['preprava', 'doprava'],
              predkontaciaKod: '518/321', clenenieDphKod: 'PD', clenenieKvKod: 'B2',
              vynimky: [], konflikt: null,
            },
            {
              nazov: 'Vymyslená', popis: 'Účet mimo podkladu', slovnik: ['nic'],
              predkontaciaKod: '999/999', clenenieDphKod: null, clenenieKvKod: null,
              vynimky: [{ podmienka: 'nikdy', predkontaciaKod: '888/888' }], konflikt: null,
            },
          ],
        },
      }),
    };
    const vysledok = await analyzujUctovnyProfil(database, testConfig(), seeded, parser);
    expect(vysledok.kategorii).toBe(2);
    expect((parser.parse.mock.calls[0][0] as any).model).toBe('gpt-5.6-sol');

    const kategorie = await listUctoKategorie(database, seeded.tenantId, seeded.organizationId);
    const preprava = kategorie.find((item) => item.nazov === 'Preprava a špedícia');
    expect(preprava?.predkontaciaId).toBe(ids.get('predkontacie:518/321'));
    expect(preprava?.clenenieKvKod).toBe('B2');
    // Účet, ktorý v podklade nebol, sa do profilu nedostane ani ako výnimka.
    const vymyslena = kategorie.find((item) => item.nazov === 'Vymyslená');
    expect(vymyslena?.predkontaciaKod).toBeUndefined();
    expect(vymyslena?.vynimky).toHaveLength(0);
  }, 90_000);

  it('kategória sa dostane do návrhu aj pri neznámom dodávateľovi a zdvihne istotu na predvyplnenie', async () => {
    const database = await createTestDatabase();
    databases.push(database);
    const seeded = await seedTestUser(database);
    const ids = await seedCodeLists(database, seeded, [
      ['predkontacie', '518/321'], ['cleneniaDph', 'PD'], ['ciselneRady', 'PF'],
    ]);
    const documentId = randomUUID();
    await database.query(
      `INSERT INTO documents (id,tenant_id,organization_id,document_type,status,processing_status,extracted,accounting,total_amount,currency)
       VALUES ($1,$2,$3,'FP','na_kontrole','ready_for_review','{}'::jsonb,'{}'::jsonb,100,'EUR')`,
      [documentId, seeded.tenantId, seeded.organizationId],
    );
    await database.query(
      `INSERT INTO ucto_kategorie (id,tenant_id,organization_id,nazov,popis,slovnik,predkontacia_kod,
         predkontacia_id,clenenie_dph_kod,clenenie_dph_id,clenenie_kv_kod,agendy,pocet)
       VALUES ($1,$2,$3,'Preprava a špedícia','Doprava tovaru','["preprava","freight"]'::jsonb,'518/321',$4,
         'PD',$5,'B2','["FP"]'::jsonb,120)`,
      [randomUUID(), seeded.tenantId, seeded.organizationId,
        ids.get('predkontacie:518/321'), ids.get('cleneniaDph:PD')],
    );

    const parser = {
      parse: vi.fn().mockResolvedValue({
        output_parsed: {
          predkontaciaId: ids.get('predkontacie:518/321'), clenenieDphId: ids.get('cleneniaDph:PD'),
          ciselnyRadId: null, confidence: 0.95, reason: 'Ide o prepravu tovaru',
        },
      }),
    };
    // Dodávateľ, ktorého firma nikdy nemala — pamäť ani história nepomôžu.
    const input = { tenantId: seeded.tenantId, organizationId: seeded.organizationId, documentId, supplierName: 'Nová špedícia s.r.o.' };
    const context = { documentType: 'FP', supplierName: 'Nová špedícia s.r.o.', totalAmount: 100, currency: 'EUR', lineDescriptions: ['Freight Shanghai - Koper', 'THC'] };
    expect(await maybeAiAccountingSuggestion(database, testConfig(), input, context, parser)).toBe(true);

    const payload = JSON.parse((parser.parse.mock.calls[0][0] as any).input[0].content[0].text);
    expect(payload.kategorie).toHaveLength(1);
    expect(payload.kategorie[0]).toMatchObject({ nazov: 'Preprava a špedícia', pouziteKrat: 120 });

    const suggestion = (await database.query<Record<string, any>>(
      'SELECT * FROM accounting_suggestions WHERE document_id=$1', [documentId],
    )).rows[0];
    // Nad 0.9 = doklad sa predvyplní sám, účtovník nemusí klikať „Použiť návrh".
    expect(Number(suggestion.confidence)).toBeGreaterThanOrEqual(0.9);
    expect(suggestion.reason).toContain('Preprava a špedícia');
    expect(suggestion.predkontacia_id).toBe(ids.get('predkontacie:518/321'));
  }, 90_000);
});

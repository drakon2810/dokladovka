import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { aiOdpoved, createTestDatabase, seedTestUser, testConfig } from '../testHelpers.js';
import { overPravnuStranku } from './uctoPravnaKontrola.js';
import { listUctoKategorie } from './uctoProfileService.js';

// Kontroluje sa DVOJICA kódov, nie zaúčtovanie: účet je vecou firmy, sekcia KV
// je vecou zákona (§ 78a). Poznámka sa píše na kategórie, ktoré tú dvojicu
// používajú — účtovník ju má vidieť tam, kde sa rozhoduje.

const databases: Awaited<ReturnType<typeof createTestDatabase>>[] = [];
afterEach(async () => Promise.all(databases.splice(0).map((database) => database.close())));

describe('právna kontrola profilu', () => {
  it('označí spornú dvojicu a bezchybnú nechá bez poznámky', async () => {
    const database = await createTestDatabase();
    databases.push(database);
    const seeded = await seedTestUser(database);
    const kde = [seeded.tenantId, seeded.organizationId];

    for (const [nazov, dph, kv] of [
      ['Reprezentácia', 'PN', 'B2'],
      ['Preprava', 'PD', 'B2'],
    ] as const) {
      await database.query(
        `INSERT INTO ucto_kategorie
          (id,tenant_id,organization_id,nazov,popis,slovnik,clenenie_dph_kod,clenenie_kv_kod,agendy,pocet)
         VALUES ($1,$2,$3,$4,'popis','[]'::jsonb,$5,$6,'["FP"]'::jsonb,10)`,
        [randomUUID(), ...kde, nazov, dph, kv],
      );
    }

    const parser = {
      create: vi.fn().mockResolvedValue({
        ...aiOdpoved({
          kombinacie: [
            {
              agenda: 'FP', clenenieDphKod: 'PN (PN)', clenenieKvKod: 'B2', sedi: false,
              poznamka: 'Plnenie mimo priznania nepatrí do B2, patrí do KN.',
            },
            { agenda: 'FP', clenenieDphKod: 'PD (PD)', clenenieKvKod: 'B2', sedi: true, poznamka: '' },
          ],
        }, 'Overujem § 78a.'),
        usage: { input_tokens: 500, output_tokens: 80 },
      }),
    };
    const vysledok = await overPravnuStranku(
      database, testConfig(), { tenantId: seeded.tenantId, organizationId: seeded.organizationId }, parser,
    );
    expect(vysledok).toEqual({ overenych: 2, sporne: 1 });

    // Čítané cez listUctoKategorie, nie priamo zo SQL: poznámka, ktorá sa
    // nedostane na obrazovku účtovníka, je zbytočná.
    const kategorie = (await listUctoKategorie(database, seeded.tenantId, seeded.organizationId))
      .sort((a, b) => a.nazov.localeCompare(b.nazov));
    expect(kategorie[0]).toMatchObject({ nazov: 'Preprava', pravnaPoznamka: undefined });
    expect(kategorie[1].pravnaPoznamka).toContain('KN');

    // Bez nástroja na web sa volanie zopakuje bez neho, nie zahodí.
    expect((parser.create.mock.calls[0][0] as any).tools).toEqual([{ type: 'web_search' }]);

    // Kontrola s web searchom je platené volanie nad firmou: beh bez dokladu
    // so spotrebou aj počtom hľadaní, ktoré sa platia zvlášť.
    expect((await database.query<Record<string, any>>(
      'SELECT document_id, prompt_version, status, error_code, usage FROM extraction_runs WHERE organization_id=$1',
      [seeded.organizationId],
    )).rows).toEqual([{
      document_id: null, prompt_version: 'pravna-kontrola-v1', status: 'succeeded', error_code: null,
      usage: { inputTokens: 500, cachedTokens: null, outputTokens: 80, reasoningTokens: null, webSearchCalls: 1 },
    }]);
  }, 90_000);

  it('bez kategórií s dvojicou kódov sa modelu ani nevolá', async () => {
    const database = await createTestDatabase();
    databases.push(database);
    const seeded = await seedTestUser(database);
    const parser = { create: vi.fn() };
    const vysledok = await overPravnuStranku(
      database, testConfig(), { tenantId: seeded.tenantId, organizationId: seeded.organizationId }, parser,
    );
    expect(vysledok).toEqual({ overenych: 0, sporne: 0 });
    expect(parser.create).not.toHaveBeenCalled();
    expect((await database.query('SELECT 1 FROM extraction_runs WHERE organization_id=$1', [seeded.organizationId])).rowCount).toBe(0);
  }, 60_000);
});

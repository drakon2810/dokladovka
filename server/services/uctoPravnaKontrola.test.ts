import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { aiOdpoved, createTestDatabase, seedTestUser, testConfig } from '../testHelpers.js';
import { overPravnuStranku } from './uctoPravnaKontrola.js';

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
      create: vi.fn().mockResolvedValue(aiOdpoved({
        kombinacie: [
          {
            agenda: 'FP', clenenieDphKod: 'PN (PN)', clenenieKvKod: 'B2', sedi: false,
            poznamka: 'Plnenie mimo priznania nepatrí do B2, patrí do KN.',
          },
          { agenda: 'FP', clenenieDphKod: 'PD (PD)', clenenieKvKod: 'B2', sedi: true, poznamka: '' },
        ],
      })),
    };
    const vysledok = await overPravnuStranku(
      database, testConfig(), { tenantId: seeded.tenantId, organizationId: seeded.organizationId }, parser,
    );
    expect(vysledok).toEqual({ overenych: 2, sporne: 1 });

    const kategorie = await database.query<Record<string, any>>(
      'SELECT nazov, pravna_poznamka FROM ucto_kategorie WHERE organization_id=$1 ORDER BY nazov',
      [seeded.organizationId],
    );
    expect(kategorie.rows[0]).toMatchObject({ nazov: 'Preprava', pravna_poznamka: null });
    expect(kategorie.rows[1].pravna_poznamka).toContain('KN');

    // Bez nástroja na web sa volanie zopakuje bez neho, nie zahodí.
    expect((parser.create.mock.calls[0][0] as any).tools).toEqual([{ type: 'web_search' }]);
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
  }, 60_000);
});

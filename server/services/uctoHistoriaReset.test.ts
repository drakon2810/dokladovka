import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import { importUctoHistory } from './uctoHistoryService.js';
import { createTestDatabase, seedTestUser } from '../testHelpers.js';

const databases: Awaited<ReturnType<typeof createTestDatabase>>[] = [];
afterEach(async () => Promise.all(databases.splice(0).map((database) => database.close())));

describe('korpus histórie a rozdelené agendy', () => {
  // Agenda je prvou zložkou hashu riadku. Po rozdelení (dobropis FP → FP-D) sa
  // hash zmení, takže opakovaný prenos riadok NEPREPÍŠE — pridá druhý. Preto
  // prvá dávka úplného prenosu korpus zahadzuje; tento test drží dôvod.
  it('zmena agendy vyrobí NOVÝ riadok, nie aktualizáciu', async () => {
    const database = await createTestDatabase();
    databases.push(database);
    const seeded = await seedTestUser(database);
    const riadok = { lineText: 'oprava zakladu dane', predkontaciaKod: '518/321', dokladCislo: 'D1' };

    await importUctoHistory(database, { ...seeded, source: 'mdb', rows: [{ agenda: 'FP', ...riadok }] });
    await importUctoHistory(database, { ...seeded, source: 'mdb', rows: [{ agenda: 'FP-D', ...riadok }] });

    const agendy = (await database.query<{ agenda: string } & Record<string, unknown>>(
      'SELECT agenda FROM ucto_historia WHERE organization_id=$1 ORDER BY agenda', [seeded.organizationId],
    )).rows.map((row) => row.agenda);
    // Dva riadky, nie jeden — presne to, čo reset na prvej dávke rieši.
    expect(agendy).toEqual(['FP', 'FP-D']);
  }, 90_000);

  it('nové agendy prejdú validáciou', async () => {
    const database = await createTestDatabase();
    databases.push(database);
    const seeded = await seedTestUser(database);
    const agendy = ['FP-D', 'FP-T', 'FP-Z', 'FV-D', 'FV-T', 'FV-Z'] as const;
    const vysledok = await importUctoHistory(database, {
      ...seeded,
      source: 'mdb',
      rows: agendy.map((agenda, index) => ({
        agenda, lineText: `riadok ${index}`, predkontaciaKod: '518/321', dokladCislo: `X${index}`,
      })),
    });
    expect(vysledok.imported).toBe(agendy.length);
  }, 90_000);
});

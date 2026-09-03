import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { createTestDatabase, seedTestUser } from '../testHelpers.js';

// Kind som pridal do zod schémy, ale CHECK na tabuľke zostal starý: požiadavka
// prešla validáciou a spadla až na INSERT-e. Agent posiela telemetriu cez
// „Try", takže chybu prehltol a na serveri nebolo po adresári ani stopy —
// vyzeralo to, akoby sa ten kód nikdy nespustil.
describe('telemetria synchronizácie', { timeout: 60_000 }, () => {
  it('prijme všetky druhy, ktoré agent posiela — vrátane adresára', async () => {
    const database = await createTestDatabase();
    const seeded = await seedTestUser(database);
    const installationId = randomUUID();
    await database.query(
      `INSERT INTO agent_installations (id,tenant_id,name,hostname,agent_version,token_hash,status)
       VALUES ($1,$2,'Test','TEST','0.11.0',$3,'connected')`,
      [installationId, seeded.tenantId, randomUUID()],
    );
    for (const kind of ['predkontacie', 'cleneniaDph', 'ciselneRady', 'strediska',
      'bankoveUcty', 'treningAi', 'adresar']) {
      await database.query(
        `INSERT INTO agent_sync_runs
          (id,tenant_id,organization_id,agent_installation_id,kind,state,item_count,duration_ms)
         VALUES ($1,$2,$3,$4,$5,'ok',1,10)`,
        [randomUUID(), seeded.tenantId, seeded.organizationId, installationId, kind],
      );
    }
    expect((await database.query('SELECT 1 FROM agent_sync_runs')).rowCount).toBe(7);
  });
});

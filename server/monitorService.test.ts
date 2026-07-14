import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import type { Database } from './db/database.js';
import { runHealthMonitor } from './monitorService.js';
import { createTestDatabase, seedTestUser, testConfig } from './testHelpers.js';

describe('Mostík health monitor', () => {
  let database: Database | undefined;
  afterEach(async () => { await database?.close(); });

  it('vytvorí deduplikované upozornenie adminovi pre offline agenta a vysokú chybovosť', async () => {
    database = await createTestDatabase();
    const seeded = await seedTestUser(database);
    await database.query(
      `INSERT INTO agent_installations (id,tenant_id,name,hostname,token_hash,last_seen_at,agent_version,status)
       VALUES ($1,$2,'Agent','POHODA-SRV',$3,now() - interval '3 hours','0.1.0','connected')`,
      [randomUUID(), seeded.tenantId, randomUUID()],
    );
    for (let index = 0; index < 5; index += 1) {
      await database.query(
        `INSERT INTO export_jobs
          (id,tenant_id,organization_id,document_ids,status,idempotency_key,request_xml,request_xml_hash,created_by,completed_at)
         VALUES ($1,$2,$3,'[]'::jsonb,'failed',$4,'<xml/>',$5,$6,now())`,
        [randomUUID(), seeded.tenantId, seeded.organizationId, randomUUID(), randomUUID(), seeded.userId],
      );
    }

    const config = testConfig({ agentOfflineAlertHours: 2, exportFailureAlertPercent: 20 });
    await expect(runHealthMonitor(database, config)).resolves.toEqual({ offline: 1, failureRates: 1 });
    await runHealthMonitor(database, config);
    const alerts = await database.query<{ event_type: string } & Record<string, unknown>>(
      'SELECT event_type FROM notification_outbox WHERE tenant_id=$1 ORDER BY event_type', [seeded.tenantId],
    );
    expect(alerts.rows.map((row) => row.event_type)).toEqual(['agent_offline', 'export_failure_rate']);
  }, 120_000);
});

import { randomUUID } from 'node:crypto';
import type { ServerConfig } from './config.js';
import type { Database } from './db/database.js';

interface OfflineInstallation extends Record<string, unknown> {
  id: string;
  tenant_id: string;
  hostname: string;
  last_seen_at?: string | Date;
}

interface ExportHealth extends Record<string, unknown> {
  tenant_id: string;
  total: number;
  failed: number;
}

function dayKey(): string {
  return new Date().toISOString().slice(0, 10);
}

export async function runHealthMonitor(database: Database, config: ServerConfig): Promise<{ offline: number; failureRates: number }> {
  const offline = await database.query<OfflineInstallation>(
    `SELECT id, tenant_id, hostname, last_seen_at
       FROM agent_installations
      WHERE status='connected'
        AND (last_seen_at IS NULL OR last_seen_at < now() - ($1::text || ' hours')::interval)`,
    [config.agentOfflineAlertHours],
  );
  for (const installation of offline.rows) {
    const admins = await database.query<{ email: string } & Record<string, unknown>>(
      `SELECT email FROM users WHERE tenant_id=$1 AND role='admin' AND active=true ORDER BY email`,
      [installation.tenant_id],
    );
    await database.query(
      `INSERT INTO notification_outbox (id,tenant_id,event_type,dedup_key,payload)
       VALUES ($1,$2,'agent_offline',$3,$4::jsonb) ON CONFLICT (dedup_key) DO NOTHING`,
      [randomUUID(), installation.tenant_id, `agent_offline:${installation.id}:${dayKey()}`, JSON.stringify({
        installationId: installation.id,
        hostname: installation.hostname,
        lastSeenAt: installation.last_seen_at ? new Date(installation.last_seen_at).toISOString() : null,
        recipients: admins.rows.map((row) => row.email),
      })],
    );
  }

  const health = await database.query<ExportHealth>(
    `SELECT tenant_id, COUNT(*)::int AS total,
            COALESCE(SUM(CASE WHEN status='failed' THEN 1 ELSE 0 END),0)::int AS failed
       FROM export_jobs WHERE created_at > now() - interval '24 hours'
      GROUP BY tenant_id`,
  );
  let failureRates = 0;
  for (const tenant of health.rows) {
    const percent = tenant.total === 0 ? 0 : (tenant.failed / tenant.total) * 100;
    if (tenant.total < 5 || percent < config.exportFailureAlertPercent) continue;
    failureRates += 1;
    const admins = await database.query<{ email: string } & Record<string, unknown>>(
      `SELECT email FROM users WHERE tenant_id=$1 AND role='admin' AND active=true ORDER BY email`, [tenant.tenant_id],
    );
    await database.query(
      `INSERT INTO notification_outbox (id,tenant_id,event_type,dedup_key,payload)
       VALUES ($1,$2,'export_failure_rate',$3,$4::jsonb) ON CONFLICT (dedup_key) DO NOTHING`,
      [randomUUID(), tenant.tenant_id, `export_failure_rate:${tenant.tenant_id}:${dayKey()}`, JSON.stringify({
        total: tenant.total,
        failed: tenant.failed,
        percent,
        thresholdPercent: config.exportFailureAlertPercent,
        recipients: admins.rows.map((row) => row.email),
      })],
    );
  }
  return { offline: offline.rowCount, failureRates };
}

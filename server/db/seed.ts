import { randomUUID } from 'node:crypto';
import { loadConfig } from '../config.js';
import { hashPassword } from '../security.js';
import { createDatabase } from './database.js';
import { migrateDatabase } from './migrate.js';

export async function seedAdmin(
  email: string,
  password: string,
  options?: { tenantName?: string; userName?: string },
): Promise<{ tenantId: string; userId: string }> {
  const database = await createDatabase(loadConfig());
  try {
    await migrateDatabase(database);
    const existing = await database.query<{ id: string; tenant_id: string }>(
      'SELECT id, tenant_id FROM users WHERE lower(email) = lower($1)',
      [email],
    );
    if (existing.rows[0]) {
      return { userId: existing.rows[0].id, tenantId: existing.rows[0].tenant_id };
    }
    const tenantId = randomUUID();
    const userId = randomUUID();
    await database.transaction(async (tx) => {
      await tx.query('INSERT INTO tenants (id, name) VALUES ($1,$2)', [tenantId, options?.tenantName ?? 'Dokladovka']);
      await tx.query(
        `INSERT INTO users (id, tenant_id, name, email, password_hash, role)
         VALUES ($1,$2,$3,$4,$5,'admin')`,
        [userId, tenantId, options?.userName ?? 'Administrátor', email.trim().toLowerCase(), await hashPassword(password)],
      );
      await tx.query('INSERT INTO tenant_integrations (tenant_id) VALUES ($1)', [tenantId]);
    });
    return { tenantId, userId };
  } finally {
    await database.close();
  }
}

if (import.meta.url === `file://${process.argv[1]?.replaceAll('\\', '/')}`) {
  const email = process.env.SEED_ADMIN_EMAIL?.trim();
  const password = process.env.SEED_ADMIN_PASSWORD;
  if (!email || !password) {
    throw new Error('SEED_ADMIN_EMAIL a SEED_ADMIN_PASSWORD sú povinné pre db:seed');
  }
  const result = await seedAdmin(email, password);
  process.stdout.write(`Admin pripravený pre tenant ${result.tenantId}.\n`);
}

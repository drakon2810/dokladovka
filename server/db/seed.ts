import { randomUUID } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { loadConfig } from '../config.js';
import { hashPassword } from '../security.js';
import { createDatabase } from './database.js';
import { migrateDatabase } from './migrate.js';

export async function seedAdmin(
  email: string,
  password: string,
  options?: { tenantName?: string; userName?: string; role?: 'admin' | 'superadmin' },
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
         VALUES ($1,$2,$3,$4,$5,$6)`,
        [userId, tenantId, options?.userName ?? 'Administrátor', email.trim().toLowerCase(),
          await hashPassword(password), options?.role ?? 'admin'],
      );
      await tx.query('INSERT INTO tenant_integrations (tenant_id) VALUES ($1)', [tenantId]);
    });
    return { tenantId, userId };
  } finally {
    await database.close();
  }
}

// pathToFileURL, nie ručné skladanie „file://" — na Windows a v ceste s
// medzerami/diakritikou sa reťazce nikdy nezhodovali a skript ticho nič neurobil.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  // Správca platformy (globálne pravidlá pre AI) je jediný účet s rolou
  // superadmin a žije vo vlastnom tenante bez organizácií — k dátam firiem sa
  // nedostane. Druhý taký účet nevznikne (unikátny index v migrácii 0033).
  const platformEmail = process.env.SEED_PLATFORM_ADMIN_EMAIL?.trim();
  if (platformEmail) {
    const platformPassword = process.env.SEED_PLATFORM_ADMIN_PASSWORD;
    if (!platformPassword) throw new Error('SEED_PLATFORM_ADMIN_PASSWORD je povinné');
    const platform = await seedAdmin(platformEmail, platformPassword, {
      role: 'superadmin', tenantName: 'Platforma', userName: 'Správca platformy',
    });
    process.stdout.write(`Správca platformy pripravený (tenant ${platform.tenantId}).\n`);
  }
  const email = process.env.SEED_ADMIN_EMAIL?.trim();
  const password = process.env.SEED_ADMIN_PASSWORD;
  if (!email || !password) {
    if (platformEmail) process.exit(0);
    throw new Error('SEED_ADMIN_EMAIL a SEED_ADMIN_PASSWORD sú povinné pre db:seed');
  }
  const result = await seedAdmin(email, password);
  process.stdout.write(`Admin pripravený pre tenant ${result.tenantId}.\n`);
}

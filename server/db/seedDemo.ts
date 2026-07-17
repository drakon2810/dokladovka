// Demo seed pre lokálny vývoj: verejné testovacie účty z prihlasovacej
// obrazovky (src/auth/config.ts) + demo organizácia s frontou a aliasmi.
// Heslo Dokladovka2026! je verejné demo heslo, nie produkčný secret.
// Idempotentné — opakované spustenie nič neduplikuje.
import { randomUUID } from 'node:crypto';
import { loadConfig } from '../config.js';
import { hashPassword } from '../security.js';
import { createDatabase } from './database.js';
import { migrateDatabase } from './migrate.js';
import { insertUniqueAlias } from '../services/organizationService.js';

const DEMO_PASSWORD = 'Dokladovka2026!';
const DEMO_USERS = [
  { name: 'Andrej Novák', email: 'andrej@kancelaria.sk', role: 'admin' },
  { name: 'Mária Kováčová', email: 'maria@kancelaria.sk', role: 'uctovnik' },
  { name: 'Peter Horváth', email: 'peter@kancelaria.sk', role: 'schvalovatel' },
] as const;

const config = loadConfig();
const database = await createDatabase(config);

try {
  await migrateDatabase(database);
  const passwordHash = await hashPassword(DEMO_PASSWORD);

  // Tenant — buď existujúci demo tenant (podľa prvého demo účtu), alebo nový.
  const existingAdmin = await database.query<{ tenant_id: string }>(
    'SELECT tenant_id FROM users WHERE lower(email)=lower($1)',
    [DEMO_USERS[0].email],
  );
  const tenantId = existingAdmin.rows[0]?.tenant_id ?? randomUUID();
  if (!existingAdmin.rows[0]) {
    await database.query('INSERT INTO tenants (id,name) VALUES ($1,$2)', [tenantId, 'Účtovná kancelária Demo']);
    await database.query('INSERT INTO tenant_integrations (tenant_id) VALUES ($1) ON CONFLICT DO NOTHING', [tenantId]);
  }

  const userIds: string[] = [];
  for (const user of DEMO_USERS) {
    const existing = await database.query<{ id: string }>(
      'SELECT id FROM users WHERE lower(email)=lower($1)', [user.email],
    );
    if (existing.rows[0]) {
      userIds.push(existing.rows[0].id);
      continue;
    }
    const id = randomUUID();
    await database.query(
      `INSERT INTO users (id,tenant_id,name,email,password_hash,role) VALUES ($1,$2,$3,$4,$5,$6)`,
      [id, tenantId, user.name, user.email, passwordHash, user.role],
    );
    userIds.push(id);
    process.stdout.write(`+ používateľ ${user.email} (${user.role})\n`);
  }

  // Demo organizácia s frontou.
  const existingOrg = await database.query<{ id: string }>(
    `SELECT id FROM organizations WHERE tenant_id=$1 AND ico='36528221'`, [tenantId],
  );
  let organizationId = existingOrg.rows[0]?.id;
  if (!organizationId) {
    organizationId = randomUUID();
    await database.query(
      `INSERT INTO organizations (id,tenant_id,name,ico,dic,ic_dph,color)
       VALUES ($1,$2,'Alfa Trade s.r.o.','36528221','2020123456','SK2020123456','#0E7A5F')`,
      [organizationId, tenantId],
    );
    await database.query(
      `INSERT INTO document_queues (id,tenant_id,organization_id,name,kind,document_types)
       VALUES ($1,$2,$3,'Prijaté faktúry','received_invoices','["FP","FV","BV","MZDY","OZ","PD"]'::jsonb)`,
      [randomUUID(), tenantId, organizationId],
    );
    await insertUniqueAlias(database, {
      tenantId,
      organizationId,
      organizationName: 'Alfa Trade s.r.o.',
      domain: config.mailReceivingDomain,
      primary: true,
    });
    process.stdout.write(`+ organizácia Alfa Trade s.r.o.\n`);
  }

  for (const userId of userIds) {
    await database.query(
      `INSERT INTO organization_memberships (user_id,organization_id,tenant_id)
       VALUES ($1,$2,$3) ON CONFLICT DO NOTHING`,
      [userId, organizationId, tenantId],
    );
  }

  // Gmail schránka IMAP pollera ako alias organizácie → pošta na ňu smeruje
  // priamo do Alfa Trade (bez karantény unknown_alias). Len pre lokálne demo.
  const imapUser = config.imap.user?.trim().toLowerCase();
  if (imapUser) {
    const existingAlias = await database.query(
      'SELECT 1 FROM organization_email_aliases WHERE address_normalized=$1', [imapUser],
    );
    if (existingAlias.rowCount === 0) {
      const [localPart, domain] = imapUser.split('@');
      await database.query(
        `INSERT INTO organization_email_aliases
          (id,tenant_id,organization_id,address,address_normalized,local_part,domain,
           slug_at_creation,token,status,is_primary)
         VALUES ($1,$2,$3,$4,$4,$5,$6,'imap-demo','imapbx','active',false)`,
        [randomUUID(), tenantId, organizationId, imapUser, localPart, domain],
      );
      process.stdout.write(`+ alias ${imapUser} → Alfa Trade s.r.o.\n`);
    }
  }

  process.stdout.write('Demo seed hotový.\n');
} finally {
  await database.close();
}

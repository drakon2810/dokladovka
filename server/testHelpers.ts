import { randomUUID } from 'node:crypto';
import { PGlite } from '@electric-sql/pglite';
import type { ServerConfig } from './config.js';
import { databaseFromPglite, type Database } from './db/database.js';
import { migrateDatabase } from './db/migrate.js';
import type { MailMessage, Mailer } from './mailer.js';
import { hashPassword } from './security.js';

export function testConfig(overrides: Partial<ServerConfig> = {}): ServerConfig {
  return {
    nodeEnv: 'test',
    port: 3001,
    appBaseUrl: 'http://localhost:5173',
    apiBaseUrl: 'http://localhost:3001',
    pgliteDataDir: 'memory://',
    mailReceivingDomain: 'doklady.test.sk',
    webhookSecret: 'test-webhook-secret',
    sessionCookieSecure: false,
    sessionTtlHours: 8,
    mail: {
      from: 'Dokladovka <no-reply@doklady.test.sk>',
      smtp: { host: undefined, port: 465, secure: true, user: undefined, password: undefined },
    },
    turnstile: { siteKey: undefined, secretKey: undefined },
    extractionProvider: 'mock',
    imap: {
      host: undefined,
      port: 993,
      user: undefined,
      password: undefined,
      pollIntervalSeconds: 30,
      mailbox: 'INBOX',
    },
    openai: {
      apiKey: undefined,
      model: 'gpt-5-mini',
      accountingModel: 'gpt-5.6-terra',
      ruleAnalysisModel: 'gpt-5.6-sol',
      storeResponses: false,
      timeoutMs: 120_000,
      maxRetries: 2,
    },
    extractionMaxFileBytes: 20 * 1024 * 1024,
    extractionMaxPdfPages: 50,
    workerPollIntervalMs: 10,
    workerConcurrency: 1,
    objectStorage: {
      mode: 'memory',
      region: 'eu-central-1',
      bucket: 'test',
      forcePathStyle: true,
      filesystemRoot: '.local/test-objects',
    },
    agentInstallerPublicBaseUrl: 'http://localhost:3001/downloads',
    agentInstallerDirectory: 'agent/artifacts',
    allowSelfSignedAgentReleases: false,
    agentReleasePublishToken: undefined,
    agentOfflineAlertHours: 2,
    exportFailureAlertPercent: 20,
    monitorIntervalMs: 100,
    ...overrides,
  };
}

export function memoryMailer(): Mailer & { sent: MailMessage[] } {
  const sent: MailMessage[] = [];
  return { sent, async send(message) { sent.push(message); } };
}

export async function createTestDatabase(): Promise<Database> {
  const database = databaseFromPglite(new PGlite());
  await migrateDatabase(database);
  return database;
}

export async function seedTestUser(database: Database, options?: { role?: 'admin' | 'uctovnik' | 'schvalovatel' }) {
  const tenantId = randomUUID();
  const userId = randomUUID();
  const organizationId = randomUUID();
  const aliasId = randomUUID();
  const email = 'admin@test.sk';
  const password = 'Test-password-123!';
  await database.transaction(async (tx) => {
    await tx.query('INSERT INTO tenants (id,name) VALUES ($1,$2)', [tenantId, 'Test tenant']);
    await tx.query(
      `INSERT INTO users (id,tenant_id,name,email,password_hash,role)
       VALUES ($1,$2,'Test Admin',$3,$4,$5)`,
      [userId, tenantId, email, await hashPassword(password), options?.role ?? 'admin'],
    );
    await tx.query(
      `INSERT INTO organizations (id,tenant_id,name,ico,dic,color)
       VALUES ($1,$2,'Test s.r.o.','12345678','2020123456','#0E7A5F')`,
      [organizationId, tenantId],
    );
    await tx.query('INSERT INTO organization_memberships (user_id,organization_id,tenant_id) VALUES ($1,$2,$3)', [userId, organizationId, tenantId]);
    await tx.query(
      `INSERT INTO organization_email_aliases
        (id,tenant_id,organization_id,address,address_normalized,local_part,domain,slug_at_creation,token,status,is_primary)
       VALUES ($1,$2,$3,'test-abc234@doklady.test.sk','test-abc234@doklady.test.sk','test-abc234','doklady.test.sk','test','abc234','active',true)`,
      [aliasId, tenantId, organizationId],
    );
    await tx.query('INSERT INTO tenant_integrations (tenant_id) VALUES ($1)', [tenantId]);
    await tx.query('INSERT INTO pohoda_company_links (organization_id,tenant_id,ico) VALUES ($1,$2,$3)', [organizationId, tenantId, '12345678']);
  });
  return { tenantId, userId, organizationId, aliasId, email, password };
}

/**
 * Odpoveď Responses API tak, ako ju vracia model: pole output správ. Návrh
 * zaúčtovania číta finálnu správu, preto testy nesmú posielať iba holý objekt
 * — inak by prehliadli, že medzi správami môže byť preambula či tool call.
 */
export function aiOdpoved(payload: unknown, preambula?: string) {
  const output: unknown[] = [];
  if (preambula) {
    output.push({ type: 'message', content: [{ type: 'output_text', text: preambula }] });
    output.push({ type: 'web_search_call', id: 'ws_test' });
  }
  output.push({ type: 'message', content: [{ type: 'output_text', text: JSON.stringify(payload) }] });
  return { output };
}

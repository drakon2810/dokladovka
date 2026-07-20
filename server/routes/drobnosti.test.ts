import { afterEach, describe, expect, it } from 'vitest';
import { buildApp } from '../app.js';
import { createTestDatabase, seedTestUser, testConfig } from '../testHelpers.js';
import { MemoryObjectStorage } from '../storage.js';

const databases: Awaited<ReturnType<typeof createTestDatabase>>[] = [];
afterEach(async () => Promise.all(databases.splice(0).map((database) => database.close())));

function sessionHeaders(response: { headers: Record<string, unknown>; json(): any }) {
  const cookie = String(response.headers['set-cookie']).split(';')[0];
  const csrf = response.json().csrfToken as string;
  return { cookie, 'x-csrf-token': csrf };
}

const PDF_BASE64 = Buffer.from('%PDF-1.4 test').toString('base64');

describe('Drobnosti', () => {
  it('whitelist odosielateľov: e-mail mimo zoznamu končí v karanténe', async () => {
    const database = await createTestDatabase();
    databases.push(database);
    const seeded = await seedTestUser(database);
    const config = testConfig();
    const app = await buildApp({ database, storage: new MemoryObjectStorage(), config, logger: false });
    await database.query(
      `UPDATE organizations SET sender_whitelist='["fakturacia@dodavatel.sk"]'::jsonb WHERE id=$1`,
      [seeded.organizationId],
    );
    const inject = (messageId: string, sender: string) => app.inject({
      method: 'POST',
      url: '/api/webhooks/inbound-email/test',
      headers: { 'x-dokladovka-webhook-secret': config.webhookSecret! },
      payload: {
        providerMessageId: messageId,
        envelopeRecipients: ['test-abc234@doklady.test.sk'],
        senderEmail: sender,
        subject: 'Faktúra',
        attachments: [{ fileName: 'faktura.pdf', contentBase64: PDF_BASE64, mimeType: 'application/pdf' }],
      },
    });

    const blocked = await inject('msg-1', 'spam@cudzi.sk');
    expect(blocked.statusCode).toBeLessThan(300);
    const blockedRow = await database.query<{ status: string; quarantine_reason?: string } & Record<string, unknown>>(
      `SELECT status, quarantine_reason FROM inbound_emails WHERE provider_message_id='msg-1'`,
    );
    expect(blockedRow.rows[0].status).toBe('quarantine');
    expect(blockedRow.rows[0].quarantine_reason).toBe('sender_not_whitelisted');

    const allowed = await inject('msg-2', 'Fakturacia@Dodavatel.sk');
    expect(allowed.statusCode).toBeLessThan(300);
    const allowedRow = await database.query<{ quarantine_reason?: string } & Record<string, unknown>>(
      `SELECT quarantine_reason FROM inbound_emails WHERE provider_message_id='msg-2'`,
    );
    expect(allowedRow.rows[0].quarantine_reason ?? null).toBeNull();
    await app.close();
  }, 120_000);

  it('FO nepodnikateľ sa založí bez IČO; firma bez IČO neprejde', async () => {
    const database = await createTestDatabase();
    databases.push(database);
    const seeded = await seedTestUser(database);
    const app = await buildApp({ database, storage: new MemoryObjectStorage(), config: testConfig(), logger: false });
    const login = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { email: seeded.email, password: seeded.password } });
    const headers = sessionHeaders(login);

    const fo = await app.inject({
      method: 'POST',
      url: '/api/organizations',
      headers,
      payload: {
        nazov: 'Ján Novák', ico: '', dic: '', farba: '#0E7A5F',
        typSubjektu: 'fo_nepodnikatel', ulica: 'Hlavná 1', mesto: 'Bratislava', psc: '81101', krajina: 'SK',
        senderWhitelist: [],
      },
    });
    expect(fo.statusCode).toBe(201);
    expect(fo.json().organization.typSubjektu).toBe('fo_nepodnikatel');
    expect(fo.json().organization.mesto).toBe('Bratislava');

    const firma = await app.inject({
      method: 'POST',
      url: '/api/organizations',
      headers,
      payload: { nazov: 'Bez IČO s.r.o.', ico: '', dic: '', farba: '#0E7A5F', typSubjektu: 'company', senderWhitelist: [] },
    });
    expect(firma.statusCode).toBe(400);
    expect(firma.json().code).toBe('organization_ico_required');
    await app.close();
  }, 120_000);

  it('preddefinované poznámky a e-mailové šablóny sa uložia a vrátia v snapshote', async () => {
    const database = await createTestDatabase();
    databases.push(database);
    const seeded = await seedTestUser(database);
    const app = await buildApp({ database, storage: new MemoryObjectStorage(), config: testConfig(), logger: false });
    const login = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { email: seeded.email, password: seeded.password } });
    const headers = sessionHeaders(login);

    const notes = await app.inject({
      method: 'PUT',
      url: `/api/organizations/${seeded.organizationId}/note-templates`,
      headers,
      payload: { poznamky: ['Uhradené kartou', 'Reprezentácia — bez odpočtu'] },
    });
    expect(notes.statusCode).toBe(200);

    const emails = await app.inject({
      method: 'PUT',
      url: `/api/organizations/${seeded.organizationId}/email-templates`,
      headers,
      payload: { sablony: [{ nazov: 'Chýbajúci doklad', predmet: 'Prosíme o doklad', telo: 'Dobrý deň, ...' }] },
    });
    expect(emails.statusCode).toBe(200);

    const snapshot = await app.inject({ method: 'GET', url: '/api/data/snapshot', headers: { cookie: headers.cookie } });
    expect(snapshot.json().noteTemplates).toHaveLength(2);
    expect(snapshot.json().emailTemplates).toHaveLength(1);
    expect(snapshot.json().emailTemplates[0].nazov).toBe('Chýbajúci doklad');

    // Nahradenie zoznamu: starý obsah zmizne.
    await app.inject({
      method: 'PUT',
      url: `/api/organizations/${seeded.organizationId}/note-templates`,
      headers,
      payload: { poznamky: ['Iba jedna'] },
    });
    const after = await app.inject({ method: 'GET', url: '/api/data/snapshot', headers: { cookie: headers.cookie } });
    expect(after.json().noteTemplates).toHaveLength(1);
    await app.close();
  }, 120_000);
});

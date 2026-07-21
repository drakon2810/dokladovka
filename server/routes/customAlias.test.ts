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

const pdfBase64 = Buffer.from('%PDF-1.4\n1 0 obj<<>>endobj\n').toString('base64');

function inboundPayload(recipient: string, messageId: string) {
  return {
    providerMessageId: messageId,
    envelopeRecipients: [recipient],
    senderEmail: 'dodavatel@example.sk',
    subject: 'Faktúra',
    attachments: [{ fileName: 'faktura.pdf', mimeType: 'application/pdf', contentBase64: pdfBase64 }],
  };
}

describe('vlastný (custom) e-mailový alias', () => {
  it('priradí vlastnú adresu firme a nasmeruje na ňu prijatý e-mail', async () => {
    const database = await createTestDatabase();
    databases.push(database);
    const seeded = await seedTestUser(database);
    const config = testConfig();
    const app = await buildApp({ database, storage: new MemoryObjectStorage(), config, logger: false });
    const headers = sessionHeaders(
      await app.inject({ method: 'POST', url: '/api/auth/login', payload: { email: seeded.email, password: seeded.password } }),
    );
    const webhookHeaders = { 'x-dokladovka-webhook-secret': config.webhookSecret! };

    // Pridanie vlastného aliasu (plus-adresa Gmailu).
    const added = await app.inject({
      method: 'POST',
      url: `/api/organizations/${seeded.organizationId}/email-aliases/custom`,
      headers,
      payload: { address: 'Moja.Schranka+AGS@gmail.com' },
    });
    expect(added.statusCode).toBe(201);
    // Adresa sa normalizuje na lowercase.
    expect(added.json().address).toBe('moja.schranka+ags@gmail.com');
    expect(added.json().isPrimary).toBe(false);

    // E-mail na túto adresu sa zaradí k firme (queued, nie karanténa).
    const routed = await app.inject({
      method: 'POST',
      url: '/api/webhooks/inbound-email/imap',
      headers: webhookHeaders,
      payload: inboundPayload('moja.schranka+ags@gmail.com', 'msg-routed-1'),
    });
    expect(routed.statusCode).toBe(202);
    expect(routed.json().status).toBe('queued');
    expect(routed.json().queued).toBe(1);

    // E-mail na neregistrovanú adresu skončí v karanténe (unknown_alias).
    const unknown = await app.inject({
      method: 'POST',
      url: '/api/webhooks/inbound-email/imap',
      headers: webhookHeaders,
      payload: inboundPayload('moja.schranka+ine@gmail.com', 'msg-unknown-1'),
    });
    expect(unknown.statusCode).toBe(202);
    expect(unknown.json().status).toBe('quarantine');
    await app.close();
  }, 120_000);

  it('odmietne duplicitnú adresu (409) a neplatnú adresu (400)', async () => {
    const database = await createTestDatabase();
    databases.push(database);
    const seeded = await seedTestUser(database);
    const app = await buildApp({ database, storage: new MemoryObjectStorage(), config: testConfig(), logger: false });
    const headers = sessionHeaders(
      await app.inject({ method: 'POST', url: '/api/auth/login', payload: { email: seeded.email, password: seeded.password } }),
    );

    const first = await app.inject({
      method: 'POST', url: `/api/organizations/${seeded.organizationId}/email-aliases/custom`,
      headers, payload: { address: 'schranka+alfa@gmail.com' },
    });
    expect(first.statusCode).toBe(201);

    const duplicate = await app.inject({
      method: 'POST', url: `/api/organizations/${seeded.organizationId}/email-aliases/custom`,
      headers, payload: { address: 'schranka+alfa@gmail.com' },
    });
    expect(duplicate.statusCode).toBe(409);
    expect(duplicate.json().code).toBe('alias_taken');

    const invalid = await app.inject({
      method: 'POST', url: `/api/organizations/${seeded.organizationId}/email-aliases/custom`,
      headers, payload: { address: 'nie-je-email' },
    });
    expect(invalid.statusCode).toBe(400);
    await app.close();
  }, 120_000);
});

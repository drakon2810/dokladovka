import { describe, expect, it } from 'vitest';
import {
  buildWebhookPayload,
  deliverToWebhook,
  normalizeRecipients,
  sniffMimeType,
  type ParsedImapMessage,
} from './imapPoller.js';

const PDF_BYTES = Buffer.from('%PDF-1.7 fake obsah');
const JPEG_BYTES = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]);

const baseConfig = { extractionMaxFileBytes: 20 * 1024 * 1024, imap: { user: 'schranka@gmail.com' } };

function baseMessage(overrides: Partial<ParsedImapMessage> = {}): ParsedImapMessage {
  return {
    uid: 42,
    messageId: '<abc-123@mail.gmail.com>',
    senderEmail: 'Dodavatel@Example.sk',
    senderName: 'Dodávateľ s.r.o.',
    subject: 'Faktúra 2026/001',
    date: new Date('2026-07-16T08:00:00Z'),
    recipients: ['Doklady@Firma.sk'],
    attachments: [{ filename: 'faktura.pdf', contentType: 'application/pdf', content: PDF_BYTES }],
    ...overrides,
  };
}

describe('sniffMimeType', () => {
  it('rozpozná PDF a JPEG podľa magic bytes', () => {
    expect(sniffMimeType(PDF_BYTES)).toBe('application/pdf');
    expect(sniffMimeType(JPEG_BYTES)).toBe('image/jpeg');
  });

  it('neznámy obsah vráti undefined', () => {
    expect(sniffMimeType(Buffer.from('hello world'))).toBeUndefined();
  });
});

describe('normalizeRecipients', () => {
  it('normalizuje, deduplikuje a zahodí neplatné adresy', () => {
    expect(
      normalizeRecipients([' Doklady@Firma.sk ', 'doklady@firma.sk', 'nie-je-email', '']),
    ).toEqual(['doklady@firma.sk']);
  });

  it('bez platných adries použije fallback (IMAP_USER)', () => {
    expect(normalizeRecipients(['???'], 'Schranka@Gmail.com')).toEqual(['schranka@gmail.com']);
  });
});

describe('buildWebhookPayload', () => {
  it('mapuje správu na webhook payload', () => {
    const payload = buildWebhookPayload(baseMessage(), baseConfig);
    expect(payload.providerMessageId).toBe('<abc-123@mail.gmail.com>');
    expect(payload.envelopeRecipients).toEqual(['doklady@firma.sk']);
    expect(payload.senderEmail).toBe('dodavatel@example.sk');
    expect(payload.senderName).toBe('Dodávateľ s.r.o.');
    expect(payload.subject).toBe('Faktúra 2026/001');
    expect(payload.receivedAt).toBe('2026-07-16T08:00:00.000Z');
    expect(payload.attachments).toHaveLength(1);
    expect(payload.attachments[0]).toEqual({
      fileName: 'faktura.pdf',
      mimeType: 'application/pdf',
      contentBase64: PDF_BYTES.toString('base64'),
    });
  });

  it('bez Message-ID vytvorí deterministický fallback z UID', () => {
    const a = buildWebhookPayload(baseMessage({ messageId: undefined }), baseConfig);
    const b = buildWebhookPayload(baseMessage({ messageId: undefined }), baseConfig);
    expect(a.providerMessageId).toBe(b.providerMessageId);
    expect(a.providerMessageId).toContain('42');
  });

  it('PDF poslané ako octet-stream opraví podľa magic bytes', () => {
    const payload = buildWebhookPayload(
      baseMessage({
        attachments: [{ filename: 'scan.pdf', contentType: 'application/octet-stream', content: PDF_BYTES }],
      }),
      baseConfig,
    );
    expect(payload.attachments[0].mimeType).toBe('application/pdf');
  });

  it('neznámy typ ponechá declared contentType (webhook rozhodne o karanténe)', () => {
    const payload = buildWebhookPayload(
      baseMessage({
        attachments: [{ filename: 'data.xml', contentType: 'application/xml; charset=utf-8', content: Buffer.from('<xml/>') }],
      }),
      baseConfig,
    );
    expect(payload.attachments[0].mimeType).toBe('application/xml');
  });

  it('príloha bez mena dostane fallback názov', () => {
    const payload = buildWebhookPayload(
      baseMessage({ attachments: [{ content: PDF_BYTES }] }),
      baseConfig,
    );
    expect(payload.attachments[0].fileName).toBe('attachment');
  });
});

describe('deliverToWebhook', () => {
  it('posiela POST s payloadom a secret hlavičkou', async () => {
    let captured: { url: string; init: RequestInit } | undefined;
    const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
      captured = { url: String(url), init: init! };
      return new Response(JSON.stringify({ id: 'x', duplicate: false, queued: 1, status: 'queued' }), {
        status: 202,
        headers: { 'content-type': 'application/json' },
      });
    }) as typeof fetch;

    const payload = buildWebhookPayload(baseMessage(), baseConfig);
    const result = await deliverToWebhook(payload, {
      apiBaseUrl: 'http://localhost:3001',
      webhookSecret: 'tajomstvo',
      fetchImpl,
    });

    expect(result.ok).toBe(true);
    expect(result.status).toBe(202);
    expect(captured?.url).toBe('http://localhost:3001/api/webhooks/inbound-email/imap');
    expect((captured?.init.headers as Record<string, string>)['x-dokladovka-webhook-secret']).toBe('tajomstvo');
    expect(JSON.parse(String(captured?.init.body)).providerMessageId).toBe('<abc-123@mail.gmail.com>');
  });

  it('chybový stav vráti ok=false', async () => {
    const fetchImpl = (async () => new Response('nope', { status: 401 })) as typeof fetch;
    const result = await deliverToWebhook(buildWebhookPayload(baseMessage(), baseConfig), {
      apiBaseUrl: 'http://localhost:3001',
      fetchImpl,
    });
    expect(result.ok).toBe(false);
    expect(result.status).toBe(401);
  });
});

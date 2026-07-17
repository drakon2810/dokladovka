// IMAP → inbound webhook mapping. Čistá logika bez sieťových závislostí,
// aby sa dala testovať samostatne; sieťový cyklus žije v server/imap.ts.
import type { ServerConfig } from '../config.js';

export interface ImapAttachment {
  filename?: string;
  contentType?: string;
  content: Buffer;
}

/** Zúžený tvar výsledku mailparsera — len polia, ktoré potrebujeme. */
export interface ParsedImapMessage {
  uid: number;
  messageId?: string;
  senderEmail?: string;
  senderName?: string;
  subject?: string;
  date?: Date;
  /** To/Cc/Delivered-To/X-Original-To — surové hodnoty, ešte nenormalizované. */
  recipients: string[];
  attachments: ImapAttachment[];
}

export interface WebhookAttachmentPayload {
  fileName: string;
  mimeType: string;
  contentBase64: string;
}

export interface WebhookPayload {
  providerMessageId: string;
  envelopeRecipients: string[];
  senderEmail?: string;
  senderName?: string;
  subject?: string;
  receivedAt?: string;
  attachments: WebhookAttachmentPayload[];
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
const MAX_ATTACHMENTS = 20;

/** Rovnaká detekcia ako v inbound webhooku — declared MIME musí sedieť s obsahom. */
export function sniffMimeType(bytes: Uint8Array): string | undefined {
  if (bytes.length >= 5 && Buffer.from(bytes.slice(0, 5)).toString('ascii') === '%PDF-') return 'application/pdf';
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'image/jpeg';
  if (bytes.length >= 8 && Buffer.from(bytes.slice(0, 8)).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return 'image/png';
  if (bytes.length >= 12 && Buffer.from(bytes.slice(0, 4)).toString('ascii') === 'RIFF'
    && Buffer.from(bytes.slice(8, 12)).toString('ascii') === 'WEBP') return 'image/webp';
  const head = Buffer.from(bytes.slice(0, 256)).toString('utf8').replace(/^﻿/, '').trimStart();
  if (head.startsWith('<?xml') || head.startsWith('<')) return 'application/xml';
  return undefined;
}

/** Normalizácia adries: trim + lowercase, len syntakticky platné, bez duplicít. */
export function normalizeRecipients(raw: string[], fallback?: string): string[] {
  const seen = new Set<string>();
  for (const value of raw) {
    const normalized = value.trim().toLowerCase();
    if (EMAIL_RE.test(normalized)) seen.add(normalized);
  }
  if (seen.size === 0 && fallback) {
    const normalizedFallback = fallback.trim().toLowerCase();
    if (EMAIL_RE.test(normalizedFallback)) seen.add(normalizedFallback);
  }
  return [...seen].slice(0, 20);
}

/**
 * Prevod sparsovaného e-mailu na payload inbound webhooku.
 * Idempotencia: providerMessageId = Message-ID (fallback na účet+UID),
 * takže opakované spracovanie tej istej správy webhook odmietne ako duplicate.
 */
export function buildWebhookPayload(
  message: ParsedImapMessage,
  config: Pick<ServerConfig, 'extractionMaxFileBytes'> & { imap: { user?: string } },
): WebhookPayload {
  const providerMessageId = (message.messageId?.trim() || `${message.uid}@imap.${message.senderEmail ?? 'unknown'}`)
    .slice(0, 300);

  const attachments: WebhookAttachmentPayload[] = [];
  for (const attachment of message.attachments.slice(0, MAX_ATTACHMENTS)) {
    // Gmail občas posiela PDF ako application/octet-stream; magic bytes sú
    // spoľahlivejšie než declared contentType. Webhook si detekciu zopakuje.
    const sniffed = sniffMimeType(attachment.content);
    attachments.push({
      fileName: (attachment.filename?.trim() || 'attachment').slice(0, 255),
      mimeType: (sniffed ?? attachment.contentType?.split(';')[0].trim() ?? 'application/octet-stream').slice(0, 120),
      contentBase64: attachment.content.toString('base64'),
    });
  }

  return {
    providerMessageId,
    envelopeRecipients: normalizeRecipients(message.recipients, config.imap.user),
    senderEmail: message.senderEmail && EMAIL_RE.test(message.senderEmail.trim().toLowerCase())
      ? message.senderEmail.trim().toLowerCase()
      : undefined,
    senderName: message.senderName?.slice(0, 200) || undefined,
    subject: message.subject?.slice(0, 500) || undefined,
    receivedAt: message.date && !Number.isNaN(message.date.getTime()) ? message.date.toISOString() : undefined,
    attachments,
  };
}

/** POST payloadu na lokálny inbound webhook. Vracia true pri úspechu (2xx). */
export async function deliverToWebhook(
  payload: WebhookPayload,
  options: { apiBaseUrl: string; webhookSecret?: string; fetchImpl?: typeof fetch },
): Promise<{ ok: boolean; status: number; body?: unknown }> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (options.webhookSecret) headers['x-dokladovka-webhook-secret'] = options.webhookSecret;
  const response = await fetchImpl(`${options.apiBaseUrl}/api/webhooks/inbound-email/imap`, {
    method: 'POST',
    headers,
    body: JSON.stringify(payload),
  });
  let body: unknown;
  try {
    body = await response.json();
  } catch {
    body = undefined;
  }
  return { ok: response.ok, status: response.status, body };
}

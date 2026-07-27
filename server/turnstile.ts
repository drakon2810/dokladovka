import type { FastifyRequest } from 'fastify';
import type { ServerConfig } from './config.js';
import { HttpError } from './http.js';

const VERIFY_URL = 'https://challenges.cloudflare.com/turnstile/v0/siteverify';

/**
 * Overenie Cloudflare Turnstile tokenu. Bez TURNSTILE_SECRET_KEY (dev, testy)
 * je captcha vypnutá — inak by sa lokálne nedalo prihlásiť ani registrovať.
 */
export async function verifyTurnstile(
  config: ServerConfig,
  token: string | undefined,
  request: FastifyRequest,
): Promise<void> {
  const secret = config.turnstile.secretKey;
  if (!secret) return;
  if (!token) throw new HttpError(400, 'captcha_required', 'Potvrďte, že nie ste robot');

  const body = new URLSearchParams({ secret, response: token, remoteip: request.ip });
  let success = false;
  try {
    const response = await fetch(VERIFY_URL, { method: 'POST', body, signal: AbortSignal.timeout(10_000) });
    const result = response.ok ? ((await response.json()) as { success?: unknown; 'error-codes'?: unknown }) : null;
    success = result?.success === true;
    if (!success) {
      // Bez tohto logu vyzerá zlý TURNSTILE_SECRET_KEY rovnako ako neúspešný
      // pokus používateľa — a captcha ticho odmieta úplne všetkých.
      request.log.warn(
        { status: response.status, errorCodes: result?.['error-codes'] ?? null, url: request.url },
        'turnstile_rejected',
      );
    }
  } catch (cause) {
    request.log.warn({ err: cause, url: request.url }, 'turnstile_unreachable');
    success = false;
  }
  if (!success) throw new HttpError(400, 'captcha_invalid', 'Overenie captcha zlyhalo, skúste to znova');
}

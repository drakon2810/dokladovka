import { t } from '../../i18n/sk';

/** Chyba samoobslužných auth tokov. `message` chodí zo servera už po slovensky. */
export class AuthApiError extends Error {
  constructor(public readonly code: string, message: string) {
    super(message);
    this.name = 'AuthApiError';
  }
}

async function post(path: string, body: Record<string, unknown>): Promise<Record<string, unknown>> {
  let response: Response;
  try {
    response = await fetch(path, {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
  } catch {
    throw new AuthApiError('unavailable', t('auth.nedostupne'));
  }
  const data = (await response.json().catch(() => null)) as Record<string, unknown> | null;
  if (response.ok) return data ?? {};
  const error = data as { code?: string; message?: string } | null;
  throw new AuthApiError(error?.code ?? 'unavailable', error?.message || t('auth.nedostupne'));
}

/** Vracia registrationId — potvrdenie kódu je viazané naň, nie na e-mail. */
export async function requestRegistration(input: {
  name: string;
  email: string;
  password: string;
  captchaToken: string;
}): Promise<string> {
  const data = await post('/api/auth/register', input);
  if (typeof data.registrationId !== 'string') throw new AuthApiError('unavailable', t('auth.nedostupne'));
  return data.registrationId;
}

export async function confirmRegistration(input: { registrationId: string; code: string }): Promise<void> {
  await post('/api/auth/register/confirm', input);
}

export async function requestPasswordReset(input: { email: string; captchaToken: string }): Promise<void> {
  await post('/api/auth/password/forgot', input);
}

export async function resetPassword(input: { token: string; password: string }): Promise<void> {
  await post('/api/auth/password/reset', input);
}

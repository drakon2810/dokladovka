import {
  createCipheriv, createDecipheriv, createHash, randomBytes, randomInt,
  scrypt as scryptCallback, timingSafeEqual,
} from 'node:crypto';
import { promisify } from 'node:util';

const scrypt = promisify(scryptCallback);

export function randomToken(bytes = 32): string {
  return randomBytes(bytes).toString('base64url');
}

export function sha256(value: string | Uint8Array): string {
  return createHash('sha256').update(value).digest('hex');
}

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const derived = await scrypt(password, salt, 64) as Buffer;
  return `scrypt$${salt.toString('base64url')}$${derived.toString('base64url')}`;
}

export async function verifyPassword(password: string, encoded: string): Promise<boolean> {
  const [algorithm, saltValue, hashValue] = encoded.split('$');
  if (algorithm !== 'scrypt' || !saltValue || !hashValue) return false;
  const salt = Buffer.from(saltValue, 'base64url');
  const expected = Buffer.from(hashValue, 'base64url');
  const actual = await scrypt(password, salt, expected.length) as Buffer;
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

export function constantTimeStringEqual(actual: string, expected: string): boolean {
  const actualHash = createHash('sha256').update(actual).digest();
  const expectedHash = createHash('sha256').update(expected).digest();
  return timingSafeEqual(actualHash, expectedHash);
}

/** Číselný kód do e-mailu (potvrdenie registrácie). */
export function createNumericCode(length = 6): string {
  return Array.from({ length }, () => String(randomInt(10))).join('');
}

export function createPairingCode(): string {
  const alphabet = '23456789ABCDEFGHJKLMNPQRSTUVWXYZ';
  const bytes = randomBytes(8);
  const raw = Array.from(bytes, (value) => alphabet[value % alphabet.length]).join('');
  return `${raw.slice(0, 4)}-${raw.slice(4)}`;
}

/**
 * Šifrovanie secretov, ktoré musia ležať v databáze v čitateľnej podobe pre
 * server, ale nie pre nikoho, kto sa dostane k zálohe databázy — dnes refresh
 * token k SharePointu.
 *
 * Prečo vôbec: heslá sa hashujú (späť ich netreba), ale refresh token server
 * musí vedieť prečítať, aby sa ním prihlásil. Hash je tu nepoužiteľný.
 *
 * AES-256-GCM, kľúč z SECRET_ENCRYPTION_KEY (base64, presne 32 bajtov).
 * Vygeneruje sa:  node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"
 *
 * Formát: v1.<iv>.<tag>.<šifrovaný text>, všetko base64. Verzia je vpredu, aby
 * sa dal algoritmus vymeniť bez hádania, čím bol starý záznam zašifrovaný.
 */
export function secretKey(rawKey: string | undefined): Buffer {
  if (!rawKey) {
    throw new Error('SECRET_ENCRYPTION_KEY nie je nastavený — bez neho sa nedá uložiť pripojenie na SharePoint');
  }
  const key = Buffer.from(rawKey, 'base64');
  if (key.byteLength !== 32) {
    throw new Error(`SECRET_ENCRYPTION_KEY musí byť base64 s 32 bajtmi (má ${key.byteLength})`);
  }
  return key;
}

export function encryptSecret(plain: string, rawKey: string | undefined): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', secretKey(rawKey), iv);
  const encrypted = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  return ['v1', iv.toString('base64'), cipher.getAuthTag().toString('base64'), encrypted.toString('base64')].join('.');
}

export function decryptSecret(payload: string, rawKey: string | undefined): string {
  const [version, iv, tag, encrypted] = payload.split('.');
  if (version !== 'v1' || !iv || !tag || !encrypted) {
    throw new Error('Zašifrovaná hodnota má neznámy formát');
  }
  const decipher = createDecipheriv('aes-256-gcm', secretKey(rawKey), Buffer.from(iv, 'base64'));
  decipher.setAuthTag(Buffer.from(tag, 'base64'));
  // Pri zlom kľúči alebo zmenenom texte hodí GCM chybu — mlčky nesprávny
  // výsledok nevráti, čo je práve to, čo od autentifikovanej šifry chceme.
  return Buffer.concat([decipher.update(Buffer.from(encrypted, 'base64')), decipher.final()]).toString('utf8');
}

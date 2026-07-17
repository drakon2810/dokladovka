// Verejná display-konfigurácia Fázy 1. NIE JE to secret ani zdroj pravdy
// pre produkčné adresy — vo Fáze 2 frontend dostáva hotové adresy z API
// a MAIL_RECEIVING_DOMAIN zostáva výhradne server-side (SPEC §11.25).
// TODO: integration point — nahradiť config endpointom backendu.

const configuredMailDomain = (
  import.meta.env?.VITE_PUBLIC_MAIL_RECEIVING_DOMAIN as string | undefined
)?.trim().toLowerCase();

if (!configuredMailDomain || !/^[a-z0-9.-]+\.[a-z]{2,}$/.test(configuredMailDomain)) {
  throw new Error('VITE_PUBLIC_MAIL_RECEIVING_DOMAIN musí obsahovať platnú verejnú doménu');
}

export const PUBLIC_MAIL_RECEIVING_DOMAIN: string = configuredMailDomain;

/** Mock tenant Fázy 1 — multi-tenant hranice vynúti backend vo Fáze 2. */
export const MOCK_TENANT_ID = 'tenant-demo';

export const EMAIL_ALIAS_TOKEN_LENGTH = 6;

/** Mock hodnota; produkčný lifecycle riadi server-side EMAIL_ALIAS_GRACE_DAYS. */
export const EMAIL_ALIAS_GRACE_DAYS = 30;

/** Podporované typy príloh pre prvú reálnu verziu (SPEC §11.8). */
export const SUPPORTED_ATTACHMENT_MIME_TYPES = [
  'application/pdf',
  'image/jpeg',
  'image/png',
  'image/webp',
  // PEPPOL BIS 3.0 e-faktúry; backend ne-PEPPOL XML odmieta.
  'application/xml',
] as const;

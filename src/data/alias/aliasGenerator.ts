// Generovanie e-mail aliasov organizácií — SPEC §11.3.
// Formula: {organizationSlug}-{randomToken}@{MAIL_RECEIVING_DOMAIN}
// Čisté funkcie bez závislosti na store — rovnaká logika pôjde vo Fáze 2 na backend.

export const MAX_LOCAL_PART_LENGTH = 64;

/** Lowercase base32 bez vizuálne nejednoznačných znakov 0/o/1/l (SPEC §11.3). */
export const ALIAS_TOKEN_ALPHABET = 'abcdefghijkmnpqrstuvwxyz23456789';

export const DEFAULT_TOKEN_LENGTH = 6;
export const MAX_COLLISION_ATTEMPTS = 10;

/** Fallback slug, ak po normalizácii nič nezostane (SPEC §11.3). */
export const FALLBACK_SLUG = 'firma';

// Právne prípony sa odstraňujú iba pre pohodlie adresy;
// oficiálny názov organizácie v dátach sa nemení (SPEC §11.3).
const LEGAL_SUFFIX_PATTERNS: RegExp[] = [
  /\bspol\.?\s*s\s*r\.?\s*o\.?/gi, // spol. s r.o.
  /\bs\.?\s*r\.?\s*o\.?(?=\s|$|[^a-z])/gi, // s.r.o., s. r. o.
  /\ba\.\s*s\.?(?=\s|$|[^a-z])/gi, // a.s., a. s.
  /\bv\.?\s*o\.?\s*s\.?(?=\s|$|[^a-z])/gi, // v.o.s.
  /\bk\.\s*s\.?(?=\s|$|[^a-z])/gi, // k.s.
  /\bs\.\s*p\.?(?=\s|$|[^a-z])/gi, // š.p. po odstránení diakritiky
];

/** Odstráni diakritiku: `Čučoriedka` → `Cucoriedka`. */
export function removeDiacritics(value: string): string {
  return value.normalize('NFD').replace(/[̀-ͯ]/g, '');
}

/**
 * Slug z názvu organizácie podľa SPEC §11.3:
 * lowercase, bez diakritiky, bez právnych prípon, iba [a-z0-9-],
 * medzery/nepovolené sekvencie → jediné `-`, orezané `-` na krajoch,
 * dĺžka obmedzená tak, aby celý local-part neprekročil 64 znakov.
 */
export function slugifyOrganizationName(
  nazov: string,
  maxLength: number = MAX_LOCAL_PART_LENGTH - 1 - DEFAULT_TOKEN_LENGTH,
): string {
  let slug = removeDiacritics(nazov).toLowerCase();
  for (const pattern of LEGAL_SUFFIX_PATTERNS) {
    slug = slug.replace(pattern, ' ');
  }
  slug = slug
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/-{2,}/g, '-')
    .replace(/^-+|-+$/g, '');
  if (slug.length > maxLength) {
    slug = slug.slice(0, maxLength).replace(/-+$/g, '');
  }
  return slug.length > 0 ? slug : FALLBACK_SLUG;
}

/**
 * Kryptograficky náhodný token — crypto.getRandomValues, nikdy Math.random()
 * (SPEC §11.3). Token nie je secret ani heslo.
 */
export function generateAliasToken(length: number = DEFAULT_TOKEN_LENGTH): string {
  if (length < 6 || length > 8) {
    throw new Error('Token musí mať 6–8 znakov (SPEC §11.3)');
  }
  const alphabet = ALIAS_TOKEN_ALPHABET;
  // rejection sampling — bez modulo biasu
  const maxValid = Math.floor(256 / alphabet.length) * alphabet.length;
  const chars: string[] = [];
  const buf = new Uint8Array(length * 2);
  while (chars.length < length) {
    crypto.getRandomValues(buf);
    for (const byte of buf) {
      if (byte < maxValid) {
        chars.push(alphabet[byte % alphabet.length]);
        if (chars.length === length) break;
      }
    }
  }
  return chars.join('');
}

export interface GeneratedAlias {
  address: string;
  addressNormalized: string;
  localPart: string;
  slug: string;
  token: string;
  domain: string;
}

export function buildAliasAddress(slug: string, token: string, domain: string): GeneratedAlias {
  const localPart = `${slug}-${token}`;
  const address = `${localPart}@${domain}`.toLowerCase();
  return {
    address,
    addressNormalized: address, // porovnávať case-insensitive, ukladať lowercase
    localPart,
    slug,
    token,
    domain: domain.toLowerCase(),
  };
}

export interface GenerateUniqueAliasOptions {
  nazov: string;
  domain: string;
  /** true, ak je normalizovaná adresa už obsadená (mock unikátneho DB indexu) */
  isTaken: (addressNormalized: string) => boolean;
  tokenLength?: number;
  slugSuggestion?: string;
}

/**
 * Vygeneruje unikátny alias; pri kolízii vygeneruje nový token a opakuje
 * (mock transakčného retry zo SPEC §11.3).
 */
export function generateUniqueAlias(options: GenerateUniqueAliasOptions): GeneratedAlias {
  const tokenLength = options.tokenLength ?? DEFAULT_TOKEN_LENGTH;
  const maxSlugLength = MAX_LOCAL_PART_LENGTH - 1 - tokenLength;
  const rawSlugSource =
    options.slugSuggestion && options.slugSuggestion.trim().length > 0
      ? options.slugSuggestion
      : options.nazov;
  const slug = slugifyOrganizationName(rawSlugSource, maxSlugLength);

  for (let attempt = 0; attempt < MAX_COLLISION_ATTEMPTS; attempt++) {
    const token = generateAliasToken(tokenLength);
    const candidate = buildAliasAddress(slug, token, options.domain);
    if (!options.isTaken(candidate.addressNormalized)) {
      return candidate;
    }
  }
  throw new Error('Nepodarilo sa vygenerovať unikátny alias — priveľa kolízií');
}

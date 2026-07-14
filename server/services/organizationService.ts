import { randomBytes, randomUUID } from 'node:crypto';
import type { Database, Queryable } from '../db/database.js';
import { HttpError } from '../http.js';

const TOKEN_ALPHABET = '23456789abcdefghjkmnpqrstuvwxyz';

export function organizationSlug(name: string): string {
  const normalized = name
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/\b(s\.?\s*r\.?\s*o\.?|a\.?\s*s\.?)\b/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return (normalized || 'firma').slice(0, 48).replace(/-+$/g, '') || 'firma';
}

function aliasToken(length = 6): string {
  const bytes = randomBytes(length);
  return Array.from(bytes, (value) => TOKEN_ALPHABET[value % TOKEN_ALPHABET.length]).join('');
}

export interface AliasRecord {
  id: string;
  tenantId: string;
  organizationId: string;
  address: string;
  addressNormalized: string;
  localPart: string;
  domain: string;
  slugAtCreation: string;
  token: string;
  status: 'active' | 'grace_period' | 'disabled';
  isPrimary: boolean;
  createdAt: string;
  graceUntil?: string;
  disabledAt?: string;
}

export async function insertUniqueAlias(
  queryable: Queryable,
  input: { tenantId: string; organizationId: string; organizationName: string; domain: string; primary: boolean },
): Promise<AliasRecord> {
  const slug = organizationSlug(input.organizationName);
  for (let attempt = 0; attempt < 10; attempt += 1) {
    const token = aliasToken();
    const maxSlugLength = Math.max(1, 64 - token.length - 1);
    const localPart = `${slug.slice(0, maxSlugLength).replace(/-+$/g, '') || 'firma'}-${token}`;
    const address = `${localPart}@${input.domain}`;
    const existing = await queryable.query('SELECT 1 FROM organization_email_aliases WHERE address_normalized = $1', [address]);
    if (existing.rowCount > 0) continue;
    const id = randomUUID();
    const createdAt = new Date().toISOString();
    await queryable.query(
      `INSERT INTO organization_email_aliases
        (id, tenant_id, organization_id, address, address_normalized, local_part, domain,
         slug_at_creation, token, status, is_primary, created_at)
       VALUES ($1,$2,$3,$4,$4,$5,$6,$7,$8,'active',$9,$10)`,
      [id, input.tenantId, input.organizationId, address, localPart, input.domain, slug, token, input.primary, createdAt],
    );
    return {
      id,
      tenantId: input.tenantId,
      organizationId: input.organizationId,
      address,
      addressNormalized: address,
      localPart,
      domain: input.domain,
      slugAtCreation: slug,
      token,
      status: 'active',
      isPrimary: input.primary,
      createdAt,
    };
  }
  throw new HttpError(409, 'alias_collision', 'Nepodarilo sa vytvoriť unikátny e-mailový alias');
}

export async function organizationBelongsToTenant(database: Database, tenantId: string, organizationId: string): Promise<boolean> {
  const result = await database.query(
    'SELECT 1 FROM organizations WHERE id = $1 AND tenant_id = $2',
    [organizationId, tenantId],
  );
  return result.rowCount > 0;
}

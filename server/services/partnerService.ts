import { randomUUID } from 'node:crypto';
import type { Queryable } from '../db/database.js';
import type { ParovacieKriterium } from './accountingProfileService.js';

// Partneri (kontrahenti) — automatické zakladanie z dokladov a párovanie
// dodávateľa podľa priority z účtovného profilu (IČO → IČ DPH → IBAN → názov).

export interface PartnerZaznam {
  id: string;
  tenantId: string;
  organizationId: string;
  nazov: string;
  ico?: string;
  dic?: string;
  icDph?: string;
  iban?: string;
  adresa?: string;
  email?: string;
  telefon?: string;
  predvolenaPredkontaciaId?: string;
  predvoleneClenenieDphId?: string;
  predvoleneStrediskoId?: string;
  poznamka?: string;
  source: 'auto' | 'manual';
  active: boolean;
  createdAt?: string;
  updatedAt?: string;
}

export interface DodavatelNaDoklade {
  nazov?: string;
  ico?: string;
  dic?: string;
  icDph?: string;
  iban?: string;
  adresa?: string;
}

export function normalizovanyNazov(value: string | undefined): string {
  return value?.trim().toLocaleLowerCase('sk').replace(/\s+/g, ' ') ?? '';
}

function cistyKod(value: string | undefined): string {
  return value?.replace(/\s+/g, '').toUpperCase() ?? '';
}

function cisteIco(value: string | undefined): string {
  return value?.replace(/\D/g, '') ?? '';
}

export function mapPartnerRow(row: Record<string, unknown>): PartnerZaznam {
  return {
    id: String(row.id),
    tenantId: String(row.tenant_id),
    organizationId: String(row.organization_id),
    nazov: String(row.name),
    ico: (row.ico as string | null) ?? undefined,
    dic: (row.dic as string | null) ?? undefined,
    icDph: (row.ic_dph as string | null) ?? undefined,
    iban: (row.iban as string | null) ?? undefined,
    adresa: (row.address as string | null) ?? undefined,
    email: (row.email as string | null) ?? undefined,
    telefon: (row.phone as string | null) ?? undefined,
    predvolenaPredkontaciaId: (row.default_predkontacia_id as string | null) ?? undefined,
    predvoleneClenenieDphId: (row.default_clenenie_dph_id as string | null) ?? undefined,
    predvoleneStrediskoId: (row.default_stredisko_id as string | null) ?? undefined,
    poznamka: (row.note as string | null) ?? undefined,
    source: row.source as PartnerZaznam['source'],
    active: row.active === true,
    createdAt: row.created_at ? new Date(String(row.created_at)).toISOString() : undefined,
    updatedAt: row.updated_at ? new Date(String(row.updated_at)).toISOString() : undefined,
  };
}

const PREDVOLENA_PRIORITA: ParovacieKriterium[] = ['ico', 'ic_dph', 'iban', 'nazov'];

async function prioritaParovania(
  tx: Queryable,
  tenantId: string,
  organizationId: string,
): Promise<ParovacieKriterium[]> {
  const profile = await tx.query<{ parovanie_dodavatelov?: ParovacieKriterium[] } & Record<string, unknown>>(
    'SELECT parovanie_dodavatelov FROM organization_accounting_profiles WHERE organization_id=$1 AND tenant_id=$2',
    [organizationId, tenantId],
  );
  const priorita = profile.rows[0]?.parovanie_dodavatelov;
  return Array.isArray(priorita) && priorita.length > 0 ? priorita : PREDVOLENA_PRIORITA;
}

/** Nájde aktívneho partnera podľa priority párovania z účtovného profilu. */
export async function najdiPartnera(
  tx: Queryable,
  tenantId: string,
  organizationId: string,
  dodavatel: DodavatelNaDoklade,
): Promise<PartnerZaznam | undefined> {
  const partneri = await tx.query<Record<string, unknown>>(
    'SELECT * FROM partners WHERE tenant_id=$1 AND organization_id=$2 AND active=true',
    [tenantId, organizationId],
  );
  if (partneri.rows.length === 0) return undefined;
  const zoznam = partneri.rows.map(mapPartnerRow);
  const priorita = await prioritaParovania(tx, tenantId, organizationId);
  for (const kriterium of priorita) {
    const match = zoznam.find((partner) => {
      switch (kriterium) {
        case 'ico':
          return Boolean(cisteIco(dodavatel.ico)) && cisteIco(partner.ico) === cisteIco(dodavatel.ico);
        case 'ic_dph':
          return Boolean(cistyKod(dodavatel.icDph)) && cistyKod(partner.icDph) === cistyKod(dodavatel.icDph);
        case 'iban':
          return Boolean(cistyKod(dodavatel.iban)) && cistyKod(partner.iban) === cistyKod(dodavatel.iban);
        case 'nazov':
          return Boolean(normalizovanyNazov(dodavatel.nazov))
            && normalizovanyNazov(partner.nazov) === normalizovanyNazov(dodavatel.nazov);
        default:
          return false;
      }
    });
    if (match) return match;
  }
  return undefined;
}

/**
 * Založí partnera z dodávateľa na doklade, alebo doplní chýbajúce polia
 * existujúceho partnera (nikdy neprepisuje ručne vyplnené hodnoty).
 */
export async function upsertPartnerZDokladu(
  tx: Queryable,
  input: { tenantId: string; organizationId: string; dodavatel: DodavatelNaDoklade },
): Promise<PartnerZaznam | undefined> {
  const nazov = input.dodavatel.nazov?.trim();
  if (!nazov) return undefined;
  const existujuci = await najdiPartnera(tx, input.tenantId, input.organizationId, input.dodavatel);
  if (existujuci) {
    await tx.query(
      `UPDATE partners SET
         ico=COALESCE(ico, $1), dic=COALESCE(dic, $2), ic_dph=COALESCE(ic_dph, $3),
         iban=COALESCE(iban, $4), address=COALESCE(address, $5), updated_at=now()
       WHERE id=$6 AND tenant_id=$7`,
      [input.dodavatel.ico ?? null, input.dodavatel.dic ?? null, input.dodavatel.icDph ?? null,
        input.dodavatel.iban ?? null, input.dodavatel.adresa ?? null, existujuci.id, input.tenantId],
    );
    return existujuci;
  }
  const id = randomUUID();
  await tx.query(
    `INSERT INTO partners
      (id, tenant_id, organization_id, name, name_normalized, ico, dic, ic_dph, iban, address, source)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'auto')`,
    [id, input.tenantId, input.organizationId, nazov, normalizovanyNazov(nazov),
      input.dodavatel.ico ?? null, input.dodavatel.dic ?? null, input.dodavatel.icDph ?? null,
      input.dodavatel.iban ?? null, input.dodavatel.adresa ?? null],
  );
  const created = await tx.query<Record<string, unknown>>(
    'SELECT * FROM partners WHERE id=$1 AND tenant_id=$2', [id, input.tenantId],
  );
  return created.rows[0] ? mapPartnerRow(created.rows[0]) : undefined;
}

import type { Queryable } from '../db/database.js';

// DPH profil klienta — typy zdieľané medzi routami, snapshotom a dphAdvisorom.
// Polia zodpovedajú stĺpcom organization_dph_profiles (0010_dph_profile.sql).

export interface DphKoeficientZaznam {
  rok: number;
  typ: 'zalohovy' | 'rocny';
  hodnota: number;
  platnostOd?: string;
  platnostDo?: string;
}

export interface DphPravidloOdpoctu {
  kategoria: string;
  percento: number;
  klucoveSlova: string[];
}

export interface DphKategoriaBezNaroku {
  kategoria: string;
  klucoveSlova: string[];
}

export interface DphProfil {
  organizationId: string;
  tenantId: string;
  platitelDph: 'platitel' | 'neplatitel' | 'registracia_7a';
  obdobieDph: 'mesacne' | 'stvrtrocne';
  uzavreteDo?: string;
  koeficient: DphKoeficientZaznam[];
  pomerneOdpocitanie: DphPravidloOdpoctu[];
  rezim: 'tuzemsky' | 'zahranicny';
  nakupyZEu: boolean;
  sluzbyZEu: boolean;
  prenesenieDp: boolean;
  pravidlaAut: DphPravidloOdpoctu[];
  bezNaroku: DphKategoriaBezNaroku[];
  samozdanenieAktivne: boolean;
  samozdanenieClenenieDphId?: string;
  samozdanenieClenenieKvKod?: string;
  clenenieBezOdpoctuId?: string;
  updatedAt?: string;
}

export function mapDphProfilRow(row: Record<string, unknown>): DphProfil {
  return {
    organizationId: String(row.organization_id),
    tenantId: String(row.tenant_id),
    platitelDph: row.platitel_dph as DphProfil['platitelDph'],
    obdobieDph: row.obdobie_dph as DphProfil['obdobieDph'],
    uzavreteDo: row.uzavrete_do
      ? new Date(String(row.uzavrete_do)).toISOString().slice(0, 10)
      : undefined,
    koeficient: (row.koeficient as DphKoeficientZaznam[] | null) ?? [],
    pomerneOdpocitanie: (row.pomerne_odpocitanie as DphPravidloOdpoctu[] | null) ?? [],
    rezim: row.rezim as DphProfil['rezim'],
    nakupyZEu: row.nakupy_z_eu === true,
    sluzbyZEu: row.sluzby_z_eu === true,
    prenesenieDp: row.prenesenie_dp === true,
    pravidlaAut: (row.pravidla_aut as DphPravidloOdpoctu[] | null) ?? [],
    bezNaroku: (row.bez_naroku as DphKategoriaBezNaroku[] | null) ?? [],
    samozdanenieAktivne: row.samozdanenie_aktivne === true,
    samozdanenieClenenieDphId: (row.samozdanenie_clenenie_dph_id as string | null) ?? undefined,
    samozdanenieClenenieKvKod: (row.samozdanenie_clenenie_kv_kod as string | null) ?? undefined,
    clenenieBezOdpoctuId: (row.clenenie_bez_odpoctu_id as string | null) ?? undefined,
    updatedAt: row.updated_at ? new Date(String(row.updated_at)).toISOString() : undefined,
  };
}

export async function loadDphProfil(
  db: Queryable,
  tenantId: string,
  organizationId: string,
): Promise<DphProfil | undefined> {
  const result = await db.query<Record<string, unknown>>(
    'SELECT * FROM organization_dph_profiles WHERE organization_id=$1 AND tenant_id=$2',
    [organizationId, tenantId],
  );
  return result.rows[0] ? mapDphProfilRow(result.rows[0]) : undefined;
}

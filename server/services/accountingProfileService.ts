import type { Queryable } from '../db/database.js';

// Účtovný profil klienta — typy zdieľané medzi routami a snapshotom.
// Polia zodpovedajú stĺpcom organization_accounting_profiles (0011).

export type ParovacieKriterium = 'ico' | 'ic_dph' | 'iban' | 'nazov';

export interface UctovnyRozvrhRiadok {
  ucet: string;
  nazov: string;
  analytiky: string[];
}

export interface UctovnyProfil {
  organizationId: string;
  tenantId: string;
  obdobieUctovania: 'mesacne' | 'stvrtrocne';
  zaokruhlovanieCelkom: 'centy' | 'pat_centov' | 'eura';
  zaokruhlovanieDph: 'matematicky' | 'nahor' | 'nadol';
  parovanieDodavatelov: ParovacieKriterium[];
  uctovnyRozvrh: UctovnyRozvrhRiadok[];
  updatedAt?: string;
}

export function mapUctovnyProfilRow(row: Record<string, unknown>): UctovnyProfil {
  return {
    organizationId: String(row.organization_id),
    tenantId: String(row.tenant_id),
    obdobieUctovania: row.obdobie_uctovania as UctovnyProfil['obdobieUctovania'],
    zaokruhlovanieCelkom: row.zaokruhlovanie_celkom as UctovnyProfil['zaokruhlovanieCelkom'],
    zaokruhlovanieDph: row.zaokruhlovanie_dph as UctovnyProfil['zaokruhlovanieDph'],
    parovanieDodavatelov: (row.parovanie_dodavatelov as ParovacieKriterium[] | null)
      ?? ['ico', 'ic_dph', 'iban', 'nazov'],
    uctovnyRozvrh: (row.uctovny_rozvrh as UctovnyRozvrhRiadok[] | null) ?? [],
    updatedAt: row.updated_at ? new Date(String(row.updated_at)).toISOString() : undefined,
  };
}

export async function loadUctovnyProfil(
  db: Queryable,
  tenantId: string,
  organizationId: string,
): Promise<UctovnyProfil | undefined> {
  const result = await db.query<Record<string, unknown>>(
    'SELECT * FROM organization_accounting_profiles WHERE organization_id=$1 AND tenant_id=$2',
    [organizationId, tenantId],
  );
  return result.rows[0] ? mapUctovnyProfilRow(result.rows[0]) : undefined;
}

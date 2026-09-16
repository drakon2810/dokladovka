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
  /**
   * Podiel DANE, keď sa líši od podielu základu. Pri aute používanom aj
   * súkromne je to bežné: základ sa delí 80/20 (§ 19 ods. 2 písm. l) zákona
   * o dani z príjmov), ale odpočet dane je od 2026 spravidla polovičný (§ 85n
   * zákona o DPH) — dve rôzne dane, dve rôzne čísla. Bez neho daň sleduje základ.
   */
  percentoDph?: number;
  /**
   * Obdobie, v ktorom pravidlo platí (deň plnenia, vrátane oboch hraníc). Režim
   * § 85n platí od 1. 1. 2026 — to isté pravidlo na plnení z roku 2025 by
   * odpočet krátilo neprávom. Bez dátumov platí vždy.
   */
  platnostOd?: string;
  platnostDo?: string;
  /**
   * Účty oboch častí. Kým ich pravidlo nemá, ostáva iba upozornením a pokynom
   * do promptu — rozrezať doklad sa s percentom bez účtov nedá.
   */
  predkontaciaId?: string;
  predkontaciaNedanovaId?: string;
  /**
   * Členenie DPH nedaňovej časti. Sekciu KV nedaňová časť nemá vlastnú: kým nesie
   * časť dane, patrí s faktúrou do B2/B3 hlavičky; KN len bez dane.
   */
  clenenieDphNedanoveId?: string;
}

export interface DphKategoriaBezNaroku {
  kategoria: string;
  klucoveSlova: string[];
}

export interface DphProfil {
  organizationId: string;
  tenantId: string;
  /** nezname = profil nevyplnený; uložiť sa nedá, len predvolený profil ho nesie. */
  platitelDph: 'platitel' | 'neplatitel' | 'registracia_7a' | 'nezname';
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

/**
 * Profil firmy, ktorá ho ešte nevyplnila. Kontroly viazané na nastavenie
 * (koeficient, uzavreté obdobie, samozdanenie, kategórie bez nároku) tak ostanú
 * ticho, ale kontroly, ktoré vyplývajú zo samotného dokladu — cudzia daň
 * zahraničného dodávateľa — bežia aj bez vyplneného profilu. Predtým sa bez
 * riadku v `organization_dph_profiles` nespustila ani jedna.
 */
export function predvolenyDphProfil(tenantId: string, organizationId: string): DphProfil {
  return {
    organizationId,
    tenantId,
    // Nie „platiteľ": firma bez profilu sa tak tichým predpokladom stala
    // platiteľom s nárokom na odpočet. Kým to účtovník nevyplní, nevieme.
    platitelDph: 'nezname',
    obdobieDph: 'stvrtrocne',
    koeficient: [],
    pomerneOdpocitanie: [],
    rezim: 'tuzemsky',
    nakupyZEu: false,
    sluzbyZEu: false,
    prenesenieDp: false,
    pravidlaAut: [],
    bezNaroku: [],
    samozdanenieAktivne: false,
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

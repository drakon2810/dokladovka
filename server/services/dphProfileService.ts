import type { Queryable } from '../db/database.js';
import { kodyHodnoty, type DruhSamozdanenia } from './profilKatalog.js';

// DPH profil klienta pre engine, poradcu a asistenta — zložený LEN z faktov
// profilu, ktoré účtovník potvrdil (profil_fakty). Navrhnuté z histórie engine
// nevidí. Kódy POHODY sa tu prekladajú na aktívne id číselníka firmy; fakt
// (alebo položka poľa) s kódom, ktorý firma aktívny nemá, sa ignoruje.

export type { DruhSamozdanenia };

export interface SamozdanenieDruh {
  faktura?: { clenenieKod: string; clenenieDphId?: string; kv?: string };
  interny?: { ddKod: string; ddPredkontaciaKod?: string; pKod?: string; pPredkontaciaKod?: string; kv?: string };
}

export interface DphPravidloOdpoctu {
  kategoria: string;
  /** Podiel ZÁKLADU — daňový náklad (§ 19 ods. 2 písm. l) ZDP). */
  percento: number;
  klucoveSlova: string[];
  /**
   * Podiel DANE, keď sa líši od podielu základu. Pri aute používanom aj
   * súkromne je to bežné: základ 80/20, odpočet dane polovičný — dve rôzne dane,
   * dve rôzne čísla. Bez neho daň sleduje základ.
   */
  percentoDph?: number;
  predkontaciaId?: string;
  predkontaciaNedanovaId?: string;
  /** Len na týchto typoch dokladov; bez neho na všetkých. */
  typyDokladov?: string[];
  /** Členenie DPH nedaňovej časti; sekciu KV dedí z hlavičky, kým nesie časť dane. */
  clenenieDphNedanoveId?: string;
  /** Kódy tých istých účtov — pokyny modelu nesú kódy, nie id. */
  predkontaciaKod?: string;
  predkontaciaNedanovaKod?: string;
  clenenieDphNedanoveKod?: string;
}

export interface DphProfil {
  organizationId: string;
  tenantId: string;
  /** registracia_7 sa správa ako §7a; bez potvrdeného statusu nezname. */
  platitelDph: 'platitel' | 'neplatitel' | 'registracia_7a' | 'nezname';
  clenenieBezOdpoctuId?: string;
  clenenieBezOdpoctuKod?: string;
  oslobodenePlnenia?: boolean;
  koeficient?: number;
  samozdanenie: Partial<Record<DruhSamozdanenia, SamozdanenieDruh>>;
  vratenieDph?: { uplatnujeme: boolean; predkontaciaId?: string; predkontaciaKod?: string };
  /** Z vozidla.pravidla: percento = daňový náklad, percentoDph = odpočet. */
  pravidlaAut: DphPravidloOdpoctu[];
  /** Z naklady.pomerne (§ 49 ods. 4): obe časti na tom istom účte, percento = percentoDph. */
  pomerneOdpocitanie: DphPravidloOdpoctu[];
  bezNarokuUcty: Array<{ predkontaciaKod: string; predkontaciaId: string; clenenieKod: string; clenenieDphId: string }>;
  tovarNaCeste?: boolean;
  drobnyMajetokHranica?: number;
}

/**
 * Profil firmy, ktorá nemá potvrdený ani jeden fakt. Kontroly viazané na
 * nastavenie mlčia, ale kontroly zo samotného dokladu — cudzia daň zahraničného
 * dodávateľa, kandidát na samozdanenie — bežia aj bez profilu.
 */
export function predvolenyDphProfil(tenantId: string, organizationId: string): DphProfil {
  return {
    organizationId,
    tenantId,
    // Nie „platiteľ": kým to účtovník nepotvrdí, nevieme.
    platitelDph: 'nezname',
    samozdanenie: {},
    pravidlaAut: [],
    pomerneOdpocitanie: [],
    bezNarokuUcty: [],
  };
}

/**
 * Potvrdené fakty firmy zložené do profilu. `knownAt` (meranie presnosti)
 * pustí len fakty potvrdené pred týmto okamihom — odpoveď účtovníka z budúcnosti
 * by inak meraný doklad naučila to, čo v jeho čase nikto nevedel.
 *
 * ponytail: fakt nemá dátum platnosti, takže doklad z minulého roka dostane
 * dnešnú hodnotu aj mimo merania (dodatočné priznanie); časovú os pridať, až
 * keď firma naozaj zmení prax a treba účtovať obe obdobia.
 */
export async function loadDphProfil(
  db: Queryable,
  tenantId: string,
  organizationId: string,
  moznosti: { knownAt?: string } = {},
): Promise<DphProfil | undefined> {
  const fakty = (await db.query<{ kluc: string; hodnota: any } & Record<string, unknown>>(
    `SELECT kluc, hodnota FROM profil_fakty
      WHERE tenant_id=$1 AND organization_id=$2 AND stav='potvrdene'
        AND ($3::timestamptz IS NULL OR potvrdene_at < $3::timestamptz)`,
    [tenantId, organizationId, moznosti.knownAt ?? null],
  )).rows;
  if (fakty.length === 0) return undefined;
  const aktivne = new Map((await db.query<{ kind: string; code: string; id: string } & Record<string, unknown>>(
    `SELECT kind, btrim(code) AS code, id FROM code_list_items
      WHERE tenant_id=$1 AND organization_id=$2 AND active=true AND kind IN ('predkontacie','cleneniaDph')`,
    [tenantId, organizationId],
  )).rows.map((row) => [`${row.kind}:${row.code}`, row.id]));
  const predkontacia = (kod: string) => aktivne.get(`predkontacie:${kod}`)!;
  const clenenie = (kod: string) => aktivne.get(`cleneniaDph:${kod}`)!;
  const preloziSa = (hodnota: unknown) => {
    const kody = kodyHodnoty(hodnota);
    return kody.predkontacie.every((kod) => aktivne.has(`predkontacie:${kod}`))
      && kody.cleneniaDph.every((kod) => aktivne.has(`cleneniaDph:${kod}`));
  };

  const profil = predvolenyDphProfil(tenantId, organizationId);
  for (const { kluc, hodnota } of fakty) {
    // Pole (pravidlá, účty) stratí len nepreložiteľnú položku, jednoduchý fakt celý.
    if (!Array.isArray(hodnota) && !preloziSa(hodnota)) continue;
    const polozky: any[] = Array.isArray(hodnota) ? hodnota.filter(preloziSa) : [];
    switch (kluc) {
      case 'dph.status':
        profil.platitelDph = hodnota.status === 'registracia_7' ? 'registracia_7a' : hodnota.status;
        break;
      case 'dph.clenenie_bez_odpoctu':
        profil.clenenieBezOdpoctuKod = hodnota.clenenieKod;
        profil.clenenieBezOdpoctuId = clenenie(hodnota.clenenieKod);
        break;
      case 'dph.oslobodene_plnenia':
        profil.oslobodenePlnenia = hodnota.ano;
        profil.koeficient = hodnota.koeficient;
        break;
      case 'zahranicie.vratenie_dph':
        profil.vratenieDph = {
          uplatnujeme: hodnota.uplatnujeme,
          ...(hodnota.predkontaciaKod ? { predkontaciaKod: hodnota.predkontaciaKod, predkontaciaId: predkontacia(hodnota.predkontaciaKod) } : {}),
        };
        break;
      case 'vozidla.pravidla':
        profil.pravidlaAut = polozky.map((pravidlo) => ({
          kategoria: pravidlo.nazov, percento: pravidlo.percentoZakladu, percentoDph: pravidlo.percentoDph,
          klucoveSlova: pravidlo.klucoveSlova,
          ...(pravidlo.typyDokladov?.length ? { typyDokladov: pravidlo.typyDokladov } : {}),
          predkontaciaKod: pravidlo.predkontaciaKod, predkontaciaId: predkontacia(pravidlo.predkontaciaKod),
          predkontaciaNedanovaKod: pravidlo.predkontaciaNedanovaKod, predkontaciaNedanovaId: predkontacia(pravidlo.predkontaciaNedanovaKod),
          ...(pravidlo.clenenieDphNedanoveKod
            ? { clenenieDphNedanoveKod: pravidlo.clenenieDphNedanoveKod, clenenieDphNedanoveId: clenenie(pravidlo.clenenieDphNedanoveKod) } : {}),
        }));
        break;
      case 'naklady.pomerne':
        // Obe časti na tom istom účte: rez delí základ aj daň v tom istom pomere
        // a neodpočítaná časť dostane členenie bez nároku.
        profil.pomerneOdpocitanie = polozky.map((pravidlo) => ({
          kategoria: pravidlo.nazov, percento: pravidlo.percentoDph, percentoDph: pravidlo.percentoDph,
          klucoveSlova: pravidlo.klucoveSlova,
          predkontaciaKod: pravidlo.predkontaciaKod, predkontaciaId: predkontacia(pravidlo.predkontaciaKod),
          predkontaciaNedanovaKod: pravidlo.predkontaciaKod, predkontaciaNedanovaId: predkontacia(pravidlo.predkontaciaKod),
          clenenieDphNedanoveKod: pravidlo.clenenieDphNedanoveKod, clenenieDphNedanoveId: clenenie(pravidlo.clenenieDphNedanoveKod),
        }));
        break;
      case 'naklady.bez_naroku':
        profil.bezNarokuUcty = polozky.map((ucet) => ({
          predkontaciaKod: ucet.predkontaciaKod, predkontaciaId: predkontacia(ucet.predkontaciaKod),
          clenenieKod: ucet.clenenieKod, clenenieDphId: clenenie(ucet.clenenieKod),
        }));
        break;
      case 'zasady.tovar_na_ceste':
        profil.tovarNaCeste = hodnota.pouziva;
        break;
      case 'zasady.drobny_majetok':
        profil.drobnyMajetokHranica = hodnota.hranica;
        break;
      default:
        if (kluc.startsWith('samozdanenie.')) {
          profil.samozdanenie[kluc.slice('samozdanenie.'.length) as DruhSamozdanenia] = {
            ...hodnota,
            ...(hodnota.faktura ? { faktura: { ...hodnota.faktura, clenenieDphId: clenenie(hodnota.faktura.clenenieKod) } } : {}),
          };
        }
    }
  }
  return profil;
}

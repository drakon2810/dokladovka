// Čo táto firma bežne účtuje a do ktorej agendy — pre krok „čo je to za papier".
//
// Návrh zaúčtovania sa pamäte firmy pýta na desiatich miestach. Klasifikácia
// nie: dostávala súbor, jeho názov a IČO klienta, a rozhodovala podľa pravidiel
// rovnakých pre všetkých. Preto taliansky verbale di contravvenzione skončil
// ako „iný doklad" a doklad vôbec nevznikol — hoci ALPINA má kategóriu
// „pokuty a úroky z omeškania" s agendami FP/OZ/VPD/INT a v jej slovníku leží
// priamo slovo „verb".
//
// Odpoveď bola v dátach, len sa jej nikto nepýtal. Profil ju modelu podá.
import { randomUUID } from 'node:crypto';
import type { Queryable } from '../db/database.js';

/** Koľko kategórií a fráz sa vojde do promptu, aby nezožrali kontext. */
const MAX_KATEGORII = 40;
const MAX_FRAZ = 6;

interface KategoriaRiadok extends Record<string, unknown> {
  nazov: string;
  agendy: unknown;
  slovnik: unknown;
}

function polePolozky(hodnota: unknown): string[] {
  return Array.isArray(hodnota) ? hodnota.filter((item): item is string => typeof item === 'string') : [];
}

/**
 * Riadok profilu: „OZ, VPD, FP | pokuty a úroky z omeškania | pokuta, verb, upomienka".
 *
 * Zámerne text, nie JSON — model ho číta ako zoznam a nemíňa tokeny na zátvorky.
 */
export async function profilPreKlasifikaciu(
  database: Queryable,
  scope: { tenantId: string; organizationId: string },
): Promise<string | undefined> {
  const kategorie = await database.query<KategoriaRiadok>(
    `SELECT nazov, agendy, slovnik FROM ucto_kategorie
      WHERE tenant_id=$1 AND organization_id=$2
      ORDER BY jsonb_array_length(slovnik) DESC
      LIMIT ${MAX_KATEGORII}`,
    [scope.tenantId, scope.organizationId],
  );
  const riadky = kategorie.rows.flatMap((row) => {
    const agendy = polePolozky(row.agendy);
    if (agendy.length === 0) return [];
    const frazy = polePolozky(row.slovnik).slice(0, MAX_FRAZ);
    return [`${agendy.join(', ')} | ${row.nazov}${frazy.length > 0 ? ` | ${frazy.join(', ')}` : ''}`];
  });
  // Opravy účtovníka idú do TOHO ISTÉHO zoznamu ako kategórie z POHODY. Nová
  // firma tak štartuje na svojej histórii a ďalej sa zlepšuje vlastnými
  // opravami — bez druhého mechanizmu, ktorý by sa musel udržiavať zvlášť.
  const vsetky = [...riadky, ...await opravyDoProfilu(database, scope)];
  return vsetky.length > 0 ? vsetky.join('\n') : undefined;
}

/** Koľko opráv typu sa pribalí — novšie prekrývajú staršie zvyklosti. */
const MAX_OPRAV = 15;

interface OpravaRiadok extends Record<string, unknown> {
  novy_typ: string;
  supplier_name_normalized: string | null;
  text_normalized: string | null;
}

/**
 * Zapíše, že účtovník prepol typ dokladu.
 *
 * Ukladá sa dodávateľ a text — to, čo sa dá porovnať s ďalším papierom. Bez
 * toho sa oprava stratí a rovnaký doklad prejde nabudúce tou istou chybou.
 */
export async function zapisOpravuTypu(
  database: Queryable,
  vstup: {
    tenantId: string; organizationId: string; documentId: string;
    povodnyTyp: string; novyTyp: string; userId?: string;
    dodavatel?: string; text?: string;
  },
): Promise<void> {
  if (vstup.povodnyTyp === vstup.novyTyp) return;
  await database.query(
    `INSERT INTO typ_opravy
      (id, tenant_id, organization_id, document_id, supplier_name_normalized, text_normalized,
       povodny_typ, novy_typ, created_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
    [randomUUID(), vstup.tenantId, vstup.organizationId, vstup.documentId,
      vstup.dodavatel?.trim().toLocaleLowerCase('sk').slice(0, 300) || null,
      vstup.text?.trim().toLocaleLowerCase('sk').slice(0, 500) || null,
      vstup.povodnyTyp, vstup.novyTyp, vstup.userId ?? null],
  );
}

/** Riadky profilu z opráv účtovníka — tie isté „agenda | čo | podľa čoho". */
async function opravyDoProfilu(
  database: Queryable,
  scope: { tenantId: string; organizationId: string },
): Promise<string[]> {
  // Kľúčom je dodávateľ (alebo text), NIE dvojica s typom: účtovník mohol ten
  // istý doklad prepnúť dvakrát — najprv na FP, potom na OZ. Dedupovanie cez
  // typ by do profilu poslalo obe verzie naraz a model by čítal, že ten istý
  // dodávateľ je aj FP aj OZ. Platí posledné slovo.
  const opravy = await database.query<OpravaRiadok>(
    `SELECT DISTINCT ON (coalesce(supplier_name_normalized, text_normalized))
            novy_typ, supplier_name_normalized, text_normalized
       FROM typ_opravy
      WHERE tenant_id=$1 AND organization_id=$2
        AND (supplier_name_normalized IS NOT NULL OR text_normalized IS NOT NULL)
      ORDER BY coalesce(supplier_name_normalized, text_normalized), created_at DESC
      LIMIT ${MAX_OPRAV}`,
    [scope.tenantId, scope.organizationId],
  );
  return opravy.rows.map((row) => {
    const podla = [row.supplier_name_normalized, row.text_normalized?.slice(0, 80)]
      .filter(Boolean).join(', ');
    return `${row.novy_typ} | opravil účtovník | ${podla}`;
  });
}

/**
 * Pomôcky pre číslovanie dokladov podľa číselných radov z POHODY.
 *
 * POHODA v exporte číselného radu vracia `topNumber` — najvyššie doteraz
 * použité číslo. Ďalší doklad v rade logicky pokračuje hodnotou +1, pričom sa
 * zachová šírka (počet číslic) aj prípadný textový prefix/suffix v čísle.
 */

/**
 * Číslo dokladu pre mzdy: mzdová páska ani rozbor miezd žiadne nenesú, účtovník
 * ho píše ako kód číselného radu + mesiac dokladu (`26MZD` + `03` → `26MZD03`).
 * Vráti `undefined`, kým nie je známy rad alebo dátum vystavenia.
 */
export function cisloMzdovehoDokladu(
  radKod: string | undefined,
  datumVystavenia: string | undefined,
): string | undefined {
  const kod = radKod?.trim();
  const mesiac = /^\d{4}-(\d{2})-\d{2}$/.exec(datumVystavenia?.trim() ?? '')?.[1];
  return kod && mesiac ? `${kod}${mesiac}` : undefined;
}

/** Doklad, ktorý si ešte len rezervuje číslo z radu. Prenesený má číslo od
 *  POHODY a zamietnutý si ho nikdy nevezme — tie sa nerátajú. */
export interface DokladVRade {
  id: string;
  orgId: string;
  status: string;
  ciselnyRadId?: string;
}

const UZ_NECERPA_CISLO = ['exportovany', 'zamietnuty'];

/**
 * Koľko ĎALŠÍCH dokladov čaká na to isté číslo z toho istého radu. POHODA
 * prideľuje najbližšie voľné číslo v okamihu prenosu, takže kým čaká viac
 * dokladov, konkrétne číslo nevie sľúbiť nikto — rozhodne poradie prenosu.
 * Detail dokladu preto pri nenulovom počte ukazuje „od <prvé voľné>".
 */
export function pocetCakajucichVRade(
  doklad: Omit<DokladVRade, 'status'>,
  vsetky: DokladVRade[],
): number {
  if (!doklad.ciselnyRadId) return 0;
  return vsetky.filter((item) => (
    item.id !== doklad.id
    && item.orgId === doklad.orgId
    && item.ciselnyRadId === doklad.ciselnyRadId
    && !UZ_NECERPA_CISLO.includes(item.status)
  )).length;
}

/**
 * Prvé voľné číslo radu zo zadaného posledného čísla, alebo `undefined`, ak
 * posledné číslo nie je známe alebo neobsahuje číslicovú časť.
 *
 * Príklady: `"0007" → "0008"`, `"2026FP0042" → "2026FP0043"`,
 * `"FA-00099" → "FA-00100"` (šírka sa rozšíri až pri pretečení).
 *
 * Rezervovať ním čísla dopredu (posunúť o počet čakajúcich dokladov) nemá
 * zmysel: POHODA prideľuje najbližšie voľné číslo v okamihu prenosu, takže
 * doklad prenesený mimo poradia dostane číslo, ktoré web sľúbil inému.
 */
export function nextNumberInSeries(last: string | undefined | null): string | undefined {
  const value = last?.trim();
  if (!value) return undefined;
  // Posledná súvislá číslicová skupina v reťazci je poradové číslo. Text pred
  // ňou (napr. rok/prefix radu) aj za ňou zostáva nezmenený.
  const match = value.match(/^(.*?)(\d+)(\D*)$/s);
  if (!match) return undefined;
  const [, prefix, digits, suffix] = match;
  const padded = String(Number(digits) + 1).padStart(digits.length, '0');
  return `${prefix}${padded}${suffix}`;
}

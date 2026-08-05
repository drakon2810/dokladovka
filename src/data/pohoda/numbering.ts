/**
 * Pomôcky pre číslovanie dokladov podľa číselných radov z POHODY.
 *
 * POHODA v exporte číselného radu vracia `topNumber` — najvyššie doteraz
 * použité číslo. Ďalší doklad v rade logicky pokračuje hodnotou +1, pričom sa
 * zachová šírka (počet číslic) aj prípadný textový prefix/suffix v čísle.
 */

/**
 * Vráti ďalšie číslo v rade zo zadaného posledného čísla, alebo `undefined`, ak
 * posledné číslo nie je známe alebo neobsahuje číslicovú časť.
 *
 * Príklady: `"0007" → "0008"`, `"2026FP0042" → "2026FP0043"`,
 * `"FA-00099" → "FA-00100"` (šírka sa rozšíri až pri pretečení).
 */
export function nextNumberInSeries(last: string | undefined | null, odstup = 0): string | undefined {
  const value = last?.trim();
  if (!value) return undefined;
  // Posledná súvislá číslicová skupina v reťazci je poradové číslo. Text pred
  // ňou (napr. rok/prefix radu) aj za ňou zostáva nezmenený.
  const match = value.match(/^(.*?)(\d+)(\D*)$/s);
  if (!match) return undefined;
  const [, prefix, digits, suffix] = match;
  // `odstup` = koľko dokladov pôjde do toho istého radu pred týmto. Bez neho by
  // všetky časti jedného rozdeleného súboru sľubovali to isté číslo.
  const next = String(Number(digits) + 1 + odstup);
  const padded = next.padStart(digits.length, '0');
  return `${prefix}${padded}${suffix}`;
}

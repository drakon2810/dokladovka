import { PDFDocument } from 'pdf-lib';

/**
 * Snímanie dokladov telefónom — čo sa dá overiť bez obrazovky.
 *
 * Dve úrovne: snímka je STRANA, viac strán je JEDEN doklad (faktúra na tri
 * listy), viac dokladov je dávka. Server robí jeden doklad z JEDNÉHO súboru
 * (ingestFiles), takže tri snímky poslané zvlášť by dali tri doklady — strany
 * sa preto zlepia do PDF ešte v telefóne.
 */

/** Dlhšia strana snímky po zmenšení. Na čítanie dokladu bohato stačí. */
export const MAX_HRANA = 2000;
/** Kvalita JPEG pri prekódovaní. Nižšie sa už drobné písmo rozpadá. */
export const KVALITA = 0.82;

export interface Strana {
  id: string;
  jpeg: Blob;
  nahlad: string;
}

export type StavDokladu = 'caka' | 'odosiela' | 'hotovo' | 'chyba';

export interface Doklad {
  id: string;
  strany: Strana[];
  stav: StavDokladu;
  chyba?: string;
}

let pocitadlo = 0;
export const noveId = (): string => `f${(pocitadlo += 1)}-${Date.now()}`;

/** Slovenské skloňovanie po číslovke — dávka aj počítadlo strán ho potrebujú. */
export function strany(pocet: number): string {
  if (pocet === 1) return 'strana';
  return pocet < 5 ? 'strany' : 'strán';
}

export function doklady(pocet: number): string {
  if (pocet === 1) return 'doklad';
  return pocet < 5 ? 'doklady' : 'dokladov';
}

/**
 * Právne formy do iniciálok nepatria. Bez nich by z „Recable, s.r.o." vyšlo
 * „RS" a zo „Zelený dvor, s.r.o." „ZD" — dve firmy s rovnakou formou by mali
 * dlaždice, ktoré sa líšia len prvým písmenom a druhé majú vždy rovnaké.
 */
const PRAVNE_FORMY = new Set(['s', 'r', 'o', 'a', 'sro', 'spol', 'as', 'ks', 'js', 'zo', 'ziv']);

/** Iniciálky firmy do dlaždice v zozname — z prvých dvoch významových slov. */
export function iniciality(nazov: string): string {
  const slova = nazov
    .split(/[\s,.]+/)
    .filter((slovo) => /[a-záäčďéíĺľňóôŕšťúýž]/i.test(slovo))
    .filter((slovo) => !PRAVNE_FORMY.has(slovo.toLocaleLowerCase('sk')));
  const prve = slova[0]?.[0] ?? '?';
  const druhe = slova[1]?.[0] ?? '';
  return (prve + druhe).toLocaleUpperCase('sk');
}

/**
 * Rozmery snímky po zmenšení. Vydelené kvôli testu: práve tu vzniká rozdiel
 * medzi „doklad sa dá prečítať" a „base64 prekročí limit požiadavky".
 */
export function rozmerPoZmenseni(sirka: number, vyska: number): { sirka: number; vyska: number } {
  const mierka = Math.min(1, MAX_HRANA / Math.max(sirka, vyska));
  return { sirka: Math.round(sirka * mierka), vyska: Math.round(vyska * mierka) };
}

/**
 * Zmenší a prekóduje na JPEG. Rieši tri veci naraz: HEIC z iPhonu (server ho
 * nepozná), veľkosť (base64 nafúkne o tretinu) aj otočenie podľa EXIF, ktoré
 * createImageBitmap spraví sám.
 */
export async function pripravSnimku(zdroj: Blob): Promise<Blob> {
  const bitmapa = await createImageBitmap(zdroj, { imageOrientation: 'from-image' });
  const { sirka, vyska } = rozmerPoZmenseni(bitmapa.width, bitmapa.height);
  const platno = document.createElement('canvas');
  platno.width = sirka;
  platno.height = vyska;
  const kontext = platno.getContext('2d');
  if (!kontext) throw new Error('canvas_nedostupny');
  kontext.drawImage(bitmapa, 0, 0, sirka, vyska);
  bitmapa.close();
  const blob = await new Promise<Blob | null>((hotovo) =>
    platno.toBlob(hotovo, 'image/jpeg', KVALITA));
  if (!blob) throw new Error('canvas_nedostupny');
  return blob;
}

/** Strany jedného dokladu do jedného PDF — server tak vidí jeden doklad. */
export async function doPdf(zoznam: Strana[]): Promise<Blob> {
  const pdf = await PDFDocument.create();
  for (const strana of zoznam) {
    const obrazok = await pdf.embedJpg(await strana.jpeg.arrayBuffer());
    const stranaPdf = pdf.addPage([obrazok.width, obrazok.height]);
    stranaPdf.drawImage(obrazok, { x: 0, y: 0, width: obrazok.width, height: obrazok.height });
  }
  return new Blob([await pdf.save()], { type: 'application/pdf' });
}

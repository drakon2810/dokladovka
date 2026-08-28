// Sémantická podobnosť textov cez embeddingy.
//
// Prečo vôbec: kategórie plnenia sa vyberali výskytom podreťazca zo slovníka.
// Taliansky riadok „Intervento del 13/03/2026" netrafil kategóriu „Asistenčné
// služby a odťah vozidiel" ani jedným znakom, takže model dostal prázdny zoznam
// kategórií a predkontáciu volil podľa názvu z účtovného rozvrhu. Vektor tie dva
// texty spojí bez toho, aby účtovník dopisoval slová do slovníka.
//
// Doplnok, nie náhrada: lexikálna zhoda ostáva TVRDÝM dôkazom. Kosínus medzi
// nesúvisiacimi slovenskými účtovnými textami býva 0,3–0,5, takže absolútny prah
// by z „dôkazu" spravil prázdne slovo; a dva rôzne mesiace v texte sú si
// vektorovo takmer identické, hoci pre účtovníka sú to iné riadky.
import OpenAI from 'openai';
import type { ServerConfig } from '../config.js';

/** Minimálne rozhranie klienta — testy ho podstrkávajú namiesto siete. */
export interface Embedder {
  create(body: { model: string; input: string[] }): Promise<{ data: Array<{ embedding: number[] }> }>;
}

/**
 * Text kategórie pre vektor. Skladá ho JEDNA funkcia, lebo zápis (analýza
 * profilu) a čítanie (návrh zaúčtovania) žijú v iných súboroch — inak sa
 * predspracovanie časom rozíde a kosínus začne porovnávať iné veci.
 *
 * Veta, nie zoznam slov: krátky zoznam kľúčových slov proti vete z položiek je
 * klasický krátky-vs-dlhý prípad, kde poradie riadi dĺžka textu, nie význam.
 */
export function textPreVektor(nazov: string, popis: string | null | undefined, slovnik: unknown): string {
  const slova = Array.isArray(slovnik)
    ? slovnik.filter((slovo): slovo is string => typeof slovo === 'string' && slovo.trim().length > 0)
    : [];
  return [nazov, popis?.trim(), slova.join(', ')].filter(Boolean).join('. ').slice(0, 2000);
}

export function kosinus(a: readonly number[], b: readonly number[]): number {
  if (a.length === 0 || a.length !== b.length) return 0;
  let skalar = 0;
  let normaA = 0;
  let normaB = 0;
  for (let i = 0; i < a.length; i += 1) {
    skalar += a[i] * b[i];
    normaA += a[i] * a[i];
    normaB += b[i] * b[i];
  }
  if (normaA === 0 || normaB === 0) return 0;
  return skalar / Math.sqrt(normaA * normaB);
}

/** Vektor uložený v DB je použiteľný len s modelom, ktorým vznikol. */
export function vektorZRiadku(
  vektor: unknown,
  vektorModel: unknown,
  aktualnyModel: string,
): number[] | undefined {
  if (vektorModel !== aktualnyModel) return undefined;
  if (!Array.isArray(vektor) || vektor.length === 0) return undefined;
  return vektor.every((cislo) => typeof cislo === 'number' && Number.isFinite(cislo))
    ? (vektor as number[])
    : undefined;
}

/**
 * Vektory pre dávku textov. Vracia undefined, keď embedding nie je k dispozícii
 * — bez kľúča, alebo keď volanie zlyhá. Volajúci vtedy MUSÍ pokračovať
 * lexikálne: sémantika je vylepšenie, nie podmienka návrhu zaúčtovania.
 */
export async function vytvorVektory(
  config: ServerConfig,
  texty: readonly string[],
  injected?: Embedder,
): Promise<number[][] | undefined> {
  const pouzitelne = texty.filter((text) => text.trim().length > 0);
  if (pouzitelne.length === 0) return undefined;
  if (!injected && !config.openai.apiKey) return undefined;
  const klient = injected ?? (new OpenAI({
    apiKey: config.openai.apiKey,
    timeout: config.openai.timeoutMs,
    // Retry rieši durable job, nie SDK — inak by tri timeouty embeddingu
    // pridali 6 minút k spracovaniu JEDNÉHO dokladu.
    maxRetries: 0,
  }).embeddings as unknown as Embedder);
  try {
    const odpoved = await klient.create({
      model: config.openai.embeddingModel,
      input: texty.map((text) => text.trim() || ' '),
    });
    const vektory = odpoved.data.map((polozka) => polozka.embedding);
    return vektory.length === texty.length ? vektory : undefined;
  } catch (cause) {
    console.warn('[embedding] volanie zlyhalo, pokračujem lexikálne:',
      cause instanceof Error ? cause.message : cause);
    return undefined;
  }
}

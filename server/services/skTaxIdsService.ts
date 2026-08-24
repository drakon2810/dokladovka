// Daňové identifikátory slovenských firiem z OpenData API Finančnej správy SR.
// RPO (Štatistický úrad) zverejňuje len IČO, názov a sídlo — DIČ a IČ DPH sú
// v informačných zoznamoch FS, ktoré vyžadujú API kľúč. Kľúč je secret, takže
// volanie beží na serveri: v routách pre našepkávač organizácií a vo workeri
// pri oprave dodávateľa z dokladu.
import { textSimilarity } from './accountingSuggestionService.js';

const FS_BASE = 'https://iz.opendata.financnasprava.sk/api/data';
/** Zoznam daňových subjektov registrovaných na daň z príjmov — obsahuje DIČ. */
const LIST_INCOME_TAX = 'ds_dsrdp';
/** Zoznam subjektov registrovaných k DPH — obsahuje IČ DPH. */
const LIST_VAT = 'ds_dphs';

/** Externé API nesmie držať spracovanie dokladu — oprava je len bonus. */
const TIMEOUT_MS = 5_000;

interface FsRow {
  dic?: string;
  ic_dph?: string;
  nazov_ds?: string;
}

export interface SkDanoveIdentifikatory {
  dic?: string;
  icDph?: string;
  nazov?: string;
}

async function fsLookup(key: string, list: string, ico: string): Promise<FsRow | undefined> {
  const url = `${FS_BASE}/${list}/search?page=1&column=ico&search=${encodeURIComponent(ico)}`;
  const response = await fetch(url, { headers: { key }, signal: AbortSignal.timeout(TIMEOUT_MS) });
  // 404 = subjekt v zozname nie je (napr. neplatiteľ DPH) — nie je to chyba.
  if (!response.ok) return undefined;
  const body = (await response.json()) as { data?: FsRow[] };
  return body.data?.[0];
}

/** DIČ a IČ DPH slovenskej firmy podľa IČO; prázdne, keď v zoznamoch nie je. */
export async function najdiSkDanoveIdentifikatory(
  apiKey: string,
  ico: string,
): Promise<SkDanoveIdentifikatory> {
  const [danZPrijmov, dph] = await Promise.all([
    fsLookup(apiKey, LIST_INCOME_TAX, ico).catch(() => undefined),
    fsLookup(apiKey, LIST_VAT, ico).catch(() => undefined),
  ]);
  return {
    dic: danZPrijmov?.dic ?? undefined,
    icDph: dph?.ic_dph ?? undefined,
    nazov: danZPrijmov?.nazov_ds ?? dph?.nazov_ds ?? undefined,
  };
}

/** Slovenské IČ DPH je kód krajiny a desať číslic — nič iné POHODA neprijme. */
const SK_IC_DPH = /^SK\d{10}$/;

/**
 * Oprava daňových čísel slovenského dodávateľa podľa registra FS.
 *
 * Model číta IČ DPH z fotky bločka a jediná prehliadnutá číslica z neho spraví
 * neplatné číslo: doklad sa nedá schváliť a účtovník musí ručne opravovať to,
 * čo appka sama zle prečítala. Register je pre slovenskú firmu zdroj pravdy,
 * tak sa hodnota doplní odtiaľ.
 *
 * Zámerne opatrne:
 * - PLATNÉ číslo z dokladu sa neprepisuje — register dopĺňa len to, čo chýba
 *   alebo je formátom nepoužiteľné;
 * - zhoda názvu je podmienka, nie ozdoba: keď model prehliadne číslicu aj v
 *   IČO, register vráti INÚ firmu a jej IČ DPH by ticho prešlo do kontrolného
 *   výkazu. Radšej nechať doklad blokovaný, nech to človek uvidí.
 */
export async function opravSkDanoveCisla(
  apiKey: string | undefined,
  dodavatel: { nazov?: string; ico?: string; dic?: string; icDph?: string; krajina?: string },
): Promise<{ dic?: string; icDph?: string } | undefined> {
  const ico = String(dodavatel.ico ?? '').replace(/\D/g, '');
  const icDph = String(dodavatel.icDph ?? '').replace(/\s+/g, '').toUpperCase();
  const krajina = String(dodavatel.krajina ?? '').trim().toUpperCase();
  if (!apiKey || !/^\d{8}$/.test(ico)) return undefined;
  if (krajina && krajina !== 'SK') return undefined;
  if (SK_IC_DPH.test(icDph) && dodavatel.dic) return undefined;

  const register = await najdiSkDanoveIdentifikatory(apiKey, ico);
  if (!register.icDph && !register.dic) return undefined;
  if (register.nazov && textSimilarity(register.nazov, dodavatel.nazov ?? '') < 0.5) return undefined;

  const opravene: { dic?: string; icDph?: string } = {};
  if (register.icDph && !SK_IC_DPH.test(icDph)) opravene.icDph = register.icDph;
  if (register.dic && !dodavatel.dic) opravene.dic = register.dic;
  return Object.keys(opravene).length > 0 ? opravene : undefined;
}

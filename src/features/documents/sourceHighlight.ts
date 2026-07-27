// Zvýraznenie zdroja údajov (maketa „Zvýraznenie zdroja údajov" z Claude Design):
// jeden odtieň na sekciu panelu, ten istý odtieň dostane nadpis sekcie, pole
// vyplnené AI aj obdĺžnik nad zdrojovým textom v náhľade dokladu.
//
// Zdrojom pravdy je posledný úspešný beh extrakcie: evidence[] drží doslovný
// citát z dokladu (podľa neho sa hľadá text v PDF vrstve) a fieldConfidence
// istotu poľa. Hodnota, ktorú účtovník prepísal, farbu stráca — farba znamená
// „toto prišlo z dokladu", nie „toto je správne".
import type { DocumentExtractedData, ExtractionResult, ExtractionRun } from '../../data/types';

export interface SourceSection {
  n: number;
  title: string;
}

export const SOURCE_SECTIONS: SourceSection[] = [
  { n: 1, title: 'Základné údaje' },
  { n: 2, title: 'Dodávateľ' },
  { n: 3, title: 'Čiastka a DPH' },
  { n: 4, title: 'Platobné údaje' },
  { n: 5, title: 'Položky' },
];

/** Pole dokladu → sekcia panelu, v ktorej ho účtovník vidí. */
const FIELD_SECTION: Record<string, number> = {
  cisloFaktury: 1,
  datumVystavenia: 1,
  datumDodania: 1,
  datumSplatnosti: 1,
  sumaSpolu: 1,
  'dodavatel.nazov': 1,
  'dodavatel.ico': 2,
  'dodavatel.dic': 2,
  'dodavatel.icDph': 2,
  'dodavatel.adresa': 2,
  mena: 3,
  variabilnySymbol: 4,
  konstantnySymbol: 4,
  'dodavatel.iban': 4,
};

/** To isté pole v surovom výsledku AI — contract.ts používa anglické názvy. */
const WIRE_KEY: Record<string, string> = {
  cisloFaktury: 'invoiceNumber',
  datumVystavenia: 'issueDate',
  datumDodania: 'taxDate',
  datumSplatnosti: 'dueDate',
  sumaSpolu: 'totalAmount',
  mena: 'currency',
  variabilnySymbol: 'variableSymbol',
  konstantnySymbol: 'constantSymbol',
  'dodavatel.nazov': 'supplier.nazov',
  'dodavatel.ico': 'supplier.ico',
  'dodavatel.dic': 'supplier.dic',
  'dodavatel.icDph': 'supplier.icDph',
  'dodavatel.adresa': 'supplier.adresa',
  'dodavatel.iban': 'supplier.iban',
};

/** Sekcia „Položky" nemá jedno pole — obdĺžnik dostane celý blok riadkov. */
export const ITEMS_PATH = 'polozky';

export interface SourceField {
  /** Sekcia panelu (1–5) — určuje odtieň. */
  section: number;
  /** Hodnota tak, ako ju vrátila AI (surový reťazec z behu extrakcie). */
  ai: string;
  confidence?: number;
  /** Strana dokladu, na ktorej AI hodnotu našla. */
  page?: number;
  /** Doslovný citát z dokladu — vysvetlenie pri nízkej istote. */
  quote?: string;
  /** Reťazce, ktoré sa hľadajú v textovej vrstve PDF. */
  needles: string[];
}

export type SourceMap = Record<string, SourceField>;

/** Beh, ktorého výsledok je v doklade skutočne použitý (rovnako ako pri evidencii). */
function pickRun(runs: ExtractionRun[], appliedRunId?: string): ExtractionRun | undefined {
  return runs.find((item) => item.id === appliedRunId && item.status === 'succeeded' && item.result)
    ?? runs.find((item) => item.status === 'succeeded' && item.result);
}

function aiValue(result: ExtractionResult, path: string): string | undefined {
  const wire = WIRE_KEY[path];
  if (!wire) return undefined;
  const raw = wire.startsWith('supplier.')
    ? result.supplier[wire.slice('supplier.'.length) as keyof ExtractionResult['supplier']]
    : (result as unknown as Record<string, unknown>)[wire];
  const value = typeof raw === 'string' ? raw.trim() : undefined;
  return value ? value : undefined;
}

function currentValue(extracted: DocumentExtractedData, path: string): string {
  if (path.startsWith('dodavatel.')) {
    const key = path.slice('dodavatel.'.length) as keyof DocumentExtractedData['dodavatel'];
    return String(extracted.dodavatel[key] ?? '');
  }
  const value = (extracted as unknown as Record<string, unknown>)[path];
  return value === undefined || value === null ? '' : String(value);
}

const CURRENCY_SIGNS: Record<string, string> = { '€': 'EUR', $: 'USD', KČ: 'CZK' };

/** Porovnanie odolné voči medzerám a diakritike zápisu (IBAN, IČ DPH, meny). */
function squash(value: string): string {
  const flat = value.replace(/\s+/g, '').toUpperCase();
  return CURRENCY_SIGNS[flat] ?? flat;
}

function sameValue(path: string, ai: string, now: string): boolean {
  if (path === 'sumaSpolu') {
    const left = Number(ai.replace(',', '.'));
    const right = Number(now.replace(',', '.'));
    return Number.isFinite(left) && Number.isFinite(right) && Math.abs(left - right) < 0.005;
  }
  return squash(ai) === squash(now);
}

/** Zápisy tej istej hodnoty, ktoré sa reálne vyskytujú na dokladoch. */
function variants(value: string): string[] {
  const iso = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (iso) {
    const [, year, month, day] = iso;
    return [
      `${day}.${month}.${year}`,
      `${Number(day)}.${Number(month)}.${year}`,
      `${day}/${month}/${year}`,
      `${day}.${month}.${year.slice(2)}`,
    ];
  }
  if (/^-?\d+(?:[.,]\d+)?$/.test(value)) {
    return [value.replace('.', ','), value.replace(',', '.')];
  }
  return [];
}

/**
 * Hodnota kratšia ako 4 znaky (mena, sadzba) sa na doklade opakuje všade —
 * zvýrazňuje sa len vtedy, keď AI dodala citát s kontextom.
 */
const MIN_NEEDLE = 4;

function needlesFor(ai: string, quotes: string[]): string[] {
  const candidates = [...quotes, ai, ...variants(ai)];
  const unique = new Set<string>();
  for (const candidate of candidates) {
    const trimmed = candidate.trim();
    if (trimmed.replace(/\s+/g, '').length >= MIN_NEEDLE) unique.add(trimmed);
  }
  return [...unique];
}

/**
 * Mapa „pole panelu → čo o ňom vie AI". Závisí len na behoch extrakcie, nie na
 * rozpracovanom koncepte — vďaka tomu sa pri písaní do formulára neprekresľuje
 * textová vrstva PDF.
 */
export function buildSourceMap(runs: ExtractionRun[], appliedRunId?: string): SourceMap {
  const result = pickRun(runs, appliedRunId)?.result;
  if (!result) return {};

  const map: SourceMap = {};
  for (const [path, section] of Object.entries(FIELD_SECTION)) {
    const ai = aiValue(result, path);
    if (!ai) continue; // AI hodnotu nenašla → pole ostáva neutrálne
    const wire = WIRE_KEY[path];
    const quotes = (result.evidence[wire] ?? [])
      .map((item) => item.text?.trim())
      .filter((text): text is string => Boolean(text));
    map[path] = {
      section,
      ai,
      confidence: result.fieldConfidence[wire],
      page: result.evidence[wire]?.find((item) => item.page)?.page,
      quote: quotes[0],
      needles: needlesFor(ai, quotes),
    };
  }

  const popisy = result.lineItems
    .map((item) => item.description?.trim() ?? '')
    .filter((text) => text.replace(/\s+/g, '').length >= MIN_NEEDLE);
  if (popisy.length) {
    map[ITEMS_PATH] = { section: 5, ai: '', needles: [...new Set(popisy)] };
  }

  return map;
}

/** Polia, ktoré účtovník prepísal — zoradené, aby sa dali použiť ako memo kľúč. */
export function editedFields(map: SourceMap, extracted: DocumentExtractedData): string[] {
  return Object.entries(map)
    .filter(([path, field]) => path !== ITEMS_PATH && !sameValue(path, field.ai, currentValue(extracted, path)))
    .map(([path]) => path)
    .sort();
}

export interface SourceMark {
  anchor: string;
  section: number;
  edited: boolean;
  needle: string;
  re: RegExp;
}

function escapeRe(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * PDF vrstva láme text nepredvídateľne („R E C H N U N G", „DE68 2007 0000") —
 * medzi znakmi sa preto povoľuje ľubovoľná medzera a z ihly sa medzery zahodia.
 */
function needleRegex(needle: string): RegExp {
  const chars = [...needle.replace(/\s+/g, '')];
  return new RegExp(chars.map(escapeRe).join('\\s*'), 'i');
}

/**
 * Ihly pre jednu stranu, od najdlhšej — dlhší citát má prednosť pred holou
 * hodnotou, takže obdĺžnik obsiahne aj popisok („Faktúra č. 2024001").
 */
export function buildMarks(map: SourceMap, page: number, edited: ReadonlySet<string>): SourceMark[] {
  const marks: SourceMark[] = [];
  for (const [anchor, field] of Object.entries(map)) {
    // ponytail: strana z evidencie; keď ju AI neuvedie, ihla sa skúša na každej strane
    if (field.page && field.page !== page) continue;
    for (const needle of field.needles) {
      marks.push({ anchor, section: field.section, edited: edited.has(anchor), needle, re: needleRegex(needle) });
    }
  }
  return marks.sort((left, right) => right.needle.length - left.needle.length);
}

function esc(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

/**
 * customTextRenderer pre react-pdf: vráti HTML jednej položky textovej vrstvy
 * s obalenými nálezmi. Text ostáva priehľadný (kreslí ho canvas pod vrstvou),
 * viditeľné je len podfarbenie.
 */
export function highlightHtml(str: string, marks: SourceMark[]): string {
  if (!marks.length || !str.trim()) return esc(str);
  for (const mark of marks) {
    const found = mark.re.exec(str);
    if (!found || !found[0].trim()) continue;
    const hue = mark.edited ? 'dv-src-edited' : `dv-src-${mark.section}`;
    return esc(str.slice(0, found.index))
      + `<mark class="dv-src-mark ${hue}" data-src="${esc(mark.anchor)}" data-sec="${mark.section}">${esc(found[0])}</mark>`
      + highlightHtml(str.slice(found.index + found[0].length), marks);
  }
  return esc(str);
}

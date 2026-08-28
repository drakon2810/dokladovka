// Nové doklady ako neprečítaná pošta (maketa „Doklady 1a").
//
// „Nový" = prišiel po poslednej návšteve zoznamu a účtovník ho ešte neotvoril.
// Oboje je stav jedného človeka pri jednom prehliadači, nie fakt o doklade —
// preto localStorage a nie tabuľka: účtovníkovi by inak „prečítané" preskakovalo
// medzi kolegami a každé otvorenie dokladu by bol zápis do databázy.
import { create } from 'zustand';

const KLUC_PRECITANE = 'dokladovka.precitaneDoklady';
const KLUC_NAVSTEVA = 'dokladovka.poslednaNavsteva';
/** Strop zoznamu — staršie id sú aj tak pod poslednou návštevou. */
const MAX_ID = 500;

function nacitaj(): string[] {
  try {
    const raw = localStorage.getItem(KLUC_PRECITANE);
    const parsed = raw ? (JSON.parse(raw) as unknown) : [];
    return Array.isArray(parsed) ? parsed.filter((x): x is string => typeof x === 'string') : [];
  } catch {
    return [];
  }
}

function zapis(ids: string[]): void {
  try {
    localStorage.setItem(KLUC_PRECITANE, JSON.stringify(ids.slice(-MAX_ID)));
  } catch {
    // Súkromné okno alebo plná kvóta — zvýraznenie nie je dôvod zhodiť stránku.
  }
}

const usePrecitaneStore = create<{ ids: readonly string[] }>(() => ({ ids: nacitaj() }));

/** Prečítané doklady tohto prehliadača. Reaktívne — zoznam sa prekreslí sám. */
export const usePrecitane = (): ReadonlySet<string> => {
  const ids = usePrecitaneStore((stav) => stav.ids);
  return new Set(ids);
};

export function oznacPrecitany(id: string): void {
  const { ids } = usePrecitaneStore.getState();
  if (ids.includes(id)) return;
  const dalsie = [...ids, id].slice(-MAX_ID);
  usePrecitaneStore.setState({ ids: dalsie });
  zapis(dalsie);
}

export function oznacPrecitane(noveIds: readonly string[]): void {
  const { ids } = usePrecitaneStore.getState();
  const dalsie = [...new Set([...ids, ...noveIds])].slice(-MAX_ID);
  usePrecitaneStore.setState({ ids: dalsie });
  zapis(dalsie);
}

/**
 * Kedy bol zoznam naposledy otvorený. Číta sa RAZ pri vstupe na stránku —
 * keby sa čítalo priebežne, pás „od poslednej návštevy" by zmizol v tej istej
 * sekunde, v ktorej sa objaví.
 */
export function poslednaNavsteva(): string {
  try {
    return localStorage.getItem(KLUC_NAVSTEVA) ?? '';
  } catch {
    return '';
  }
}

export function zapisNavstevu(): void {
  try {
    localStorage.setItem(KLUC_NAVSTEVA, new Date().toISOString());
  } catch {
    // viď zapis()
  }
}

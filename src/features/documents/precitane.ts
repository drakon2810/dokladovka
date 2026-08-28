// Nové doklady ako neprečítaná pošta (maketa „Doklady 1a").
//
// „Nový" = prišiel po poslednej návšteve zoznamu a účtovník ho ešte neotvoril.
// Oboje je stav jedného človeka pri jednom prehliadači, nie fakt o doklade —
// preto localStorage a nie tabuľka: účtovníkovi by inak „prečítané" preskakovalo
// medzi kolegami a každé otvorenie dokladu by bol zápis do databázy.
import { create } from 'zustand';

const KLUC_PRECITANE = 'dokladovka.precitaneDoklady';
const KLUC_NAVSTEVA = 'dokladovka.poslednaNavsteva';
// Strop zoznamu prečítaných. Nad ním by najstaršie id vypadli a ich doklady by
// sa vrátili ako „nové" — preto je nastavený vysoko a „Označiť všetky ako
// prečítané" posúva zároveň značku návštevy, čím zoznam prestane rásť.
const MAX_ID = 2000;

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
 * Odkedy sa počítajú nové doklady. Pri prvom použití sa značka založí na
 * TERAZ — archív firmy nie je „nový" a pás s tisíckou dokladov by nič
 * nehovoril; doklad, ktorý príde od tejto chvíle, už nový je.
 *
 * Značka sa NEPOSÚVA pri každom otvorení zoznamu. Keby áno, otvorenie jednej
 * faktúry by pri návrate zhaslo aj ostatné, ktoré prišli s ňou — prečítané sa
 * preto držia po jednom dokladoch a značka sa posúva len na „Označiť všetky
 * ako prečítané".
 */
export function poslednaNavsteva(): string {
  try {
    const ulozena = localStorage.getItem(KLUC_NAVSTEVA);
    if (ulozena) return ulozena;
    const teraz = new Date().toISOString();
    localStorage.setItem(KLUC_NAVSTEVA, teraz);
    return teraz;
  } catch {
    return new Date().toISOString();
  }
}

export function zapisNavstevu(): void {
  try {
    localStorage.setItem(KLUC_NAVSTEVA, new Date().toISOString());
  } catch {
    // viď zapis()
  }
}

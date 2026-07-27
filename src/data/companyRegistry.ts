// Našepkávač firiem zo štátnych registrov — SK: RPO (Štatistický úrad SR),
// CZ: ARES (Ministerstvo financií ČR). Obe API sú verejné, bez kľúča a posielajú
// `Access-Control-Allow-Origin: *`, takže sa volajú priamo z prehliadača —
// žiadny vlastný proxy endpoint netreba.
// Iné krajiny sa zámerne nehľadajú (zadanie: len SK a CZ).

export interface CompanyHit {
  nazov: string;
  ico: string;
  /**
   * Daňové identifikátory vracia iba ARES (ČR) — DIČ je v Česku zároveň
   * IČ DPH. Slovenské RPO ich nezverejňuje vôbec (register obsahuje len IČO,
   * názov a sídlo), takže pri SK firmách ostávajú polia prázdne.
   */
  dic?: string;
  icDph?: string;
  ulica?: string;
  mesto?: string;
  psc?: string;
  krajina: string;
}

const MAX_HITS = 8;

/** „82412" → „824 12"; PSČ má v SK aj CZ 5 číslic písaných s medzerou. */
function formatPsc(value?: string | number): string | undefined {
  const digits = String(value ?? '').replace(/\D/g, '');
  if (digits.length !== 5) return digits || undefined;
  return `${digits.slice(0, 3)} ${digits.slice(3)}`;
}

// ===== SK: RPO =====

interface RpoPeriod {
  validTo?: string;
}

interface RpoAddress extends RpoPeriod {
  street?: string;
  buildingNumber?: string;
  regNumber?: number;
  postalCodes?: string[];
  municipality?: { value?: string };
  country?: { value?: string };
}

interface RpoEntity {
  identifiers?: Array<RpoPeriod & { value?: string }>;
  fullNames?: Array<RpoPeriod & { value?: string }>;
  addresses?: RpoAddress[];
}

/** Register vracia celú históriu; platný je záznam bez `validTo` (inak posledný). */
function current<T extends RpoPeriod>(items?: T[]): T | undefined {
  if (!items?.length) return undefined;
  return items.find((item) => !item.validTo) ?? items[items.length - 1];
}

function mapRpo(entity: RpoEntity): CompanyHit | undefined {
  const ico = current(entity.identifiers)?.value;
  const nazov = current(entity.fullNames)?.value;
  if (!ico || !nazov) return undefined;
  const address = current(entity.addresses);
  const cislo = address?.buildingNumber ?? (address?.regNumber ? String(address.regNumber) : undefined);
  return {
    nazov,
    ico,
    ulica: [address?.street, cislo].filter(Boolean).join(' ') || undefined,
    mesto: address?.municipality?.value,
    psc: formatPsc(address?.postalCodes?.[0]),
    krajina: address?.country?.value ?? 'Slovensko',
  };
}

async function searchRpo(query: string, byIco: boolean, signal?: AbortSignal): Promise<CompanyHit[]> {
  const params = new URLSearchParams(byIco ? { identifier: query } : { fullName: query });
  const response = await fetch(`https://api.statistics.sk/rpo/v1/search?${params}`, { signal });
  if (!response.ok) throw new Error('rpo_unavailable');
  const body = (await response.json()) as { results?: RpoEntity[] };
  return (body.results ?? []).slice(0, MAX_HITS).map(mapRpo).filter((hit): hit is CompanyHit => Boolean(hit));
}

// ===== CZ: ARES =====

interface AresSidlo {
  kodStatu?: string;
  nazevUlice?: string;
  cisloDomovni?: number;
  cisloOrientacni?: number;
  cisloOrientacniPismeno?: string;
  nazevObce?: string;
  psc?: number;
  nazevStatu?: string;
}

interface AresEntity {
  ico?: string;
  obchodniJmeno?: string;
  dic?: string;
  sidlo?: AresSidlo;
  seznamRegistraci?: { stavZdrojeDph?: string };
}

function mapAres(entity: AresEntity): CompanyHit | undefined {
  // ARES vracia aj zahraničné subjekty (napr. slovenské materské firmy) bez IČO —
  // tie by v CZ zozname len mýlili, takže ostávajú len české.
  if (!entity.ico || !entity.obchodniJmeno || entity.sidlo?.kodStatu !== 'CZ') return undefined;
  const sidlo = entity.sidlo;
  const orientacni = [sidlo.cisloOrientacni, sidlo.cisloOrientacniPismeno].filter(Boolean).join('');
  const cislo = [sidlo.cisloDomovni, orientacni].filter(Boolean).join('/');
  return {
    nazov: entity.obchodniJmeno,
    ico: entity.ico,
    dic: entity.dic,
    // V ČR je DIČ zároveň IČ DPH — ale len kým je subjekt reálne registrovaný
    // ako platiteľ. Neplatiteľ má DIČ tiež, IČ DPH nie.
    icDph: entity.seznamRegistraci?.stavZdrojeDph === 'AKTIVNI' ? entity.dic : undefined,
    ulica: [sidlo.nazevUlice, cislo].filter(Boolean).join(' ') || undefined,
    mesto: sidlo.nazevObce,
    psc: formatPsc(sidlo.psc),
    krajina: sidlo.nazevStatu ?? 'Česká republika',
  };
}

async function searchAres(query: string, byIco: boolean, signal?: AbortSignal): Promise<CompanyHit[]> {
  const response = await fetch(
    'https://ares.gov.cz/ekonomicke-subjekty-v-be/rest/ekonomicke-subjekty/vyhledat',
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(byIco ? { ico: [query], pocet: MAX_HITS } : { obchodniJmeno: query, pocet: MAX_HITS }),
      signal,
    },
  );
  if (!response.ok) throw new Error('ares_unavailable');
  const body = (await response.json()) as { ekonomickeSubjekty?: AresEntity[] };
  return (body.ekonomickeSubjekty ?? []).map(mapAres).filter((hit): hit is CompanyHit => Boolean(hit));
}

/**
 * DIČ a IČ DPH slovenskej firmy z informačných zoznamov Finančnej správy.
 * Ide cez vlastný backend — API kľúč FS je secret a nesmie byť v prehliadači.
 * Volá sa až po výbere firmy (nie pri každom písmene), aby sa hodinový limit
 * externého API míňal len na to, čo používateľ naozaj chce.
 */
export async function lookupSkTaxIds(
  ico: string,
  signal?: AbortSignal,
): Promise<{ dic?: string; icDph?: string }> {
  const response = await fetch(`/api/company-registry/sk-tax-ids?ico=${encodeURIComponent(ico)}`, {
    credentials: 'include',
    signal,
  });
  if (!response.ok) return {};
  const body = (await response.json()) as { dic?: string | null; icDph?: string | null };
  return { dic: body.dic ?? undefined, icDph: body.icDph ?? undefined };
}

/**
 * Našepkávanie podľa názvu alebo IČO. Číslicový dopyt sa berie ako IČO a hľadá
 * sa až pri kompletných 8 číslicach (registre robia presnú zhodu, nie prefix).
 * Výpadok jedného registra nezhodí druhý.
 */
export async function lookupCompanies(query: string, signal?: AbortSignal): Promise<CompanyHit[]> {
  const q = query.trim();
  const byIco = /^\d+$/.test(q);
  if (byIco ? q.length !== 8 : q.length < 3) return [];
  const results = await Promise.allSettled([searchRpo(q, byIco, signal), searchAres(q, byIco, signal)]);
  return results
    .flatMap((result) => (result.status === 'fulfilled' ? result.value : []))
    .slice(0, MAX_HITS);
}

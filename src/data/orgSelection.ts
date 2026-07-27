import { setCurrentOrg } from './api';
import { useDataQuery } from './query';

/**
 * Výber firmy pre stránky a karty, ktoré pracujú vždy nad jednou organizáciou
 * (Tréning AI, číselníky, profil klienta, šablóny, Dokumenty…).
 *
 * Jediným zdrojom pravdy je globálny prepínač v ľavom paneli. Lokálny stav
 * „vyber si firmu tu znovu" spôsoboval, že karta ukazovala inú firmu než
 * prepínač — a import histórie či nahratý súbor mohol skončiť pod cudzou
 * firmou. Prepnutie v karte preto prepína aj globálny kontext.
 *
 * Pri „Všetky organizácie" (alebo neznámej firme) sa padá na prvú aktívnu.
 */
export function useOrgSelection(): { orgId: string; selectOrg: (id: string) => void } {
  const { data } = useDataQuery();
  const current = data?.currentOrgId ?? 'all';
  const active = (data?.organizations ?? []).filter((org) => !org.archived);
  const orgId = active.some((org) => org.id === current) ? current : active[0]?.id ?? '';
  return { orgId, selectOrg: (id: string) => void setCurrentOrg(id) };
}

import type { DocumentType } from '../types';

/**
 * Typ dokladu → agenda číselného radu v POHODE (element „agenda" v exporte).
 * Jedno miesto pre klienta aj server (server/services/accountingSuggestionService.ts
 * drží zhodnú mapu) — pokladničný doklad nesmie dostať rad prijatých faktúr.
 */
export const AGENDA_PRE_TYP: Partial<Record<DocumentType, string>> = {
  FP: 'prijate_faktury',
  FV: 'vydane_faktury',
  PD: 'pokladna',
  BV: 'banka',
  MZDY: 'interni_doklady',
  OZ: 'ostatni_zavazky',
};

/**
 * Číselné rady vhodné pre daný typ dokladu. Keď firma pre agendu nemá ani jeden
 * rad (ručne založené číselníky bez agendy), vráti všetky — inak by sa doklad
 * nedal zaúčtovať vôbec.
 */
export function radyPreTyp<T extends { agenda?: string }>(rady: T[], typ: DocumentType): T[] {
  const agenda = AGENDA_PRE_TYP[typ];
  if (!agenda) return rady;
  const vhodne = rady.filter((item) => item.agenda === agenda);
  return vhodne.length > 0 ? vhodne : rady;
}

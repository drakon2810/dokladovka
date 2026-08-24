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

/**
 * Agendy predkontácií POHODY (atribút „agenda" v listAccountingDoubleEntry) pre
 * banku — POZOR, iný slovník než agendy číselných radov: predkontácie nesú aj
 * SMER, bankReceived = príjem, bankIssued = výdaj.
 * Server drží zhodné konštanty v bankSuggestionService.
 */
export const BANK_PREDKONTACIA_AGENDY = ['bankReceived', 'bankIssued'] as const;

/**
 * Predkontácie použiteľné pre bankový pohyb daného smeru. Položky bez agendy
 * (ručne založené) ostávajú v ponuke; pri prázdnom výsledku sa vráti všetko,
 * inak by sa pohyb nedal zaúčtovať vôbec — rovnaká zhovievavosť ako radyPreTyp.
 */
export function bankovePredkontacie<T extends { agenda?: string }>(
  items: T[],
  smer?: 'prijem' | 'vydaj',
): T[] {
  const chcena = smer === 'prijem' ? 'bankReceived' : smer === 'vydaj' ? 'bankIssued' : undefined;
  return filtrujPodlaAgendy(items, chcena ? [chcena] : BANK_PREDKONTACIA_AGENDY);
}

/**
 * Agendy predkontácií POHODY podľa typu dokladu — pre banku a pokladňu obidva
 * smery, výber smeru rieši editor pohybu (bankovePredkontacie).
 */
const PREDKONTACIA_AGENDA: Partial<Record<DocumentType, readonly string[]>> = {
  FP: ['receivedInvoice', 'receivedAdvanceInvoice'],
  FV: ['issuedInvoice', 'issuedAdvanceInvoice'],
  OZ: ['commitment', 'claim'],
  MZDY: ['internalDocument'],
  PD: ['cashPaid', 'cashReceived'],
  BV: BANK_PREDKONTACIA_AGENDY,
};

/**
 * Predkontácie použiteľné pre daný typ dokladu — na vydanú faktúru nepatrí
 * nákupová predkontácia a naopak.
 */
export function predkontaciePreTyp<T extends { agenda?: string }>(items: T[], typ: DocumentType): T[] {
  const povolene = PREDKONTACIA_AGENDA[typ];
  return povolene ? filtrujPodlaAgendy(items, povolene) : items;
}

/**
 * Sekcie kontrolného výkazu podľa strany dokladu: A1/A2/C1/D1/D2 podáva
 * DODÁVATEĽ (výstup), B1/B2/B3/C2 ODBERATEĽ (vstup); KN patrí obom. Pokladňa,
 * banka a interné doklady nesú smer až v zaúčtovaní, tam sa neobmedzuje.
 * Server drží zhodnú mapu v accountingSuggestionService.
 */
const KV_KODY_PRE_TYP: Partial<Record<DocumentType, readonly string[]>> = {
  FV: ['A1', 'A2', 'C1', 'D1', 'D2', 'KN'],
  FP: ['B1', 'B2', 'B3', 'C2', 'KN'],
  OZ: ['B1', 'B2', 'B3', 'C2', 'KN'],
};

/** Sekcie KV použiteľné pre daný typ dokladu — prijatá faktúra do A1 nepatrí. */
export function kvKodyPreTyp(kody: readonly string[], typ: DocumentType): readonly string[] {
  const povolene = KV_KODY_PRE_TYP[typ];
  return povolene ? kody.filter((kod) => povolene.includes(kod)) : kody;
}

/**
 * Položky bez agendy (ručne založené) ostávajú v ponuke a pri prázdnom výsledku
 * sa vráti všetko — inak by sa doklad nedal zaúčtovať vôbec, rovnaká
 * zhovievavosť ako pri číselných radoch.
 */
function filtrujPodlaAgendy<T extends { agenda?: string }>(items: T[], povolene: readonly string[]): T[] {
  const vhodne = items.filter((item) => !item.agenda || povolene.includes(item.agenda));
  return vhodne.length > 0 ? vhodne : items;
}

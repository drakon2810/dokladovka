import type { DocumentItem, DocumentUcto, DphAudit, OtazkaPraxe, VariantOtazky } from '../../data/types';

/**
 * Brzdí kontrola DPH daňovú časť predvyplnenia? Áno, keď o členení, ktoré
 * návrh nesie, pochybuje alebo s ním nesúhlasí. Vtedy sa sám vpíše len účet —
 * členenie DPH, sekciu KV a rozpis po položkách musí potvrdiť účtovník.
 *
 * Verdikt k inému kódu sa nepočíta: kontrola posudzovala iné zaúčtovanie
 * a o tomto návrhu nič nehovorí (rovnaké pravidlo ako panel kontroly DPH).
 */
export function danovaKontrolaBrzdi(audit: DphAudit | undefined, clenenieDphKod: string | undefined): boolean {
  if (!audit || audit.verdikt === 'suhlasi') return false;
  return !audit.posudeneClenenieKod || audit.posudeneClenenieKod === clenenieDphKod;
}

/**
 * Ukázať otázku na prax protistrany? Len na doklade, ktorý sa ešte kontroluje
 * a smie sa meniť, a len kým hlavička nesedí s niektorou ponúknutou podobou —
 * keď sedí, účtovník už odpovedal (tlačidlom alebo prevzatím návrhu).
 */
export function zobrazOtazku(
  otazka: OtazkaPraxe | undefined,
  ucto: Pick<DocumentUcto, 'predkontaciaId' | 'clenenieDphId' | 'clenenieKvKod'>,
  stav: DocumentItem['status'],
  readOnly: boolean,
  podtyp?: DocumentItem['podtyp'],
): boolean {
  if (!otazka || otazka.varianty.length < 2 || readOnly) return false;
  if (stav !== 'extrahovany' && stav !== 'na_kontrole') return false;
  // Zálohová faktúra členenie ani sekciu KV nenesie — otázka na ňu nepatrí.
  if (podtyp === 'zalohova') return false;
  return !otazka.varianty.some((variant) => variant.predkontaciaId === ucto.predkontaciaId
    && variant.clenenieDphId === ucto.clenenieDphId
    // Server posiela pri členení bez odpočtu KN aj tam, kde hlavička sekciu nemá — to isté.
    && ((variant.clenenieKvKod ?? '') === (ucto.clenenieKvKod ?? '')
      || (variant.clenenieKvKod === 'KN' && !ucto.clenenieKvKod)));
}

/**
 * Majú položky vlastné členenie DPH iné, než vybraná podoba? Výber mení len
 * hlavičku — položka s vlastným kódom z iného návrhu by poslala do POHODY daň,
 * ktorú účtovník práve odmietol. Upozorní sa, nemení sa nič potichu.
 */
export function polozkyInakoNezPodoba(
  polozky: ReadonlyArray<{ ucto?: { clenenieDphId?: string } }>,
  variant: Pick<VariantOtazky, 'clenenieDphId'>,
): boolean {
  return polozky.some((polozka) => Boolean(polozka.ucto?.clenenieDphId) && polozka.ucto?.clenenieDphId !== variant.clenenieDphId);
}

/** Čo podoba vyplní: účet, členenie DPH a sekciu KV. Rad ani stredisko nie sú predmetom sporu. */
export function patchVariantu(variant: VariantOtazky): Pick<DocumentUcto, 'predkontaciaId' | 'clenenieDphId' | 'clenenieKvKod'> {
  return { predkontaciaId: variant.predkontaciaId, clenenieDphId: variant.clenenieDphId, clenenieKvKod: variant.clenenieKvKod };
}

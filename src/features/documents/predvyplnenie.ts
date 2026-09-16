import type { DphAudit } from '../../data/types';

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

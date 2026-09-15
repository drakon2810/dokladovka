import { describe, expect, it } from 'vitest';
import { checkApprovable } from './api';
import type { DocumentItem } from './types';
import type { AppDataState } from './store';

// Klient blokuje to isté, čo server: odkaz, ktorý do POHODY neprejde, nesmie
// pustiť tlačidlo „Schváliť" a naraziť až na odmietnutie zo servera.
const polozka = (id: string, extra: Record<string, string> = {}) =>
  ({ id, orgId: 'o1', tenantId: 't1', kod: id, nazov: id, active: true, ...extra });
const codeLists = {
  predkontacie: [polozka('p1')],
  cleneniaDph: [polozka('c1')],
  ciselneRady: [
    polozka('r1', { agenda: 'prijate_faktury', uctovnyRok: '2026' }),
    polozka('r25', { agenda: 'prijate_faktury', uctovnyRok: '2025' }),
    polozka('rOZ', { agenda: 'ostatni_zavazky' }),
  ],
  strediska: [polozka('s1')], zakazky: [], cinnosti: [], projekty: [], bankoveUcty: [],
} as unknown as AppDataState['codeLists'];

const doklad = (ucto: Record<string, string>, uctoPolozky: Record<string, string> = {}) => ({
  id: 'd1', tenantId: 't1', orgId: 'o1', typ: 'FP', podtyp: 'bezna',
  status: 'na_kontrole', processingStatus: 'ready_for_review',
  ucto: { predkontaciaId: 'p1', clenenieDphId: 'c1', ciselnyRadId: 'r1', ...ucto },
  extracted: {
    dodavatel: { nazov: 'Dodávateľ s.r.o.' }, odberatel: { nazov: 'ALPINA EST' },
    cisloFaktury: 'F-1', datumVystavenia: '2026-08-01', datumSplatnosti: '2026-08-15',
    rozpisDph: [], sumaSpolu: 100, mena: 'EUR', polozky: [{ id: 'i1', popis: 'Tovar', ucto: uctoPolozky }],
  },
  zdroj: {}, confidence: 0.9, fieldConfidence: {},
} as unknown as DocumentItem);

const chybajuce = (ucto: Record<string, string>, uctoPolozky?: Record<string, string>) =>
  checkApprovable(doklad(ucto, uctoPolozky), codeLists).chybajuceUcto;

describe('schválenie — platnosť každého odkazu zaúčtovania', () => {
  it('platný doklad s prázdnym poľom položky neblokuje', () => {
    expect(chybajuce({})).toEqual([]);
  });

  it('rad inej agendy alebo iného účtovného roka blokuje', () => {
    expect(chybajuce({ ciselnyRadId: 'rOZ' })).toEqual(['ciselnyRad']);
    expect(chybajuce({ ciselnyRadId: 'r25' })).toEqual(['ciselnyRad']);
  });

  it('neplatné id na položke blokuje ako v hlavičke', () => {
    expect(chybajuce({}, { predkontaciaId: 'neznama' })).toEqual(['predkontacia']);
    expect(chybajuce({}, { clenenieDphId: 'p1' })).toEqual(['clenenieDph']);
    expect(chybajuce({}, { strediskoId: 'x' })).toEqual(['stredisko']);
    expect(chybajuce({}, { zakazkaId: 'x' })).toEqual(['analytika']);
  });

  it('sekcia KV mimo druhu dokladu blokuje v hlavičke aj na položke', () => {
    expect(chybajuce({ clenenieKvKod: 'A1' })).toEqual(['clenenieKv']);
    expect(chybajuce({}, { clenenieKvKod: 'A1' })).toEqual(['clenenieKv']);
    expect(chybajuce({ clenenieKvKod: 'B2' })).toEqual([]);
  });
});

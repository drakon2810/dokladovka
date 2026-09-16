import { describe, expect, it } from 'vitest';
import { agendaRadu, bankovePredkontacie, kvKodyPreTyp, predkontaciePreTyp, radyPreTyp } from './agendas';
import { CLENENIE_KV_KODY } from '../types';

/** Bežný doklad daného typu — podtyp rozhoduje až v testoch nižšie. */
const bezny = (typ: 'FP' | 'FV' | 'BV' | 'PD' | 'OZ' | 'MZDY') => ({ typ, podtyp: 'bezna' } as const);

const PONUKA = [
  { id: '1', agenda: 'receivedInvoice' },
  { id: '2', agenda: 'issuedInvoice' },
  { id: '3', agenda: 'bankReceived' },
  { id: '4' },
];

describe('predkontaciePreTyp', () => {
  it('vydanej faktúre neponúkne nákupnú predkontáciu', () => {
    expect(predkontaciePreTyp(PONUKA, bezny('FV')).map((item) => item.id)).toEqual(['2', '4']);
  });

  it('prijatej faktúre neponúkne odbytovú predkontáciu', () => {
    expect(predkontaciePreTyp(PONUKA, bezny('FP')).map((item) => item.id)).toEqual(['1', '4']);
  });

  it('bez zhody vráti celý číselník, aby sa doklad dal zaúčtovať', () => {
    const bezZhody = [{ id: '1', agenda: 'receivedInvoice' }];
    expect(predkontaciePreTyp(bezZhody, bezny('FV'))).toEqual(bezZhody);
  });

  it('zálohová faktúra dostane len zálohové predkontácie', () => {
    const ponuka = [...PONUKA, { id: '5', agenda: 'receivedAdvanceInvoice' }];
    expect(predkontaciePreTyp(ponuka, { typ: 'FP', podtyp: 'zalohova' }).map((i) => i.id))
      .toEqual(['4', '5']);
  });

  it('banka drží smer cez bankovePredkontacie', () => {
    expect(bankovePredkontacie(PONUKA, 'prijem').map((item) => item.id)).toEqual(['3', '4']);
    expect(predkontaciePreTyp(PONUKA, bezny('BV')).map((item) => item.id)).toEqual(['3', '4']);
  });
});

describe('agendaRadu', () => {
  // Zálohová faktúra má v POHODE vlastnú agendu; dobropis a ťarchopis nie —
  // ich rady ležia medzi bežnými faktúrami (2612 „Prijaté dopropisy").
  it('zálohová faktúra má vlastnú agendu radov', () => {
    expect(agendaRadu({ typ: 'FP', podtyp: 'zalohova' })).toBe('prijate_zalohove_faktury');
    expect(agendaRadu({ typ: 'FV', podtyp: 'zalohova' })).toBe('vydane_zalohove_faktury');
  });

  it('dobropis a ťarchopis ostávajú v agende faktúr', () => {
    for (const podtyp of ['bezna', 'dobropis', 'tarchopis'] as const) {
      expect(agendaRadu({ typ: 'FP', podtyp })).toBe('prijate_faktury');
      expect(agendaRadu({ typ: 'FV', podtyp })).toBe('vydane_faktury');
    }
  });

  it('rady sa filtrujú podľa druhu, nie len podľa typu', () => {
    const rady = [
      { id: 'f', agenda: 'prijate_faktury' },
      { id: 'z', agenda: 'prijate_zalohove_faktury' },
    ];
    expect(radyPreTyp(rady, { typ: 'FP', podtyp: 'bezna' }).map((i) => i.id)).toEqual(['f']);
    expect(radyPreTyp(rady, { typ: 'FP', podtyp: 'zalohova' }).map((i) => i.id)).toEqual(['z']);
  });

  // ROFA: rad „FP20" prečítaný z decembrových dokladov 2025 sa ponúkal aj
  // faktúre z roku 2026 vedľa skutočného FP202.
  it('rad iného účtovného roka sa dokladu neponúkne', () => {
    const rady = [
      { id: 'stary', agenda: 'prijate_faktury', uctovnyRok: '2025' },
      { id: 'novy', agenda: 'prijate_faktury', uctovnyRok: '2026' },
      { id: 'bezRoka', agenda: 'prijate_faktury' },
    ];
    expect(radyPreTyp(rady, bezny('FP'), '2026').map((i) => i.id)).toEqual(['novy', 'bezRoka']);
    // Bez roka dokladu sa nefiltruje; bez radu nového roka ostanú rady agendy.
    expect(radyPreTyp(rady, bezny('FP')).map((i) => i.id)).toEqual(['stary', 'novy', 'bezRoka']);
    expect(radyPreTyp(rady.slice(0, 2), bezny('FP'), '2027').map((i) => i.id)).toEqual(['stary', 'novy']);
  });
});

describe('kvKodyPreTyp', () => {
  it('bežná faktúra drží stranu dokladu', () => {
    expect(kvKodyPreTyp(CLENENIE_KV_KODY, bezny('FP'))).toContain('B1');
    expect(kvKodyPreTyp(CLENENIE_KV_KODY, bezny('FP'))).not.toContain('A1');
  });

  // Dobropis aj ťarchopis su opravou zakladu dane (§25a) — patria do C1/C2,
  // nie medzi bezne A1/B1. Bez tohto by dostali sekciu obycajnej faktury.
  it('dobropis a ťarchopis patria do opravnej sekcie', () => {
    for (const podtyp of ['dobropis', 'tarchopis'] as const) {
      expect(kvKodyPreTyp(CLENENIE_KV_KODY, { typ: 'FP', podtyp })).toEqual(['C2', 'KN']);
      expect(kvKodyPreTyp(CLENENIE_KV_KODY, { typ: 'FV', podtyp })).toEqual(['C1', 'KN']);
    }
  });

  // Zalohova faktura do kontrolneho vykazu nevstupuje — danovy moment nastane
  // az pri uhrade alebo zuctovacej fakture.
  it('zálohová faktúra do KV nevstupuje', () => {
    expect(kvKodyPreTyp(CLENENIE_KV_KODY, { typ: 'FP', podtyp: 'zalohova' })).toEqual(['KN']);
    expect(kvKodyPreTyp(CLENENIE_KV_KODY, { typ: 'FV', podtyp: 'zalohova' })).toEqual(['KN']);
  });

  // Plná faktúra zaplatená v hotovosti patrí do B2 — účtovník ju musí vedieť
  // vybrať aj na pokladničnom doklade. Výstupné sekcie tam nepatria.
  it('pokladničný doklad ponúka B2 aj B3', () => {
    const kody = kvKodyPreTyp(CLENENIE_KV_KODY, bezny('PD'));
    expect(kody).toContain('B2');
    expect(kody).toContain('B3');
    expect(kody).not.toContain('A1');
  });
});

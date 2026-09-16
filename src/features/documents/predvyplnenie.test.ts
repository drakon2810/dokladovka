import { describe, expect, it } from 'vitest';
import type { DphAudit, OtazkaPraxe } from '../../data/types';
import { danovaKontrolaBrzdi, patchVariantu, polozkyInakoNezPodoba, zobrazOtazku } from './predvyplnenie';

// R09: protistrana má viac praxí s inou daňou — účtovník vyberá podobu.
const otazka: OtazkaPraxe = {
  spor: 'dph',
  varianty: [
    { predkontaciaId: 'p1', clenenieDphId: 'd-pd', clenenieKvKod: 'B2', dokladov: 4, od: '2026-01-05', do: '2026-06-30',
      kody: { predkontacia: '518', clenenieDph: 'PD', clenenieKv: 'B2' } },
    { predkontaciaId: 'p1', clenenieDphId: 'd-pn', clenenieKvKod: 'KN', dokladov: 3, od: '2026-02-01', do: '2026-05-31',
      kody: { predkontacia: '518', clenenieDph: 'PN', clenenieKv: 'KN' } },
  ],
};

describe('otázka na prax protistrany', () => {
  it('ukáže sa len na kontrolovanom doklade, kým hlavička nesedí s podobou', () => {
    expect(zobrazOtazku(otazka, {}, 'na_kontrole', false)).toBe(true);
    expect(zobrazOtazku(otazka, {}, 'extrahovany', false)).toBe(true);
    expect(zobrazOtazku(undefined, {}, 'na_kontrole', false)).toBe(false);
    expect(zobrazOtazku(otazka, {}, 'schvaleny', false)).toBe(false);
    expect(zobrazOtazku(otazka, {}, 'na_kontrole', true)).toBe(false);
    expect(zobrazOtazku(otazka, { predkontaciaId: 'p1', clenenieDphId: 'd-pn', clenenieKvKod: 'KN' }, 'na_kontrole', false)).toBe(false);
    // Iná sekcia KV je iná odpoveď — otázka ostáva.
    expect(zobrazOtazku(otazka, { predkontaciaId: 'p1', clenenieDphId: 'd-pn', clenenieKvKod: 'B2' }, 'na_kontrole', false)).toBe(true);
    // Prázdna sekcia pri PN je to isté ako KN — účtovník už odpovedal.
    expect(zobrazOtazku(otazka, { predkontaciaId: 'p1', clenenieDphId: 'd-pn' }, 'na_kontrole', false)).toBe(false);
    // Zálohová faktúra členenie ani sekciu nemení — otázka na ňu nepatrí.
    expect(zobrazOtazku(otazka, {}, 'na_kontrole', false, 'zalohova')).toBe(false);
  });

  it('upozorní na položky s iným členením DPH, než má vybraná podoba', () => {
    const polozka = (clenenieDphId?: string) => ({ ucto: clenenieDphId ? { clenenieDphId } : undefined });
    expect(polozkyInakoNezPodoba([polozka(), polozka('d-pn')], otazka.varianty[1])).toBe(false);
    expect(polozkyInakoNezPodoba([polozka(), polozka('d-pd')], otazka.varianty[1])).toBe(true);
  });

  it('podoba vyplní účet, členenie a sekciu, rad nechá tak', () => {
    expect(patchVariantu(otazka.varianty[1])).toEqual({ predkontaciaId: 'p1', clenenieDphId: 'd-pn', clenenieKvKod: 'KN' });
  });
});

// Predvyplnenie po piatich rovnakých dokladoch je rozhodnutie vlastníka, ale
// daň pri ňom nesmie ísť naslepo: keď kontrola DPH o posúdenom členení
// pochybuje alebo s ním nesúhlasí, predvyplní sa len účet.
const audit = (verdikt: DphAudit['verdikt'], posudeneClenenieKod?: string): DphAudit => ({
  documentId: 'd1', organizationId: 'o1', verdikt, posudeneClenenieKod, dovod: 'test',
});

describe('danovaKontrolaBrzdi', () => {
  it('bez kontroly alebo pri súhlase nebrzdí', () => {
    expect(danovaKontrolaBrzdi(undefined, 'PD')).toBe(false);
    expect(danovaKontrolaBrzdi(audit('suhlasi', 'PD'), 'PD')).toBe(false);
  });

  it('pochybnosť alebo nesúhlas k navrhnutému členeniu brzdí', () => {
    expect(danovaKontrolaBrzdi(audit('neisty', 'PD'), 'PD')).toBe(true);
    expect(danovaKontrolaBrzdi(audit('nesuhlasi'), 'PD')).toBe(true);
  });

  // Verdikt k inému kódu, než aký navrhuje návrh, o tomto návrhu nič nehovorí.
  it('verdikt k inému členeniu nebrzdí', () => {
    expect(danovaKontrolaBrzdi(audit('nesuhlasi', 'PN'), 'PD')).toBe(false);
  });
});

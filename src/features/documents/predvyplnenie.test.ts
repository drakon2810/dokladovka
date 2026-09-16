import { describe, expect, it } from 'vitest';
import type { DphAudit } from '../../data/types';
import { danovaKontrolaBrzdi } from './predvyplnenie';

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

import { describe, expect, it } from 'vitest';
import { cisloMzdovehoDokladu, nextNumberInSeries, pocetCakajucichVRade, type DokladVRade } from './numbering';

describe('pocetCakajucichVRade', () => {
  const doklad = (id: string, extra: Partial<DokladVRade> = {}): DokladVRade => ({
    id, orgId: 'org-1', status: 'na_kontrole', ciselnyRadId: 'r-mzd', ...extra,
  });
  // Rozbor za marec aj za apríl dá po troch dokladoch do radu 26MZD.
  const marec = [doklad('m1'), doklad('m2'), doklad('m3')];
  const april = [doklad('a1'), doklad('a2'), doklad('a3')];
  const vsetky = [...april, ...marec];

  it('ráta všetky ostatné doklady čakajúce na ten istý rad', () => {
    expect(vsetky.map((item) => pocetCakajucichVRade(item, vsetky))).toEqual([5, 5, 5, 5, 5, 5]);
  });

  it('prenesené a zamietnuté doklady už číslo nečerpajú', () => {
    const poPrenose = vsetky.map((item) => (
      item.id.startsWith('m') ? { ...item, status: 'exportovany' } : item
    ));
    expect(april.map((item) => pocetCakajucichVRade(item, poPrenose))).toEqual([2, 2, 2]);
    const zvysny = [...poPrenose.filter((item) => item.id !== 'a2' && item.id !== 'a3'), doklad('a2', { status: 'zamietnuty' })];
    expect(pocetCakajucichVRade(april[0], zvysny)).toBe(0);
  });

  it('iný rad, iná firma ani ten istý doklad sa nerátajú', () => {
    const cudzie = [doklad('x1', { ciselnyRadId: 'r-fp' }), doklad('x2', { orgId: 'org-2' }), marec[0]];
    expect(pocetCakajucichVRade(marec[0], cudzie)).toBe(0);
    // Doklad bez zvoleného radu žiadne číslo nečaká.
    expect(pocetCakajucichVRade({ ...marec[0], ciselnyRadId: undefined }, vsetky)).toBe(0);
  });
});

describe('cisloMzdovehoDokladu', () => {
  it('spojí kód číselného radu s mesiacom dokladu', () => {
    expect(cisloMzdovehoDokladu('26MZD', '2026-03-31')).toBe('26MZD03');
    expect(cisloMzdovehoDokladu(' 26MZD ', '2026-12-01')).toBe('26MZD12');
  });

  it('bez radu alebo bez platného dátumu nevráti nič', () => {
    expect(cisloMzdovehoDokladu(undefined, '2026-03-31')).toBeUndefined();
    expect(cisloMzdovehoDokladu('26MZD', undefined)).toBeUndefined();
    expect(cisloMzdovehoDokladu('26MZD', '31.03.2026')).toBeUndefined();
  });
});

describe('nextNumberInSeries', () => {
  it('inkrementuje a zachová šírku (padding)', () => {
    expect(nextNumberInSeries('0007')).toBe('0008');
    expect(nextNumberInSeries('0099')).toBe('0100');
  });

  it('zachová prefix radu (rok, skratka)', () => {
    expect(nextNumberInSeries('2026FP0042')).toBe('2026FP0043');
    expect(nextNumberInSeries('FA-00099')).toBe('FA-00100');
  });

  it('rozšíri šírku až pri pretečení', () => {
    expect(nextNumberInSeries('999')).toBe('1000');
  });

  it('vráti undefined pre prázdne alebo nečíselné hodnoty', () => {
    expect(nextNumberInSeries(undefined)).toBeUndefined();
    expect(nextNumberInSeries('')).toBeUndefined();
    expect(nextNumberInSeries('   ')).toBeUndefined();
    expect(nextNumberInSeries('bez čísla')).toBeUndefined();
  });
});

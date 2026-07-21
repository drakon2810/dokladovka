import { describe, expect, it } from 'vitest';
import { nextNumberInSeries } from './numbering';

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

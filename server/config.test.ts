// Čítanie OPENAI_REASONING_EFFORT — zlá hodnota nesmie zhodiť štart servera.
import { describe, expect, it } from 'vitest';
import { loadConfig } from './config.js';

const base = {
  NODE_ENV: 'test',
  MAIL_RECEIVING_DOMAIN: 'doklady.test.sk',
  OPENAI_API_KEY: 'test-key',
} as NodeJS.ProcessEnv;

const effortOf = (value?: string) =>
  loadConfig({ ...base, ...(value === undefined ? {} : { OPENAI_REASONING_EFFORT: value }) }).openai.reasoningEffort;

describe('openai.reasoningEffort', () => {
  it('predvolene rozmýšľa málo — extrakcia je čítanie, nie úvaha', () => {
    expect(effortOf()).toBe('low');
  });

  it('rešpektuje nastavenú hodnotu bez ohľadu na veľkosť písmen', () => {
    expect(effortOf('high')).toBe('high');
    expect(effortOf(' Minimal ')).toBe('minimal');
  });

  it('prázdna hodnota parameter vypne (modely bez rozmýšľania ho odmietajú)', () => {
    expect(effortOf('')).toBeUndefined();
  });

  it('neznámu hodnotu stiahne na predvolenú namiesto pádu', () => {
    expect(effortOf('turbo')).toBe('low');
  });
});

// Súbežnosť workera: nesprávna hodnota v premennej nesmie zhodiť štart ani
// pustiť stovky súbežných extrakcií.
describe('workerConcurrency', () => {
  const pocet = (value?: string) =>
    loadConfig({ ...base, ...(value === undefined ? {} : { WORKER_CONCURRENCY: value }) }).workerConcurrency;

  it('predvolene beží po jednom — súbežnosť sa zapína vedome', () => {
    expect(pocet()).toBe(1);
  });

  it('rešpektuje nastavenú hodnotu', () => {
    expect(pocet('4')).toBe(4);
  });

  it('nezmysel aj preklep stiahne na bezpečnú hodnotu', () => {
    expect(pocet('0')).toBe(1);
    expect(pocet('-3')).toBe(1);
    expect(pocet('veľa')).toBe(1);
    expect(pocet('400')).toBe(16);
  });
});

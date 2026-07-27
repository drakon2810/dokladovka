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

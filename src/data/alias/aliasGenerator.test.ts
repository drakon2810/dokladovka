// Testy generátora aliasov — pravidlá SPEC §11.3 a edge cases §11.26.
import { describe, expect, it, vi, afterEach } from 'vitest';
import {
  ALIAS_TOKEN_ALPHABET,
  DEFAULT_TOKEN_LENGTH,
  FALLBACK_SLUG,
  MAX_COLLISION_ATTEMPTS,
  MAX_LOCAL_PART_LENGTH,
  buildAliasAddress,
  generateAliasToken,
  generateUniqueAlias,
  removeDiacritics,
  slugifyOrganizationName,
} from './aliasGenerator';

const DOMAIN = 'doklady.dokladorpro.sk';

afterEach(() => {
  vi.restoreAllMocks();
});

describe('removeDiacritics', () => {
  it('odstráni slovenskú diakritiku', () => {
    expect(removeDiacritics('Čučoriedka')).toBe('Cucoriedka');
    expect(removeDiacritics('Žiar nad Hronom, š.p.')).toBe('Ziar nad Hronom, s.p.');
    expect(removeDiacritics('äöüľščťžýáíéňôřď')).toBe('aoulsctzyaienord');
  });
});

describe('slugifyOrganizationName', () => {
  it('prevedie názov na lowercase slug', () => {
    expect(slugifyOrganizationName('AGS s.r.o.')).toBe('ags');
  });

  it('odstráni diakritiku (Čučoriedka → cucoriedka)', () => {
    expect(slugifyOrganizationName('Čučoriedka s.r.o.')).toBe('cucoriedka');
  });

  it('odstráni právne prípony s.r.o., a.s., spol. s r.o., v.o.s., k.s.', () => {
    expect(slugifyOrganizationName('Alfa Trade s.r.o.')).toBe('alfa-trade');
    expect(slugifyOrganizationName('Alfa Trade s. r. o.')).toBe('alfa-trade');
    expect(slugifyOrganizationName('ZSE Energia, a.s.')).toBe('zse-energia');
    expect(slugifyOrganizationName('Účtovná kancelária, spol. s r.o.')).toBe(
      'uctovna-kancelaria',
    );
    expect(slugifyOrganizationName('Beta v.o.s.')).toBe('beta');
    expect(slugifyOrganizationName('Gama k.s.')).toBe('gama');
  });

  it('neodstráni písmená podobné príponám vnútri slov (Alza.sk)', () => {
    expect(slugifyOrganizationName('Alza.sk')).toBe('alza-sk');
  });

  it('nahradí medzery a sekvencie nepovolených znakov jediným "-"', () => {
    expect(slugifyOrganizationName('Kancelárske   potreby & syn')).toBe(
      'kancelarske-potreby-syn',
    );
    expect(slugifyOrganizationName('A___B///C')).toBe('a-b-c');
  });

  it('povolí iba ASCII a-z, 0-9 a pomlčku', () => {
    const slug = slugifyOrganizationName('Metro Cash & Carry SR 24/7');
    expect(slug).toMatch(/^[a-z0-9-]+$/);
  });

  it('odstráni pomlčky na začiatku a konci', () => {
    expect(slugifyOrganizationName('- Alfa -')).toBe('alfa');
    expect(slugifyOrganizationName('...Beta...')).toBe('beta');
  });

  it('vráti fallback "firma" pre prázdny výsledok normalizácie', () => {
    expect(slugifyOrganizationName('')).toBe(FALLBACK_SLUG);
    expect(slugifyOrganizationName('***')).toBe(FALLBACK_SLUG);
    expect(slugifyOrganizationName('s.r.o.')).toBe(FALLBACK_SLUG);
  });

  it('vráti fallback pre názov iba z cyriliky (edge case §11.26)', () => {
    expect(slugifyOrganizationName('ООО Ромашка')).toBe(FALLBACK_SLUG);
  });

  it('skráti veľmi dlhý názov tak, aby sa zmestil do limitu (edge case §11.26)', () => {
    const longName = 'Veľmi Dlhé Meno Organizácie '.repeat(10);
    const slug = slugifyOrganizationName(longName);
    expect(slug.length).toBeLessThanOrEqual(
      MAX_LOCAL_PART_LENGTH - 1 - DEFAULT_TOKEN_LENGTH,
    );
    expect(slug.endsWith('-')).toBe(false);
  });

  it('rešpektuje vlastný maxLength', () => {
    expect(slugifyOrganizationName('abcdefghij', 5)).toBe('abcde');
  });
});

describe('generateAliasToken', () => {
  it('má predvolenú dĺžku 6 znakov', () => {
    expect(generateAliasToken()).toHaveLength(6);
  });

  it('podporuje dĺžku 6–8 a odmietne inú (SPEC §11.3)', () => {
    expect(generateAliasToken(8)).toHaveLength(8);
    expect(() => generateAliasToken(5)).toThrow();
    expect(() => generateAliasToken(9)).toThrow();
  });

  it('používa iba abecedu bez nejednoznačných znakov 0/o/1/l', () => {
    for (let i = 0; i < 50; i++) {
      const token = generateAliasToken();
      expect(token).toMatch(/^[a-z2-9]+$/);
      for (const ch of token) {
        expect(ALIAS_TOKEN_ALPHABET).toContain(ch);
        expect('0o1l').not.toContain(ch);
      }
    }
  });

  it('používa crypto.getRandomValues, nie Math.random()', () => {
    const cryptoSpy = vi.spyOn(globalThis.crypto, 'getRandomValues');
    const mathSpy = vi.spyOn(Math, 'random');
    generateAliasToken();
    expect(cryptoSpy).toHaveBeenCalled();
    expect(mathSpy).not.toHaveBeenCalled();
  });

  it('generuje rôzne tokeny (pravdepodobnostná kontrola)', () => {
    const tokens = new Set(Array.from({ length: 100 }, () => generateAliasToken()));
    expect(tokens.size).toBeGreaterThan(95);
  });
});

describe('buildAliasAddress', () => {
  it('zostaví adresu {slug}-{token}@{domain} v lowercase', () => {
    const alias = buildAliasAddress('ags', 'k7m4q2', DOMAIN);
    expect(alias.address).toBe('ags-k7m4q2@doklady.dokladorpro.sk');
    expect(alias.localPart).toBe('ags-k7m4q2');
    expect(alias.addressNormalized).toBe(alias.address);
  });

  it('normalizuje doménu na lowercase', () => {
    const alias = buildAliasAddress('ags', 'k7m4q2', 'Doklady.DokladorPro.SK');
    expect(alias.address).toBe('ags-k7m4q2@doklady.dokladorpro.sk');
  });
});

describe('generateUniqueAlias', () => {
  it('vygeneruje validný alias pre bežný názov', () => {
    const alias = generateUniqueAlias({
      nazov: 'AGS s.r.o.',
      domain: DOMAIN,
      isTaken: () => false,
    });
    expect(alias.address).toMatch(
      /^ags-[a-z2-9]{6}@doklady\.dokladorpro\.sk$/,
    );
    expect(alias.localPart.length).toBeLessThanOrEqual(MAX_LOCAL_PART_LENGTH);
  });

  it('local-part nikdy neprekročí 64 znakov ani pri dlhom názve', () => {
    const alias = generateUniqueAlias({
      nazov: 'x'.repeat(200),
      domain: DOMAIN,
      isTaken: () => false,
      tokenLength: 8,
    });
    expect(alias.localPart.length).toBeLessThanOrEqual(MAX_LOCAL_PART_LENGTH);
  });

  it('dve organizácie s rovnakým názvom dostanú rôzne adresy (edge case §11.26)', () => {
    const taken = new Set<string>();
    const a = generateUniqueAlias({
      nazov: 'Alfa s.r.o.',
      domain: DOMAIN,
      isTaken: (addr) => taken.has(addr),
    });
    taken.add(a.addressNormalized);
    const b = generateUniqueAlias({
      nazov: 'Alfa s.r.o.',
      domain: DOMAIN,
      isTaken: (addr) => taken.has(addr),
    });
    expect(a.address).not.toBe(b.address);
    expect(a.slug).toBe(b.slug);
  });

  it('pri kolízii tokenu vygeneruje nový token a zopakuje pokus (§11.3)', () => {
    let calls = 0;
    const alias = generateUniqueAlias({
      nazov: 'Alfa',
      domain: DOMAIN,
      isTaken: () => {
        calls++;
        return calls <= 3; // prvé tri pokusy kolidujú
      },
    });
    expect(calls).toBe(4);
    expect(alias.address).toMatch(/^alfa-[a-z2-9]{6}@/);
  });

  it('po vyčerpaní pokusov vyhodí zrozumiteľnú chybu', () => {
    let calls = 0;
    expect(() =>
      generateUniqueAlias({
        nazov: 'Alfa',
        domain: DOMAIN,
        isTaken: () => {
          calls++;
          return true;
        },
      }),
    ).toThrow(/kolízií/);
    expect(calls).toBe(MAX_COLLISION_ATTEMPTS);
  });

  it('použije slugSuggestion namiesto názvu, ak je zadaný (SPEC §11.19)', () => {
    const alias = generateUniqueAlias({
      nazov: 'AGS s.r.o.',
      domain: DOMAIN,
      isTaken: () => false,
      slugSuggestion: 'ags-fakturacia',
    });
    expect(alias.slug).toBe('ags-fakturacia');
  });

  it('slugSuggestion prejde rovnakou normalizáciou (žiadny token/doména od používateľa)', () => {
    const alias = generateUniqueAlias({
      nazov: 'AGS s.r.o.',
      domain: DOMAIN,
      isTaken: () => false,
      slugSuggestion: 'Môj Alias @vlastná-doména.sk',
    });
    expect(alias.slug).toMatch(/^[a-z0-9-]+$/);
    expect(alias.slug).not.toContain('@');
    expect(alias.address.split('@')[1]).toBe(DOMAIN);
  });
});

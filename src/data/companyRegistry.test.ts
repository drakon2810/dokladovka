// Mapovanie odpovedí RPO (SK) a ARES (CZ) na spoločný tvar formulára.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { lookupCompanies } from './companyRegistry';

const RPO_SLOVNAFT = {
  results: [
    {
      identifiers: [{ value: '31322832', validFrom: '1992-04-29' }],
      fullNames: [
        { value: 'SLOVNAFT a.s.', validFrom: '1992-04-29', validTo: '1998-11-29' },
        { value: 'SLOVNAFT, a.s.', validFrom: '2008-05-30' },
      ],
      addresses: [
        {
          validFrom: '2006-06-16',
          street: 'Vlčie hrdlo',
          buildingNumber: '1',
          postalCodes: ['82412'],
          municipality: { value: 'Bratislava' },
          country: { value: 'Slovenská republika' },
        },
        {
          validFrom: '1992-04-29',
          validTo: '2006-06-15',
          street: 'Stará adresa',
          postalCodes: ['81000'],
          municipality: { value: 'Košice' },
        },
      ],
    },
  ],
};

const ARES_ASSECO = {
  ekonomickeSubjekty: [
    {
      ico: '27074358',
      obchodniJmeno: 'Asseco Central Europe, a.s.',
      dic: 'CZ27074358',
      seznamRegistraci: { stavZdrojeDph: 'AKTIVNI' },
      sidlo: {
        kodStatu: 'CZ',
        nazevUlice: 'Budějovická',
        cisloDomovni: 778,
        cisloOrientacni: 3,
        cisloOrientacniPismeno: 'a',
        nazevObce: 'Praha',
        psc: 14000,
        nazevStatu: 'Česká republika',
      },
    },
    // Zahraničný subjekt bez IČO — nesmie sa dostať do našepkávača.
    { obchodniJmeno: 'Asseco CE Cloud, a.s.', sidlo: { kodStatu: 'SK', nazevObce: 'Bratislava' } },
  ],
};

function mockRegistries(rpo: unknown, ares: unknown) {
  vi.stubGlobal('fetch', vi.fn(async (url: string) => ({
    ok: true,
    json: async () => (String(url).includes('statistics.sk') ? rpo : ares),
  })));
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('lookupCompanies', () => {
  it('mapuje platný (nie historický) názov a adresu z RPO', async () => {
    mockRegistries(RPO_SLOVNAFT, { ekonomickeSubjekty: [] });
    const [hit] = await lookupCompanies('31322832');
    expect(hit).toEqual({
      nazov: 'SLOVNAFT, a.s.',
      ico: '31322832',
      ulica: 'Vlčie hrdlo 1',
      mesto: 'Bratislava',
      psc: '824 12',
      krajina: 'Slovenská republika',
    });
  });

  it('mapuje ARES vrátane DIČ/IČ DPH a súpisného/orientačného čísla, cudzie subjekty vynechá', async () => {
    mockRegistries({ results: [] }, ARES_ASSECO);
    const hits = await lookupCompanies('Asseco');
    expect(hits).toHaveLength(1);
    expect(hits[0]).toEqual({
      nazov: 'Asseco Central Europe, a.s.',
      ico: '27074358',
      dic: 'CZ27074358',
      icDph: 'CZ27074358',
      ulica: 'Budějovická 778/3a',
      mesto: 'Praha',
      psc: '140 00',
      krajina: 'Česká republika',
    });
  });

  it('neplatiteľovi DPH nechá IČ DPH prázdne, hoci DIČ má', async () => {
    mockRegistries({ results: [] }, {
      ekonomickeSubjekty: [{
        ico: '12345678',
        obchodniJmeno: 'Neplatitel s.r.o.',
        dic: 'CZ12345678',
        seznamRegistraci: { stavZdrojeDph: 'NEEXISTUJICI' },
        sidlo: { kodStatu: 'CZ', nazevObce: 'Brno', psc: 60200 },
      }],
    });
    const [hit] = await lookupCompanies('Neplatitel');
    expect(hit.dic).toBe('CZ12345678');
    expect(hit.icDph).toBeUndefined();
  });

  it('výpadok jedného registra nezhodí druhý', async () => {
    vi.stubGlobal('fetch', vi.fn(async (url: string) => (
      String(url).includes('statistics.sk')
        ? { ok: false, json: async () => ({}) }
        : { ok: true, json: async () => ARES_ASSECO }
    )));
    expect(await lookupCompanies('Asseco')).toHaveLength(1);
  });

  it('nehľadá pri neúplnom IČO ani pri krátkom názve', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    expect(await lookupCompanies('3132')).toEqual([]);
    expect(await lookupCompanies('as')).toEqual([]);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

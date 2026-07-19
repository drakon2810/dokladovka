import { describe, expect, it } from 'vitest';
import { dphPokynyPreAi, posudDph } from './dphAdvisor.js';
import type { DphProfil } from './dphProfileService.js';

function profil(overrides: Partial<DphProfil> = {}): DphProfil {
  return {
    organizationId: 'org-1',
    tenantId: 'tenant-1',
    platitelDph: 'platitel',
    obdobieDph: 'mesacne',
    koeficient: [],
    pomerneOdpocitanie: [],
    rezim: 'tuzemsky',
    nakupyZEu: false,
    sluzbyZEu: false,
    prenesenieDp: false,
    pravidlaAut: [],
    bezNaroku: [],
    samozdanenieAktivne: false,
    ...overrides,
  };
}

function dokument(extracted: Record<string, unknown>, clenenieDph?: { id: string; kod: string; nazov: string }) {
  return { documentType: 'FP', extracted, accounting: {}, clenenieDph };
}

const FAKTURA_S_DPH = {
  dodavatel: { nazov: 'Slovnaft a.s.', icDph: 'SK2020123456' },
  datumVystavenia: '2026-07-01',
  datumDodania: '2026-07-01',
  mena: 'EUR',
  rozpisDph: [{ sadzba: 23, zaklad: 100, dph: 23 }],
  sumaSpolu: 123,
  polozky: [{ popis: 'Natural 95 — PHM' }],
};

describe('dphAdvisor — posudDph', () => {
  it('neplatiteľ so zvoleným odpočtom je blokovaný; bez členenia len návrh', () => {
    const bezClenenia = posudDph(dokument(FAKTURA_S_DPH), profil({ platitelDph: 'neplatitel' }));
    expect(bezClenenia.blokacie).toHaveLength(0);
    expect(bezClenenia.navrhy.some((zistenie) => zistenie.kod === 'dph_bez_odpoctu')).toBe(true);

    const sOdpoctom = posudDph(
      dokument(FAKTURA_S_DPH, { id: 'cl-1', kod: 'PD', nazov: 'Plný odpočet' }),
      profil({ platitelDph: 'neplatitel' }),
    );
    expect(sOdpoctom.blokacie).toHaveLength(1);
    expect(sOdpoctom.blokacie[0].kod).toBe('dph_neplatitel_odpocet');

    const bezOdpoctu = posudDph(
      dokument(FAKTURA_S_DPH, { id: 'cl-2', kod: 'BO', nazov: 'Bez nároku na odpočet' }),
      profil({ platitelDph: 'neplatitel' }),
    );
    expect(bezOdpoctu.blokacie).toHaveLength(0);
  });

  it('explicitné členenie bez odpočtu v profile má prednosť pred heuristikou', () => {
    const nastaveny = profil({ platitelDph: 'registracia_7a', clenenieBezOdpoctuId: 'cl-bo' });
    const spravne = posudDph(dokument(FAKTURA_S_DPH, { id: 'cl-bo', kod: 'X1', nazov: 'Vlastné' }), nastaveny);
    expect(spravne.blokacie).toHaveLength(0);
    const zle = posudDph(dokument(FAKTURA_S_DPH, { id: 'cl-ine', kod: 'X2', nazov: 'Iné' }), nastaveny);
    expect(zle.blokacie).toHaveLength(1);
  });

  it('kandidát na samozdanenie: EÚ dodávateľ bez DPH', () => {
    const vysledok = posudDph(dokument({
      dodavatel: { nazov: 'Alza.cz a.s.', icDph: 'CZ27082440' },
      datumDodania: '2026-07-02',
      mena: 'EUR',
      rozpisDph: [{ sadzba: 0, zaklad: 200, dph: 0 }],
      sumaSpolu: 200,
    }), profil({ samozdanenieAktivne: true, samozdanenieClenenieDphId: 'cl-b1', samozdanenieClenenieKvKod: 'B1' }));
    const kandidat = vysledok.navrhy.find((zistenie) => zistenie.kod === 'dph_samozdanenie_kandidat');
    expect(kandidat).toBeDefined();
    expect(kandidat?.sprava).toContain('46.00');
    expect(kandidat?.clenenieDphId).toBe('cl-b1');
    expect(kandidat?.clenenieKvKod).toBe('B1');
  });

  it('slovenský dodávateľ s DPH nie je kandidát na samozdanenie', () => {
    const vysledok = posudDph(dokument(FAKTURA_S_DPH), profil({ samozdanenieAktivne: true }));
    expect(vysledok.navrhy.some((zistenie) => zistenie.kod === 'dph_samozdanenie_kandidat')).toBe(false);
  });

  it('pravidlo pre autá: kľúčové slovo PHM v položkách spustí varovanie 80 %', () => {
    const vysledok = posudDph(dokument(FAKTURA_S_DPH), profil({
      pravidlaAut: [{ kategoria: 'PHM osobné auto', percento: 80, klucoveSlova: ['PHM', 'servis'] }],
    }));
    const varovanie = vysledok.varovania.find((zistenie) => zistenie.kod === 'dph_auto_odpocet');
    expect(varovanie).toBeDefined();
    expect(varovanie?.percento).toBe(80);
    expect(varovanie?.sprava).toContain('80 %');
  });

  it('kľúčové slová sa zhodujú bez diakritiky a veľkosti písmen', () => {
    const vysledok = posudDph(dokument({
      dodavatel: { nazov: 'Reštaurácia Koliba' },
      datumDodania: '2026-07-03',
      rozpisDph: [{ sadzba: 23, zaklad: 50, dph: 11.5 }],
      sumaSpolu: 61.5,
      polozky: [{ popis: 'Občerstvenie na poradu' }],
    }), profil({
      bezNaroku: [{ kategoria: 'Reprezentácia', klucoveSlova: ['obcerstvenie', 'reprezentacia'] }],
    }));
    expect(vysledok.varovania.some((zistenie) => zistenie.kod === 'dph_bez_naroku')).toBe(true);
  });

  it('uzavreté obdobie: DUZP pred dátumom podania varuje na dodatočné priznanie', () => {
    const vysledok = posudDph(dokument(FAKTURA_S_DPH), profil({ uzavreteDo: '2026-07-31' }));
    expect(vysledok.varovania.some((zistenie) => zistenie.kod === 'dph_obdobie_uzavrete')).toBe(true);
    const otvorene = posudDph(dokument(FAKTURA_S_DPH), profil({ uzavreteDo: '2026-06-30' }));
    expect(otvorene.varovania.some((zistenie) => zistenie.kod === 'dph_obdobie_uzavrete')).toBe(false);
  });

  it('koeficient: návrh s hodnotou pre rok DUZP, zálohový má prednosť', () => {
    const vysledok = posudDph(dokument(FAKTURA_S_DPH), profil({
      koeficient: [
        { rok: 2025, typ: 'rocny', hodnota: 0.9 },
        { rok: 2026, typ: 'rocny', hodnota: 0.85 },
        { rok: 2026, typ: 'zalohovy', hodnota: 0.87 },
      ],
    }));
    const navrh = vysledok.navrhy.find((zistenie) => zistenie.kod === 'dph_koeficient');
    expect(navrh?.sprava).toContain('0,87');
    expect(navrh?.sprava).toContain('2026');
  });

  it('prenesenie DP (§69): SK doklad bez DPH s bežným členením varuje', () => {
    const vysledok = posudDph(dokument({
      dodavatel: { nazov: 'Stavby SK s.r.o.', icDph: 'SK2020999999' },
      datumDodania: '2026-07-05',
      rozpisDph: [],
      sumaSpolu: 1500,
    }, { id: 'cl-pd', kod: 'PD', nazov: 'Plný odpočet' }), profil({ prenesenieDp: true }));
    const varovanie = vysledok.varovania.find((zistenie) => zistenie.kod === 'dph_prenesenie_kandidat');
    expect(varovanie).toBeDefined();
    expect(varovanie?.sprava).toContain('bežné členenie');
  });

  it('neplatiteľ nedostáva varovania o krátení odpočtu', () => {
    const vysledok = posudDph(dokument(FAKTURA_S_DPH), profil({
      platitelDph: 'neplatitel',
      pravidlaAut: [{ kategoria: 'PHM', percento: 80, klucoveSlova: ['PHM'] }],
      koeficient: [{ rok: 2026, typ: 'zalohovy', hodnota: 0.87 }],
    }));
    expect(vysledok.varovania.some((zistenie) => zistenie.kod === 'dph_auto_odpocet')).toBe(false);
    expect(vysledok.navrhy.some((zistenie) => zistenie.kod === 'dph_koeficient')).toBe(false);
  });
});

describe('dphAdvisor — dphPokynyPreAi', () => {
  it('odvodzuje pokyny z profilu', () => {
    const pokyny = dphPokynyPreAi(profil({
      platitelDph: 'neplatitel',
      pravidlaAut: [{ kategoria: 'PHM', percento: 80, klucoveSlova: ['PHM'] }],
      bezNaroku: [{ kategoria: 'Reprezentácia', klucoveSlova: ['reprezentácia'] }],
      samozdanenieAktivne: true,
      samozdanenieClenenieDphId: 'cl-b1',
    }));
    expect(pokyny.join(' ')).toContain('bez odpočtu');
    expect(pokyny.join(' ')).toContain('80 %');
    expect(pokyny.join(' ')).toContain('cl-b1');
    expect(pokyny.join(' ')).toContain('Reprezentácia');
  });
});

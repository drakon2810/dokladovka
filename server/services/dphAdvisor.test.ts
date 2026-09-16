import { describe, expect, it } from 'vitest';
import { clenenieVyzeraNaOdpocet, dphPokynyPreAi, posudDph } from './dphAdvisor.js';
import { predvolenyDphProfil, type DphProfil } from './dphProfileService.js';

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

  it('samozdanenie počíta sadzbou platnou v deň plnenia, nie dnešnou', () => {
    const vysledok = posudDph(dokument({
      dodavatel: { nazov: 'Alza.cz a.s.', icDph: 'CZ27082440' },
      datumDodania: '2024-11-20',
      mena: 'EUR',
      rozpisDph: [{ sadzba: 0, zaklad: 200, dph: 0 }],
      sumaSpolu: 200,
    }), profil({ samozdanenieAktivne: true }));
    const kandidat = vysledok.navrhy.find((zistenie) => zistenie.kod === 'dph_samozdanenie_kandidat');
    expect(kandidat?.sprava).toContain('DPH 20 % = 40.00');
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

  it('pravidlo pre autá s obdobím platnosti mlčí mimo neho', () => {
    const pravidlaAut = [{ kategoria: 'Osobné auto', percento: 80, percentoDph: 50, klucoveSlova: ['PHM'], platnostOd: '2026-01-01' }];
    const vlani = posudDph(dokument({ ...FAKTURA_S_DPH, datumDodania: '2025-12-15' }), profil({ pravidlaAut }));
    expect(vlani.varovania.some((zistenie) => zistenie.kod === 'dph_auto_odpocet')).toBe(false);
    const tento = posudDph(dokument(FAKTURA_S_DPH), profil({ pravidlaAut }));
    expect(tento.varovania.some((zistenie) => zistenie.kod === 'dph_auto_odpocet')).toBe(true);
    expect(dphPokynyPreAi(profil({ pravidlaAut })).join(' ')).toContain('od 2026-01-01');
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

  it('koeficient iného roka sa nepoužije; ročný z minulého roka platí ako zálohový', () => {
    const stary = posudDph(dokument(FAKTURA_S_DPH), profil({ koeficient: [{ rok: 2024, typ: 'rocny', hodnota: 0.8 }] }));
    expect(stary.navrhy.some((zistenie) => zistenie.kod === 'dph_koeficient')).toBe(false);
    const minuly = posudDph(dokument(FAKTURA_S_DPH), profil({ koeficient: [{ rok: 2025, typ: 'rocny', hodnota: 0.9 }] }));
    expect(minuly.navrhy.find((zistenie) => zistenie.kod === 'dph_koeficient')?.percento).toBe(90);
  });

  it('firma bez profilu nie je platiteľ ani neplatiteľ', () => {
    const nezname = predvolenyDphProfil('tenant-1', 'org-1');
    expect(nezname.platitelDph).toBe('nezname');
    expect(dphPokynyPreAi(nezname).join(' ')).not.toContain('bez odpočtu');
    const vysledok = posudDph(dokument(FAKTURA_S_DPH, { id: 'cl-pd', kod: 'PD', nazov: 'Tuzemské plnenia' }), nezname);
    expect(vysledok.blokacie).toHaveLength(0);
    expect(vysledok.navrhy.some((zistenie) => zistenie.kod === 'dph_bez_odpoctu')).toBe(false);
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

  it('cudzia daň: rakúsky dodávateľ s 20 % blokuje tuzemské členenie s odpočtom', () => {
    const rakuskaFaktura = {
      dodavatel: {
        nazov: 'Autobahnen- und Schnellstraßen-Finanzierungs-AG',
        icDph: 'ATU43143200',
        krajina: 'AT',
      },
      datumVystavenia: '2026-07-13',
      datumDodania: '2026-07-13',
      mena: 'EUR',
      rozpisDph: [{ sadzba: 20, zaklad: 89, dph: 17.8 }],
      sumaSpolu: 106.8,
      polozky: [{ popis: 'Annual vignette Car 2026' }],
    };
    const sOdpoctom = posudDph(
      dokument(rakuskaFaktura, { id: 'cl-pd', kod: 'PD', nazov: 'Tuzemské plnenia' }),
      profil(),
    );
    expect(sOdpoctom.navrhy.some((zistenie) => zistenie.kod === 'dph_cudzia_dan')).toBe(true);
    expect(sOdpoctom.blokacie.map((zistenie) => zistenie.kod)).toEqual(['dph_cudzia_dan_odpocet']);
    expect(sOdpoctom.blokacie[0].sprava).toContain('17.80');

    // Tvar po normalizácii: rozpis je nezdaniteľný, daň drží `cudziaDan`.
    const poNormalizacii = posudDph(dokument({
      ...rakuskaFaktura,
      rozpisDph: [{ sadzba: 0, zaklad: 106.8, dph: 0 }],
      cudziaDan: 17.8,
    }, { id: 'cl-pd', kod: 'PD', nazov: 'Tuzemské plnenia' }), profil({ samozdanenieAktivne: true }));
    expect(poNormalizacii.blokacie.map((zistenie) => zistenie.kod)).toEqual(['dph_cudzia_dan_odpocet']);
    // A nie je to kandidát na samozdanenie — daň dodávateľ účtoval, len cudziu.
    expect(poNormalizacii.navrhy.some((zistenie) => zistenie.kod === 'dph_samozdanenie_kandidat')).toBe(false);

    // Členenie bez odpočtu je správna voľba — návrh ostáva, blokácia nie.
    const bezOdpoctu = posudDph(
      dokument(rakuskaFaktura, { id: 'cl-un', kod: 'UN', nazov: 'Nezahrnované do priznania' }),
      profil(),
    );
    expect(bezOdpoctu.blokacie).toHaveLength(0);
    expect(bezOdpoctu.navrhy.some((zistenie) => zistenie.kod === 'dph_cudzia_dan')).toBe(true);
  });

  it('cudzia daň sa nespustí na slovenskej dani ani na SK registrácii cudzej firmy', () => {
    const domaci = posudDph(dokument(FAKTURA_S_DPH, { id: 'cl-pd', kod: 'PD', nazov: 'Tuzemské plnenia' }), profil());
    expect(domaci.blokacie).toHaveLength(0);
    expect(domaci.navrhy.some((zistenie) => zistenie.kod === 'dph_cudzia_dan')).toBe(false);

    // Rakúska firma registrovaná v SR fakturuje slovenských 23 % — bežný nákup.
    const skRegistracia = posudDph(dokument({
      dodavatel: { nazov: 'Wien Handel GmbH', icDph: 'SK4020123456', krajina: 'AT' },
      datumDodania: '2026-07-13',
      mena: 'EUR',
      rozpisDph: [{ sadzba: 23, zaklad: 100, dph: 23 }],
      sumaSpolu: 123,
    }, { id: 'cl-pd', kod: 'PD', nazov: 'Tuzemské plnenia' }), profil());
    expect(skRegistracia.blokacie).toHaveLength(0);
    expect(skRegistracia.navrhy.some((zistenie) => zistenie.kod === 'dph_cudzia_dan')).toBe(false);
  });

  it('položka s vlastným členením sa posudzuje ako hlavička (R1 z auditu)', () => {
    // Neplatiteľ: hlavička bez odpočtu, položka s odpočtom. Posudzovala sa len
    // hlavička, takže doklad prešiel bez blokácie a export poslal PD za riadok.
    const r1 = {
      documentType: 'FP',
      extracted: {
        sumaSpolu: 123, rozpisDph: [{ zaklad: 100, dph: 23 }],
        polozky: [{ popis: 'Synthetic', sumaSpolu: 123, ucto: { clenenieDphId: 'PD' } }],
      },
      accounting: { clenenieDphId: 'UN' },
      clenenieDph: { id: 'UN', kod: 'UN', nazov: 'Nezahrnovat do DPH' },
      cleneniaPoloziek: [{ id: 'PD', kod: 'PD', nazov: 'Tuzemské plnenie s odpočtom' }],
    };
    expect(posudDph(r1, profil({ platitelDph: 'neplatitel' })).blokacie.map((zistenie) => zistenie.kod))
      .toEqual(['dph_neplatitel_odpocet']);
    // Položka bez vlastného členenia dedí hlavičku — tá odpočet neuplatňuje.
    const zdedene = { ...r1, extracted: { ...r1.extracted, polozky: [{ popis: 'Synthetic', sumaSpolu: 123 }] } };
    expect(posudDph(zdedene, profil({ platitelDph: 'neplatitel' })).blokacie).toHaveLength(0);

    // Cudzia daň: to isté pravidlo pre položku s odpočtom pod hlavičkou UN.
    const cudzia = {
      ...r1,
      extracted: {
        dodavatel: { nazov: 'ASFINAG', icDph: 'ATU43143200', krajina: 'AT' },
        rozpisDph: [{ sadzba: 20, zaklad: 89, dph: 17.8 }], sumaSpolu: 106.8,
        polozky: [{ popis: 'Vignette', sumaSpolu: 106.8, ucto: { clenenieDphId: 'PD' } }],
      },
    };
    expect(posudDph(cudzia, profil()).blokacie.map((zistenie) => zistenie.kod)).toEqual(['dph_cudzia_dan_odpocet']);
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

// Dáta z produkcie (16. 9. 2026): 675 dokladov má hlavičku PD s B2 a riadky PN —
// čiastočný odpočet, zákonný. Podozrivý je až doklad, na ktorom sa neodpočítava
// NIČ, a predsa ide do B2/B3. Ani vtedy nie blokácia, len návrh KN.
describe('dphAdvisor — sekcia B2/B3 bez odpočtu na celom doklade', () => {
  const PN = { id: 'cl-pn', kod: 'PN', nazov: 'Nezahrňovať do priznania DPH' };
  const PD = { id: 'cl-pd', kod: 'PD', nazov: 'Tuzemské plnenia' };
  const posud = (accounting: Record<string, string>, polozky: Array<Record<string, unknown>> = []) => posudDph({
    documentType: 'FP',
    extracted: { ...FAKTURA_S_DPH, polozky },
    accounting,
    clenenieDph: [PN, PD].find((clenenie) => clenenie.id === accounting.clenenieDphId),
    cleneniaPoloziek: [PN, PD],
  }, profil());
  const kvNavrh = (vysledok: ReturnType<typeof posudDph>) => vysledok.navrhy.find((zistenie) => zistenie.kod === 'dph_kv_bez_odpoctu');

  it('hlavička PN so sekciou B2 a žiadny odpočet: návrh KN, nie blokácia', () => {
    const vysledok = posud({ clenenieDphId: PN.id, clenenieKvKod: 'B2' }, [{ popis: 'Káva' }]);
    expect(kvNavrh(vysledok)).toMatchObject({ clenenieKvKod: 'KN' });
    expect(vysledok.blokacie).toHaveLength(0);
  });

  it('aspoň jeden riadok s odpočtom: PN s B2 inde je v poriadku', () => {
    const vysledok = posud({ clenenieDphId: PN.id, clenenieKvKod: 'B2' },
      [{ popis: 'Káva' }, { popis: 'Papier', ucto: { clenenieDphId: PD.id } }]);
    expect(kvNavrh(vysledok)).toBeUndefined();
  });

  it('riadok so sekciou B3 pod hlavičkou KN bez odpočtu sa tiež ozve', () => {
    const vysledok = posud({ clenenieDphId: PN.id, clenenieKvKod: 'KN' }, [{ popis: 'Káva', ucto: { clenenieKvKod: 'B3' } }]);
    expect(kvNavrh(vysledok)).toBeDefined();
  });

  it('odpočet v hlavičke alebo sekcia KN: nič', () => {
    expect(kvNavrh(posud({ clenenieDphId: PD.id, clenenieKvKod: 'B2' }))).toBeUndefined();
    expect(kvNavrh(posud({ clenenieDphId: PN.id, clenenieKvKod: 'KN' }))).toBeUndefined();
  });
});

describe('dphAdvisor — clenenieVyzeraNaOdpocet', () => {
  it('známy kód POHODY rozhoduje podľa riadkov priznania, nie podľa názvu', () => {
    // „Nadobudnutie tovaru prvým odberateľom" do priznania nevstupuje — názov o tom mlčí.
    expect(clenenieVyzeraNaOdpocet({ kod: 'PD1odb', nazov: 'Nadobudnutie tovaru prvým odberateľom' })).toBe(false);
    expect(clenenieVyzeraNaOdpocet({ kod: 'PDtovar', nazov: 'Dovoz tovaru' })).toBe(true);
    expect(clenenieVyzeraNaOdpocet({ kod: 'X1', nazov: 'Vlastné' })).toBe(true);
    expect(clenenieVyzeraNaOdpocet({ kod: 'X2', nazov: 'Bez nároku na odpočet' })).toBe(false);
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

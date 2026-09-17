import { describe, expect, it } from 'vitest';
import { clenenieVyzeraNaOdpocet, dphPokynyPreAi, posudDph } from './dphAdvisor.js';
import { predvolenyDphProfil, type DphProfil } from './dphProfileService.js';

function profil(overrides: Partial<DphProfil> = {}): DphProfil {
  return { ...predvolenyDphProfil('tenant-1', 'org-1'), platitelDph: 'platitel', ...overrides };
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

const ALZA_BEZ_DPH = {
  dodavatel: { nazov: 'Alza.cz a.s.', icDph: 'CZ27082440' },
  datumDodania: '2026-07-02',
  mena: 'EUR',
  rozpisDph: [{ sadzba: 0, zaklad: 200, dph: 0 }],
  sumaSpolu: 200,
};

const PHM_AUTO = {
  kategoria: 'PHM osobné auto', percento: 80, percentoDph: 50, klucoveSlova: ['PHM', 'servis'],
  predkontaciaKod: 'PHM-501200', predkontaciaNedanovaKod: 'PHM-Nadspotreba', clenenieDphNedanoveKod: 'PN',
};

const kandidat = (vysledok: ReturnType<typeof posudDph>) =>
  vysledok.navrhy.find((zistenie) => zistenie.kod === 'dph_samozdanenie_kandidat');

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

  it('kandidát na samozdanenie: EÚ dodávateľ bez DPH dostane členenie faktúry z potvrdených druhov', () => {
    const faktura = { clenenieKod: 'PN', clenenieDphId: 'cl-pn', kv: 'KN' };
    const vysledok = kandidat(posudDph(dokument(ALZA_BEZ_DPH), profil({
      samozdanenie: {
        sluzby_eu: { faktura, interny: { ddKod: 'DDsl§69', pKod: 'PDsluz', kv: 'B1' } },
        tovar_eu: { faktura, interny: { ddKod: 'DDnadEU', pKod: 'PDnadEU', kv: 'B1' } },
        // Spoza EÚ sa na českého dodávateľa nevzťahuje.
        sluzby_mimo_eu: { faktura: { clenenieKod: 'PB', clenenieDphId: 'cl-pb' } },
      },
    })));
    expect(vysledok).toMatchObject({ clenenieDphId: 'cl-pn', clenenieKvKod: 'KN' });
    expect(vysledok?.sprava).toContain('46.00');
    expect(vysledok?.sprava).toContain('Služby z EÚ (§69 ods. 3): faktúra PN, KV KN; interný doklad DDsl§69 a PDsluz, KV B1');
    expect(vysledok?.sprava).not.toContain('cl-pn');

    // Druhy s rôznou faktúrou: z dokladu nevieme, či ide o službu alebo tovar — členenie nenavrhneme.
    const rozne = kandidat(posudDph(dokument(ALZA_BEZ_DPH), profil({
      samozdanenie: { sluzby_eu: { faktura }, tovar_eu: { faktura: { clenenieKod: 'PB', clenenieDphId: 'cl-pb' } } },
    })));
    expect(rozne).toBeDefined();
    expect(rozne?.clenenieDphId).toBeUndefined();
    expect(rozne?.clenenieKvKod).toBeUndefined();
  });

  it('kandidát na samozdanenie beží aj bez profilu a aj pri dodávateľovi spoza EÚ', () => {
    const svajciarsky = {
      dodavatel: { nazov: 'Swiss Software AG', krajina: 'CH' },
      datumDodania: '2026-07-02', mena: 'EUR', rozpisDph: [], sumaSpolu: 500,
    };
    const bezProfilu = kandidat(posudDph(dokument(svajciarsky), predvolenyDphProfil('tenant-1', 'org-1')));
    expect(bezProfilu?.sprava).toContain('dodávateľ z CH');
    expect(bezProfilu?.clenenieDphId).toBeUndefined();

    const sProfilom = kandidat(posudDph(dokument(svajciarsky), profil({
      samozdanenie: {
        sluzby_mimo_eu: { faktura: { clenenieKod: 'PN', clenenieDphId: 'cl-pn', kv: 'KN' } },
        sluzby_eu: { faktura: { clenenieKod: 'PB', clenenieDphId: 'cl-pb' } },
      },
    })));
    expect(sProfilom).toMatchObject({ clenenieDphId: 'cl-pn', clenenieKvKod: 'KN' });
  });

  it('samozdanenie počíta sadzbou platnou v deň plnenia, nie dnešnou', () => {
    const vysledok = posudDph(dokument({ ...ALZA_BEZ_DPH, datumDodania: '2024-11-20' }), profil());
    expect(kandidat(vysledok)?.sprava).toContain('DPH 20 % = 40.00');
  });

  it('slovenský dodávateľ s DPH nie je kandidát na samozdanenie', () => {
    expect(kandidat(posudDph(dokument(FAKTURA_S_DPH), profil()))).toBeUndefined();
  });

  it('pravidlo pre autá hovorí daňový náklad aj odpočet DPH; pomerné len odpočet, bez diakritiky', () => {
    const auto = posudDph(dokument(FAKTURA_S_DPH), profil({ pravidlaAut: [PHM_AUTO] }))
      .varovania.find((zistenie) => zistenie.kod === 'dph_auto_odpocet');
    expect(auto).toMatchObject({ percento: 80, sprava: 'Daňový náklad 80 %, odpočet DPH 50 % — PHM osobné auto (nájdené „PHM“).' });

    const pomerne = posudDph(dokument({ ...FAKTURA_S_DPH, polozky: [{ popis: 'Mobilný paušál 04/2026' }] }), profil({
      pomerneOdpocitanie: [{
        kategoria: 'Telefón', percento: 70, percentoDph: 70, klucoveSlova: ['mobilny pausal'],
        predkontaciaKod: '518100', predkontaciaNedanovaKod: '518100', clenenieDphNedanoveKod: 'PN',
      }],
    })).varovania.find((zistenie) => zistenie.kod === 'dph_pomerny_odpocet');
    expect(pomerne?.sprava).toBe('Odpočet DPH 70 % — Telefón (nájdené „mobilny pausal“).');
  });

  it('koeficient: návrh s hodnotou len pri oslobodených plneniach', () => {
    const navrh = posudDph(dokument(FAKTURA_S_DPH), profil({ oslobodenePlnenia: true, koeficient: 0.87 }))
      .navrhy.find((zistenie) => zistenie.kod === 'dph_koeficient');
    expect(navrh).toMatchObject({ percento: 87 });
    expect(navrh?.sprava).toContain('0,87');
    expect(posudDph(dokument(FAKTURA_S_DPH), profil({ oslobodenePlnenia: true })).navrhy
      .some((zistenie) => zistenie.kod === 'dph_koeficient')).toBe(false);
  });

  it('firma bez profilu nie je platiteľ ani neplatiteľ', () => {
    const nezname = predvolenyDphProfil('tenant-1', 'org-1');
    expect(nezname.platitelDph).toBe('nezname');
    expect(dphPokynyPreAi(nezname)).toEqual([]);
    const vysledok = posudDph(dokument(FAKTURA_S_DPH, { id: 'cl-pd', kod: 'PD', nazov: 'Tuzemské plnenia' }), nezname);
    expect(vysledok.blokacie).toHaveLength(0);
    expect(vysledok.navrhy.some((zistenie) => zistenie.kod === 'dph_bez_odpoctu')).toBe(false);
  });

  it('prenesenie DP (§69 ods. 12): SK doklad bez DPH varuje len firme s potvrdeným prijatým prenesením', () => {
    const stavby = dokument({
      dodavatel: { nazov: 'Stavby SK s.r.o.', icDph: 'SK2020999999' },
      datumDodania: '2026-07-05',
      rozpisDph: [],
      sumaSpolu: 1500,
    }, { id: 'cl-pd', kod: 'PD', nazov: 'Plný odpočet' });
    const varovanie = posudDph(stavby, profil({
      samozdanenie: { prenesenie_prijate: { interny: { ddKod: 'DDsluz', pKod: 'PDsluz' } } },
    })).varovania.find((zistenie) => zistenie.kod === 'dph_prenesenie_kandidat');
    expect(varovanie?.sprava).toContain('bežné členenie');
    expect(posudDph(stavby, profil()).varovania.some((zistenie) => zistenie.kod === 'dph_prenesenie_kandidat')).toBe(false);
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
    }, { id: 'cl-pd', kod: 'PD', nazov: 'Tuzemské plnenia' }), profil());
    expect(poNormalizacii.blokacie.map((zistenie) => zistenie.kod)).toEqual(['dph_cudzia_dan_odpocet']);
    // A nie je to kandidát na samozdanenie — daň dodávateľ účtoval, len cudziu.
    expect(kandidat(poNormalizacii)).toBeUndefined();

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
      pravidlaAut: [PHM_AUTO],
      oslobodenePlnenia: true,
      koeficient: 0.87,
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
  it('pomenuje potvrdené fakty kódmi, nikdy nie id', () => {
    const pokyny = dphPokynyPreAi(profil({
      platitelDph: 'registracia_7a',
      clenenieBezOdpoctuKod: 'PB', clenenieBezOdpoctuId: 'cl-pb',
      samozdanenie: {
        sluzby_eu: {
          faktura: { clenenieKod: 'PN', clenenieDphId: 'cl-pn', kv: 'KN' },
          interny: { ddKod: 'DDsl§69', pKod: 'PDsluz', kv: 'B1' },
        },
        dovoz: { faktura: { clenenieKod: 'PDtovar', clenenieDphId: 'cl-pdtovar' } },
      },
      oslobodenePlnenia: false,
      pravidlaAut: [{ ...PHM_AUTO, predkontaciaId: 'id-phm', predkontaciaNedanovaId: 'id-nad', clenenieDphNedanoveId: 'cl-pn' }],
      bezNarokuUcty: [{ predkontaciaKod: '513100', predkontaciaId: 'id-repre', clenenieKod: 'PN', clenenieDphId: 'cl-pn' }],
      vratenieDph: { uplatnujeme: true, predkontaciaKod: '378-DPH', predkontaciaId: 'id-378' },
      tovarNaCeste: false,
      drobnyMajetokHranica: 1700,
    }));
    expect(pokyny).toEqual([
      'Organizácia nemá nárok na odpočet DPH — vždy vyber členenie DPH bez odpočtu (PB).',
      'Služby z EÚ (§69 ods. 3): faktúra PN, KV KN; interný doklad DDsl§69 a PDsluz, KV B1.',
      'Dovoz tovaru: faktúra PDtovar.',
      'Organizácia nemá oslobodené plnenia — odpočet nekráti, členenia krátenia (PK) nepoužívaj.',
      'Ak sa v doklade vyskytuje „PHM“, „servis“, daňový náklad je 80 % a odpočet DPH 50 % (PHM osobné auto; daňová časť PHM-501200, nedaňová PHM-Nadspotreba s členením PN).',
      'Na účte 513100 firma neodpočítava — členenie PN.',
      'Zahraničnú DPH si firma nechá vrátiť (§55a) — položka cudzej dane je pohľadávka na 378-DPH, nie náklad.',
      'Firma tovar na ceste (účet 139) neúčtuje.',
      'Majetok so základom od 1700 € je dlhodobý; lacnejší je drobný majetok v nákladoch.',
    ]);
    expect(pokyny.join(' ')).not.toMatch(/cl-|id-/);
  });
});

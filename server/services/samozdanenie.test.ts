import { describe, expect, it } from 'vitest';
import { predvolenyDphProfil, type DphProfil } from './dphProfileService.js';
import { danZoZakladu, polozkyPrenosu, zostavSamozdanenie } from './samozdanenieService.js';

const KODY = { ddKod: 'DDsl§69', ddPredkontaciaKod: 'aInt', pKod: 'PDsluz', pPredkontaciaKod: 'bInt', kv: 'B1' };

function profil(cast: Partial<DphProfil> = {}): DphProfil {
  return {
    ...predvolenyDphProfil('t1', 'o1'),
    platitelDph: 'platitel',
    samozdanenie: { sluzby_eu: { interny: KODY }, tovar_eu: { interny: { ...KODY, ddKod: 'DDnadEU', pKod: 'PDnadEU' } } },
    ...cast,
  };
}

const faktura = (extracted: Record<string, unknown> = {}, dodavatel: Record<string, unknown> = { nazov: 'Google Ireland', icDph: 'IE6388047V', krajina: 'IE' }) => ({
  dodavatel, cisloFaktury: '5301', datumVystavenia: '2026-06-12', datumDodania: '2026-06-10', mena: 'EUR',
  rozpisDph: [{ sadzba: 0, zaklad: 1000, dph: 0 }], sumaSpolu: 1000, ...extracted,
});

const zostav = (vstup: Partial<Parameters<typeof zostavSamozdanenie>[0]> = {}) => zostavSamozdanenie({
  documentType: 'FP', podtyp: 'bezna', extracted: faktura(), profil: profil(), ...vstup,
});

describe('samozdanenie — kedy sa blok ukáže', () => {
  it('cudzí dodávateľ z EÚ a spoza EÚ, faktúra bez DPH', () => {
    expect(zostav()).toMatchObject({ uzemie: 'eu', hodnota: { druh: 'sluzby_eu' } });
    // IČ DPH z EÚ stačí aj bez prečítanej krajiny.
    expect(zostav({ extracted: faktura({}, { nazov: 'A1', icDph: 'ATU12345678' }) })).toMatchObject({ uzemie: 'eu' });
    expect(zostav({ extracted: faktura({}, { nazov: 'Slack', krajina: 'US' }) }))
      .toMatchObject({ uzemie: 'mimo_eu', hodnota: { druh: 'sluzby_mimo_eu' } });
  });

  it('slovenský dodávateľ len s potvrdeným prijatým prenesením', () => {
    const tuzemsky = faktura({}, { nazov: 'Stavby s.r.o.', icDph: 'SK2020123456' });
    expect(zostav({ extracted: tuzemsky })).toBeUndefined();
    expect(zostav({ extracted: tuzemsky, profil: profil({ samozdanenie: { prenesenie_prijate: { interny: KODY } } }) }))
      .toMatchObject({ uzemie: 'sk', hodnota: { druh: 'prenesenie_prijate' } });
  });

  it('nie pri faktúre s DPH, dobropise ani ostatnom záväzku', () => {
    expect(zostav({ extracted: faktura({ rozpisDph: [{ sadzba: 23, zaklad: 1000, dph: 230 }], sumaSpolu: 1230 }) })).toBeUndefined();
    expect(zostav({ podtyp: 'dobropis' })).toBeUndefined();
    expect(zostav({ documentType: 'OZ' })).toBeUndefined();
  });
});

describe('samozdanenie — predvolená voľba', () => {
  it('pamäť dodávateľa > nastavenie firmy > vytvoriť doklady; uložená voľba má prednosť', () => {
    const vPohode = profil({ samozdanenieVPohode: true });
    expect(zostav()?.predvolene).toEqual({ volba: 'vytvorit', zdroj: 'predvolene' });
    expect(zostav({ profil: vPohode })?.hodnota).toMatchObject({ volba: 'v_pohode', zdroj: 'firma' });
    expect(zostav({ profil: vPohode, pamat: { dovod: 'miesto_dodania' } })?.hodnota)
      .toMatchObject({ volba: 'nevznika', zdroj: 'dodavatel', dovod: 'miesto_dodania' });
    expect(zostav({ pamat: { dovod: 'iny', dovodText: 'Licencia bez plnenia' } })?.hodnota)
      .toMatchObject({ volba: 'nevznika', dovod: 'iny', dovodText: 'Licencia bez plnenia' });
    expect(zostav({ profil: vPohode, ulozene: { volba: 'vytvorit', zdroj: 'uctovnik' } })?.hodnota)
      .toMatchObject({ volba: 'vytvorit', zdroj: 'uctovnik' });
  });

  it('hodnota zapísaná schválením z predvolieb sa prepočíta; druh pripne len ručná zmena, voľbu prenos do POHODY', () => {
    const zoSchvalenia = { volba: 'vytvorit', druh: 'sluzby_eu', zdroj: 'predvolene' } as const;
    const zUsa = faktura({}, { nazov: 'Slack', icDph: '', krajina: 'US' });
    // Opravený dodávateľ a nové nastavenie firmy sa prejavia.
    expect(zostav({ extracted: zUsa, ulozene: zoSchvalenia })?.hodnota).toMatchObject({ druh: 'sluzby_mimo_eu', zdroj: 'predvolene' });
    expect(zostav({ profil: profil({ samozdanenieVPohode: true }), ulozene: zoSchvalenia })?.hodnota).toMatchObject({ volba: 'v_pohode', zdroj: 'firma' });
    // Voľba účtovníka ostáva, druh bez ručnej zmeny ide za územím.
    expect(zostav({ extracted: zUsa, ulozene: { volba: 'v_pohode', druh: 'sluzby_eu', zdroj: 'uctovnik' } })?.hodnota)
      .toMatchObject({ volba: 'v_pohode', druh: 'sluzby_mimo_eu' });
    expect(zostav({ extracted: zUsa, ulozene: { volba: 'vytvorit', zdroj: 'uctovnik', rucne: { druh: 'sluzby_eu' } } })?.hodnota.druh).toBe('sluzby_eu');
    // Časť už v POHODE: voľba aj druh ostávajú, ako odišli.
    const prenesene = { ...zoSchvalenia, export: { faktura: { stav: 'ok' as const, at: '2026-09-17T10:00:00Z' } } };
    expect(zostav({ extracted: zUsa, profil: profil({ samozdanenieVPohode: true }), ulozene: prenesene })?.hodnota)
      .toMatchObject({ volba: 'vytvorit', druh: 'sluzby_eu' });
  });
});

describe('samozdanenie — výpočet', () => {
  it('EUR: základ je suma faktúry, daň základnou sadzbou k dátumu dodania, odpočet rovnaký', () => {
    const stav = zostav();
    expect(stav?.hodnota).toMatchObject({
      datumDanovejPovinnosti: '2026-06-10', sadzba: 23, zaklad: 1000, dan: 230, odpocet: 230, interny: KODY,
    });
    expect(stav?.chyby).toEqual([]);
    expect(stav?.sadzby).toEqual([23]);
  });

  it('cudzia mena: kurz z extrakcie, ručný kurz, bez kurzu nejde schváliť', () => {
    const usd = faktura({ mena: 'USD', sumaSpolu: 1080, rozpisDph: [] }, { nazov: 'Slack', krajina: 'US' });
    const profilMimo = profil({ samozdanenie: { sluzby_mimo_eu: { interny: KODY } } });
    expect(zostav({ extracted: { ...usd, kurz: 1.08 }, profil: profilMimo })?.hodnota).toMatchObject({ kurz: 1.08, zaklad: 1000, dan: 230 });
    expect(zostav({ extracted: usd, profil: profilMimo, ulozene: { volba: 'vytvorit', rucne: { kurz: 1.2 } } })?.hodnota)
      .toMatchObject({ kurz: 1.2, zaklad: 900, dan: 207 });
    const bezKurzu = zostav({ extracted: usd, profil: profilMimo });
    expect(bezKurzu?.hodnota.zaklad).toBeUndefined();
    expect(bezKurzu?.chyby).toEqual(['kurz']);
    // Už zaúčtované v POHODE kurz nepotrebuje.
    expect(zostav({ extracted: usd, profil: profilMimo, ulozene: { volba: 'v_pohode' } })?.chyby).toEqual([]);
  });

  it('tovar z EÚ: skorší z vystavenia a 15. dňa mesiaca po dodaní, na výber znížené sadzby', () => {
    const tovar = (datumVystavenia: string, datumDodania: string, rucne = {}) => zostav({
      extracted: faktura({ datumVystavenia, datumDodania }), ulozene: { volba: 'vytvorit', rucne: { druh: 'tovar_eu', ...rucne } },
    })?.hodnota;
    expect(tovar('2026-07-20', '2026-06-10')?.datumDanovejPovinnosti).toBe('2026-07-15');
    expect(tovar('2026-06-12', '2026-06-10')?.datumDanovejPovinnosti).toBe('2026-06-12');
    expect(tovar('2027-01-20', '2026-12-05')?.datumDanovejPovinnosti).toBe('2027-01-15');
    expect(tovar('2026-07-20', '2026-06-10', { sadzba: 19 })).toMatchObject({ sadzba: 19, dan: 190 });
    expect(zostav({ ulozene: { volba: 'vytvorit', rucne: { druh: 'tovar_eu' } } })?.sadzby).toEqual([23, 19, 5]);
    // Pri službe sa znížená sadzba nevyberá.
    expect(zostav({ ulozene: { volba: 'vytvorit', rucne: { sadzba: 19 } } })?.hodnota.sadzba).toBe(23);
    // Ručný dátum má prednosť a sadzba sa berie k nemu.
    expect(zostav({ ulozene: { volba: 'vytvorit', rucne: { datumDanovejPovinnosti: '2024-12-20' } } })?.hodnota)
      .toMatchObject({ datumDanovejPovinnosti: '2024-12-20', sadzba: 20, dan: 200 });
  });

  it('dátum pred tabuľkou sadzieb DPH je chyba dátumu, nie pád výpočtu', () => {
    const stare = zostav({ extracted: faktura({ datumDodania: '2010-12-31' }) });
    expect(stare?.chyby).toEqual(['datum']);
    expect(stare?.hodnota.dan).toBeUndefined();
    expect(zostav({ ulozene: { volba: 'vytvorit', rucne: { datumDanovejPovinnosti: '0002-06-10' } } })?.chyby).toEqual(['datum']);
    // Bez výpočtu dane sa zaobíde „Už zaúčtované v POHODE".
    expect(zostav({ extracted: faktura({ datumDodania: '2010-12-31' }), ulozene: { volba: 'v_pohode' } })?.chyby).toEqual([]);
  });

  it('neplatiteľ a §7a len vymeranie; nepotvrdený status oba doklady s upozornením', () => {
    const bezP = { sluzby_eu: { interny: { ddKod: 'DDsl§69', ddPredkontaciaKod: 'aInt', kv: 'B1' } } };
    for (const platitelDph of ['neplatitel', 'registracia_7a'] as const) {
      const stav = zostav({ profil: profil({ platitelDph, samozdanenie: bezP }) });
      expect(stav?.hodnota).toMatchObject({ dan: 230, odpocet: 0 });
      expect(stav?.chyby).toEqual([]);
    }
    const nezname = zostav({ profil: profil({ platitelDph: 'nezname' }) });
    expect(nezname).toMatchObject({ statusNepotvrdeny: true, hodnota: { odpocet: 230 } });
    // Platiteľ bez kódov odpočtu schváliť nemôže.
    expect(zostav({ profil: profil({ samozdanenie: bezP }) })?.chyby).toEqual(['kody']);
  });

  it('daň na centy podľa §26: od 0,005 nahor', () => {
    expect(danZoZakladu(10.5, 23)).toBe(2.42); // 2,415
    expect(danZoZakladu(21.5, 23)).toBe(4.95); // 4,945
    expect(danZoZakladu(1.02, 23)).toBe(0.23); // 0,2346
    expect(danZoZakladu(0.5, 23)).toBe(0.12); // 0,115
  });

  it('chyby voľby: chýbajúce kódy, dovoz, dôvod výnimky', () => {
    expect(zostav({ profil: profil({ samozdanenie: {} }) })?.chyby).toEqual(['kody']);
    expect(zostav({ ulozene: { volba: 'vytvorit', rucne: { druh: 'dovoz' } } })?.chyby).toEqual(['dovoz']);
    expect(zostav({ ulozene: { volba: 'nevznika' } })?.chyby).toEqual(['dovod']);
    expect(zostav({ ulozene: { volba: 'nevznika', dovod: 'iny' } })?.chyby).toEqual(['dovod']);
    expect(zostav({ ulozene: { volba: 'nevznika', dovod: 'slovenska_dph', dovodText: 'zahodí sa' } })?.hodnota)
      .toEqual(expect.not.objectContaining({ dovodText: expect.anything() }));
  });
});

describe('samozdanenie — položky prenosu', () => {
  it('berie faktúry a ich interné doklady z dataPacku, nič cudzie', () => {
    const id = '11111111-1111-1111-1111-111111111111';
    const xml = `<dat:dataPackItem id="${id}-sz-dd" version="2.0"></dat:dataPackItem>
<dat:dataPackItem id="${id}-sz-p" version="2.0"></dat:dataPackItem>
<dat:dataPackItem id="22222222-2222-2222-2222-222222222222-p1" version="2.0"></dat:dataPackItem>`;
    expect([...polozkyPrenosu([id, '22222222-2222-2222-2222-222222222222'], xml)]).toEqual([`${id}-sz-dd`, `${id}-sz-p`]);
  });
});

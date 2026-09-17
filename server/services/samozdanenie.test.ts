import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import { createTestDatabase, seedTestUser } from '../testHelpers.js';
import { predvolenyDphProfil, type DphProfil } from './dphProfileService.js';
import { danZoZakladu, polozkyPrenosu, radSamozdanenia, zostavSamozdanenie } from './samozdanenieService.js';

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

describe('samozdanenie — druh plnenia', () => {
  it('prax dodávateľa rozhodne tovar proti službe, mimo EÚ sa nepoužije', () => {
    // ROFA: dodávateľ z AT, ktorého firma 108× zaúčtovala ako nadobudnutie tovaru.
    expect(zostav({ praxDodavatela: 'tovar' })?.hodnota)
      .toMatchObject({ druh: 'tovar_eu', interny: { ddKod: 'DDnadEU', pKod: 'PDnadEU' } });
    // Tovar z EÚ má dátum povinnosti k 15. dňu nasledujúceho mesiaca a nižšie sadzby.
    expect(zostav({ praxDodavatela: 'tovar' })?.sadzby).toEqual([23, 19, 5]);
    expect(zostav({ praxDodavatela: 'sluzby' })?.hodnota.druh).toBe('sluzby_eu');
    // Tovar z tretej krajiny je dovoz cez colnicu — prax ho nesmie prepnúť na nadobudnutie.
    expect(zostav({ praxDodavatela: 'tovar', extracted: faktura({}, { nazov: 'Shenzhen Ltd', krajina: 'CN' }) })?.hodnota.druh)
      .toBe('sluzby_mimo_eu');
    // Ručná zmena účtovníka je nad praxou.
    expect(zostav({ praxDodavatela: 'tovar', ulozene: { volba: 'vytvorit', zdroj: 'uctovnik', rucne: { druh: 'sluzby_eu' } } })?.hodnota.druh)
      .toBe('sluzby_eu');
  });

  it('doklad, ktorého časť už išla do POHODY, druh nemení', () => {
    // Interný doklad prijatý s varovaním sa pri opakovanom prenose posiela znova —
    // musí to byť ten istý druh, inak by v POHODE vznikli dva rôzne doklady.
    const odoslane = { volba: 'vytvorit' as const, zdroj: 'predvolene' as const, druh: 'sluzby_eu' as const,
      export: { dd: { stav: 'warning' as const, at: '2026-06-20T10:00:00.000Z' } } };
    expect(zostav({ praxDodavatela: 'tovar', ulozene: odoslane })?.hodnota.druh).toBe('sluzby_eu');
  });

  it('firma, ktorá samozdanenie nerieši, blok nedostane', () => {
    expect(zostav({ profil: profil({ samozdaneniePostup: 'neriesime' }) })).toBeUndefined();
  });

  it('prax účtu rozhodne, keď dodávateľ vlastnú nemá; nezhoda signálov sa nevyjadrí', () => {
    // Green Lab Magyarország: v histórii ROFY jediný doklad s DD kódom, takže
    // prax dodávateľa (správne) mlčí a rodinu má povedať účet 131.
    expect(zostav({ praxUctu: 'tovar' })?.hodnota.druh).toBe('tovar_eu');
    expect(zostav({ praxUctu: 'sluzby' })?.hodnota.druh).toBe('sluzby_eu');
    // Prax s dodávateľom je prvá — s účtom sa zhoduje aj nezhoduje.
    expect(zostav({ praxDodavatela: 'tovar', praxUctu: 'tovar' })?.hodnota.druh).toBe('tovar_eu');
    // Nezhoda: zlá rodina znamená zlé členenie, zlý dátum povinnosti aj zlú
    // sekciu KV, takže novší signál nesmie starší prebiť — rozhodne územie.
    expect(zostav({ praxDodavatela: 'sluzby', praxUctu: 'tovar' })?.hodnota.druh).toBe('sluzby_eu');
    expect(zostav({ praxDodavatela: 'tovar', praxUctu: 'sluzby' })?.hodnota.druh).toBe('sluzby_eu');
    // Ručná zmena účtovníka je nad oboma signálmi.
    expect(zostav({ praxUctu: 'tovar', ulozene: { volba: 'vytvorit', zdroj: 'uctovnik', rucne: { druh: 'sluzby_eu' } } })?.hodnota.druh)
      .toBe('sluzby_eu');
    // Mimo EÚ sa os tovar/služba nepoužíva vôbec — tovar z tretej krajiny je dovoz.
    expect(zostav({ praxUctu: 'tovar', extracted: faktura({}, { nazov: 'Shenzhen Ltd', krajina: 'CN' }) })?.hodnota.druh)
      .toBe('sluzby_mimo_eu');
  });
});

describe('samozdanenie — prepis kódov a základu na doklade', () => {
  it('prepis prežije prepočet, KV je na každom riadku a vlastný základ je vidieť', () => {
    const stav = zostav({ ulozene: {
      volba: 'vytvorit', zdroj: 'uctovnik',
      rucne: { interny: { ddPredkontaciaKod: 'cInt', pKv: 'KN' }, zaklad: 400 },
    } });
    expect(stav?.hodnota.interny).toMatchObject({
      ddKod: 'DDsl§69', ddPredkontaciaKod: 'cInt', pKod: 'PDsluz', pPredkontaciaKod: 'bInt', kv: 'B1', pKv: 'KN',
    });
    // Zmiešaná faktúra: základ účtovníka platí a daň sa počíta z neho, ale blok
    // vie, čo je suma dokladu, aby rozdiel v riadku označil.
    expect(stav?.hodnota).toMatchObject({ zaklad: 400, dan: 92, odpocet: 92 });
    expect(stav?.zakladDokladu).toBe(1000);
    expect(stav?.chyby).toEqual([]);
    // Bez prepisu ide základ za sumou dokladu.
    expect(zostav()?.hodnota.zaklad).toBe(1000);
    expect(zostav()?.hodnota.interny).toEqual(KODY);
  });

  it('riadok, ktorý POHODA už prijala, prepis nezmení', () => {
    const odoslane = {
      volba: 'vytvorit' as const, zdroj: 'uctovnik' as const, druh: 'sluzby_eu' as const,
      interny: { ddKod: 'DDsl§69', ddPredkontaciaKod: 'aInt', pKod: 'PDsluz', pPredkontaciaKod: 'bInt', kv: 'B1' },
      rucne: { interny: { ddPredkontaciaKod: 'cInt', pPredkontaciaKod: 'cInt' } },
      export: { dd: { stav: 'ok' as const, at: '2026-06-20T10:00:00.000Z' } },
    };
    // Vymeranie je v POHODE — ostáva, ako odišlo. Odpočet ešte nie, prepis platí.
    expect(zostav({ ulozene: odoslane })?.hodnota.interny)
      .toMatchObject({ ddPredkontaciaKod: 'aInt', pPredkontaciaKod: 'cInt' });
  });
});

describe('samozdanenie — predvolená voľba', () => {
  it('pamäť dodávateľa > nastavenie firmy > vytvoriť doklady; uložená voľba má prednosť', () => {
    const vPohode = profil({ samozdaneniePostup: 'v_pohode' });
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
    expect(zostav({ profil: profil({ samozdaneniePostup: 'v_pohode' }), ulozene: zoSchvalenia })?.hodnota).toMatchObject({ volba: 'v_pohode', zdroj: 'firma' });
    // Voľba účtovníka ostáva, druh bez ručnej zmeny ide za územím.
    expect(zostav({ extracted: zUsa, ulozene: { volba: 'v_pohode', druh: 'sluzby_eu', zdroj: 'uctovnik' } })?.hodnota)
      .toMatchObject({ volba: 'v_pohode', druh: 'sluzby_mimo_eu' });
    expect(zostav({ extracted: zUsa, ulozene: { volba: 'vytvorit', zdroj: 'uctovnik', rucne: { druh: 'sluzby_eu' } } })?.hodnota.druh).toBe('sluzby_eu');
    // Časť už v POHODE: voľba aj druh ostávajú, ako odišli.
    const prenesene = { ...zoSchvalenia, export: { faktura: { stav: 'ok' as const, at: '2026-09-17T10:00:00Z' } } };
    expect(zostav({ extracted: zUsa, profil: profil({ samozdaneniePostup: 'v_pohode' }), ulozene: prenesene })?.hodnota)
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

// Číselný rad interných dokladov samozdanenia. Prvý ostrý import AGS skončil
// v rade „26DPH — Preúčtovanie DPH" (26DPH02, 26DPH03), hoci firma tieto
// doklady vedie v rade 26SAM — a rad je v každej firme iný (26SAM, 26IN, 26SZ,
// 26RCH), takže sa nedá zadrôtovať a musí vyjsť z jej histórie.
describe('samozdanenie — číselný rad z histórie firmy', () => {
  const databases: Awaited<ReturnType<typeof createTestDatabase>>[] = [];
  afterEach(async () => Promise.all(databases.splice(0).map((database) => database.close())));

  async function firma() {
    const database = await createTestDatabase();
    databases.push(database);
    const seeded = await seedTestUser(database);
    const kde = { tenantId: seeded.tenantId, organizationId: seeded.organizationId };
    let externe = 100;

    const rad = async (kod: string, nazov: string, rok: string) => {
      externe += 1;
      const ext = String(externe);
      await database.query(
        `INSERT INTO code_list_items (id,tenant_id,organization_id,kind,code,name,source,agenda,external_id,accounting_year)
         VALUES ($1,$2,$3,'ciselneRady',$4,$5,'pohoda','interni_doklady',$6,$7)`,
        [randomUUID(), kde.tenantId, kde.organizationId, kod, nazov, ext, rok],
      );
      return { ext, kod };
    };
    let poradie = 0;
    const doklad = async (ciselnyRad: { ext: string; kod: string }, clenenie: string, datum: string) => {
      poradie += 1;
      await database.query(
        `INSERT INTO ucto_historia
          (id,tenant_id,organization_id,agenda,doklad_cislo,datum,line_text_normalized,clenenie_dph_kod,
           riadok_index,source,riadok_hash,rad_external_id,rad_kod)
         VALUES ($1,$2,$3,'INT',$4,$5::date,'vymeranie dph',$6,0,'mdb',$7,$8,$9)`,
        [randomUUID(), kde.tenantId, kde.organizationId, `${ciselnyRad.kod}${poradie}`, datum, clenenie,
          randomUUID(), ciselnyRad.ext, ciselnyRad.kod],
      );
    };
    return { database, kde, rad, doklad };
  }

  it('rad nesú doklady s členením strany DD, nie zvyšok agendy', async () => {
    const { database, kde, rad, doklad } = await firma();
    const sam = await rad('26SAM', 'Samozdanenie', '2026');
    const mzdy = await rad('26MZD', 'Interné doklady-Mzdy', '2026');
    const dph = await rad('26DPH', 'Preúčtovanie DPH', '2026');
    for (const den of ['07', '08', '09']) await doklad(sam, 'DDsl§69', `2026-01-${den}`);
    await doklad(sam, 'DDnadEU', '2026-02-10');
    // Interné doklady, ktoré samozdanením nie sú: mzdy a preúčtovanie DPH. Tých
    // je v agende viac a rad podľa celej agendy by vybral ich.
    for (let index = 0; index < 20; index += 1) await doklad(mzdy, 'PN', '2026-03-10');
    for (let index = 0; index < 10; index += 1) await doklad(dph, 'PD', '2026-03-11');

    expect(await radSamozdanenia(database, kde, 2026)).toBe('26SAM');
    // Bez histórie sa rad nehádá a číslo pridelí POHODA.
    expect(await radSamozdanenia(database, kde, 2025)).toBeUndefined();
  }, 90_000);

  it('doklad ďalšieho roka dostane rad toho roka, nie kód s minulým rokom', async () => {
    const { database, kde, rad, doklad } = await firma();
    const sam26 = await rad('26SAM', 'Samozdanenie', '2026');
    for (const den of ['07', '08', '09']) await doklad(sam26, 'DDsl§69', `2026-01-${den}`);

    // Rok 2027 ešte doklady nemá. Kód radu nesie rok predponou, takže 26SAM sa
    // na doklade roku 2027 poslať nesmie: taký rad už v POHODE nebeží.
    expect(await radSamozdanenia(database, kde, 2027)).toBeUndefined();
    await rad('27SAM', 'Samozdanenie', '2027');
    expect(await radSamozdanenia(database, kde, 2027)).toBe('27SAM');
    expect(await radSamozdanenia(database, kde, 2026)).toBe('26SAM');

    // Dva rady toho istého názvu (ALPINA má „Interné doklady" na 26ID aj 26SAM)
    // sa rozsúdiť nedajú — radšej nič než cudzí rad.
    await rad('27SA2', 'Samozdanenie', '2027');
    expect(await radSamozdanenia(database, kde, 2027)).toBeUndefined();
  }, 90_000);

  it('rad minulého roka nevyhrá nad radom roka dokladu', async () => {
    const { database, kde, rad, doklad } = await firma();
    const sam25 = await rad('25SAM', 'Samozdanenie', '2025');
    const sam26 = await rad('26SAM', 'Samozdanenie', '2026');
    for (let index = 0; index < 30; index += 1) await doklad(sam25, 'DDsl§69', '2025-06-10');
    await doklad(sam26, 'DDsl§69', '2026-01-08');

    expect(await radSamozdanenia(database, kde, 2026)).toBe('26SAM');
    expect(await radSamozdanenia(database, kde, 2025)).toBe('25SAM');
  }, 90_000);
});

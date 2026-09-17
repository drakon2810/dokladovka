// @vitest-environment happy-dom
// Blok samozdanenia nad zaúčtovaním prijatej faktúry: náhľad interných
// dokladov zo servera, tri voľby a zmeny, ktoré posiela na uloženie.
import { act } from 'react-dom/test-utils';
import { createRoot } from 'react-dom/client';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it, vi } from 'vitest';
import type { BlokSamozdanenia, CodeListItem } from '../../data/types';

(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;

const api = vi.hoisted(() => ({ getSamozdanenie: vi.fn(), ulozSamozdanenie: vi.fn() }));
vi.mock('../../data/api', async (importOriginal) => ({ ...(await importOriginal<typeof import('../../data/api')>()), ...api }));

const { SamozdanenieBlok, danZoZakladu, riadkyNahladu, zakladZDokladu, zmenRozhodnutie } = await import('./SamozdanenieBlok');

const KODY = { ddKod: 'DDsl§69', ddPredkontaciaKod: 'aInt', pKod: 'PDsluz', pPredkontaciaKod: 'bInt', kv: 'B1' };
const blok = (cast: Partial<BlokSamozdanenia> = {}, hodnota: Partial<BlokSamozdanenia['hodnota']> = {}): BlokSamozdanenia => ({
  uzemie: 'eu', predvolene: { volba: 'vytvorit', zdroj: 'predvolene' }, sadzby: [23], mena: 'EUR', chyby: [],
  statusNepotvrdeny: false, upravitelny: true, dodavatel: 'Google Ireland Ltd', robimeVPohode: false, pamatDodavatela: false,
  ...cast,
  hodnota: {
    volba: 'vytvorit', druh: 'sluzby_eu', zdroj: 'predvolene', datumDanovejPovinnosti: '2026-06-10', sadzba: 23,
    zaklad: 1000, dan: 230, odpocet: 230, interny: KODY, ...hodnota,
  },
});

/**
 * Písanie do poľa. React si pamätá poslednú hodnotu vlastným setterom, takže
 * priame `pole.value = …` by zmenu skrylo a onChange by nikdy nebežalo.
 */
const napis = (pole: HTMLInputElement, hodnota: string) => {
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(pole, hodnota);
  pole.dispatchEvent(new Event('input', { bubbles: true }));
};

const kod = (kod: string): CodeListItem =>
  ({ id: kod, tenantId: 't1', orgId: 'o1', kod, nazov: kod, source: 'pohoda', active: true });
const CISELNIKY = {
  predkontacie: [kod('aInt'), kod('bInt'), kod('cInt')],
  cleneniaDph: [kod('DDsl§69'), kod('PDsluz')],
};

async function vykresli(nacitany: BlokSamozdanenia | null, readOnly = false, navyse: { sumaSpolu?: number; codeLists?: typeof CISELNIKY } = {}) {
  api.getSamozdanenie.mockResolvedValue(nacitany);
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  await act(async () => {
    root.render(<MemoryRouter><SamozdanenieBlok documentId="d1" version={1} readOnly={readOnly} {...navyse} /></MemoryRouter>);
  });
  const otvor = async () => {
    await act(async () => { container.querySelector<HTMLButtonElement>('.sz-hlava')?.click(); });
  };
  return { container, otvor, zavri: () => { act(() => root.unmount()); container.remove(); } };
}

describe('SamozdanenieBlok — pomocné funkcie', () => {
  it('iný druh prepočíta dátum aj sadzbu, dovoz prepne na „Už zaúčtované"; iný dátum prepočíta sadzbu', () => {
    const hodnota = blok({}, { rucne: { datumDanovejPovinnosti: '2026-06-01', sadzba: 19, kurz: 1.08 } }).hodnota;
    expect(zmenRozhodnutie(hodnota, { pole: 'druh', hodnota: 'tovar_eu' })).toMatchObject({ volba: 'vytvorit', rucne: { kurz: 1.08, druh: 'tovar_eu' } });
    expect(zmenRozhodnutie(hodnota, { pole: 'druh', hodnota: 'tovar_eu' }).rucne).not.toHaveProperty('sadzba');
    expect(zmenRozhodnutie(hodnota, { pole: 'druh', hodnota: 'dovoz' })).toMatchObject({ volba: 'v_pohode', rucne: { druh: 'dovoz' } });
    // Druh odvodený serverom sa neposiela — pripol by sa a oprava dodávateľa by ho neprepočítala.
    expect(zmenRozhodnutie(hodnota, { pole: 'volba', hodnota: 'v_pohode' })).not.toHaveProperty('druh');
    expect(zmenRozhodnutie({ ...hodnota, rucne: { druh: 'tovar_eu' } }, { pole: 'datum', hodnota: '2026-07-15' }).rucne)
      .toEqual({ druh: 'tovar_eu', datumDanovejPovinnosti: '2026-07-15' });
    expect(zmenRozhodnutie(hodnota, { pole: 'datum', hodnota: '2026-07-15' }).rucne)
      .toEqual({ kurz: 1.08, datumDanovejPovinnosti: '2026-07-15' });
    expect(zmenRozhodnutie({ ...hodnota, dovod: 'iny', dovodText: 'Licencia' }, { pole: 'dovod', hodnota: 'miesto_dodania' }))
      .toMatchObject({ dovod: 'miesto_dodania', dovodText: undefined });
  });

  it('náhľad: platiteľ vymeranie aj odpočet, neplatiteľ len vymeranie, KV na každom riadku', () => {
    expect(riadkyNahladu(blok().hodnota).map((riadok) => [riadok.kluc, riadok.predkontacia, riadok.clenenie, riadok.dan]))
      .toEqual([['vymeranie', 'aInt', 'DDsl§69', 230], ['odpocet', 'bInt', 'PDsluz', 230]]);
    expect(riadkyNahladu(blok({}, { odpocet: 0 }).hodnota).map((riadok) => riadok.kluc)).toEqual(['vymeranie']);
    // Prepis sekcie KV platí len na svojom riadku, druhý ostáva pri profile.
    expect(riadkyNahladu(blok({}, { interny: { ...KODY, pKv: 'KN' } }).hodnota).map((riadok) => riadok.kv)).toEqual(['B1', 'KN']);
  });

  it('prepis kódov a základu prežije zmenu dátumu; iný druh plnenia kódy zahodí', () => {
    const hodnota = blok({}, { rucne: { interny: { ddPredkontaciaKod: 'cInt' }, zaklad: 400 } }).hodnota;
    expect(zmenRozhodnutie(hodnota, { pole: 'datum', hodnota: '2026-07-15' }).rucne)
      .toMatchObject({ interny: { ddPredkontaciaKod: 'cInt' }, zaklad: 400 });
    // Iná rodina plnenia má iné kódy (DDnadEU proti DDsluz); základ je o sume.
    const inyDruh = zmenRozhodnutie(hodnota, { pole: 'druh', hodnota: 'tovar_eu' }).rucne;
    expect(inyDruh).toMatchObject({ druh: 'tovar_eu', zaklad: 400 });
    expect(inyDruh).not.toHaveProperty('interny');
    // Prepis sa dopĺňa po poliach — druhý riadok sa nestratí.
    expect(zmenRozhodnutie(hodnota, { pole: 'interny', hodnota: { pKv: 'KN' } }).rucne?.interny)
      .toEqual({ ddPredkontaciaKod: 'cInt', pKv: 'KN' });
    expect(zmenRozhodnutie(hodnota, { pole: 'zaklad', hodnota: undefined }).rucne?.zaklad).toBeUndefined();
  });

  it('výpočet základu a dane sedí na cent so serverom (ROFA AF260391)', () => {
    // Referencia je zostavSamozdanenie / danZoZakladu v server/services/samozdanenieService.ts.
    expect(zakladZDokladu(8577.57, 'EUR')).toBe(8577.57);
    expect(danZoZakladu(8577.57, 23)).toBe(1972.84);
    expect(zakladZDokladu(7184.77, 'EUR')).toBe(7184.77);
    expect(danZoZakladu(7184.77, 23)).toBe(1652.5);
    // Cudzia mena: základ = suma delená kurzom, bez kurzu sa nepočíta.
    expect(zakladZDokladu(1080, 'USD', 1.08)).toBe(1000);
    expect(zakladZDokladu(1080, 'USD')).toBeUndefined();
    expect(zakladZDokladu(0, 'EUR')).toBeUndefined();
    // §26 ods. 3: od 0,005 nahor.
    expect(danZoZakladu(10.5, 23)).toBe(2.42);
    expect(danZoZakladu(0.5, 23)).toBe(0.12);
  });
});

describe('SamozdanenieBlok — vykreslenie', () => {
  it('doklad bez samozdanenia nevykreslí nič', async () => {
    const { container, zavri } = await vykresli(null);
    expect(container.innerHTML).toBe('');
    zavri();
  });

  it('zvinutý riadok nesie druh, daň, voľbu a to, čo zablokuje schválenie', async () => {
    const { container, zavri } = await vykresli(blok({ chyby: ['kody'], statusNepotvrdeny: true }));
    const suhrn = container.querySelector('.sz-suhrn')?.textContent ?? '';
    expect(suhrn).toContain('Služby z EÚ');
    expect(suhrn).toContain('230,00');
    expect(container.querySelector('.sz-hlava-volba')?.textContent).toContain('Vytvoriť interné doklady');
    // Tabuľka interných dokladov je až po otvorení — zvinutý riadok nezaberá výšku.
    expect(container.querySelector('.sz-tabulka')).toBeNull();
    expect(container.querySelector('.sz-hlava-chyby a[href="/profil-klienta"]')?.textContent)
      .toBe('Doplňte samozdanenie Služby z EÚ v profile klienta');
    expect(container.querySelector('.sz-hlava-chyby')?.textContent).toContain('Status DPH firmy nie je potvrdený v profile klienta');
    expect(container.querySelector('.sz-blok')?.className).toContain('sz-blok-chyba');
    zavri();
  });

  it('voľba „Vytvoriť": tabuľka, dátum, info a odkaz na profil pri chýbajúcich kódoch', async () => {
    const { container, otvor, zavri } = await vykresli(blok({ chyby: ['kody'], statusNepotvrdeny: true }));
    await otvor();
    const text = container.textContent ?? '';
    expect(text).toContain('Vytvoriť interné doklady');
    expect(text).toContain('Už zaúčtované v POHODE');
    expect(text).toContain('Nevzniká povinnosť samozdanenia');
    expect([...container.querySelectorAll('th')].map((th) => th.textContent))
      .toEqual(['Interný doklad', 'Predkontácia', 'Členenie', 'KV', 'Základ', 'DPH 23 %']);
    const riadky = [...container.querySelectorAll('tbody tr')].map((tr) => [...tr.querySelectorAll('td')].slice(0, 4).map((td) => td.textContent));
    expect(riadky).toEqual([['Vymeranie dane', 'aInt', 'DDsl§69', 'B1'], ['Odpočet dane', 'bInt', 'PDsluz', 'B1']]);
    expect(text).toContain('Dátum daňovej povinnosti');
    expect(text).toContain('Zmeniť druh plnenia');
    expect(text).toContain('Po schválení pôjdu do POHODY spolu s faktúrou.');
    expect(text).toContain('Status DPH firmy nie je potvrdený v profile klienta');
    expect(container.querySelector('a[href="/profil-klienta"]')?.textContent).toBe('Doplňte samozdanenie Služby z EÚ v profile klienta');
    zavri();

    // Dátum mimo tabuľky sadzieb: bez sadzby a s chybou dátumu.
    const bezSadzby = await vykresli(blok({ sadzby: [], chyby: ['datum'] }, { sadzba: undefined, dan: undefined, odpocet: undefined }));
    await bezSadzby.otvor();
    expect([...bezSadzby.container.querySelectorAll('th')].at(-1)?.textContent).toBe('DPH — %');
    expect(bezSadzby.container.textContent).toContain('Doplňte platný dátum daňovej povinnosti.');
    bezSadzby.zavri();
  });

  it('prepnutie na „Nevzniká povinnosť" uloží voľbu s pamäťou dodávateľa; schválený doklad je len na čítanie', async () => {
    api.ulozSamozdanenie.mockResolvedValue(blok({}, { volba: 'nevznika', zdroj: 'uctovnik' }));
    const { container, otvor, zavri } = await vykresli(blok());
    await otvor();
    const radio = container.querySelectorAll<HTMLInputElement>('input[type="radio"]')[2];
    await act(async () => { radio.click(); });
    expect(api.ulozSamozdanenie).toHaveBeenCalledWith('d1', expect.objectContaining({ volba: 'nevznika', pamatatDodavatela: true }));
    expect(container.textContent).toContain('Pamätať pre dodávateľa Google Ireland Ltd');
    expect(container.querySelector<HTMLInputElement>('input[type="checkbox"]')?.checked).toBe(true);
    zavri();

    const schvaleny = await vykresli(blok({ upravitelny: false }));
    await schvaleny.otvor();
    expect(schvaleny.container.textContent).toContain('samozdanenie sa už nedá zmeniť');
    expect([...schvaleny.container.querySelectorAll<HTMLInputElement>('input[type="radio"]')].every((input) => input.disabled)).toBe(true);
    expect(schvaleny.container.querySelector('input[type="date"]')).toBeNull();
    expect(schvaleny.container.textContent).toContain('10.06.2026');
    schvaleny.zavri();
  });

  it('blok sleduje rozpracovaný doklad: nová suma prepočíta základ aj daň a označí ich ako neuložené', async () => {
    // ROFA AF260391: účtovník prepísal položku a položky dali 7 184,77, blok
    // však ďalej ukazoval základ 8 577,57 a DPH 1 972,84 zo servera.
    const ulozene = blok({}, { zaklad: 8577.57, dan: 1972.84, odpocet: 1972.84 });
    const { container, otvor, zavri } = await vykresli(ulozene, false, { sumaSpolu: 7184.77 });
    expect(container.querySelector('.sz-suhrn')?.textContent).toContain('652,50');
    expect(container.querySelector('.sz-suhrn')?.className).toContain('sz-neulozene');
    await otvor();
    const sumy = [...container.querySelectorAll('tbody tr')]
      .map((tr) => [...tr.querySelectorAll('td')].slice(-2).map((td) => td.textContent?.replace(/\s/g, ' ').trim()));
    expect(sumy).toEqual([['7 184,77 €', '1 652,50 €'], ['7 184,77 €', '1 652,50 €']]);
    expect(container.textContent).toContain('ešte nie sú uložené');
    zavri();

    // Suma, ktorá so serverom sedí, nič neoznačí.
    const zhodne = await vykresli(ulozene, false, { sumaSpolu: 8577.57 });
    expect(zhodne.container.querySelector('.sz-suhrn')?.className).not.toContain('sz-neulozene');
    expect(zhodne.container.textContent).not.toContain('ešte nie sú uložené');
    zhodne.zavri();

    // Vlastný základ účtovníka (zmiešaná faktúra) prepočet neprebíja, ale
    // v riadku je vidieť, že to číslo nie je zo sumy dokladu.
    const vlastny = await vykresli(
      blok({ zakladDokladu: 8577.57 }, { zaklad: 400, dan: 92, odpocet: 92, rucne: { zaklad: 400 } }),
      false, { sumaSpolu: 7184.77 },
    );
    await vlastny.otvor();
    expect(vlastny.container.textContent).toContain('400,00');
    expect(vlastny.container.textContent?.replace(/\s/g, ' ')).toContain('Základ je váš, nie zo sumy dokladu (8 577,57 €).');
    expect(vlastny.container.textContent).not.toContain('ešte nie sú uložené');
    vlastny.zavri();

    // Zamknutý doklad ukazuje to, čo pôjde do POHODY — nič sa neprepočítava.
    const zmrazeny = await vykresli(blok({ upravitelny: false }, { zaklad: 8577.57, dan: 1972.84, odpocet: 1972.84 }), false, { sumaSpolu: 7184.77 });
    expect(zmrazeny.container.querySelector('.sz-suhrn')?.textContent).toContain('972,84');
    zmrazeny.zavri();
  });

  it('kódy interných dokladov a základ sa opravia priamo v náhľade', async () => {
    api.ulozSamozdanenie.mockResolvedValue(blok());
    const { container, otvor, zavri } = await vykresli(blok(), false, { sumaSpolu: 1000, codeLists: CISELNIKY });
    await otvor();
    const bunky = [...container.querySelectorAll('tbody tr')].map((tr) => [...tr.querySelectorAll('td')]);

    // Predkontácia vymerania: prepis ide do rucne.interny.ddPredkontaciaKod.
    await act(async () => { bunky[0][1].querySelector<HTMLElement>('.dk-pick-btn')?.click(); });
    const cInt = [...document.querySelectorAll<HTMLButtonElement>('.dk-pick-opt')].find((opt) => opt.textContent?.includes('cInt'));
    await act(async () => { cInt!.click(); });
    expect(api.ulozSamozdanenie).toHaveBeenLastCalledWith('d1', expect.objectContaining({
      rucne: { interny: { ddPredkontaciaKod: 'cInt' } },
    }));

    // Sekcia KV odpočtu je vlastná — vymeranie do B1, odpočet do KN.
    await act(async () => { bunky[1][3].querySelector<HTMLElement>('.dk-pick-btn')?.click(); });
    const kn = [...document.querySelectorAll<HTMLButtonElement>('.dk-pick-opt')].find((opt) => opt.textContent?.trim().endsWith('KN'));
    await act(async () => { kn!.click(); });
    expect(api.ulozSamozdanenie).toHaveBeenLastCalledWith('d1', expect.objectContaining({ rucne: { interny: { pKv: 'KN' } } }));

    // Základ sa ukladá až po dopísaní, nie na každú klávesu.
    const pocetPredZakladom = api.ulozSamozdanenie.mock.calls.length;
    await act(async () => { bunky[0][4].querySelector<HTMLElement>('.dk-cell')?.click(); });
    const pole = bunky[0][4].querySelector<HTMLInputElement>('input')!;
    await act(async () => { napis(pole, '400'); });
    expect(api.ulozSamozdanenie.mock.calls.length).toBe(pocetPredZakladom);
    // React počúva focusout, nie blur (blur nebublá).
    await act(async () => { pole.dispatchEvent(new Event('focusout', { bubbles: true })); });
    expect(api.ulozSamozdanenie).toHaveBeenLastCalledWith('d1', expect.objectContaining({ rucne: { zaklad: 400 } }));
    zavri();

    // Bez číselníkov (a na zamknutom doklade) ostáva náhľad textom.
    const bezCiselnikov = await vykresli(blok());
    await bezCiselnikov.otvor();
    expect(bezCiselnikov.container.querySelector('tbody .dk-pick-btn')).toBeNull();
    expect([...bezCiselnikov.container.querySelectorAll('tbody tr')[0].querySelectorAll('td')][1].textContent).toBe('aInt');
    bezCiselnikov.zavri();
  });

  it('druh plnenia sa dá zmeniť aj pri „Už zaúčtované v POHODE"', async () => {
    // Firma, ktorá si interné doklady zakladá sama, opravuje ten istý štítok —
    // predtým bol výber schovaný vo voľbe „Vytvoriť interné doklady".
    api.ulozSamozdanenie.mockResolvedValue(blok({}, { volba: 'v_pohode', zdroj: 'uctovnik', rucne: { druh: 'tovar_eu' } }));
    const { container, otvor, zavri } = await vykresli(blok({ robimeVPohode: true }, { volba: 'v_pohode', zdroj: 'firma' }));
    await otvor();
    const prepnut = [...container.querySelectorAll<HTMLButtonElement>('.sz-odkaz')]
      .find((tlacidlo) => tlacidlo.textContent === 'Zmeniť druh plnenia');
    expect(prepnut).toBeDefined();
    await act(async () => { prepnut!.click(); });
    const vyber = container.querySelector<HTMLSelectElement>('select[aria-label="Zmeniť druh plnenia"]');
    expect(vyber).not.toBeNull();
    vyber!.value = 'tovar_eu';
    await act(async () => { vyber!.dispatchEvent(new Event('change', { bubbles: true })); });
    expect(api.ulozSamozdanenie).toHaveBeenCalledWith('d1', expect.objectContaining({ volba: 'v_pohode', rucne: { druh: 'tovar_eu' } }));
    zavri();
  });
});

// @vitest-environment happy-dom
// Blok samozdanenia nad zaúčtovaním prijatej faktúry: náhľad interných
// dokladov zo servera, tri voľby a zmeny, ktoré posiela na uloženie.
import { act } from 'react-dom/test-utils';
import { createRoot } from 'react-dom/client';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it, vi } from 'vitest';
import type { BlokSamozdanenia } from '../../data/types';

(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;

const api = vi.hoisted(() => ({ getSamozdanenie: vi.fn(), ulozSamozdanenie: vi.fn() }));
vi.mock('../../data/api', async (importOriginal) => ({ ...(await importOriginal<typeof import('../../data/api')>()), ...api }));

const { SamozdanenieBlok, riadkyNahladu, zmenRozhodnutie } = await import('./SamozdanenieBlok');

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

async function vykresli(nacitany: BlokSamozdanenia | null, readOnly = false) {
  api.getSamozdanenie.mockResolvedValue(nacitany);
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  await act(async () => {
    root.render(<MemoryRouter><SamozdanenieBlok documentId="d1" version={1} readOnly={readOnly} /></MemoryRouter>);
  });
  return { container, zavri: () => { act(() => root.unmount()); container.remove(); } };
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

  it('náhľad: platiteľ vymeranie aj odpočet, neplatiteľ len vymeranie', () => {
    expect(riadkyNahladu(blok().hodnota).map((riadok) => [riadok.kluc, riadok.predkontacia, riadok.clenenie, riadok.dan]))
      .toEqual([['vymeranie', 'aInt', 'DDsl§69', 230], ['odpocet', 'bInt', 'PDsluz', 230]]);
    expect(riadkyNahladu(blok({}, { odpocet: 0 }).hodnota).map((riadok) => riadok.kluc)).toEqual(['vymeranie']);
  });
});

describe('SamozdanenieBlok — vykreslenie', () => {
  it('doklad bez samozdanenia nevykreslí nič', async () => {
    const { container, zavri } = await vykresli(null);
    expect(container.innerHTML).toBe('');
    zavri();
  });

  it('voľba „Vytvoriť": tabuľka, dátum, info a odkaz na profil pri chýbajúcich kódoch', async () => {
    const { container, zavri } = await vykresli(blok({ chyby: ['kody'], statusNepotvrdeny: true }));
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
    expect([...bezSadzby.container.querySelectorAll('th')].at(-1)?.textContent).toBe('DPH — %');
    expect(bezSadzby.container.textContent).toContain('Doplňte platný dátum daňovej povinnosti.');
    bezSadzby.zavri();
  });

  it('prepnutie na „Nevzniká povinnosť" uloží voľbu s pamäťou dodávateľa; schválený doklad je len na čítanie', async () => {
    api.ulozSamozdanenie.mockResolvedValue(blok({}, { volba: 'nevznika', zdroj: 'uctovnik' }));
    const { container, zavri } = await vykresli(blok());
    const radio = container.querySelectorAll<HTMLInputElement>('input[type="radio"]')[2];
    await act(async () => { radio.click(); });
    expect(api.ulozSamozdanenie).toHaveBeenCalledWith('d1', expect.objectContaining({ volba: 'nevznika', pamatatDodavatela: true }));
    expect(container.textContent).toContain('Pamätať pre dodávateľa Google Ireland Ltd');
    expect(container.querySelector<HTMLInputElement>('input[type="checkbox"]')?.checked).toBe(true);
    zavri();

    const schvaleny = await vykresli(blok({ upravitelny: false }));
    expect([...schvaleny.container.querySelectorAll<HTMLInputElement>('input[type="radio"]')].every((input) => input.disabled)).toBe(true);
    expect(schvaleny.container.querySelector('input[type="date"]')).toBeNull();
    expect(schvaleny.container.textContent).toContain('10.06.2026');
    schvaleny.zavri();
  });
});

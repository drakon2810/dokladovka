// @vitest-environment happy-dom
// Stránka profilu klienta nad odpoveďou servera: hlavička z potvrdených faktov,
// otázky navrchu a odpoveď jedným klikom ide správnym volaním API.
import { act } from 'react-dom/test-utils';
import { createRoot } from 'react-dom/client';
import { describe, expect, it, vi } from 'vitest';
import type { ProfilKlienta } from '../../data/types';

(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;

const mocky = vi.hoisted(() => {
  const profil: ProfilKlienta = {
    fakty: [
      {
        kluc: 'dph.status', stav: 'navrhnute', hodnota: { status: 'platitel' }, zdroj: 'historia',
        dokaz: { dokladov: 212, od: '2025-01-02', do: '2026-08-30', priklady: [{ agenda: 'FP', cislo: '2026001', datum: '2026-08-30' }] },
        updatedAt: '2026-09-16T10:00:00.000Z',
      },
      {
        kluc: 'samozdanenie.sluzby_eu', stav: 'potvrdene', zdroj: 'uctovnik', potvrdil: 'Jana Nová', potvrdeneAt: '2026-09-12T08:00:00.000Z',
        hodnota: { faktura: { clenenieKod: 'PN', kv: 'KN' }, interny: { ddKod: 'DDsl§69', pKod: 'PDsluz', kv: 'B1' } },
        updatedAt: '2026-09-12T08:00:00.000Z',
      },
    ],
    otazky: [
      {
        id: '11111111-1111-4111-8111-111111111111', kluc: 'fakt:zasady.drobny_majetok', druh: 'fakt', stav: 'otvorena', blokuje: false,
        dokladov: 0, data: { kluc: 'zasady.drobny_majetok' }, createdAt: '2026-09-16T10:00:00.000Z',
      },
      {
        id: '22222222-2222-4222-8222-222222222222', kluc: 'spor:FP:ACME', druh: 'spor_protistrany', stav: 'otvorena', blokuje: false,
        dokladov: 14, createdAt: '2026-09-16T10:00:00.000Z',
        data: {
          agenda: 'FP', protistrana: 'ACME', typDokladu: 'FP',
          varianty: [
            {
              predkontaciaId: 'p1', clenenieDphId: 'c1', dokladov: 9, od: '2025-02-01', do: '2026-06-30',
              kody: { predkontacia: '518100', clenenieDph: 'PD', clenenieKv: 'B2' },
              // Prax, ktorá doklad delí (PHM 80/20 s polovicou odpočtu) — karta to musí povedať.
              casti: [{ predkontaciaKod: '501900', clenenieDphKod: 'PN', clenenieKvKod: 'B2', podiel: 0.2, podielDph: 0.5 }],
              dokladovCasti: 6,
            },
            { predkontaciaId: 'p1', clenenieDphId: 'c2', dokladov: 5, od: '2025-01-10', do: '2025-12-20', kody: { predkontacia: '518100', clenenieDph: 'PN' } },
          ],
        },
      },
    ],
    navrhyDelenia: [
      { klucoveSlova: ['natural 95'], percento: 80, percentoDph: 50, predkontaciaId: 'p1', predkontaciaNedanovaId: 'p2', dokladov: 11, priklady: [] },
    ],
    banka: [
      {
        id: 'b1', kluc: 'ico:11111111:vydaj', smer: 'vydaj', stav: 'navrhnute', partnerIco: '11111111', partnerMena: ['print-office s.r.o.'],
        slova: [], protiucet: '321100', predkontaciaKod: 'Úhrada FP',
        dokaz: { riadkov: 12, podiel: 1, od: '2025-02-01', do: '2026-08-20', protiucet: '321100', kandidati: ['Úhrada FP'] },
      },
      {
        id: 'b2', kluc: 'text:poplatok vedenie:vydaj', smer: 'vydaj', stav: 'navrhnute', partnerMena: [], slova: ['poplatok', 'vedenie'],
        protiucet: '568100', dokaz: { riadkov: 20, podiel: 0.95, od: '2025-01-31', do: '2026-08-31', protiucet: '568100', kandidati: ['Poplatky', 'Poplatky karta'] },
      },
    ],
    prepocitaneAt: '2026-09-16T10:00:00.000Z',
  };
  return {
    profil,
    getProfil: vi.fn(async () => profil),
    ulozFakt: vi.fn(async () => profil),
    odpovedzOtazke: vi.fn(async () => profil),
    rozhodniPraxBanky: vi.fn(async () => profil),
  };
});

vi.mock('../../data/api', () => ({
  getProfil: mocky.getProfil,
  ulozFakt: mocky.ulozFakt,
  odpovedzOtazke: mocky.odpovedzOtazke,
  rozhodniPraxBanky: mocky.rozhodniPraxBanky,
  prepocitajProfil: vi.fn(async () => mocky.profil),
  UCTO_AGENDA_NAZOV: { FP: 'Faktúra prijatá' },
}));
vi.mock('../../data/orgSelection', () => ({ useOrgSelection: () => ({ orgId: 'org-1', selectOrg: () => undefined }) }));
vi.mock('../../data/query', () => ({
  useDataQuery: () => ({
    loading: false,
    data: {
      organizations: [{ id: 'org-1', nazov: 'ALPINA s.r.o.', farba: '#0E7A5F' }],
      codeLists: {
        predkontacie: [
          { id: 'p1', kod: '501100', nazov: 'PHM', orgId: 'org-1', active: true },
          { id: 'p2', kod: '501900', nazov: 'PHM nadspotreba', orgId: 'org-1', active: true },
        ],
        cleneniaDph: [{ id: 'c1', kod: 'PN', nazov: 'Bez nároku', orgId: 'org-1', active: true }],
      },
    },
  }),
}));

const { nazovFaktu } = await import('./profilKatalog');
const { ProfilKlientaPage } = await import('./ProfilKlientaPage');

async function vykresli() {
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  await act(async () => { root.render(<ProfilKlientaPage />); });
  // Profil prichádza asynchrónne — ešte jedno kolo pre then().
  await act(async () => { await Promise.resolve(); });
  // Sumy majú nezlomiteľnú medzeru (1 700 €) — porovnáva sa s obyčajnou.
  const tlacidlo = (text: string) => [...container.querySelectorAll('button')]
    .find((button) => button.textContent?.replace(/\s/g, ' ').trim() === text);
  return { container, tlacidlo, zatvor: () => { act(() => root.unmount()); container.remove(); } };
}

describe('ProfilKlientaPage', () => {
  it('ukáže hlavičku z potvrdených faktov, prstenec, filtre, otázky a sekcie', async () => {
    const { container, zatvor } = await vykresli();
    const text = container.textContent ?? '';
    expect(mocky.getProfil).toHaveBeenCalledWith('org-1');
    expect(text).toContain('ALPINA s.r.o.');
    // Súhrn je len z potvrdených — navrhnutý platiteľ doň nepatrí.
    expect(text).toContain('Samozdanenie: služby z EÚ');
    expect(text).not.toContain('Platiteľ DPH · samozdanenie');
    // Platiteľ (aj navrhnutý) skryje členenie bez odpočtu: 18 relevantných faktov, 1 potvrdený.
    expect(container.querySelector('[role="img"]')?.getAttribute('aria-label')).toBe('1 z 18 potvrdených');
    const filtre = [...container.querySelectorAll('[role="tab"]')].map((tab) => tab.textContent);
    // Navrhnuté: status, návrh delenia a dve praxe banky.
    expect(filtre).toEqual(['Treba odpovedať2', 'Navrhnuté z histórie4', 'Potvrdené1']);
    expect(text).toContain('Od akej sumy firma účtuje majetok ako dlhodobý?');
    expect(text).toContain('Ako účtovať DPH pri protistrane ACME?');
    // Každý kód s názvom poľa: inak nie je vidieť, čo je predkontácia a čo sekcia KV.
    expect(text).toContain('Predkontácia 518100 · Členenie DPH PD · Sekcia KV B2 — 9× dokladov');
    expect(text).toContain('Odpoveď platí pre doklady typu Faktúra prijatá.');
    // Rozúčtovanie z praxe vrátane zvyšku na účte hlavičky.
    expect(text).toContain('Doklad sa delí na položky:');
    expect(text).toContain('20 % základu a 50 % dane na Predkontácia 501900, Členenie DPH PN, Sekcia KV B2');
    expect(text).toContain('80 % základu a 50 % dane na Predkontácia 518100, Členenie DPH PD, Sekcia KV B2');
    expect(text).toContain('Rozpis je doložený 6 z 9 dokl. tejto podoby.');
    // Prepínač samozdanenia je nad druhmi plnení a druhy ho už neopakujú.
    expect(text).toContain('Rieši firma samozdanenie prijatých faktúr?');
    expect(text).not.toContain(nazovFaktu('samozdanenie.postup'));
    expect(text).toContain('Navrhnuté z histórie · 212 dokl.');
    expect(text).toContain('Potvrdil Jana Nová 12. 9. 2026');
    expect(text).toContain('Faktúra PN, KV KN · interný doklad DDsl§69 a PDsluz, KV B1');
    expect(text).toContain('Daňový náklad 80 % · Odpočet DPH 50 %');
    expect(text).not.toContain('Členenie pre nákupy bez odpočtu');
    zatvor();
  });

  it('odpoveď jedným klikom: hranica majetku, spôsob protistrany a potvrdenie návrhu delenia', async () => {
    const { tlacidlo, zatvor } = await vykresli();
    await act(async () => { tlacidlo('1 700 €')!.click(); });
    expect(mocky.ulozFakt).toHaveBeenCalledWith('org-1', 'zasady.drobny_majetok', { stav: 'potvrdene', hodnota: { hranica: 1700 } });

    await act(async () => { tlacidlo('Použiť')!.click(); });
    expect(mocky.odpovedzOtazke).toHaveBeenCalledWith('org-1', '22222222-2222-4222-8222-222222222222', { akcia: 'variant', index: 0 });

    const potvrdit = [...document.querySelectorAll('#pk-vozidla button')].filter((button) => button.textContent === 'Potvrdiť') as HTMLElement[];
    // Vo vozidlách je jediné „Potvrdiť" — návrh delenia.
    await act(async () => { potvrdit.at(-1)!.click(); });
    expect(mocky.ulozFakt).toHaveBeenLastCalledWith('org-1', 'vozidla.pravidla', {
      stav: 'potvrdene',
      hodnota: [{
        nazov: 'natural 95', klucoveSlova: ['natural 95'], percentoZakladu: 80, percentoDph: 50,
        predkontaciaKod: '501100', predkontaciaNedanovaKod: '501900',
      }],
    });

    // Prepínač samozdanenia nad sekciou: kliknutie na voľbu fakt hneď potvrdí.
    const volbaPostupu = [...document.querySelectorAll('#pk-samozdanenie button')]
      .find((button) => button.textContent?.startsWith('Samozdanenie neriešime')) as HTMLElement;
    await act(async () => { volbaPostupu.click(); });
    expect(mocky.ulozFakt).toHaveBeenLastCalledWith('org-1', 'samozdanenie.postup', { stav: 'potvrdene', hodnota: { postup: 'neriesime' } });
    zatvor();
  });

  // „Len pre typy dokladov" bol text: napísaná skratka mimo enumu servera pravidlo zneplatnila.
  it('okno pravidla delenia: typy dokladov sa vyberajú zo zoznamu, nie píšu', async () => {
    const { container, tlacidlo, zatvor } = await vykresli();
    await act(async () => { tlacidlo('Pridať pravidlo')!.click(); });
    const okno = container.querySelector('[role="dialog"]')!;
    expect(okno.querySelector('input[id="pk-pole-typyDokladov"]')).toBeNull();
    const typ = (nazov: string) => [...okno.querySelectorAll('button')]
      .find((button) => button.textContent === nazov) as HTMLButtonElement;
    await act(async () => { typ('Faktúra prijatá').click(); });
    await act(async () => { typ('Ostatný záväzok').click(); });
    expect([...okno.querySelectorAll('[aria-pressed="true"]')].map((button) => button.textContent))
      .toEqual(['Faktúra prijatá', 'Ostatný záväzok']);
    // Druhé kliknutie voľbu zruší — nevybraté znamená všetky doklady.
    await act(async () => { typ('Faktúra prijatá').click(); });
    expect([...okno.querySelectorAll('[aria-pressed="true"]')].map((button) => button.textContent)).toEqual(['Ostatný záväzok']);
    zatvor();
  });

  it('vypnuté samozdanenie: voľba je vybraná a prijaté plnenia sú označené za nepoužité', async () => {
    mocky.profil.fakty.push({
      kluc: 'samozdanenie.postup', stav: 'potvrdene', hodnota: { postup: 'neriesime' }, zdroj: 'uctovnik',
      updatedAt: '2026-09-16T10:00:00.000Z',
    });
    try {
      const { container, zatvor } = await vykresli();
      const sekcia = container.querySelector('#pk-samozdanenie')!;
      expect(sekcia.querySelector('[aria-pressed="true"]')?.textContent).toContain('Samozdanenie neriešime');
      expect(sekcia.textContent).toContain('Samozdanenie prijatých faktúr je vypnuté');
      expect(sekcia.querySelector('.opacity-60')?.textContent).toContain('Prijaté plnenia');
      zatvor();
    } finally {
      mocky.profil.fakty.pop();
    }
  });

  it('Banka: jediný kandidát sa potvrdí hneď, z viacerých až po výbere; zamietnutie', async () => {
    const { container, zatvor } = await vykresli();
    const banka = container.querySelector('#pk-banka')!;
    const riadky = [...banka.querySelectorAll('li')];
    expect(riadky[0].textContent).toContain('print-office s.r.o. · IČO 11111111');
    expect(riadky[0].textContent).toContain('Výdaj na 321100 · 12 riadkov denníka · 1. 2. 2025 – 20. 8. 2026');
    expect(riadky[0].textContent).toContain('Úhrada FP');
    expect(riadky[1].textContent).toContain('Text „poplatok vedenie"');
    const tlacidlo = (riadok: Element, text: string) =>
      [...riadok.querySelectorAll('button')].find((button) => button.textContent === text) as HTMLButtonElement;

    await act(async () => { tlacidlo(riadky[0], 'Potvrdiť').click(); });
    expect(mocky.rozhodniPraxBanky).toHaveBeenLastCalledWith('org-1', 'b1', { stav: 'potvrdene', predkontaciaKod: 'Úhrada FP' });

    // Dva kandidáti: bez výberu sa potvrdiť nedá — nič sa nevyberá za účtovníka.
    expect(tlacidlo(riadky[1], 'Potvrdiť').disabled).toBe(true);
    const vyber = riadky[1].querySelector('select')!;
    await act(async () => {
      vyber.value = 'Poplatky karta';
      vyber.dispatchEvent(new Event('change', { bubbles: true }));
    });
    await act(async () => { tlacidlo(riadky[1], 'Potvrdiť').click(); });
    expect(mocky.rozhodniPraxBanky).toHaveBeenLastCalledWith('org-1', 'b2', { stav: 'potvrdene', predkontaciaKod: 'Poplatky karta' });

    await act(async () => { tlacidlo(riadky[1], 'Zamietnuť').click(); });
    expect(mocky.rozhodniPraxBanky).toHaveBeenLastCalledWith('org-1', 'b2', { stav: 'zamietnute' });
    zatvor();
  });

  it('filter „Potvrdené" schová otázky a nepotvrdené riadky', async () => {
    const { container, zatvor } = await vykresli();
    const potvrdene = [...container.querySelectorAll('[role="tab"]')].find((tab) => tab.textContent?.startsWith('Potvrdené')) as HTMLElement;
    await act(async () => { potvrdene.click(); });
    expect(potvrdene.getAttribute('aria-selected')).toBe('true');
    const text = container.textContent ?? '';
    expect(text).not.toContain('Ako účtovať DPH pri protistrane ACME?');
    expect(text).toContain('Služby z EÚ');
    expect(text).not.toContain('Registrácia DPHPlatiteľ DPH');
    // Navrhnutá prax banky medzi potvrdenými nie je.
    expect(container.querySelector('#pk-banka')).toBeNull();
    zatvor();
  });
});

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
          agenda: 'FP', protistrana: 'ACME',
          varianty: [
            { predkontaciaId: 'p1', clenenieDphId: 'c1', dokladov: 9, od: '2025-02-01', do: '2026-06-30', kody: { predkontacia: '518100', clenenieDph: 'PD', clenenieKv: 'B2' } },
            { predkontaciaId: 'p1', clenenieDphId: 'c2', dokladov: 5, od: '2025-01-10', do: '2025-12-20', kody: { predkontacia: '518100', clenenieDph: 'PN' } },
          ],
        },
      },
    ],
    navrhyDelenia: [
      { klucoveSlova: ['natural 95'], percento: 80, percentoDph: 50, predkontaciaId: 'p1', predkontaciaNedanovaId: 'p2', dokladov: 11, priklady: [] },
    ],
    prepocitaneAt: '2026-09-16T10:00:00.000Z',
  };
  return {
    profil,
    getProfil: vi.fn(async () => profil),
    ulozFakt: vi.fn(async () => profil),
    odpovedzOtazke: vi.fn(async () => profil),
  };
});

vi.mock('../../data/api', () => ({
  getProfil: mocky.getProfil,
  ulozFakt: mocky.ulozFakt,
  odpovedzOtazke: mocky.odpovedzOtazke,
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
    // Platiteľ (aj navrhnutý) skryje členenie bez odpočtu: 17 relevantných faktov, 1 potvrdený.
    expect(container.querySelector('[role="img"]')?.getAttribute('aria-label')).toBe('1 z 17 potvrdených');
    const filtre = [...container.querySelectorAll('[role="tab"]')].map((tab) => tab.textContent);
    expect(filtre).toEqual(['Treba odpovedať2', 'Navrhnuté z histórie2', 'Potvrdené1']);
    expect(text).toContain('Od akej sumy firma účtuje majetok ako dlhodobý?');
    expect(text).toContain('Ako účtovať DPH pri protistrane ACME?');
    expect(text).toContain('518100 · PD · KV B2');
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

    const potvrdit = [...document.querySelectorAll('button')].filter((button) => button.textContent === 'Potvrdiť');
    // Prvé „Potvrdiť" je navrhnutý status, posledné je návrh delenia vo vozidlách.
    await act(async () => { potvrdit.at(-1)!.click(); });
    expect(mocky.ulozFakt).toHaveBeenLastCalledWith('org-1', 'vozidla.pravidla', {
      stav: 'potvrdene',
      hodnota: [{
        nazov: 'natural 95', klucoveSlova: ['natural 95'], percentoZakladu: 80, percentoDph: 50,
        predkontaciaKod: '501100', predkontaciaNedanovaKod: '501900',
      }],
    });
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
    zatvor();
  });
});

import { afterEach, describe, expect, it, vi } from 'vitest';
import { opravSkDanoveCisla } from './skTaxIdsService.js';

/** Odpoveď oboch zoznamov FS pre jedno IČO. */
function stubRegister(row: { dic?: string; ic_dph?: string; nazov_ds?: string } | undefined) {
  const fetchMock = vi.fn(async () => ({
    ok: row !== undefined,
    json: async () => ({ data: row ? [row] : [] }),
  }));
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

afterEach(() => vi.unstubAllGlobals());

const METRO = {
  nazov: 'METRO Cash & Carry SR s.r.o.',
  ico: '45952671',
  icDph: 'SK20203150701', // o číslicu dlhšie — model ju prečítal z bločka zle
  krajina: 'SK',
};

describe('opravSkDanoveCisla', () => {
  it('neplatné IČ DPH z bločka opraví podľa registra a doplní DIČ', async () => {
    stubRegister({ dic: '2023150701', ic_dph: 'SK2023150701', nazov_ds: 'METRO Cash & Carry SR s.r.o.' });
    expect(await opravSkDanoveCisla('key', METRO)).toEqual({ icDph: 'SK2023150701', dic: '2023150701' });
  });

  it('platné IČ DPH z dokladu neprepisuje', async () => {
    const fetchMock = stubRegister({ dic: '2023150701', ic_dph: 'SK9999999999' });
    expect(await opravSkDanoveCisla('key', { ...METRO, icDph: 'SK2023150701', dic: '2023150701' })).toBeUndefined();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('register s iným názvom firmy sa nepoužije — IČO mohlo byť prečítané zle', async () => {
    stubRegister({ dic: '1111111111', ic_dph: 'SK1111111111', nazov_ds: 'Stavebniny Juh s.r.o.' });
    expect(await opravSkDanoveCisla('key', METRO)).toBeUndefined();
  });

  it('zahraničného dodávateľa ani doklad bez IČO sa netýka', async () => {
    const fetchMock = stubRegister({ ic_dph: 'SK2023150701' });
    expect(await opravSkDanoveCisla('key', { ...METRO, krajina: 'AT', icDph: 'ATU43143200' })).toBeUndefined();
    expect(await opravSkDanoveCisla('key', { ...METRO, ico: undefined })).toBeUndefined();
    // Bez kľúča k API sa nikam nevolá — funkcia je voliteľný bonus.
    expect(await opravSkDanoveCisla(undefined, METRO)).toBeUndefined();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('subjekt, ktorý v zoznamoch nie je, nechá doklad tak', async () => {
    stubRegister(undefined);
    expect(await opravSkDanoveCisla('key', METRO)).toBeUndefined();
  });
});

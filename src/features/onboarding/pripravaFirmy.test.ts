import { describe, expect, it, vi } from 'vitest';
import type { PripravenostFirmy, SignalPripravenosti } from '../../data/types';
import { t } from '../../i18n/sk';

// Analýza čítala prázdny korpus histórie a padala na 409 „primálo riadkov",
// hoci pamäť mala stovky rozhodnutí — sú to dve tabuľky. Krok 5 preto najprv
// preklopí pamäť a až potom analyzuje; nula kategórií nesmie prejsť ako hotovo.
const backfill = vi.fn(async () => ({ imported: 549 }));
const analyze = vi.fn(async () => ({ kategorii: 12, textov: 0, davok: 1, pokrytieRiadkov: 0 }));

vi.mock('../../data/api', () => ({
  backfillUctoHistory: (...args: unknown[]) => backfill(...(args as [])),
  analyzeUctoProfil: (...args: unknown[]) => analyze(...(args as [])),
  nacitajPripravenost: vi.fn(async () => null),
}));
vi.mock('../../data/mostik/mostikService', () => ({
  requestMostikTrainingSync: vi.fn(),
  requestMostikCodeListSync: vi.fn(),
}));

const {
  KROKY, stavKrokov, automatickyKrok, krokDobehol, poznamkaPaty, upozorneniePripravenosti, upozornenieNavrhu,
} = await import('./PripravaFirmyModal');

const organizacia = { id: 'org-1', nazov: 'Firma', emailAlias: 'a@b.sk' } as never;
const priprava = { organizationId: 'org-1', mostik: true, ciselniky: 40, pamat: 549, kategorie: 0, schranka: true };

const ok: SignalPripravenosti = { stav: 'ok', dovod: 'ok' };
const caka: SignalPripravenosti = { stav: 'caka', dovod: 'ciselniky_chybaju' };
const pripravenost = (
  stav: PripravenostFirmy['stav'], signaly: Partial<PripravenostFirmy['signaly']>,
): PripravenostFirmy => ({
  stav, signaly: { mostik: ok, firma: ok, ciselniky: ok, historia: ok, profil: ok, meranie: ok, otazky: ok, ...signaly },
});

describe('príprava firmy', () => {
  it('analýza najprv preklopí pamäť do histórie', async () => {
    const analyza = KROKY.find((krok) => krok.cislo === 5)!;
    await analyza.spustit!('org-1');
    expect(backfill).toHaveBeenCalledWith('org-1');
    expect(backfill.mock.invocationCallOrder[0]).toBeLessThan(analyze.mock.invocationCallOrder[0]);
  });

  // Analýza beží vo workeri, takže spustit() sa vráti hneď a o výsledku nevie
  // nič. Že nula kategórií neprejde ako hotovo, drží odteraz „splneny": krok
  // dobieha, kým sa kategórie naozaj neobjavia — rovnako ako mostík nad ním.
  it('nula kategórií nie je hotovo ani po spustení', async () => {
    const analyza = KROKY.find((krok) => krok.cislo === 5)!;
    await analyza.spustit!('org-1');
    expect(analyza.beziKymNeHotovy).toBe(true);
    expect(analyza.splneny({ ...priprava, kategorie: 0 }, organizacia)).toBe(false);
    expect(analyza.splneny({ ...priprava, kategorie: 12 }, organizacia)).toBe(true);
  });

  it('krok 5 čaká na číselníky aj pamäť', () => {
    const stavy = stavKrokov({ ...priprava, mostik: false, ciselniky: 0, pamat: 0 }, organizacia);
    expect(stavy).toEqual(['hotovy', 'naRade', 'zamknuty', 'zamknuty', 'zamknuty']);
  });

  it('s hotovou pamäťou je analýza na rade', () => {
    expect(stavKrokov(priprava, organizacia)[4]).toBe('naRade');
  });

  it('číselníky si účtovník neklikáva — agent ich ťahá sám', () => {
    const ciselniky = KROKY.find((krok) => krok.cislo === 3)!;
    expect(ciselniky.automaticky).toBe(true);
    expect(ciselniky.cesta).toBeUndefined();
    expect(ciselniky.spustit).toBeTypeOf('function');
  });

  it('automatický je práve jeden krok — inak by sa spúšťali cez seba', () => {
    expect(KROKY.filter((krok) => krok.automaticky)).toHaveLength(1);
  });

  // Prázdne prepojenie z založenia firmy robilo zo snapshotu „Mostík hotový"
  // a krok 3 sa rozbehol nad agentom, ktorý neexistuje.
  it('prázdne prepojenie neodomkne číselníky ani ich nespustí', () => {
    const nova = pripravenost('nepripravena', {
      mostik: { stav: 'caka', dovod: 'agent_nesparovany' }, firma: { stav: 'caka', dovod: 'caka_na_agenta' },
      ciselniky: caka, historia: caka, profil: caka, meranie: { stav: 'overit', dovod: 'meranie_chyba' },
    });
    const stavy = stavKrokov({ ...priprava, mostik: true, ciselniky: 0, pamat: 0 }, organizacia, nova);
    expect(stavy).toEqual(['hotovy', 'naRade', 'zamknuty', 'zamknuty', 'zamknuty']);
    expect(automatickyKrok(stavy, nova)).toBeUndefined();
  });

  it('číselníky sa samé nesťahujú, kým server nepotvrdí agenta aj databázu firmy', () => {
    const bezSynchronizacie = pripravenost('nepripravena', {
      firma: { stav: 'overit', dovod: 'sparovane_bez_synchronizacie' }, ciselniky: caka, historia: caka, profil: caka,
    });
    const stavy = stavKrokov({ ...priprava, ciselniky: 0 }, organizacia, bezSynchronizacie);
    expect(stavy[2]).toBe('naRade');
    expect(automatickyKrok(stavy, bezSynchronizacie)).toBeUndefined();
    // Kým sa pripravenosť načítava, nerozbehne sa nič.
    expect(automatickyKrok(stavy, undefined)).toBeUndefined();
    const spojena = pripravenost('nepripravena', { ciselniky: caka, historia: caka, profil: caka });
    expect(automatickyKrok(stavKrokov({ ...priprava, ciselniky: 0 }, organizacia, spojena), spojena)?.cislo).toBe(3);
  });

  it('krok s výhradou „overiť" je hotový, päta však netvrdí, že je firma pripravená', () => {
    const overit = pripravenost('overit', {
      firma: { stav: 'overit', dovod: 'sparovane_bez_synchronizacie', detail: { dbName: 'StwPh_1_2026', uctovnyRok: '2026' } },
      historia: { stav: 'overit', dovod: 'historia_len_hlavicky' },
    });
    expect(stavKrokov({ ...priprava, ciselniky: 0, pamat: 0 }, organizacia, overit)).toEqual(Array(5).fill('hotovy'));
    expect(KROKY[1].hotovo(priprava, organizacia, overit)).toContain('StwPh_1_2026 · rok 2026');
    expect(poznamkaPaty(true, overit)).toContain(t('pripravenost.sparovane_bez_synchronizacie'));
    expect(poznamkaPaty(true, pripravenost('pripravena', {}))).toBe(t('priprava.hotovoPoznamka'));
  });

  it('bez odpovede servera platia počty zo snapshotu, no „pripravená" sa netvrdí', () => {
    expect(stavKrokov(priprava, organizacia, null)).toEqual(['hotovy', 'hotovy', 'hotovy', 'hotovy', 'naRade']);
    expect(automatickyKrok(stavKrokov({ ...priprava, ciselniky: 0 }, organizacia, null), null)?.cislo).toBe(3);
    expect(poznamkaPaty(true, null)).not.toBe(t('priprava.hotovoPoznamka'));
  });

  // POHODA vráti jeden číselník s chybou: krok 3 ostane „na rade" s chybou.
  // Spúšťal sa sám pri každom otvorení a spinner čakal na „hotovo", ktoré nepríde.
  it('po chybe číselníka sa krok 3 sám nespúšťa a bežiaci spinner zhasne', () => {
    const chyba: SignalPripravenosti = { stav: 'chyba', dovod: 'ciselnik_chyba_druh', detail: 'ciselneRady', kedy: '2026-09-15T12:00:00.000Z' };
    const poChybe = pripravenost('nepripravena', { ciselniky: chyba, historia: caka, profil: caka });
    const stavy = stavKrokov({ ...priprava, ciselniky: 40 }, organizacia, poChybe);
    expect(stavy[2]).toBe('naRade');
    expect(automatickyKrok(stavy, poChybe)).toBeUndefined();
    // Spustený nad prázdnymi číselníkmi — nová chyba znamená, že agent odpovedal.
    expect(krokDobehol(KROKY[2], 'naRade', poChybe, undefined)).toBe(true);
    // Tá istá chyba ako pri spustení ešte nie je odpoveď na túto požiadavku.
    expect(krokDobehol(KROKY[2], 'naRade', poChybe, chyba.kedy)).toBe(false);
    expect(krokDobehol(KROKY[2], 'naRade', pripravenost('nepripravena', { ciselniky: caka }), undefined)).toBe(false);
    expect(krokDobehol(KROKY[2], 'hotovy', null, undefined)).toBe(true);
  });

  it('upozornenie pri návrhu len pri nepripravenej firme', () => {
    expect(upozornenieNavrhu(pripravenost('pripravena', {}))).toBeUndefined();
    expect(upozornenieNavrhu(null)).toBeUndefined();
    const meranie: SignalPripravenosti = { stav: 'overit', dovod: 'meranie_chyba' };
    expect(upozornenieNavrhu(pripravenost('overit', { meranie }))).toBeUndefined();
    expect(upozornenieNavrhu(pripravenost('nepripravena', { historia: caka, meranie })))
      .toBe(`${t('pripravenost.navrhUpozornenie')} ${t('pripravenost.ciselniky_chybaju')}`);
  });

  it('upozornenie pri návrhu nesie prvý nesplnený dôvod', () => {
    expect(upozorneniePripravenosti(pripravenost('pripravena', {}))).toBeUndefined();
    expect(upozorneniePripravenosti(null)).toBeUndefined();
    expect(upozorneniePripravenosti(pripravenost('nepripravena', {
      historia: { stav: 'chyba', dovod: 'historia_neuplna', detail: 'agenda FP: parts' },
      meranie: { stav: 'overit', dovod: 'meranie_chyba' },
    }))).toBe(`${t('pripravenost.historia_neuplna')} (agenda FP: parts)`);
    // Otázky profilu klienta nie sú krok sprievodcu, dôvod však musí mať text.
    expect(upozorneniePripravenosti(pripravenost('overit', { otazky: { stav: 'caka', dovod: 'otazky_blokujuce', pocet: 1 } })))
      .toBe(t('pripravenost.otazky_blokujuce'));
    expect(t('pripravenost.otazky_otvorene')).toBeTruthy();
  });
});

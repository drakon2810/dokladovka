import { describe, expect, it } from 'vitest';
import { vypocitajPripravenost, type ImportHistorie, type VstupPripravenosti } from './pripravenostService.js';

const teraz = new Date('2026-09-15T12:00:00Z');
const predHodinami = (hodin: number) => new Date(teraz.getTime() - hodin * 3_600_000).toISOString();
const moznosti = { teraz, agentOfflineHodin: 2 };

const publikovany: ImportHistorie = {
  stav: 'publikovany', chyba: null, vytvoreny: predHodinami(5), publikovany: predHodinami(5),
  manifest: {
    databaza: 'StwPh_12345678_2026', rok: 2026,
    agendy: [
      { poziadavka: 'receivedInvoice', agenda: 'FP', stav: 'ok', dokladov: 120, poloziek: 300, riadkov: 420 },
      { poziadavka: 'voucher', stav: 'ok', dokladov: 40, poloziek: 40, riadkov: 80 },
      { poziadavka: 'issuedDebitNote', agenda: 'FV-T', stav: 'ok', dokladov: 0, poloziek: 0, riadkov: 0 },
      // Ostatné pohľadávky meranie nevie merať — pripravenosť kvôli nim nesmie zamrznúť.
      { poziadavka: 'receivable', agenda: 'OP', stav: 'ok', dokladov: 3, poloziek: 3, riadkov: 6 },
    ],
  },
};

/** Firma, na ktorej je všetko hotové a čerstvé. */
function pripravena(): VstupPripravenosti {
  return {
    mostikZapnuty: true,
    pripojenychAgentov: 1,
    agentVideny: predHodinami(0.1),
    prepojenie: { dbName: 'StwPh_12345678_2026', uctovnyRok: '2026', matchRule: 'auto_ico' },
    poslednaSynchronizacia: predHodinami(0.5),
    ciselniky: ['predkontacie', 'cleneniaDph', 'ciselneRady'].map((druh) => ({
      druh, beh: { stav: 'ok', poloziek: 10, chyba: null, kedy: predHodinami(0.5) }, zPohody: 10, spolu: 10,
    })),
    historia: { posledny: publikovany, publikovany, bezManifestu: true },
    analyza: { stav: 'succeeded', chyba: null, zarazena: predHodinami(4.5), kedy: predHodinami(4), kategorii: 12, zlyhanychDavok: 0 },
    kategorie: true,
    meranie: { kedy: predHodinami(4), vynechane: [] },
    otazky: { blokujucich: 0, ostatnych: 0 },
  };
}

const s = (vstup: Partial<VstupPripravenosti>) => vypocitajPripravenost({ ...pripravena(), ...vstup }, moznosti);

describe('pripravenosť firmy', () => {
  it('všetko ok a čerstvé je pripravená', () => {
    const vysledok = s({});
    expect(vysledok.stav, JSON.stringify(vysledok.signaly)).toBe('pripravena');
    expect(vysledok.signaly.historia).toMatchObject({ stav: 'ok', pocet: 163 });
    expect(vysledok.signaly.firma.detail).toEqual({ dbName: 'StwPh_12345678_2026', uctovnyRok: '2026', matchRule: 'auto_ico' });
  });

  it('nová firma s prázdnym prepojením a bez agenta nie je pripravená', () => {
    const vysledok = s({
      pripojenychAgentov: 0, agentVideny: null,
      prepojenie: { dbName: null, uctovnyRok: null, matchRule: null }, poslednaSynchronizacia: null,
      ciselniky: pripravena().ciselniky.map((druh) => ({ ...druh, beh: null, zPohody: 0, spolu: 0 })),
      historia: { posledny: null, publikovany: null, bezManifestu: false },
      analyza: null, kategorie: false, meranie: null,
    });
    expect(vysledok.stav).toBe('nepripravena');
    expect(vysledok.signaly.mostik).toMatchObject({ stav: 'caka', dovod: 'agent_nesparovany' });
    expect(vysledok.signaly.firma).toMatchObject({ stav: 'caka', dovod: 'caka_na_agenta' });
    expect(vysledok.signaly.historia).toMatchObject({ stav: 'caka', dovod: 'historia_nestiahnuta' });
  });

  it('agent, ktorý sa dlhšie neozval, je chyba', () => {
    const vysledok = s({ agentVideny: predHodinami(3) });
    expect(vysledok.signaly.mostik).toMatchObject({ stav: 'chyba', dovod: 'agent_offline' });
    expect(vysledok.stav).toBe('nepripravena');
  });

  it('spárovaná bez synchronizácie treba overiť, stará synchronizácia je chyba', () => {
    expect(s({ poslednaSynchronizacia: null }).signaly.firma).toMatchObject({ stav: 'overit', dovod: 'sparovane_bez_synchronizacie' });
    expect(s({ poslednaSynchronizacia: predHodinami(4) }).signaly.firma).toMatchObject({ stav: 'chyba', dovod: 'firma_nesynchronizovana' });
  });

  it('číselníky: chyba behu, len ručné, chýbajúci druh, prázdna odpoveď', () => {
    const [predkontacie, ...ostatne] = pripravena().ciselniky;
    // Chyba nesie čas posledného behu — bežiaci krok sprievodcu podľa neho zhasne.
    expect(s({ ciselniky: [{ ...predkontacie, beh: { stav: 'error', poloziek: 0, chyba: 'timeout', kedy: predHodinami(0.1) } }, ...ostatne] }).signaly.ciselniky)
      .toMatchObject({ stav: 'chyba', dovod: 'ciselnik_chyba', detail: 'predkontacie: timeout', kedy: predHodinami(0.1) });
    expect(s({ ciselniky: pripravena().ciselniky.map((druh) => ({ ...druh, beh: null, zPohody: 0, spolu: 3 })) }).signaly.ciselniky)
      .toMatchObject({ stav: 'overit', dovod: 'ciselniky_rucne' });
    expect(s({ ciselniky: [{ ...predkontacie, zPohody: 0, spolu: 0 }, ...ostatne] }).signaly.ciselniky)
      .toMatchObject({ stav: 'chyba', dovod: 'ciselnik_chyba_druh', detail: 'predkontacie', kedy: predHodinami(0.5) });
    expect(s({ ciselniky: [{ ...predkontacie, beh: { stav: 'ok', poloziek: 0, chyba: null, kedy: predHodinami(0.5) } }, ...ostatne] }).signaly.ciselniky)
      .toMatchObject({ stav: 'overit', dovod: 'ciselnik_prazdna_odpoved' });
  });

  it('história len s hlavičkami a prázdna história treba overiť', () => {
    const agendy = publikovany.manifest!.agendy!;
    const hlavicky = { ...publikovany, manifest: { ...publikovany.manifest, agendy: agendy.map((agenda) => ({ ...agenda, poloziek: 0 })) } };
    expect(s({ historia: { posledny: hlavicky, publikovany: hlavicky, bezManifestu: true } }).signaly.historia)
      .toMatchObject({ stav: 'overit', dovod: 'historia_len_hlavicky' });
    const prazdna = { ...publikovany, manifest: { databaza: 'X', agendy: [] } };
    const vysledok = s({ historia: { posledny: prazdna, publikovany: prazdna, bezManifestu: false } });
    expect(vysledok.signaly.historia).toMatchObject({ stav: 'overit', dovod: 'historia_prazdna' });
    expect(vysledok.stav).toBe('overit');
  });

  it('zamietnutý prenos je chyba s dôvodom, aj keď staršia história žije', () => {
    const zamietnuty: ImportHistorie = { ...publikovany, stav: 'zamietnuty', chyba: 'agenda FP: parts', publikovany: null, vytvoreny: predHodinami(1) };
    const vysledok = s({ historia: { posledny: zamietnuty, publikovany, bezManifestu: true } });
    expect(vysledok.signaly.historia).toMatchObject({ stav: 'chyba', dovod: 'historia_neuplna', detail: 'agenda FP: parts' });
    expect(vysledok.stav).toBe('nepripravena');
  });

  it('prenos, ktorý prijíma viac ako hodinu, sa nedokončil; mladší ešte beží', () => {
    const prijima = (hodin: number): ImportHistorie => ({ stav: 'prijima', chyba: null, manifest: null, vytvoreny: predHodinami(hodin), publikovany: null });
    expect(s({ historia: { posledny: prijima(2), publikovany, bezManifestu: true } }).signaly.historia)
      .toMatchObject({ stav: 'chyba', dovod: 'historia_neukoncena' });
    expect(s({ historia: { posledny: prijima(0.2), publikovany, bezManifestu: true } }).signaly.historia)
      .toMatchObject({ stav: 'caka', dovod: 'historia_prebieha' });
  });

  it('história zo staršieho Mostíka bez manifestu treba overiť', () => {
    const vysledok = s({ historia: { posledny: null, publikovany: null, bezManifestu: true } });
    expect(vysledok.signaly.historia).toMatchObject({ stav: 'overit', dovod: 'historia_bez_manifestu' });
    expect(vysledok.stav).toBe('overit');
  });

  it('profil: bežiaca, zlyhaná, prázdna, čiastočná a staršia analýza', () => {
    const analyza = pripravena().analyza!;
    expect(s({ analyza: { ...analyza, stav: 'running' } }).signaly.profil).toMatchObject({ stav: 'caka', dovod: 'analyza_bezi' });
    expect(s({ analyza: { ...analyza, stav: 'failed', chyba: 'kľúč' } }).signaly.profil).toMatchObject({ stav: 'chyba', dovod: 'analyza_zlyhala', detail: 'kľúč' });
    expect(s({ analyza: { ...analyza, kategorii: 0 } }).signaly.profil).toMatchObject({ stav: 'chyba', dovod: 'analyza_prazdna' });
    expect(s({ analyza: { ...analyza, zlyhanychDavok: 2 } }).signaly.profil).toMatchObject({ stav: 'overit', dovod: 'analyza_ciastocna', pocet: 2 });
    expect(s({ analyza: { ...analyza, zarazena: predHodinami(7), kedy: predHodinami(6) } }).signaly.profil)
      .toMatchObject({ stav: 'overit', dovod: 'profil_starsi_ako_historia' });
    // Analýza číta históriu pri štarte: zaradená pred publikáciou, dobehnutá po nej, stojí na starej histórii.
    expect(s({ analyza: { ...analyza, zarazena: predHodinami(5.5), kedy: predHodinami(4) } }).signaly.profil)
      .toMatchObject({ stav: 'overit', dovod: 'profil_starsi_ako_historia', kedy: predHodinami(4) });
  });

  it('meranie: chýba, staršie ako publikácia, agendy, na ktoré vzorka nestačila', () => {
    expect(s({ meranie: null }).signaly.meranie).toMatchObject({ stav: 'overit', dovod: 'meranie_chyba' });
    expect(s({ meranie: { kedy: predHodinami(6), vynechane: [] } }).signaly.meranie).toMatchObject({ stav: 'overit', dovod: 'meranie_starsie' });
    const vysledok = s({ meranie: { kedy: predHodinami(1), vynechane: ['FV-D', 'PPD'] } });
    expect(vysledok.signaly.meranie).toMatchObject({ stav: 'overit', dovod: 'meranie_ciastocne', detail: 'FV-D, PPD' });
    // Meranie neblokuje — firma sa dá overiť, nie je nepripravená.
    expect(vysledok.stav).toBe('overit');
  });

  it('agenda histórie, ktorú meranie nevie merať (OP), meranie nezhodí', () => {
    expect(s({ meranie: { kedy: predHodinami(1), vynechane: [] } }).signaly.meranie).toMatchObject({ stav: 'ok' });
  });

  it('otázky profilu: blokujúca čaká, ostatné treba overiť, ani jedna firmu nezastaví', () => {
    const blokujuca = s({ otazky: { blokujucich: 1, ostatnych: 3 } });
    expect(blokujuca.signaly.otazky).toEqual({ stav: 'caka', dovod: 'otazky_blokujuce', pocet: 1 });
    expect(blokujuca.stav).toBe('overit');
    const ostatne = s({ otazky: { blokujucich: 0, ostatnych: 3 } });
    expect(ostatne.signaly.otazky).toEqual({ stav: 'overit', dovod: 'otazky_otvorene', pocet: 3 });
    expect(ostatne.stav).toBe('overit');
    expect(s({}).signaly.otazky).toEqual({ stav: 'ok', dovod: 'ok' });
  });
});

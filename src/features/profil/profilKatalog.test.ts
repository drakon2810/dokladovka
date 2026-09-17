import { describe, expect, it } from 'vitest';
import type { ProfilFakt, ProfilKlienta, ProfilOtazka, VariantOtazky } from '../../data/types';
import { sk } from '../../i18n/sk';
import {
  castiVariantu, formularZHodnoty, hodnotaZFormulara, kluceFaktov, kodyHodnoty, nadpisOtazky, nazovFaktu, nazovTypuDokladu,
  pocty, popisFaktu, popisOtazky, poliaFaktu, poliaVariantu, pravidloZNavrhu, relevantneKluce, stavFaktu, stavSekcie,
  suhrnProfilu, triedOtazky, vetaCasti, vetaHodnoty, vetaVariantu, TYPY_DOKLADOV, ZOZNAMOVE,
} from './profilKatalog';

// Serverový katalóg (kľúče a zod schémy) je mimo projektu appky, tsc ho sem
// staticky pustiť nevie — test ho načíta za behu, aby sa zoznamy nerozišli.
const CESTA_SERVERA = '../../../server/services/profilKatalog';
type SchemaServera = { safeParse: (hodnota: unknown) => { success: boolean } };
const { PROFIL_KATALOG, polozkaKatalogu } = await import(/* @vite-ignore */ CESTA_SERVERA) as {
  PROFIL_KATALOG: Array<{ kluc: string }>;
  polozkaKatalogu: (kluc: string) => { schema: SchemaServera } | undefined;
};

/** Jedna platná hodnota na každý kľúč — pri zozname jedna položka. */
const VZORKY: Record<string, unknown> = {
  'dph.status': { status: 'registracia_7a' },
  'dph.clenenie_bez_odpoctu': { clenenieKod: 'PN' },
  'dph.oslobodene_plnenia': { ano: true, koeficient: 0.85 },
  'samozdanenie.sluzby_eu': { faktura: { clenenieKod: 'PN', kv: 'KN' }, interny: { ddKod: 'DDsl§69', pKod: 'PDsluz', kv: 'B1' } },
  'samozdanenie.sluzby_mimo_eu': { interny: { ddKod: 'DDsluz' } },
  'samozdanenie.tovar_eu': { interny: { ddKod: 'DDnadEU', pKod: 'PDnadEU', kv: 'B1' } },
  'samozdanenie.prenesenie_prijate': { faktura: { clenenieKod: 'PN' } },
  'samozdanenie.dovoz': { faktura: { clenenieKod: 'PDtovar' } },
  'samozdanenie.prenesenie_vystavene': { faktura: { clenenieKod: 'UN§69', kv: 'A2' } },
  'samozdanenie.sluzby_zahranicie_vystavene': { faktura: { clenenieKod: 'UDzahrSl' } },
  'samozdanenie.zahranicie_vystavene': { faktura: { clenenieKod: 'UDzahr' } },
  'samozdanenie.tovar_do_eu': { faktura: { clenenieKod: 'UDdodEU', kv: 'D1' } },
  'zahranicie.vratenie_dph': { uplatnujeme: true, predkontaciaKod: '378005' },
  'vozidla.pravidla': {
    nazov: 'PHM', klucoveSlova: ['natural 95', 'BA123XY'], percentoZakladu: 80, percentoDph: 50,
    predkontaciaKod: '501100', predkontaciaNedanovaKod: '501900', clenenieDphNedanoveKod: 'PN',
    typyDokladov: ['FP', 'OZ'],
  },
  'naklady.bez_naroku': { predkontaciaKod: '513100', clenenieKod: 'PN' },
  'naklady.pomerne': { nazov: 'Telefón', klucoveSlova: ['telefon'], percentoDph: 70, predkontaciaKod: '518200', clenenieDphNedanoveKod: 'PN' },
  'zasady.tovar_na_ceste': { pouziva: false },
  'zasady.drobny_majetok': { hranica: 1700 },
  'samozdanenie.postup': { postup: 'neriesime' },
};
const hodnotaFaktu = (kluc: string) => (ZOZNAMOVE.has(kluc) ? [VZORKY[kluc]] : VZORKY[kluc]);

const fakt = (kluc: string, stav: ProfilFakt['stav'], hodnota: unknown): ProfilFakt =>
  ({ kluc, stav, hodnota, zdroj: 'historia', updatedAt: '2026-09-16T10:00:00.000Z' });
const otazka = (id: string, cast: Partial<ProfilOtazka>): ProfilOtazka => ({
  id, kluc: `fakt:${id}`, druh: 'fakt', stav: 'otvorena', blokuje: false, dokladov: 0, data: { kluc: id }, createdAt: '2026-09-16T10:00:00.000Z', ...cast,
});
const profil = (cast: Partial<ProfilKlienta>): ProfilKlienta => ({ fakty: [], otazky: [], navrhyDelenia: [], banka: [], ...cast });

describe('katalóg profilu klienta', () => {
  it('pozná presne tie kľúče, ktoré server, a každý má názov, popis a vetu hodnoty', () => {
    expect([...kluceFaktov()].sort()).toEqual(PROFIL_KATALOG.map((polozka) => polozka.kluc).sort());
    const texty = sk as Record<string, string>;
    for (const kluc of kluceFaktov()) {
      expect(texty[`profilKlienta.fakt.${kluc}.nazov`], kluc).toBeTruthy();
      expect(texty[`profilKlienta.fakt.${kluc}.popis`], kluc).toBeTruthy();
      expect(vetaHodnoty(kluc, hodnotaFaktu(kluc)), kluc).not.toBe('—');
      expect(nazovFaktu(kluc)).not.toContain('profilKlienta.');
      expect(popisFaktu(kluc)).not.toContain('profilKlienta.');
    }
  });

  // Formulár nesmie poslať tvar, ktorý server odmietne — a nesmie nič stratiť.
  it('formulár vráti tú istú hodnotu a server ju prijme', () => {
    for (const kluc of kluceFaktov()) {
      const vysledok = hodnotaZFormulara(kluc, formularZHodnoty(kluc, VZORKY[kluc]));
      expect(vysledok, kluc).toEqual({ hodnota: VZORKY[kluc] });
      expect(polozkaKatalogu(kluc)!.schema.safeParse(hodnotaFaktu(kluc)).success, kluc).toBe(true);
      for (const pole of poliaFaktu(kluc)) {
        expect((sk as Record<string, string>)[`profilKlienta.pole.${kluc}.${pole.cesta}`]
          ?? (sk as Record<string, string>)[`profilKlienta.pole.${pole.cesta}`], `${kluc} ${pole.cesta}`).toBeTruthy();
      }
    }
  });

  it('formulár: prázdna skupina sa vynechá, čiarka v čísle platí, chýbajúce povinné pole sa pomenuje', () => {
    expect(hodnotaZFormulara('samozdanenie.sluzby_eu', { 'faktura.clenenieKod': '', 'faktura.kv': '', 'interny.ddKod': 'DDsluz' }))
      .toEqual({ hodnota: { interny: { ddKod: 'DDsluz' } } });
    expect(hodnotaZFormulara('samozdanenie.sluzby_eu', { 'faktura.kv': 'KN' })).toEqual({ chyba: 'faktura.clenenieKod' });
    expect(hodnotaZFormulara('dph.oslobodene_plnenia', { ano: 'true', koeficient: '0,9' })).toEqual({ hodnota: { ano: true, koeficient: 0.9 } });
    // Koeficient pri „nie" server odmieta — skryté pole sa neposiela.
    expect(hodnotaZFormulara('dph.oslobodene_plnenia', { ano: 'false', koeficient: '0,9' })).toEqual({ hodnota: { ano: false } });
    expect(hodnotaZFormulara('dph.oslobodene_plnenia', { ano: 'true', koeficient: '1,5' })).toEqual({ chyba: 'koeficient' });
    expect(hodnotaZFormulara('naklady.pomerne', { ...formularZHodnoty('naklady.pomerne', VZORKY['naklady.pomerne']), klucoveSlova: ' , ' }))
      .toEqual({ chyba: 'klucoveSlova' });
  });

  it('veta hodnoty je čitateľná a kódy z nej sa dajú vytiahnuť', () => {
    expect(vetaHodnoty('samozdanenie.sluzby_eu', VZORKY['samozdanenie.sluzby_eu']))
      .toBe('Faktúra PN, KV KN · interný doklad DDsl§69 a PDsluz, KV B1');
    expect(vetaHodnoty('zasady.drobny_majetok', { hranica: 1700 })).toMatch(/^Dlhodobý majetok od 1\s700 €$/);
    expect(vetaHodnoty('dph.status', { status: 'nieco' })).toBe('—');
    expect(vetaHodnoty('naklady.bez_naroku', [VZORKY['naklady.bez_naroku']])).toBe('Bez odpočtu na účtoch 513100 (PN)');
    expect(kodyHodnoty([VZORKY['vozidla.pravidla']])).toEqual(['501100', '501900', 'PN']);
  });

  it('členenie bez odpočtu sa platiteľa netýka; počty rátajú aj „nepoužíva sa" ako rozhodnuté', () => {
    const p = profil({
      fakty: [
        fakt('dph.status', 'navrhnute', { status: 'platitel' }),
        fakt('samozdanenie.sluzby_eu', 'potvrdene', VZORKY['samozdanenie.sluzby_eu']),
        fakt('samozdanenie.dovoz', 'nepouziva_sa', null),
      ],
      otazky: [otazka('zasady.drobny_majetok', {}), otazka('dph.oslobodene_plnenia', { stav: 'odlozena', blokuje: true })],
      navrhyDelenia: [{ klucoveSlova: ['nafta'], percento: 80, predkontaciaId: 'p1', predkontaciaNedanovaId: 'p2', dokladov: 7, priklady: [] }],
    });
    expect(relevantneKluce(p.fakty)).not.toContain('dph.clenenie_bez_odpoctu');
    expect(relevantneKluce([])).toContain('dph.clenenie_bez_odpoctu');
    expect(stavFaktu('zasady.drobny_majetok', p)).toBe('odpovedat');
    expect(stavFaktu('zasady.tovar_na_ceste', p)).toBe('nevyplnene');
    expect(pocty(p)).toEqual({ relevantnych: kluceFaktov().length - 1, potvrdenych: 2, navrhnutych: 2, otazok: 2, blokuje: true });
    expect(stavSekcie('dph', p)).toEqual({ bodka: 'blokuje', pocet: 2 });
    expect(stavSekcie('vozidla', p)).toEqual({ bodka: 'navrhnute', pocet: 1 });
    expect(stavSekcie('naklady', p)).toEqual({ bodka: 'prazdne', pocet: 0 });
    expect(suhrnProfilu(p.fakty)).toBe('Samozdanenie: služby z EÚ');
    expect(suhrnProfilu([])).toBe(sk['profilKlienta.suhrn.prazdny']);
  });

  it('otázky: blokujúce a s viac dokladmi prvé, odložené zvlášť', () => {
    const { otvorene, odlozene } = triedOtazky([
      otazka('a', { dokladov: 3 }), otazka('b', { dokladov: 40 }), otazka('c', { blokuje: true }), otazka('d', { stav: 'odlozena' }),
    ]);
    expect(otvorene.map((item) => item.id)).toEqual(['c', 'b', 'a']);
    expect(odlozene.map((item) => item.id)).toEqual(['d']);
  });

  it('otázka rozporu pomenuje potvrdené aj to, čo ukazuje história', () => {
    const rozpor = otazka('dph.oslobodene_plnenia', {
      data: { kluc: 'dph.oslobodene_plnenia', rozpor: true, navrh: { ano: true }, dokaz: { dokladov: 12 } },
    });
    const fakty = [fakt('dph.oslobodene_plnenia', 'potvrdene', { ano: false })];
    expect(nadpisOtazky(rozpor)).toBe('História nesedí s profilom: Oslobodené plnenia a koeficient');
    expect(popisOtazky(rozpor, fakty, (agenda) => agenda)).toContain('„Nie, odpočet je celý", no 12 dokl. v histórii ukazuje „Áno, odpočet sa kráti koeficientom"');
    const status = otazka('dph.status', { blokuje: true, data: { kluc: 'dph.status', napoveda: 'registracia_7a' } });
    expect(nadpisOtazky(status)).toBe('Je firma platiteľom DPH?');
    expect(popisOtazky(status, [], (agenda) => agenda)).toContain('§7a');
    const malo = otazka('samozdanenie.tovar_eu', { data: { kluc: 'samozdanenie.tovar_eu', navrh: VZORKY['samozdanenie.tovar_eu'], dokaz: { dokladov: 3 } } });
    expect(nadpisOtazky(malo)).toBe('Ako firma účtuje tovar z EÚ?');
    expect(popisOtazky(malo, [], (agenda) => agenda)).toContain('len 3 dokl.');
    const spor = otazka('x', { druh: 'spor_protistrany', kluc: 'spor:FP:12345678', data: { agenda: 'FP', protistrana: 'ACME', varianty: [] } });
    expect(nadpisOtazky(spor)).toBe('Ako účtovať DPH pri protistrane ACME?');
    expect(popisOtazky(spor, [], () => 'Faktúra prijatá')).toMatch(/^Faktúra prijatá:/);
  });

  // Kódy protistrany za sebou („bInt · PDnadEU · B1") nepovedia, čo je čo.
  it('možnosť otázky pomenuje každé pole a bez druhu dokladu sekciu KV nesľubuje', () => {
    const variant: VariantOtazky = {
      predkontaciaId: 'p1', clenenieDphId: 'c1', clenenieKvKod: 'B3', dokladov: 5, od: '2026-01-31', do: '2026-07-31',
      kody: { predkontacia: 'PHM - Biensky VW', clenenieDph: 'PD', clenenieKv: 'B3' },
    };
    expect(poliaVariantu(variant, 'PD')).toEqual([
      { nazov: 'Predkontácia', kod: 'PHM - Biensky VW' },
      { nazov: 'Členenie DPH', kod: 'PD' },
      { nazov: 'Sekcia KV', kod: 'B3' },
    ]);
    // Bez typu dokladu pravidlo platí na všetky doklady protistrany — sekciu vtedy určí doklad.
    expect(poliaVariantu(variant).at(-1)).toEqual({ nazov: 'Sekcia KV', kod: 'podľa druhu dokladu' });
    expect(vetaVariantu({ faktura: { clenenieKod: 'PN', kv: 'KN' } }, 'samozdanenie.sluzby_eu'))
      .toBe('Členenie DPH PN · Sekcia KV KN');
  });

  // Bloček PHM m.bienský: 163,75 € sa delí 80/20 a odpočet dane je polovičný.
  it('možnosť s rozúčtovaním ukáže časti, ich podiely aj zvyšok na účte hlavičky', () => {
    const variant: VariantOtazky = {
      predkontaciaId: 'p1', clenenieDphId: 'c1', clenenieKvKod: 'B3', dokladov: 5, od: '2026-01-31', do: '2026-07-31',
      kody: { predkontacia: 'PHM - Biensky VW', clenenieDph: 'PD', clenenieKv: 'B3' },
      casti: [{ predkontaciaKod: 'DPH PHM VW', clenenieDphKod: 'PN', clenenieKvKod: 'B3', podiel: 0.2, podielDph: 0.5 }],
      dokladovCasti: 3,
    };
    const casti = castiVariantu(variant);
    expect(casti.map(vetaCasti)).toEqual([
      '20 % základu a 50 % dane na Predkontácia DPH PHM VW, Členenie DPH PN, Sekcia KV B3',
      '80 % základu a 50 % dane na Predkontácia PHM - Biensky VW, Členenie DPH PD, Sekcia KV B3',
    ]);
    // Podoba bez rozpisu nemá čo ukázať a zvyšok si nevymýšľa.
    expect(castiVariantu({ ...variant, casti: [], dokladovCasti: undefined })).toEqual([]);
    expect(vetaCasti({ predkontaciaKod: '501100' })).toBe('Predkontácia 501100');
  });

  it('typy dokladov sa vyberajú zo zoznamu servera a nevybraté znamená všetky doklady', () => {
    const polia = poliaFaktu('vozidla.pravidla');
    // Pole nie je text: písané skratky server odmietne, preto sa vyberá.
    expect(polia.find((pole) => pole.cesta === 'typyDokladov')).toEqual({ cesta: 'typyDokladov', typ: 'typy' });
    expect(TYPY_DOKLADOV.map(nazovTypuDokladu))
      .toEqual(['Faktúra prijatá', 'Faktúra vydaná', 'Ostatný záväzok', 'Pokladničný doklad', 'Bankový výpis', 'Interný doklad']);
    const formular = formularZHodnoty('vozidla.pravidla', VZORKY['vozidla.pravidla']);
    expect(formular.typyDokladov).toBe('FP, OZ');
    expect(hodnotaZFormulara('vozidla.pravidla', formular)).toEqual({ hodnota: VZORKY['vozidla.pravidla'] });
    // Nevybraté = pravidlo platí na všetky doklady, teda pole v hodnote vôbec nie je.
    const { typyDokladov: _typy, ...bezTypov } = VZORKY['vozidla.pravidla'] as Record<string, unknown>;
    expect(hodnotaZFormulara('vozidla.pravidla', { ...formular, typyDokladov: '' })).toEqual({ hodnota: bezTypov });
    expect(polozkaKatalogu('vozidla.pravidla')!.schema.safeParse([bezTypov]).success).toBe(true);
  });

  it('návrh delenia sa prevedie na pravidlo s kódmi, neznámy účet nič nehádže', () => {
    const kody: Record<string, string> = { p1: '501100', p2: '501900', c1: 'PN' };
    const navrh = { klucoveSlova: ['natural', '95', 'shell', 'karta'], percento: 80, percentoDph: 50, predkontaciaId: 'p1', predkontaciaNedanovaId: 'p2', clenenieDphNedanoveId: 'c1', dokladov: 9, priklady: [] };
    const pravidlo = pravidloZNavrhu(navrh, (id) => kody[id]);
    expect(pravidlo).toEqual({
      nazov: 'natural, 95, shell', klucoveSlova: navrh.klucoveSlova, percentoZakladu: 80, percentoDph: 50,
      predkontaciaKod: '501100', predkontaciaNedanovaKod: '501900', clenenieDphNedanoveKod: 'PN',
    });
    expect(polozkaKatalogu('vozidla.pravidla')!.schema.safeParse([pravidlo]).success).toBe(true);
    expect(pravidloZNavrhu({ ...navrh, predkontaciaNedanovaId: 'zmazany' }, (id) => kody[id])).toBeUndefined();
  });
});

import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import type { Database } from '../db/database.js';
import { createTestDatabase, seedTestUser } from '../testHelpers.js';
import {
  nacitajPraxBanky, odvodPraxBanky, predkontaciaZPraxe, prepocitajPraxBanky, rozhodniPraxBanky, zmerajPraxBanky,
  type BankovaPredkontacia, type RiadokBanky,
} from './bankaPraxService.js';

// Prax banky z denníka POHODY: partner alebo opakovaný text + smer → protiúčet
// a banková predkontácia firmy. Šablóny majú banku na 221000, denník na 221100 —
// banková strana je rola, nie presná analytika.

const databases: Database[] = [];
afterEach(async () => Promise.all(databases.splice(0).map((database) => database.close())));

const PREDKONTACIE: BankovaPredkontacia[] = [
  { kod: 'Úhrada FP', agenda: 'bankIssued', ucetMd: '321100', ucetDal: '221000' },
  // Rovnaký protiúčet, opačný smer — výdaju sa ponúknuť nesmie.
  { kod: 'Dobropis FP', agenda: 'bankReceived', ucetMd: '221000', ucetDal: '321100' },
  { kod: 'Úhrada FV', agenda: 'bankReceived', ucetMd: '221000', ucetDal: '311100' },
  { kod: 'Poplatky', agenda: 'bankIssued', ucetMd: '568100', ucetDal: '221000' },
  { kod: 'Poplatky karta', agenda: 'bankIssued', ucetMd: '568100', ucetDal: '221000' },
  // Fakturová predkontácia s rovnakými účtami do bankovej praxe nepatrí.
  { kod: '325/221', agenda: 'receivedInvoice', ucetMd: '325100', ucetDal: '221000' },
];

const vydaj = (protiucet: string, r: Partial<RiadokBanky> = {}): RiadokBanky =>
  ({ datum: '2026-03-01', suma: 100, ucetMd: protiucet, ucetDal: '221100', ...r });
const prijem = (protiucet: string, r: Partial<RiadokBanky> = {}): RiadokBanky =>
  ({ datum: '2026-03-01', suma: 100, ucetMd: '221100', ucetDal: protiucet, ...r });
const krat = (n: number, riadok: RiadokBanky) => Array.from({ length: n }, () => riadok);

describe('odvodenie praxe banky', () => {
  it('≥ 5 riadkov a vedúci protiúčet ≥ 90 %, smer oddelene, 221 ako rola', () => {
    const praxe = odvodPraxBanky([
      ...krat(5, vydaj('321100', { partnerIco: '11 111 111', partnerNazov: 'Print-Office s.r.o.' })),
      ...krat(5, prijem('311100', { partnerIco: '11111111', partnerNazov: 'Print-Office  S.R.O.' })),
      // 4 riadky sú málo.
      ...krat(4, vydaj('321100', { partnerNazov: 'Malý dodávateľ' })),
      // 9 z 10 = 90 % stačí, 8 z 10 nie.
      ...krat(9, vydaj('321100', { partnerNazov: 'Deväť' })), vydaj('325100', { partnerNazov: 'Deväť' }),
      ...krat(8, vydaj('321100', { partnerNazov: 'Osem' })), ...krat(2, vydaj('325100', { partnerNazov: 'Osem' })),
      // Prevod medzi účtami 221 a nulová suma nie sú pohyb s protiúčtom.
      ...krat(5, { datum: '2026-03-01', suma: 100, ucetMd: '221100', ucetDal: '221200', partnerNazov: 'Prevod' }),
      ...krat(5, vydaj('321100', { partnerNazov: 'Nula', suma: 0 })),
    ], PREDKONTACIE);
    expect(praxe.map((prax) => [prax.kluc, prax.protiucet, prax.predkontaciaKod, prax.dokaz.riadkov])).toEqual([
      ['meno:deväť:vydaj', '321100', 'Úhrada FP', 10],
      ['ico:11111111:prijem', '311100', 'Úhrada FV', 5],
      ['ico:11111111:vydaj', '321100', 'Úhrada FP', 5],
    ]);
    expect(praxe[1]).toMatchObject({ partnerMena: ['print-office s.r.o.'], dokaz: { kandidati: ['Úhrada FV'] } });
    expect(praxe[2].dokaz.kandidati).toEqual(['Úhrada FP']);
    expect(praxe[0].dokaz.podiel).toBe(0.9);
  });

  it('viac kandidátov sa nevyberá a text bez partnera je kľúčom len so smerom', () => {
    const praxe = odvodPraxBanky([
      ...['01', '02', '03', '04', '05'].map((mesiac) => vydaj('568100', { text: `Poplatok za vedenie účtu ${mesiac}/2026`, datum: `2026-${mesiac}-28` })),
      ...krat(5, vydaj('325100', { text: 'Úhrada 26OZ001' })),
    ], PREDKONTACIE);
    expect(praxe).toEqual([
      {
        kluc: 'text:poplatok uctu vedenie:vydaj', smer: 'vydaj', partnerMena: [], slova: ['poplatok', 'uctu', 'vedenie'], protiucet: '568100',
        dokaz: { riadkov: 5, podiel: 1, od: '2026-01-28', do: '2026-05-28', protiucet: '568100', kandidati: ['Poplatky', 'Poplatky karta'] },
      },
      // 325100 má len fakturovú predkontáciu — prax bez bankovej predkontácie.
      {
        kluc: 'text:uhrada:vydaj', smer: 'vydaj', partnerMena: [], slova: ['uhrada'], protiucet: '325100',
        dokaz: { riadkov: 5, podiel: 1, od: '2026-03-01', do: '2026-03-01', protiucet: '325100', kandidati: [] },
      },
    ]);
  });

  it('textová prax: dôkaz zo všetkých riadkov s jej slovami, užšia prax prebije širšiu', () => {
    // 4× „Úhrada DPH" je pod prahom, no prax „uhrada" by sa na ňu použila — iný protiúčet ju zhodí.
    expect(odvodPraxBanky([
      ...krat(5, vydaj('321100', { text: 'Úhrada' })), ...krat(4, vydaj('343100', { text: 'Úhrada DPH 04/2026' })),
    ], PREDKONTACIE)).toEqual([]);
    const praxe = odvodPraxBanky([
      ...krat(45, vydaj('321100', { text: 'Úhrada' })), ...krat(5, vydaj('343100', { text: 'Úhrada DPH 04/2026' })),
    ], PREDKONTACIE);
    expect(praxe.map((prax) => [prax.kluc, prax.protiucet, prax.predkontaciaKod, prax.dokaz.riadkov, prax.dokaz.podiel])).toEqual([
      ['text:uhrada:vydaj', '321100', 'Úhrada FP', 50, 0.9],
      ['text:dph uhrada:vydaj', '343100', undefined, 5, 1],
    ]);
    expect(predkontaciaZPraxe(praxe, { suma: -10, text: 'Úhrada faktúry 26001' })).toBe('Úhrada FP');
    // Užšia prax „dph uhrada" (bez kódu) širšiu na svoj text nepustí.
    expect(predkontaciaZPraxe(praxe, { suma: -10, text: 'ÚHRADA DPH 05/2026' })).toBeUndefined();
  });

  it('pohyb výpisu: meno alebo slová textu, správny smer, zamietnutá nie, potvrdená má prednosť', () => {
    const praxe = [
      { smer: 'vydaj' as const, partnerIco: '11111111', partnerMena: ['print-office s.r.o.'], slova: [], predkontaciaKod: 'Úhrada FP' },
      { smer: 'vydaj' as const, partnerMena: [], slova: ['poplatok', 'vedenie'], predkontaciaKod: 'Poplatky' },
      { smer: 'vydaj' as const, partnerMena: [], slova: ['poplatok'], predkontaciaKod: 'Poplatky karta' },
      { smer: 'vydaj' as const, partnerMena: ['zamietnutý'], slova: [], predkontaciaKod: 'Úhrada FP', stav: 'zamietnute' as const },
    ];
    expect(predkontaciaZPraxe(praxe, { suma: -120, protistrana: 'PRINT-OFFICE s.r.o. ' })).toBe('Úhrada FP');
    // Opačný smer ani zamietnutá prax návrh nedajú.
    expect(predkontaciaZPraxe(praxe, { suma: 120, protistrana: 'Print-Office s.r.o.' })).toBeUndefined();
    expect(predkontaciaZPraxe(praxe, { suma: -1, protistrana: 'Zamietnutý' })).toBeUndefined();
    // Pohyb s protistranou sa textom nepáruje.
    expect(predkontaciaZPraxe(praxe, { suma: -3, protistrana: 'Neznámy', text: 'Poplatok' })).toBeUndefined();
    // Užšia prax prebije širšiu — aj zamietnutá.
    expect(predkontaciaZPraxe(praxe, { suma: -3, text: 'POPLATOK za vedenie uctu 08/2026' })).toBe('Poplatky');
    expect(predkontaciaZPraxe(praxe, { suma: -3, text: 'Poplatok za výber' })).toBe('Poplatky karta');
    expect(predkontaciaZPraxe([{ ...praxe[1], stav: 'zamietnute' }, praxe[2]], { suma: -3, text: 'Poplatok za vedenie' })).toBeUndefined();
    // Dve rovnako úzke praxe s rôznym kódom = žiadny návrh; potvrdená rozhodne.
    const karta = { smer: 'vydaj' as const, partnerMena: [], slova: ['karta', 'poplatok'], predkontaciaKod: 'Poplatky karta' };
    expect(predkontaciaZPraxe([praxe[1], karta], { suma: -3, text: 'Poplatok za vedenie, karta' })).toBeUndefined();
    expect(predkontaciaZPraxe([{ ...praxe[1], stav: 'potvrdene' }, karta], { suma: -3, text: 'Poplatok za vedenie, karta' })).toBe('Poplatky');
  });
});

async function priprav() {
  const database = await createTestDatabase();
  databases.push(database);
  const firma = await seedTestUser(database);
  for (const p of PREDKONTACIE) {
    await database.query(
      `INSERT INTO code_list_items (id,tenant_id,organization_id,kind,code,name,source,agenda,ucet_md,ucet_dal)
       VALUES ($1,$2,$3,'predkontacie',$4,$4,'pohoda',$5,$6,$7)`,
      [randomUUID(), firma.tenantId, firma.organizationId, p.kod, p.agenda, p.ucetMd, p.ucetDal],
    );
  }
  const dennik = async (riadky: RiadokBanky[], agenda = 'Banka') => {
    for (const r of riadky) {
      await database.query(
        `INSERT INTO ucto_dennik (id,tenant_id,organization_id,externalny_id,agenda,datum,text,suma,ucet_md,ucet_dal,partner_ico,partner_nazov)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
        [randomUUID(), firma.tenantId, firma.organizationId, randomUUID(), agenda, r.datum ?? null, r.text ?? null, r.suma ?? null,
          r.ucetMd, r.ucetDal, r.partnerIco ?? null, r.partnerNazov ?? null],
      );
    }
  };
  const prepocitaj = () => database.transaction((tx) => prepocitajPraxBanky(tx, firma));
  const podlaKluca = async () => new Map((await nacitajPraxBanky(database, firma)).map((prax) => [prax.kluc, prax]));
  return { database, firma, dennik, prepocitaj, podlaKluca };
}

describe('prepočet praxe banky', () => {
  it('potvrdenú a zamietnutú prax neprepíše, len im obnoví dôkaz; navrhnutú prepíše alebo zmaže', async () => {
    const { database, firma, dennik, prepocitaj, podlaKluca } = await priprav();
    await dennik([
      ...krat(5, vydaj('321100', { partnerNazov: 'Potvrdená' })),
      ...krat(5, vydaj('321100', { partnerNazov: 'Zamietnutá' })),
      ...krat(5, vydaj('321100', { partnerNazov: 'Navrhnutá' })),
      ...krat(5, vydaj('568100', { partnerNazov: 'Zmizne' })),
    ]);
    // Iná agenda denníka do praxe banky nepatrí.
    await dennik(krat(5, vydaj('321100', { partnerNazov: 'Faktúra' })), 'Prijaté faktúry');
    expect(await prepocitaj()).toEqual({ praxi: 4 });
    let praxe = await podlaKluca();
    expect([...praxe.keys()].sort()).toEqual(['meno:navrhnutá:vydaj', 'meno:potvrdená:vydaj', 'meno:zamietnutá:vydaj', 'meno:zmizne:vydaj']);
    // Dve bankové predkontácie na 568100 — navrhnutá prax kód nemá.
    expect(praxe.get('meno:zmizne:vydaj')?.predkontaciaKod).toBeUndefined();

    const rozhodni = (kluc: string, telo: Parameters<typeof rozhodniPraxBanky>[3]) =>
      database.transaction((tx) => rozhodniPraxBanky(tx, firma, praxe.get(kluc)!.id, telo));
    // Kód mimo kandidátov (opačný smer) server odmietne.
    await expect(rozhodni('meno:potvrdená:vydaj', { stav: 'potvrdene', predkontaciaKod: 'Dobropis FP' }))
      .rejects.toMatchObject({ code: 'banka_prax_kod_neplatny' });
    await rozhodni('meno:potvrdená:vydaj', { stav: 'potvrdene', predkontaciaKod: 'Úhrada FP' });
    await rozhodni('meno:zamietnutá:vydaj', { stav: 'zamietnute' });

    // História sa zmení: všetci traja teraz platia na 325100, „Zmizne" už nič.
    await database.query(`DELETE FROM ucto_dennik WHERE partner_nazov='Zmizne'`);
    await dennik(['Potvrdená', 'Zamietnutá', 'Navrhnutá'].flatMap((meno) => krat(50, vydaj('325100', { partnerNazov: meno, datum: '2026-04-01' }))));
    await prepocitaj();
    praxe = await podlaKluca();
    expect(praxe.get('meno:potvrdená:vydaj')).toMatchObject({
      stav: 'potvrdene', protiucet: '321100', predkontaciaKod: 'Úhrada FP', potvrdil: 'Test Admin',
      dokaz: { riadkov: 55, protiucet: '325100', kandidati: [], od: '2026-03-01', do: '2026-04-01' },
    });
    expect(praxe.get('meno:zamietnutá:vydaj')).toMatchObject({ stav: 'zamietnute', protiucet: '321100', dokaz: { riadkov: 55, protiucet: '325100' } });
    expect(praxe.get('meno:navrhnutá:vydaj')).toMatchObject({ stav: 'navrhnute', protiucet: '325100', dokaz: { riadkov: 55 } });
    expect(praxe.get('meno:navrhnutá:vydaj')?.predkontaciaKod).toBeUndefined();
    expect(praxe.has('meno:zmizne:vydaj')).toBe(false);

    // Potvrdenú prax, ktorú história už nedrží, prepočet nezmaže — len jej vezme dôkaz.
    await database.query(`DELETE FROM ucto_dennik WHERE partner_nazov='Potvrdená'`);
    await prepocitaj();
    const potvrdena = (await podlaKluca()).get('meno:potvrdená:vydaj');
    expect(potvrdena).toMatchObject({ stav: 'potvrdene', predkontaciaKod: 'Úhrada FP' });
    expect(potvrdena?.dokaz).toBeUndefined();
  }, 90_000);
});

describe('meranie praxe banky (skript zmerajBanku)', () => {
  it('riadok vidí len prax z predošlých dní — celý svoj deň nie', async () => {
    const { firma, dennik, database } = await priprav();
    const partner = (datum: string, protiucet = '321100') => vydaj(protiucet, { datum, partnerNazov: 'Print-Office s.r.o.' });
    const poplatok = (datum: string) => vydaj('568100', { datum, text: 'Poplatok za výber' });
    await dennik([
      partner('2026-01-01'), partner('2026-01-02'), partner('2026-01-03'), partner('2026-01-04'),
      // Piaty deň má dva riadky: druhý nesmie vidieť prvý (4 predošlé < 5).
      partner('2026-01-05'), partner('2026-01-05'),
      // Šiesty deň: 6 predošlých → návrh správny; siedmy: iný protiúčet → chybný.
      partner('2026-01-06'), partner('2026-01-07', '325100'),
      // Text bez partnera: na 568100 sú dve bankové predkontácie — návrh nie je.
      ...['2026-01-01', '2026-01-02', '2026-01-03', '2026-01-04', '2026-01-05', '2026-01-06'].map(poplatok),
      // Príjem bez praxe sa ráta do riadkov, návrh nemá.
      prijem('311100', { datum: '2026-01-07', partnerNazov: 'Odberateľ' }),
    ]);
    expect(await zmerajPraxBanky(database, firma)).toEqual({
      riadkov: 15, navrhnutych: 2, spravnych: 1, navrhnutychZTextu: 0, spravnychZTextu: 0,
    });
    // Jediná predkontácia na 568100 → textová prax dá správny návrh šiestemu poplatku.
    await database.query(`UPDATE code_list_items SET active=false WHERE code='Poplatky karta'`);
    expect(await zmerajPraxBanky(database, firma)).toEqual({
      riadkov: 15, navrhnutych: 3, spravnych: 2, navrhnutychZTextu: 1, spravnychZTextu: 1,
    });
    // Meranie nič nezapisuje.
    expect((await database.query('SELECT 1 FROM banka_prax')).rowCount).toBe(0);
  }, 90_000);
});

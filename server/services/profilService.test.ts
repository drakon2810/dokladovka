import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import type { Database } from '../db/database.js';
import { createTestDatabase, seedTestUser } from '../testHelpers.js';
import { aktualizujProfil, ulozFakt } from './profilService.js';

// Profil z histórie POHODY bez modelu: čo z dokladov vyplýva, sa navrhne, čo
// nie, sa opýta — a čo účtovník potvrdil, generátor nikdy neprepíše.

const databases: Database[] = [];
afterEach(async () => Promise.all(databases.splice(0).map((database) => database.close())));

type Firma = Awaited<ReturnType<typeof seedTestUser>>;

interface Riadok {
  agenda: string; cislo: string; datum?: string; nazov: string; ico?: string; idx?: number;
  pk?: string; dph?: string; kv?: string; krajina?: string; sadzba?: number;
}

async function priprav() {
  const database = await createTestDatabase();
  databases.push(database);
  const firma = await seedTestUser(database);
  const riadok = (r: Riadok) => database.query(
    `INSERT INTO ucto_historia
      (id,tenant_id,organization_id,agenda,doklad_cislo,datum,supplier_ico,supplier_name_normalized,line_text_normalized,
       sadzba_dph,predkontacia_kod,clenenie_dph_kod,clenenie_kv_kod,source,riadok_hash,riadok_index,krajina)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'text',$9,$10,$11,$12,'mdb',$13,$14,$15)`,
    [randomUUID(), firma.tenantId, firma.organizationId, r.agenda, r.cislo, r.datum ?? '2026-03-10', r.ico ?? null, r.nazov,
      r.sadzba ?? null, r.pk ?? null, r.dph ?? null, r.kv ?? null, randomUUID(), r.idx ?? 0, r.krajina ?? null],
  );
  const prepocitaj = () => database.transaction((tx) => aktualizujProfil(tx, firma));
  const fakty = async () => new Map((await database.query<Record<string, any>>(
    'SELECT kluc, stav, hodnota, zdroj, dokaz FROM profil_fakty WHERE organization_id=$1', [firma.organizationId],
  )).rows.map((row) => [row.kluc, row]));
  const otazky = async () => new Map((await database.query<Record<string, any>>(
    'SELECT kluc, stav, blokuje, dokladov, data FROM profil_otazky WHERE organization_id=$1', [firma.organizationId],
  )).rows.map((row) => [row.kluc, row]));
  return { database, firma, riadok, prepocitaj, fakty, otazky };
}

const kodyFirmy = async (database: Database, firma: Firma, kody: Array<[string, string, string?]>) => {
  for (const [kind, code, name] of kody) {
    await database.query(
      `INSERT INTO code_list_items (id,tenant_id,organization_id,kind,code,name,source) VALUES ($1,$2,$3,$4,$5,$6,'pohoda')`,
      [randomUUID(), firma.tenantId, firma.organizationId, kind, code, name ?? code],
    );
  }
};

describe('profil klienta z histórie', () => {
  it('platiteľ: štyri doklady sú otázka, piaty návrh; otázka zastará a návrh bez dôkazu zmizne', async () => {
    const { database, firma, riadok, prepocitaj, fakty, otazky } = await priprav();
    for (const n of [1, 2, 3, 4]) await riadok({ agenda: 'FP', cislo: `F${n}`, datum: `2026-0${n}-10`, nazov: 'telekom', dph: 'PD', kv: 'B2' });
    await prepocitaj();
    expect((await fakty()).has('dph.status')).toBe(false);
    expect((await otazky()).get('fakt:dph.status')).toMatchObject({ stav: 'otvorena', blokuje: true, data: { kluc: 'dph.status' } });
    expect((await otazky()).get('fakt:zasady.drobny_majetok')).toMatchObject({ stav: 'otvorena', blokuje: false, dokladov: 0 });

    await riadok({ agenda: 'FV', cislo: 'V1', datum: '2026-05-10', nazov: 'odberatel', dph: 'UD', kv: 'A1' });
    expect(await prepocitaj()).toMatchObject({ navrhnutych: 1 });
    expect((await fakty()).get('dph.status')).toMatchObject({
      stav: 'navrhnute', zdroj: 'historia', hodnota: { status: 'platitel' },
      dokaz: { dokladov: 5, od: '2026-01-10', do: '2026-05-10', navrh: { status: 'platitel' } },
    });
    expect((await fakty()).get('dph.status')!.dokaz.priklady).toEqual([
      { agenda: 'FV', cislo: 'V1', datum: '2026-05-10' }, { agenda: 'FP', cislo: 'F4', datum: '2026-04-10' },
      { agenda: 'FP', cislo: 'F3', datum: '2026-03-10' },
    ]);
    expect((await otazky()).get('fakt:dph.status')?.stav).toBe('zastarana');

    // História zmizla: navrhnutý fakt bez dôkazu zmizne a otázka sa vráti.
    await database.query('DELETE FROM ucto_historia WHERE organization_id=$1', [firma.organizationId]);
    await prepocitaj();
    expect((await fakty()).has('dph.status')).toBe(false);
    expect((await otazky()).get('fakt:dph.status')?.stav).toBe('otvorena');
  }, 60_000);

  it('samozdanenie: služby z EÚ s párom DD+P a faktúrou PN/KN, prenesenie pri SK dodávateľovi, mimo EÚ len otázka', async () => {
    const { riadok, prepocitaj, fakty, otazky } = await priprav();
    for (const n of [1, 2, 3, 4, 5]) {
      // Krajinu nesie len faktúra — interný doklad adresu nemá.
      await riadok({ agenda: 'FP', cislo: `G${n}`, nazov: 'google ireland', krajina: 'IE', dph: 'PN', kv: 'KN' });
      // Dva interné doklady ako v POHODE: vymeranie (aInt) a odpočet (bInt).
      await riadok({ agenda: 'INT', cislo: `GI${n}`, nazov: 'google ireland', pk: 'aInt', dph: 'DDsl§69', kv: 'B1' });
      await riadok({ agenda: 'INT', cislo: `GO${n}`, nazov: 'google ireland', pk: 'bInt', dph: 'PDsluz', kv: 'B1' });
      // Dovoz podľa § 84a: DD a P na internom doklade, bez faktúry.
      await riadok({ agenda: 'INT', cislo: `D${n}`, nazov: 'shenzhen trade', krajina: 'CN', pk: 'aInt', dph: 'DDtov§84a', kv: 'B1' });
      await riadok({ agenda: 'INT', cislo: `DO${n}`, nazov: 'shenzhen trade', pk: 'bInt', dph: 'PDtov§84a', kv: 'B1' });
      await riadok({ agenda: 'INT', cislo: `R${n}`, nazov: 'recable', ico: '44556677', krajina: 'SK', dph: 'DDsluz', kv: 'B1' });
      await riadok({ agenda: 'INT', cislo: `R${n}`, nazov: 'recable', ico: '44556677', krajina: 'SK', idx: 1, dph: 'PDsluz', kv: 'B1' });
    }
    for (const n of [1, 2]) {
      await riadok({ agenda: 'INT', cislo: `O${n}`, nazov: 'openai llc', krajina: 'US', dph: 'DDsl§69', kv: 'B1' });
      // Odpočet PDsluz inej protistrany sa k páru nepripletie.
      await riadok({ agenda: 'FP', cislo: `X${n}`, nazov: 'iny', dph: 'PDsluz', kv: 'B1' });
    }
    await prepocitaj();
    const f = await fakty();
    expect(f.get('samozdanenie.sluzby_eu')).toMatchObject({ stav: 'navrhnute', dokaz: { dokladov: 5 } });
    expect(f.get('samozdanenie.sluzby_eu')!.hodnota).toEqual({
      faktura: { clenenieKod: 'PN', kv: 'KN' },
      interny: { ddKod: 'DDsl§69', ddPredkontaciaKod: 'aInt', pKod: 'PDsluz', pPredkontaciaKod: 'bInt', kv: 'B1' },
    });
    expect(f.get('samozdanenie.dovoz')!.hodnota).toEqual({
      interny: { ddKod: 'DDtov§84a', ddPredkontaciaKod: 'aInt', pKod: 'PDtov§84a', pPredkontaciaKod: 'bInt', kv: 'B1' },
    });
    expect(f.get('samozdanenie.prenesenie_prijate')!.hodnota).toEqual({ interny: { ddKod: 'DDsluz', pKod: 'PDsluz', kv: 'B1' } });
    expect(f.has('samozdanenie.sluzby_mimo_eu')).toBe(false);
    const o = await otazky();
    expect(o.get('fakt:samozdanenie.sluzby_mimo_eu')).toMatchObject({
      stav: 'otvorena', dokladov: 2,
      data: { kluc: 'samozdanenie.sluzby_mimo_eu', navrh: { interny: { ddKod: 'DDsl§69', kv: 'B1' } }, dokaz: { dokladov: 2 } },
    });
    expect(o.has('fakt:samozdanenie.sluzby_eu')).toBe(false);
  }, 60_000);

  it('účet bez nároku podľa položiek a tovar na ceste z denníka', async () => {
    const { database, firma, riadok, prepocitaj, fakty } = await priprav();
    await kodyFirmy(database, firma, [
      ['predkontacie', 'repre'], ['predkontacie', '518100'],
      ['cleneniaDph', 'PN', 'Nezahrňovať do priznania DPH'], ['cleneniaDph', 'PD', 'Tuzemské plnenia'],
    ]);
    for (const n of [1, 2, 3, 4, 5]) {
      await riadok({ agenda: 'FP', cislo: `H${n}`, nazov: 'hotel', dph: 'PD', kv: 'B2' });
      await riadok({ agenda: 'FP', cislo: `H${n}`, nazov: 'hotel', idx: 1, pk: 'repre', dph: 'PN' });
    }
    // Zberný účet s občasnou nedaňovou položkou bez nároku nie je.
    for (const n of [1, 2, 3, 4, 5, 6, 7]) {
      await riadok({ agenda: 'FP', cislo: `S${n}`, nazov: 'sluzby', idx: 1, pk: '518100', dph: n <= 5 ? 'PN' : 'PD' });
    }
    for (const n of [1, 2, 3]) {
      await database.query(
        `INSERT INTO ucto_dennik (id,tenant_id,organization_id,externalny_id,agenda,doklad_cislo,datum,ucet_md,ucet_dal)
         VALUES ($1,$2,$3,$4,'Prijaté faktúry',$5,'2026-02-0${n}','139100','321000')`,
        [randomUUID(), firma.tenantId, firma.organizationId, `db:${n}`, `T${n}`],
      );
    }
    await prepocitaj();
    const f = await fakty();
    expect(f.get('naklady.bez_naroku')).toMatchObject({ stav: 'navrhnute', dokaz: { dokladov: 5 } });
    expect(f.get('naklady.bez_naroku')!.hodnota).toEqual([{ predkontaciaKod: 'repre', clenenieKod: 'PN' }]);
    expect(f.get('zasady.tovar_na_ceste')).toMatchObject({ hodnota: { pouziva: true }, dokaz: { dokladov: 3, do: '2026-02-03' } });
  }, 60_000);

  it('potvrdený fakt generátor neprepíše; rozpor otvorí aj zodpovedanú otázku, ale len raz', async () => {
    const { database, firma, riadok, prepocitaj, fakty, otazky } = await priprav();
    const potvrd = (hodnota: unknown) => database.transaction((tx) =>
      ulozFakt(tx, { ...firma }, 'dph.status', { stav: 'potvrdene', hodnota }));

    await prepocitaj();
    await potvrd({ status: 'neplatitel' });
    expect((await otazky()).get('fakt:dph.status')?.stav).toBe('zodpovedana');

    for (const n of [1, 2, 3, 4, 5]) await riadok({ agenda: 'FP', cislo: `F${n}`, nazov: 'telekom', dph: 'PD', kv: 'B2' });
    await prepocitaj();
    expect((await fakty()).get('dph.status')).toMatchObject({
      stav: 'potvrdene', zdroj: 'uctovnik', hodnota: { status: 'neplatitel' }, dokaz: { dokladov: 5, navrh: { status: 'platitel' } },
    });
    // Odpoveď bez dôkazu z histórie nie je odpoveďou na to, že história hovorí inak.
    expect((await otazky()).get('fakt:dph.status')).toMatchObject({
      stav: 'otvorena', dokladov: 5, data: { kluc: 'dph.status', rozpor: true, navrh: { status: 'platitel' } },
    });

    // Účtovník trvá na svojom: rozpor je zodpovedaný a znova sa nezaloží.
    await potvrd({ status: 'neplatitel' });
    await prepocitaj();
    expect((await otazky()).get('fakt:dph.status')?.stav).toBe('zodpovedana');
    await database.query(`UPDATE profil_otazky SET stav='zodpovedana' WHERE kluc='fakt:zasady.drobny_majetok'`);
    await prepocitaj();
    expect((await otazky()).get('fakt:zasady.drobny_majetok')?.stav).toBe('zodpovedana');

    // Dôkaz ostáva aj po potvrdení, s potvrdenou praxou rozpor zmizne.
    await potvrd({ status: 'platitel' });
    await prepocitaj();
    expect((await fakty()).get('dph.status')).toMatchObject({ hodnota: { status: 'platitel' }, dokaz: { dokladov: 5 } });
    expect((await otazky()).get('fakt:dph.status')?.stav).toBe('zodpovedana');
  }, 60_000);
});

import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import { createTestDatabase, seedTestUser } from '../testHelpers.js';
import { parseDennik, ulozDennik } from './uctoDennikService.js';

// Účtovný denník je jediný zdroj, z ktorého vidno, že doklad bol rozdelený:
// hlavičkový korpus po rozdelení nezachová nič. Meranie na reálnom denníku
// ALPINY za 2026 (7389 proviozok): 48 % dokladov má viac než jednu proviozku
// a 24 % ide na niekoľko RÔZNYCH nákladových účtov.

const databases: Awaited<ReturnType<typeof createTestDatabase>>[] = [];
afterEach(async () => Promise.all(databases.splice(0).map((database) => database.close())));

/** Skrátená odpoveď POHODY v tvare, aký naozaj vracia listAccountancyRequest. */
const ODPOVED = `<?xml version="1.0" encoding="Windows-1250"?>
<rsp:responsePack version="2.0" id="Dennik" state="ok" ico="36283410"
  xmlns:rsp="http://www.stormware.cz/schema/version_2/response.xsd"
  xmlns:lst="http://www.stormware.cz/schema/version_2/list.xsd"
  xmlns:act="http://www.stormware.cz/schema/version_2/accountancy.xsd"
  xmlns:typ="http://www.stormware.cz/schema/version_2/type.xsd">
  <rsp:responsePackItem version="2.0" id="d01" state="ok">
    <lst:listAccountancy version="2.0" state="ok">
      <lst:accountancy version="2.0">
        <act:accountingItem>
          <act:id>1001</act:id>
          <act:source>Prijaté faktúry</act:source>
          <act:number><typ:numberRequested>26FP001</typ:numberRequested></act:number>
          <act:text>Tonery</act:text>
          <act:homeCurrency><typ:priceSum>100.00</typ:priceSum></act:homeCurrency>
          <act:accounting><act:credit>501400</act:credit><act:debit>321100</act:debit></act:accounting>
          <act:address><typ:address><typ:company>Print-Office s.r.o.</typ:company><typ:ico>12345678</typ:ico></typ:address></act:address>
          <act:date>2026-05-31</act:date>
        </act:accountingItem>
        <act:accountingItem>
          <act:id>1002</act:id>
          <act:source>Prijaté faktúry</act:source>
          <act:number><typ:numberRequested>26FP001</typ:numberRequested></act:number>
          <act:text>Reprezentácia</act:text>
          <act:homeCurrency><typ:priceSum>40.00</typ:priceSum></act:homeCurrency>
          <act:accounting><act:credit>513100</act:credit><act:debit>321100</act:debit></act:accounting>
          <act:date>2026-05-31</act:date>
        </act:accountingItem>
        <act:accountingItem>
          <act:id>1003</act:id>
          <act:source>Prijaté faktúry</act:source>
          <act:number><typ:numberRequested>26FP001</typ:numberRequested></act:number>
          <act:text>DPH</act:text>
          <act:homeCurrency><typ:priceSum>32.20</typ:priceSum></act:homeCurrency>
          <act:accounting><act:credit>343100</act:credit><act:debit>321100</act:debit></act:accounting>
          <act:date>2026-05-31</act:date>
        </act:accountingItem>
        <act:accountingItem>
          <act:id>1004</act:id>
          <act:source>Banka</act:source>
          <act:text>Proviozka bez uctov sa preskoci</act:text>
          <act:date>2026-05-31</act:date>
        </act:accountingItem>
      </lst:accountancy>
    </lst:listAccountancy>
  </rsp:responsePackItem>
</rsp:responsePack>`;

describe('účtovný denník z POHODY', () => {
  it('rozloží proviozky vrátane účtov MD/DAL a preskočí tie bez zaúčtovania', () => {
    const { riadky, preskocene } = parseDennik(ODPOVED);
    expect(riadky).toHaveLength(3);
    expect(preskocene).toBe(1);
    // POHODA má credit = MD a debit = DAL (accountancy.xsd) — pomenovanie je
    // oproti angličtine prehodené a zámena by otočila celé zaúčtovanie.
    expect(riadky[0]).toMatchObject({
      externalnyId: '1001', agenda: 'Prijaté faktúry', dokladCislo: '26FP001',
      ucetMd: '501400', ucetDal: '321100', suma: 100, partnerNazov: 'Print-Office s.r.o.',
      partnerIco: '12345678', datum: '2026-05-31',
    });
    // Jeden doklad, tri proviozky, dva rôzne nákladové účty — presne to, čo
    // hlavičkový korpus stratí a kvôli čomu sa denník ťahá.
    expect(new Set(riadky.map((r) => r.dokladCislo))).toEqual(new Set(['26FP001']));
    expect(new Set(riadky.filter((r) => !r.ucetMd.startsWith('343')).map((r) => r.ucetMd)))
      .toEqual(new Set(['501400', '513100']));
  });

  it('odmietne súbor, ktorý nie je odpoveďou z POHODY', () => {
    expect(() => parseDennik('<html><body>nie je to XML z POHODY</body></html>')).toThrow(/responsePack/);
  });

  it('ku každej proviozke doplní kandidátov na predkontáciu a nevynúti jedného', async () => {
    const database = await createTestDatabase();
    databases.push(database);
    const seeded = await seedTestUser(database);
    // Dve predkontácie s ROVNAKOU dvojicou účtov — na reálnych dátach je takých
    // proviozok 25 %, preto sa kandidáti držia ako zoznam, nie ako jeden kód.
    for (const [code, md, dal] of [
      ['501400/321100', '501400', '321100'], ['Tonery 501400', '501400', '321100'],
      ['513100/321100', '513100', '321100'],
    ] as const) {
      await database.query(
        `INSERT INTO code_list_items (id,tenant_id,organization_id,kind,code,name,source,ucet_md,ucet_dal)
         VALUES ($1,$2,$3,'predkontacie',$4,$4,'pohoda',$5,$6)`,
        [randomUUID(), seeded.tenantId, seeded.organizationId, code, md, dal],
      );
    }
    const { riadky } = parseDennik(ODPOVED);
    const vysledok = await ulozDennik(database, {
      tenantId: seeded.tenantId, organizationId: seeded.organizationId, riadky,
    });
    expect(vysledok).toEqual({ ulozenych: 3, sJednouPredkontaciou: 1, sViacerymi: 1, bezPredkontacie: 1 });

    const ulozene = await database.query<{ ucet_md: string; predkontacia_kody: string[] } & Record<string, unknown>>(
      'SELECT ucet_md, predkontacia_kody FROM ucto_dennik WHERE organization_id=$1 ORDER BY ucet_md',
      [seeded.organizationId],
    );
    expect(ulozene.rows.map((r) => [r.ucet_md, r.predkontacia_kody.length])).toEqual([
      ['343100', 0], // DPH: žiadna predkontácia s touto dvojicou — legitímny stav
      ['501400', 2], // dvaja kandidáti, rozhodne sa neskôr podľa textu
      ['513100', 1],
    ]);

    // Opakovaný import nesmie zdvojiť: identitou je act:id z POHODY.
    await ulozDennik(database, { tenantId: seeded.tenantId, organizationId: seeded.organizationId, riadky });
    const poDruhom = await database.query('SELECT count(*) AS n FROM ucto_dennik WHERE organization_id=$1', [seeded.organizationId]);
    expect(Number((poDruhom.rows[0] as { n: string }).n)).toBe(3);
  }, 60_000);
});

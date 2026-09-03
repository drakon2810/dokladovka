import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import type { Database } from '../db/database.js';
import { createTestDatabase, seedTestUser } from '../testHelpers.js';
import { doplnZKartyPartnera, importujAdresar } from './partnerService.js';

async function pripravDb(): Promise<{ database: Database; scope: { tenantId: string; organizationId: string } }> {
  const database = await createTestDatabase();
  const seeded = await seedTestUser(database);
  return { database, scope: { tenantId: seeded.tenantId, organizationId: seeded.organizationId } };
}

// Presne prípad z ostrej prevádzky: talianska faktúra B.R. Pneumatici tlačí
// v označenom poli „Partita IVA" číslo ODBERATEĽA (SK…), a dodávateľovo
// IT01800220244 má v drobnej hlavičke. Model nechal prázdno — správne, lebo
// priradiť cudzie číslo dodávateľovi je horšie. Odpoveď je v adresári POHODY.
const BRP = {
  nazov: 'B.R. Pneumatici S.p.A.',
  icDph: 'IT01800220244',
  ulica: 'Via Gombe 5',
  mesto: 'Thiene',
  psc: '360 16',
  krajina: 'IT',
};

describe('adresár POHODY do kariet partnerov', { timeout: 60_000 }, () => {
  it('založí kartu a poskladá adresu', async () => {
    const { database, scope } = await pripravDb();
    expect(await importujAdresar(database, scope, [BRP])).toMatchObject({ vytvorene: 1, aktualizovane: 0 });
    const partner = await database.query<{ name: string; ic_dph: string; address: string }>(
      'SELECT name, ic_dph, address FROM partners',
    );
    expect(partner.rows[0]).toMatchObject({
      name: 'B.R. Pneumatici S.p.A.',
      ic_dph: 'IT01800220244',
      address: 'Via Gombe 5, 360 16 Thiene, IT',
    });
  });

  it('druhý prenos kartu aktualizuje, nezaloží druhú', async () => {
    const { database, scope } = await pripravDb();
    await importujAdresar(database, scope, [BRP]);
    expect(await importujAdresar(database, scope, [BRP])).toMatchObject({ vytvorene: 0, aktualizovane: 1 });
    expect((await database.query('SELECT 1 FROM partners')).rowCount).toBe(1);
  });

  it('doplní kartu, ktorá vznikla z extrakcie naprázdno', async () => {
    const { database, scope } = await pripravDb();
    // Karta z faktúry, kde sa identifikátory nepodarilo prečítať.
    await importujAdresar(database, scope, [{ nazov: 'B.R. Pneumatici S.p.A.' }]);
    await importujAdresar(database, scope, [BRP]);
    const partner = await database.query<{ ic_dph: string | null }>('SELECT ic_dph FROM partners');
    expect(partner.rows[0].ic_dph).toBe('IT01800220244');
  });

  it('jedna medzera navyše nesmie založiť druhú kartu', async () => {
    const { database, scope } = await pripravDb();
    // POHODA má „B.R.Pneumatici S.p.A.", faktúra „B.R. Pneumatici S.p.A." —
    // rozdiel je jediná medzera za bodkou. Prísne porovnanie vyrobilo dve
    // karty: prázdnu z extrakcie a plnú z adresára.
    await importujAdresar(database, scope, [{ nazov: 'B.R. Pneumatici S.p.A.' }]);
    expect(await importujAdresar(database, scope, [{ ...BRP, nazov: 'B.R.Pneumatici S.p.A.' }]))
      .toMatchObject({ vytvorene: 0, aktualizovane: 1 });
    expect((await database.query('SELECT 1 FROM partners')).rowCount).toBe(1);
  });

  it('pri dvoch kartách vyhrá vyplnenejšia', async () => {
    const { database, scope } = await pripravDb();
    await importujAdresar(database, scope, [BRP]);
    // Prázdny duplikát, ktorý sa do databázy dostal skôr, než sa párovanie
    // opravilo — nesmie prebiť kartu s údajmi.
    await database.query(
      `INSERT INTO partners (id,tenant_id,organization_id,name,name_normalized,source)
       VALUES ($1,$2,$3,'B.R. Pneumatici S.p.A.','b.r. pneumatici s.p.a.','auto')`,
      [randomUUID(), scope.tenantId, scope.organizationId],
    );
    expect(await doplnZKartyPartnera(database, scope, { nazov: 'B.R. Pneumatici S.p.A.' }))
      .toMatchObject({ icDph: 'IT01800220244' });
  });

  it('záznam bez názvu preskočí — nemá sa ako spárovať', async () => {
    const { database, scope } = await pripravDb();
    expect(await importujAdresar(database, scope, [{ nazov: '  ' }])).toMatchObject({ preskocene: 1, vytvorene: 0 });
  });
});

describe('doplnenie dodávateľa z karty', { timeout: 60_000 }, () => {
  it('prázdne IČ DPH a adresa sa vezmú z adresára', async () => {
    const { database, scope } = await pripravDb();
    await importujAdresar(database, scope, [BRP]);
    expect(await doplnZKartyPartnera(database, scope, { nazov: 'B.R. Pneumatici S.p.A.' }))
      .toEqual({ icDph: 'IT01800220244', adresa: 'Via Gombe 5, 360 16 Thiene, IT' });
  });

  it('čo je na doklade, má prednosť — firma sa mohla presťahovať', async () => {
    const { database, scope } = await pripravDb();
    await importujAdresar(database, scope, [BRP]);
    const doplnene = await doplnZKartyPartnera(database, scope, {
      nazov: 'B.R. Pneumatici S.p.A.', icDph: 'IT99999999999',
    });
    expect(doplnene?.icDph).toBeUndefined();
    expect(doplnene?.adresa).toBe('Via Gombe 5, 360 16 Thiene, IT');
  });

  it('neznámy dodávateľ nedoplní nič', async () => {
    const { database, scope } = await pripravDb();
    expect(await doplnZKartyPartnera(database, scope, { nazov: 'Nikdy nevidená s.r.o.' })).toBeUndefined();
  });

  it('bez názvu sa nehľadá vôbec', async () => {
    const { database, scope } = await pripravDb();
    await importujAdresar(database, scope, [BRP]);
    expect(await doplnZKartyPartnera(database, scope, { icDph: 'IT01800220244' })).toBeUndefined();
  });
});

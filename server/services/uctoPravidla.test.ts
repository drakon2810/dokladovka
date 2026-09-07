import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import { createTestDatabase, seedTestUser } from '../testHelpers.js';
import { najdiPravidlo, prepocitajPravidla } from './uctoPravidlaService.js';
import { doplnRozpisKategorii } from './uctoKategoriaRozpis.js';

// Pravidlo je zhrnutie toho, čo v korpuse naozaj stojí — počíta sa bez modelu.
// Prípady sú z ALPINY: leasing sa delí na istinu a úrok, PHM na daňovú
// a nedaňovú časť v pomere 80/20, a bežný dodávateľ sa nedelí vôbec.

const databases: Awaited<ReturnType<typeof createTestDatabase>>[] = [];
afterEach(async () => Promise.all(databases.splice(0).map((database) => database.close())));

describe('pravidlá odvodené z histórie', () => {
  it('nájde ustálenú hlavičku aj tvar položiek', async () => {
    const database = await createTestDatabase();
    databases.push(database);
    const seeded = await seedTestUser(database);
    const kde = [seeded.tenantId, seeded.organizationId];

    const riadok = async (
      agenda: string, dodavatel: string, cislo: string, index: number,
      text: string, suma: number | null, predkontacia: string | null, dph: string | null,
    ) => database.query(
      `INSERT INTO ucto_historia
        (id,tenant_id,organization_id,agenda,doklad_cislo,datum,supplier_name_normalized,
         line_text_normalized,suma,predkontacia_kod,clenenie_dph_kod,riadok_index,source,riadok_hash)
       VALUES ($1,$2,$3,$4,$5,'2026-05-10',$6,$7,$8,$9,$10,$11,'mdb',$12)`,
      [randomUUID(), ...kde, agenda, cislo, dodavatel, text, suma, predkontacia, dph, index, randomUUID()],
    );

    // Leasing: hlavička istina, položky istina + úrok. Sumy sa menia, takže
    // podiel ustálený NIE JE a do pravidla nepatrí.
    for (const [cislo, istina, urok] of [['L1', 800, 200], ['L2', 900, 120], ['L3', 700, 300]] as const) {
      await riadok('OZ', 'čsob leasing', cislo, 0, 'splátka', null, 'leas.istina', 'PD');
      await riadok('OZ', 'čsob leasing', cislo, 1, 'istina', istina, 'leas.istina', 'PD');
      await riadok('OZ', 'čsob leasing', cislo, 2, 'úrok', urok, 'Úroky-leas', 'PD');
    }
    // PHM: pomer 80/20 je v každom doklade rovnaký, takže sa zapíše.
    for (const [cislo, celok] of [['F1', 100], ['F2', 200], ['F3', 50]] as const) {
      await riadok('FP', 'up déjeuner', cislo, 0, 'phm', null, 'PHM-501200', 'PD');
      await riadok('FP', 'up déjeuner', cislo, 1, 'daňová časť', celok * 0.8, 'PHM-501200', 'PD');
      await riadok('FP', 'up déjeuner', cislo, 2, 'nedaňová časť', celok * 0.2, 'PHM-Nadspotreba', 'PN');
    }
    // Bežný dodávateľ: jedna položka, žiadny rozpis.
    for (const cislo of ['T1', 'T2', 'T3', 'T4']) {
      await riadok('FP', 'telekom', cislo, 0, 'telefón', null, '518/321', 'PD');
      await riadok('FP', 'telekom', cislo, 1, 'telefón', 50, '518/321', 'PD');
    }
    // Dvojdokladová protistrana je náhoda, nie prax — pravidlo nevznikne.
    for (const cislo of ['X1', 'X2']) {
      await riadok('FP', 'jednorazovka', cislo, 0, 'čosi', null, '518/321', 'PD');
    }

    const vysledok = await prepocitajPravidla(database, {
      tenantId: seeded.tenantId, organizationId: seeded.organizationId,
    });
    expect(vysledok).toEqual({ pravidiel: 3, sRozpisom: 2 });

    const leasing = await najdiPravidlo(database, {
      tenantId: seeded.tenantId, organizationId: seeded.organizationId,
    }, ['OZ'], { nazov: 'ČSOB Leasing' });
    expect(leasing).toMatchObject({
      dokladov: 3, zhoda: 3, predkontaciaKod: 'leas.istina', clenenieDphKod: 'PD',
    });
    expect(leasing?.rozpis.map((r) => [r.text, r.predkontaciaKod, r.podiel])).toEqual([
      ['istina', 'leas.istina', undefined],
      ['úrok', 'Úroky-leas', undefined],
    ]);

    // PHM: pomer je v každom doklade rovnaký, takže sa do pravidla zapíše.
    const phm = await najdiPravidlo(database, {
      tenantId: seeded.tenantId, organizationId: seeded.organizationId,
    }, ['FP'], { nazov: 'Up Déjeuner' });
    expect(phm?.rozpis.map((r) => [r.predkontaciaKod, r.clenenieDphKod, r.podiel])).toEqual([
      ['PHM-501200', 'PD', 0.8],
      ['PHM-Nadspotreba', 'PN', 0.2],
    ]);

    // Dodávateľ, ktorý sa nedelí, rozpis nedostane — inak by pravidlo tvrdilo
    // rozdelenie tam, kde žiadne nie je.
    const telekom = await najdiPravidlo(database, {
      tenantId: seeded.tenantId, organizationId: seeded.organizationId,
    }, ['FP'], { nazov: 'Telekom' });
    expect(telekom?.rozpis).toEqual([]);

    // Dva doklady na prax nestačia.
    expect(await najdiPravidlo(database, {
      tenantId: seeded.tenantId, organizationId: seeded.organizationId,
    }, ['FP'], { nazov: 'Jednorazovka' })).toBeUndefined();
  }, 90_000);

  it('prepočet nahrádza celú sadu, nepridáva k nej', async () => {
    const database = await createTestDatabase();
    databases.push(database);
    const seeded = await seedTestUser(database);
    for (const cislo of ['A1', 'A2', 'A3']) {
      await database.query(
        `INSERT INTO ucto_historia
          (id,tenant_id,organization_id,agenda,doklad_cislo,datum,supplier_name_normalized,
           line_text_normalized,predkontacia_kod,riadok_index,source,riadok_hash)
         VALUES ($1,$2,$3,'FP',$4,'2026-05-10','dodavatel','sluzba','518/321',0,'mdb',$5)`,
        [randomUUID(), seeded.tenantId, seeded.organizationId, cislo, randomUUID()],
      );
    }
    const kde = { tenantId: seeded.tenantId, organizationId: seeded.organizationId };
    await prepocitajPravidla(database, kde);
    await prepocitajPravidla(database, kde);
    const pocet = await database.query('SELECT count(*) AS n FROM ucto_pravidla WHERE organization_id=$1',
      [seeded.organizationId]);
    expect(Number((pocet.rows[0] as { n: string }).n)).toBe(1);
  }, 60_000);
});

// Rozpis kategórie. Pravidlo protistrany platí len pre dodávateľa, ktorého
// firma už mala; kategória hovorí o DRUHU plnenia, takže platí aj pre celkom
// nového. Kategória „Leasing - splátka (istina a úrok)" mala doteraz v názve
// dve veci a v poli jednu.
describe('rozpis kategórie plnenia', () => {
  it('odvodí tvar z dokladov, ktoré do kategórie spadli', async () => {
    const database = await createTestDatabase();
    databases.push(database);
    const seeded = await seedTestUser(database);
    const kde = [seeded.tenantId, seeded.organizationId];

    await database.query(
      `INSERT INTO ucto_kategorie (id,tenant_id,organization_id,nazov,popis,slovnik,pocet)
       VALUES ($1,$2,$3,'Leasing','Splátky leasingu','["leasing","splátka"]'::jsonb,10)`,
      [randomUUID(), ...kde],
    );
    // Kategória, do ktorej nespadne nič — rozpis dostať nesmie.
    await database.query(
      `INSERT INTO ucto_kategorie (id,tenant_id,organization_id,nazov,popis,slovnik,pocet)
       VALUES ($1,$2,$3,'Kancelária','Kancelárske potreby','["toner","papier"]'::jsonb,4)`,
      [randomUUID(), ...kde],
    );

    const riadok = async (cislo: string, index: number, text: string, predkontacia: string) =>
      database.query(
        `INSERT INTO ucto_historia
          (id,tenant_id,organization_id,agenda,doklad_cislo,datum,supplier_name_normalized,
           line_text_normalized,suma,predkontacia_kod,riadok_index,source,riadok_hash)
         VALUES ($1,$2,$3,'OZ',$4,'2026-05-10','ktokoľvek',$5,100,$6,$7,'mdb',$8)`,
        [randomUUID(), ...kde, cislo, text, predkontacia, index, randomUUID()],
      );
    // Tri doklady rôznych dodávateľov — kategória ich spája podľa slovníka.
    for (const cislo of ['L1', 'L2', 'L3']) {
      await riadok(cislo, 0, 'leasing splátka vozidla', 'leas.istina');
      await riadok(cislo, 1, 'istina', 'leas.istina');
      await riadok(cislo, 2, 'úrok', 'Úroky-leas');
    }

    // Doklady účtované na JEDEN účet sú v korpuse kvôli textom položiek, ale
    // o delení nehovoria nič. Keby tvar učili aj ony, prevážili by — odvodRozpis
    // by videl prevažne rovnaké riadky a kategórii by neostalo nič.
    for (const cislo of ['J1', 'J2', 'J3', 'J4', 'J5']) {
      await riadok(cislo, 0, 'leasing splátka vozidla', 'leas.istina');
      await riadok(cislo, 1, 'splátka', 'leas.istina');
      await riadok(cislo, 2, 'splátka', 'leas.istina');
    }

    const vysledok = await doplnRozpisKategorii(database, {
      tenantId: seeded.tenantId, organizationId: seeded.organizationId,
    });
    expect(vysledok).toEqual({ kategoriiSRozpisom: 1 });

    const kategorie = await database.query<Record<string, any>>(
      'SELECT nazov, rozpis FROM ucto_kategorie WHERE organization_id=$1 ORDER BY nazov', [seeded.organizationId],
    );
    expect(kategorie.rows[0].nazov).toBe('Kancelária');
    expect(kategorie.rows[0].rozpis).toEqual([]);
    expect((kategorie.rows[1].rozpis as Array<Record<string, unknown>>).map((r) => r.predkontaciaKod))
      .toEqual(['leas.istina', 'Úroky-leas']);
  }, 90_000);
});

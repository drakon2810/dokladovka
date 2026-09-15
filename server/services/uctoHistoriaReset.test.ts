import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import { importUctoHistory } from './uctoHistoryService.js';
import { createTestDatabase, seedTestUser } from '../testHelpers.js';

const databases: Awaited<ReturnType<typeof createTestDatabase>>[] = [];
afterEach(async () => Promise.all(databases.splice(0).map((database) => database.close())));

describe('korpus histórie a rozdelené agendy', () => {
  // Agenda je prvou zložkou hashu riadku. Po rozdelení (dobropis FP → FP-D) sa
  // hash zmení, takže opakovaný prenos riadok NEPREPÍŠE — pridá druhý. Preto
  // prvá dávka úplného prenosu korpus zahadzuje; tento test drží dôvod.
  it('zmena agendy vyrobí NOVÝ riadok, nie aktualizáciu', async () => {
    const database = await createTestDatabase();
    databases.push(database);
    const seeded = await seedTestUser(database);
    const riadok = { lineText: 'oprava zakladu dane', predkontaciaKod: '518/321', dokladCislo: 'D1' };

    await importUctoHistory(database, { ...seeded, source: 'mdb', rows: [{ agenda: 'FP', ...riadok }] });
    await importUctoHistory(database, { ...seeded, source: 'mdb', rows: [{ agenda: 'FP-D', ...riadok }] });

    const agendy = (await database.query<{ agenda: string } & Record<string, unknown>>(
      'SELECT agenda FROM ucto_historia WHERE organization_id=$1 ORDER BY agenda', [seeded.organizationId],
    )).rows.map((row) => row.agenda);
    // Dva riadky, nie jeden — presne to, čo reset na prvej dávke rieši.
    expect(agendy).toEqual(['FP', 'FP-D']);
  }, 90_000);

  // S natívnym id POHODY je identita doklad a položka v jednej databáze — nie
  // agenda, číslo a poradie. Presun dobropisu medzi agendami ani prehodené
  // položky tak nevyrobia druhý riadok; to isté id v inej databáze (inom roku)
  // je iný doklad.
  it('natívne id drží riadok pri presune agendy aj prehodení položiek', async () => {
    const database = await createTestDatabase();
    databases.push(database);
    const seeded = await seedTestUser(database);
    const doklad = { predkontaciaKod: '518/321', dokladCislo: 'D1', datum: '2026-01-15', dokladId: 100 };
    const nahraj = (zdrojDatabaza: string, rows: Parameters<typeof importUctoHistory>[1]['rows']) =>
      importUctoHistory(database, { ...seeded, source: 'mdb', zdrojDatabaza, rows });

    await nahraj('StwPh_12345678_2026', [
      { agenda: 'FP', ...doklad, lineText: 'oprava', riadokIndex: 0 },
      { agenda: 'FP', ...doklad, lineText: 'a', riadokIndex: 1, polozkaId: 501 },
      { agenda: 'FP', ...doklad, lineText: 'b', riadokIndex: 2, polozkaId: 502 },
    ]);
    await nahraj('StwPh_12345678_2026', [
      { agenda: 'FP-D', ...doklad, lineText: 'oprava', riadokIndex: 0 },
      { agenda: 'FP-D', ...doklad, lineText: 'b', riadokIndex: 1, polozkaId: 502 },
      { agenda: 'FP-D', ...doklad, lineText: 'a', riadokIndex: 2, polozkaId: 501 },
    ]);
    const riadky = async () => (await database.query<Record<string, unknown>>(
      `SELECT agenda, line_text_normalized AS text, riadok_index, zdroj_databaza, pohoda_doklad_id, pohoda_polozka_id
         FROM ucto_historia WHERE organization_id=$1 ORDER BY zdroj_databaza, riadok_index`,
      [seeded.organizationId],
    )).rows;
    expect((await riadky()).map((row) => [row.agenda, row.text, row.riadok_index, row.pohoda_polozka_id === null ? null : Number(row.pohoda_polozka_id)]))
      .toEqual([['FP-D', 'oprava', 0, null], ['FP-D', 'b', 1, 502], ['FP-D', 'a', 2, 501]]);

    await nahraj('StwPh_12345678_2027', [{ agenda: 'FP', ...doklad, lineText: 'iny rok', riadokIndex: 0 }]);
    expect(await riadky()).toHaveLength(4);
  }, 90_000);

  // F12: prírastkový import (ručné XML, starší Mostík) s tým istým odtlačkom
  // prepisoval sumy a kódy, ale opravený text, partnera a stredisko nechal
  // starými. Ručné XML sadzbu DPH nenesie — prepis ju nesmie zmazať.
  it('opakovaný import prepíše opravený text, partnera aj stredisko a sadzbu nezmaže', async () => {
    const database = await createTestDatabase();
    databases.push(database);
    const seeded = await seedTestUser(database);
    const stredisko = randomUUID();
    await database.query(
      `INSERT INTO code_list_items (id,tenant_id,organization_id,kind,code,name,source)
       VALUES ($1,$2,$3,'strediska','BA','Bratislava','pohoda')`,
      [stredisko, seeded.tenantId, seeded.organizationId],
    );
    const zaklad = { agenda: 'FP' as const, dokladCislo: 'DF1', datum: '2026-07-01', riadokIndex: 1, predkontaciaKod: '518/321', clenenieDphKod: 'PD' };
    const nahraj = (riadok: Record<string, unknown>) =>
      importUctoHistory(database, { ...seeded, source: 'mdb', rows: [{ ...zaklad, lineText: 'Tonery', ...riadok }] });
    const ulozeny = async () => (await database.query<Record<string, any>>(
      `SELECT line_text_normalized, supplier_ico, supplier_name_normalized, stredisko_kod, stredisko_id, sadzba_dph, suma_dph
         FROM ucto_historia WHERE organization_id=$1`,
      [seeded.organizationId],
    )).rows;

    await nahraj({ supplierIco: '11111111', supplierName: 'Stara s.r.o.', strediskoKod: 'BA', sadzbaDph: 23, sumaDph: 2.3 });
    await nahraj({ lineText: 'Tonery HP', supplierIco: '22222222', supplierName: 'Nova s.r.o.' });
    const [opraveny, ...zvysok] = await ulozeny();
    expect(zvysok).toEqual([]);
    expect(opraveny).toMatchObject({
      line_text_normalized: 'tonery hp', supplier_ico: '22222222', supplier_name_normalized: 'nova s.r.o.',
      stredisko_kod: 'BA', stredisko_id: stredisko,
    });
    expect([Number(opraveny.sadzba_dph), Number(opraveny.suma_dph)]).toEqual([23, 2.3]);

    // Iné stredisko prepíše kód aj id ako dvojicu — id Bratislavy s kódom KE by klamalo.
    await nahraj({ strediskoKod: 'KE' });
    expect((await ulozeny())[0]).toMatchObject({ stredisko_kod: 'KE', stredisko_id: null });
  }, 90_000);

  it('nové agendy prejdú validáciou', async () => {
    const database = await createTestDatabase();
    databases.push(database);
    const seeded = await seedTestUser(database);
    const agendy = ['FP-D', 'FP-T', 'FP-Z', 'FV-D', 'FV-T', 'FV-Z'] as const;
    const vysledok = await importUctoHistory(database, {
      ...seeded,
      source: 'mdb',
      rows: agendy.map((agenda, index) => ({
        agenda, lineText: `riadok ${index}`, predkontaciaKod: '518/321', dokladCislo: `X${index}`,
      })),
    });
    expect(vysledok.imported).toBe(agendy.length);
  }, 90_000);
});

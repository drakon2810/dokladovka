import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { aiOdpoved, createTestDatabase, seedTestUser, testConfig } from '../testHelpers.js';
import { zmerajPresnost } from './uctoPresnostService.js';

// Meranie stojí a padá na jednej veci: meraný doklad NESMIE vidieť sám seba.
// Korpus je zrkadlo toho, čo účtovník urobil, takže bez delenia časom by model
// dostal do promptu vlastnú odpoveď a výsledok by bol 100 % o ničom.

const databases: Awaited<ReturnType<typeof createTestDatabase>>[] = [];
afterEach(async () => Promise.all(databases.splice(0).map((database) => database.close())));

describe('meranie presnosti zaúčtovania', () => {
  it('drží históriu k deliacemu dátumu a spočíta zhodu po agendách', async () => {
    const database = await createTestDatabase();
    databases.push(database);
    const seeded = await seedTestUser(database);
    const kde = [seeded.tenantId, seeded.organizationId];

    const spravna = randomUUID();
    const ina = randomUUID();
    for (const [id, kod] of [[spravna, '518/321'], [ina, '501/321']] as const) {
      await database.query(
        `INSERT INTO code_list_items (id,tenant_id,organization_id,kind,code,name,source,ucet_md,ucet_dal)
         VALUES ($1,$2,$3,'predkontacie',$4,$4,'pohoda','518100','321100')`,
        [id, ...kde, kod],
      );
    }

    const doKorpusu = async (
      cislo: string, datum: string, predkontacia: string, riadokIndex: number, text: string,
    ) => database.query(
      `INSERT INTO ucto_historia
        (id,tenant_id,organization_id,agenda,doklad_cislo,datum,supplier_name_normalized,
         line_text_normalized,predkontacia_id,riadok_index,suma,source,riadok_hash)
       VALUES ($1,$2,$3,'FP',$4,$5::date,'preprava s.r.o.',$6,$7,$8,100,'mdb',$9)`,
      [randomUUID(), ...kde, cislo, datum, text, predkontacia, riadokIndex, randomUUID()],
    );

    // Minulosť: firma tomuto dodávateľovi dávala 518/321.
    for (const [index, cislo] of ['26FP001', '26FP002', '26FP003'].entries()) {
      await doKorpusu(cislo, `2026-0${index + 1}-15`, spravna, 0, 'preprava tovaru');
    }
    // Meraný doklad. Účtovník mu dal INÚ predkontáciu než tým predtým — práve
    // tá odlišnosť robí z merania test: ak sa v prompte objaví, doklad si
    // odpoveď odpísal sám od seba.
    await doKorpusu('26FP090', '2026-08-20', ina, 0, 'preprava tovaru');

    // Model odpovie tým, čo má v ponuke; test nekontroluje jeho úsudok, ale to,
    // že meranie beží, porovná a nezapočíta doklad sám sebe.
    const parser = {
      create: vi.fn().mockResolvedValue(aiOdpoved({
        predkontaciaId: spravna, clenenieDphId: null, clenenieKvKod: null,
        ciselnyRadId: null, confidence: 0.8, reason: 'Preprava',
      })),
    };
    const vysledok = await zmerajPresnost(
      database, testConfig(), { tenantId: seeded.tenantId, organizationId: seeded.organizationId },
      { deliciDatum: '2026-08-01', vzorka: 10 }, parser as never,
    );

    expect(vysledok.vzorka).toBe(1);
    // Model odpovedal podľa histórie (518/321), účtovník dal 501/321 — nezhoda.
    // Presne to má meranie ukazovať namiesto pochvaly samému sebe.
    expect(vysledok.vysledok.FP).toMatchObject({ dokladov: 1, predkontacia: 0 });
    expect(vysledok.rozdiely).toHaveLength(1);
    expect(vysledok.rozdiely[0]).toMatchObject({ doklad: '26FP090' });

    // Jadro veci: zaúčtovanie meraného dokladu sa do promptu nesmie dostať.
    const prompt = JSON.parse((parser.create.mock.calls[0][0] as any).input[0].content[0].text);
    const vPrompte = (prompt.dennik ?? []).map((riadok: any) => riadok.predkontaciaId);
    expect(vPrompte).not.toContain(ina);
    expect(vPrompte).toContain(spravna);
    // A história spred deliaceho dátumu tam naopak byť má — inak by sa model
    // nemal z čoho rozhodovať a meranie by trestalo prázdny vstup.
    expect(prompt.dennik.length).toBeGreaterThan(0);

    // Náhradný doklad po sebe neostáva.
    const zvysky = await database.query(
      `SELECT 1 FROM documents WHERE organization_id=$1 AND source->>'meranie'='true'`,
      [seeded.organizationId],
    );
    expect(zvysky.rowCount).toBe(0);

    const behy = await database.query('SELECT vzorka FROM ucto_presnost WHERE organization_id=$1', [seeded.organizationId]);
    expect(behy.rowCount).toBe(1);
  }, 90_000);

  it('bez dokladov za meraným obdobím to povie, nie spadne', async () => {
    const database = await createTestDatabase();
    databases.push(database);
    const seeded = await seedTestUser(database);
    await database.query(
      `INSERT INTO ucto_historia
        (id,tenant_id,organization_id,agenda,doklad_cislo,datum,line_text_normalized,
         predkontacia_kod,riadok_index,source,riadok_hash)
       VALUES ($1,$2,$3,'FP','26FP001','2026-01-10','preprava','518/321',0,'mdb',$4)`,
      [randomUUID(), seeded.tenantId, seeded.organizationId, randomUUID()],
    );
    await expect(zmerajPresnost(
      database, testConfig(), { tenantId: seeded.tenantId, organizationId: seeded.organizationId },
      { deliciDatum: '2026-06-01' }, { create: vi.fn() } as never,
    )).rejects.toThrow(/doklady/);
  }, 60_000);
});

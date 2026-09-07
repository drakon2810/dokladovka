import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { aiOdpoved, createTestDatabase, seedTestUser, testConfig } from '../testHelpers.js';
import { zmerajPresnost } from './uctoPresnostService.js';
import { prepocitajPravidla } from './uctoPravidlaService.js';

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

  // Na vydanej faktúre je protistranou ODBERATEĽ a návrh ho číta z iného poľa
  // než dodávateľa. Meranie ho neposielalo, takže každá vydaná faktúra išla do
  // modelu bez protistrany — bez pravidla, bez jej denníka, bez rozúčtovania.
  // Model odpovedal najčastejším vzorom firmy a meranie mu to rátalo ako chybu:
  // AGS malo takto DPH 3 z 8, hoci v ostrej prevádzke odberateľ nechýba.
  it('vydaná faktúra nesie odberateľa, inak sa meria naslepo', async () => {
    const database = await createTestDatabase();
    databases.push(database);
    const seeded = await seedTestUser(database);
    const kde = [seeded.tenantId, seeded.organizationId];
    const predkontacia = randomUUID();
    await database.query(
      `INSERT INTO code_list_items (id,tenant_id,organization_id,kind,code,name,source,ucet_md,ucet_dal)
       VALUES ($1,$2,$3,'predkontacie','602200','602200 sklad.-tuz.','pohoda','311100','602200')`,
      [predkontacia, ...kde],
    );
    const doKorpusu = async (cislo: string, datum: string, index: number) => database.query(
      `INSERT INTO ucto_historia
        (id,tenant_id,organization_id,agenda,doklad_cislo,datum,supplier_name_normalized,
         line_text_normalized,predkontacia_id,predkontacia_kod,clenenie_dph_kod,clenenie_kv_kod,
         riadok_index,suma,source,riadok_hash)
       VALUES ($1,$2,$3,'FV',$4,$5::date,'milena pribis','skladovanie',$6,'602200','UD','D2',$7,100,'mdb',$8)`,
      [randomUUID(), ...kde, cislo, datum, predkontacia, index, randomUUID()],
    );
    for (const [index, cislo] of ['26FV001', '26FV002', '26FV003'].entries()) {
      await doKorpusu(cislo, `2026-0${index + 1}-15`, 0);
    }
    await doKorpusu('26FV090', '2026-08-20', 0);
    await prepocitajPravidla(database, { tenantId: seeded.tenantId, organizationId: seeded.organizationId });

    const parser = {
      create: vi.fn().mockResolvedValue(aiOdpoved({
        predkontaciaId: predkontacia, clenenieDphId: null, clenenieKvKod: null,
        ciselnyRadId: null, confidence: 0.8, reason: 'Skladovanie',
      })),
    };
    await zmerajPresnost(
      database, testConfig(), { tenantId: seeded.tenantId, organizationId: seeded.organizationId },
      { deliciDatum: '2026-08-01', vzorka: 10 }, parser as never,
    );

    const prompt = JSON.parse((parser.create.mock.calls[0][0] as any).input[0].content[0].text);
    expect(prompt.dokument.odberatel).toMatchObject({ nazov: 'milena pribis' });
    // A dôsledok, kvôli ktorému to celé je: pravidlo tej protistrany sa modelu
    // naozaj dostane. Bez odberateľa je tento blok prázdny.
    expect(prompt.pravidlo).toMatchObject({ dokladov: 3, zhoda: 3, predkontaciaKod: '602200' });
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

// Prvé ostré meranie ALPINY malo vzorku bez jedinej prijatej faktúry: pár
// leasingových splátok a rezerv je zaúčtovaných dopredu (31. 12.), takže
// „max mínus tri mesiace" dalo delítko 30. 9. a za ním ostalo 42 dokladov,
// všetko OZ a INT. Percentil sa o takéto výbežky neopiera.
describe('deliaci dátum', () => {
  it('nenechá sa strhnúť dokladmi zaúčtovanými dopredu', async () => {
    const database = await createTestDatabase();
    databases.push(database);
    const seeded = await seedTestUser(database);
    const predkontacia = randomUUID();
    await database.query(
      `INSERT INTO code_list_items (id,tenant_id,organization_id,kind,code,name,source)
       VALUES ($1,$2,$3,'predkontacie','518/321','518/321','pohoda')`,
      [predkontacia, seeded.tenantId, seeded.organizationId],
    );
    const doklad = async (cislo: string, datum: string, agenda: string) => database.query(
      `INSERT INTO ucto_historia
        (id,tenant_id,organization_id,agenda,doklad_cislo,datum,supplier_name_normalized,
         line_text_normalized,predkontacia_id,riadok_index,source,riadok_hash)
       VALUES ($1,$2,$3,$4,$5,$6::date,'dodavatel','sluzba',$7,0,'mdb',$8)`,
      [randomUUID(), seeded.tenantId, seeded.organizationId, agenda, cislo, datum, predkontacia, randomUUID()],
    );
    // 20 bežných faktúr od januára do augusta.
    for (let index = 1; index <= 20; index += 1) {
      await doklad(`26FP${index}`, `2026-0${Math.ceil(index / 3)}-10`, 'FP');
    }
    // A dve leasingové splátky zaúčtované na koniec roka.
    await doklad('26OZ001', '2026-12-31', 'OZ');
    await doklad('26OZ002', '2026-12-30', 'OZ');

    const parser = {
      create: vi.fn().mockResolvedValue(aiOdpoved({
        predkontaciaId: predkontacia, clenenieDphId: null, clenenieKvKod: null,
        ciselnyRadId: null, confidence: 0.8, reason: 'Služba',
      })),
    };
    const vysledok = await zmerajPresnost(
      database, testConfig(), { tenantId: seeded.tenantId, organizationId: seeded.organizationId },
      { vzorka: 10 }, parser as never,
    );
    // „max − 3 mesiace" by dalo 30. 9. a vzorku z dvoch decembrových OZ.
    // Percentil necháva merateľné aj faktúry.
    expect(vysledok.deliciDatum < '2026-09-01').toBe(true);
    expect(Object.keys(vysledok.vysledok)).toContain('FP');
  }, 90_000);
});

// Druhé ostré meranie ALPINY malo rozpísaných dokladov nula, hoci za deliacim
// dátumom ich je 166 v OZ a 169 v INT. Príčina: staršie importy niesli len
// hlavičku a riadok_index majú prázdny, takže pri predvolenom NULLS LAST prišla
// taká hlavička AŽ ZA položkami toho istého dokladu — a prepísala ich.
describe('skladanie dokladu z korpusu', () => {
  it('stará hlavička bez indexu neprepíše položky', async () => {
    const database = await createTestDatabase();
    databases.push(database);
    const seeded = await seedTestUser(database);
    const kde = [seeded.tenantId, seeded.organizationId];

    const hlavna = randomUUID();
    const iny = randomUUID();
    for (const [id, code] of [[hlavna, '518/321'], [iny, '501/321']] as const) {
      await database.query(
        `INSERT INTO code_list_items (id,tenant_id,organization_id,kind,code,name,source)
         VALUES ($1,$2,$3,'predkontacie',$4,$4,'pohoda')`,
        [id, ...kde, code],
      );
    }
    const riadok = async (index: number | null, text: string, predkontacia: string) => database.query(
      `INSERT INTO ucto_historia
        (id,tenant_id,organization_id,agenda,doklad_cislo,datum,supplier_name_normalized,
         line_text_normalized,predkontacia_id,riadok_index,suma,source,riadok_hash)
       VALUES ($1,$2,$3,'FP','26FP500','2026-08-10','dodavatel',$4,$5,$6,50,'mdb',$7)`,
      [randomUUID(), ...kde, text, predkontacia, index, randomUUID()],
    );
    await riadok(0, 'nová hlavička', hlavna);
    await riadok(1, 'tovar', hlavna);
    await riadok(2, 'rozúčtovaná časť', iny);
    // Stará hlavička z .mdb importu — bez indexu.
    await riadok(null, 'stará hlavička', hlavna);

    const parser = {
      create: vi.fn().mockResolvedValue(aiOdpoved({
        predkontaciaId: hlavna, clenenieDphId: null, clenenieKvKod: null,
        ciselnyRadId: null, confidence: 0.8, reason: 'Tovar',
      })),
    };
    const vysledok = await zmerajPresnost(
      database, testConfig(), { tenantId: seeded.tenantId, organizationId: seeded.organizationId },
      { deliciDatum: '2026-08-01', vzorka: 5 }, parser as never,
    );

    // Doklad je rozpísaný a obe položky sa k modelu dostali.
    expect(vysledok.vysledok.FP).toMatchObject({ dokladov: 1, rozpisanych: 1 });
    const prompt = JSON.parse((parser.create.mock.calls[0][0] as any).input[0].content[0].text);
    expect(prompt.dokument.polozky.map((polozka: any) => polozka.popis))
      .toEqual(['tovar', 'rozúčtovaná časť']);
  }, 90_000);
});

import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import type { Database } from '../db/database.js';
import { createTestDatabase, seedTestUser } from '../testHelpers.js';
import { profilPreKlasifikaciu, zapisOpravuTypu } from './firemnyProfilService.js';

interface Prostredie {
  database: Database;
  scope: { tenantId: string; organizationId: string };
  userId: string;
  kategoria(nazov: string, agendy: string[], slovnik: string[]): Promise<void>;
  /**
   * Doklad, na ktorý sa oprava odkazuje — bez neho neprejde cudzí kľúč.
   * Typ je FP: 'INY' tabuľka nepozná, lebo taký doklad vôbec nevzniká.
   */
  doklad(): Promise<string>;
}

async function pripravDb(): Promise<Prostredie> {
  const database = await createTestDatabase();
  const seeded = await seedTestUser(database);
  return {
    database,
    scope: { tenantId: seeded.tenantId, organizationId: seeded.organizationId },
    userId: seeded.userId,
    async kategoria(nazov, agendy, slovnik) {
      await database.query(
        `INSERT INTO ucto_kategorie (id,tenant_id,organization_id,nazov,slovnik,agendy)
         VALUES ($1,$2,$3,$4,$5::jsonb,$6::jsonb)`,
        [randomUUID(), seeded.tenantId, seeded.organizationId, nazov,
          JSON.stringify(slovnik), JSON.stringify(agendy)],
      );
    },
    async doklad() {
      const id = randomUUID();
      await database.query(
        `INSERT INTO documents (id,tenant_id,organization_id,document_type,status,processing_status,
                                extracted,accounting,total_amount,currency)
         VALUES ($1,$2,$3,'FP','na_kontrole','ready_for_review','{}'::jsonb,'{}'::jsonb,0,'EUR')`,
        [id, seeded.tenantId, seeded.organizationId],
      );
      return id;
    },
  };
}

describe('profil firmy pre klasifikáciu', { timeout: 60_000 }, () => {
  it('bez histórie nedá nič — nová firma nemá čo podsunúť', async () => {
    const p = await pripravDb();
    expect(await profilPreKlasifikaciu(p.database, p.scope)).toBeUndefined();
  });

  it('podá agendy, kategóriu aj typické frázy', async () => {
    const p = await pripravDb();
    // Skutočná kategória ALPINY. V jej slovníku leží „verb" — začiatok názvu
    // súboru talianskej pokuty, ktorú klasifikácia zahodila ako „iný doklad".
    await p.kategoria('pokuty a úroky z omeškania', ['FP', 'OZ', 'VPD', 'INT'],
      ['pokuta', 'verb', 'verb.', 'upomienka', 'úroky z omeškania']);

    const profil = await profilPreKlasifikaciu(p.database, p.scope);
    expect(profil).toContain('FP, OZ, VPD, INT | pokuty a úroky z omeškania');
    expect(profil).toContain('verb');
  });

  it('kategória bez agendy sa nepribalí — nepovie, kam doklad patrí', async () => {
    const p = await pripravDb();
    await p.kategoria('nezaradené', [], ['čokoľvek']);
    expect(await profilPreKlasifikaciu(p.database, p.scope)).toBeUndefined();
  });

  it('oprava účtovníka sa pripojí k tomu istému zoznamu', async () => {
    const p = await pripravDb();
    await p.kategoria('pokuty', ['OZ'], ['pokuta']);
    await zapisOpravuTypu(p.database, {
      ...p.scope, documentId: await p.doklad(), povodnyTyp: 'INY', novyTyp: 'OZ',
      userId: p.userId, dodavatel: 'REPUBLIQUE FRANCAISE', text: 'superamento dei limiti di velocità',
    });
    const profil = await profilPreKlasifikaciu(p.database, p.scope);
    // Jeden zoznam, nie dva mechanizmy: história z POHODY aj vlastné opravy.
    expect(profil).toContain('pokuty');
    expect(profil).toContain('OZ | opravil účtovník | republique francaise');
  });

  it('oprava sa zapíše aj bez kategórií — nová firma sa učí od prvej', async () => {
    const p = await pripravDb();
    await zapisOpravuTypu(p.database, {
      ...p.scope, documentId: await p.doklad(), povodnyTyp: 'INY', novyTyp: 'PD',
      dodavatel: 'Shell', text: 'nafta',
    });
    expect(await profilPreKlasifikaciu(p.database, p.scope)).toContain('PD | opravil účtovník | shell');
  });

  it('typ, ktorý sa nezmenil, nie je oprava', async () => {
    const p = await pripravDb();
    await zapisOpravuTypu(p.database, {
      ...p.scope, documentId: await p.doklad(), povodnyTyp: 'FP', novyTyp: 'FP', dodavatel: 'X',
    });
    expect((await p.database.query('SELECT 1 FROM typ_opravy')).rowCount).toBe(0);
  });

  it('novšia oprava toho istého dodávateľa prekryje staršiu', async () => {
    const p = await pripravDb();
    for (const [povodny, novy] of [['INY', 'FP'], ['FP', 'OZ']]) {
      await zapisOpravuTypu(p.database, {
        ...p.scope, documentId: await p.doklad(), povodnyTyp: povodny, novyTyp: novy, dodavatel: 'Tá istá s.r.o.',
      });
    }
    const profil = await profilPreKlasifikaciu(p.database, p.scope) ?? '';
    // Účtovník si to rozmyslel; profil má niesť posledné slovo, nie obe.
    expect(profil.split('\n').filter((riadok) => riadok.includes('tá istá s.r.o.'))).toHaveLength(1);
  });
});

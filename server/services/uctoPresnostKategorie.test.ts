import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createTestDatabase, seedTestUser, testConfig } from '../testHelpers.js';
import { zmerajPresnost } from './uctoPresnostService.js';

// Režim bez AI je zadarmo a opakovateľný — ani s kategóriami nesmie poslať
// text dokladu do OpenAI, hoci kontajner kľúč má.
const embeddingy = vi.hoisted(() => vi.fn());
vi.mock('openai', () => ({
  default: class {
    embeddings = { create: embeddingy };
  },
}));

const databases: Awaited<ReturnType<typeof createTestDatabase>>[] = [];
afterEach(async () => Promise.all(databases.splice(0).map((database) => database.close())));

describe('meranie bez AI s kategóriami', () => {
  it('neposiela embeddingy ani s kľúčom', async () => {
    const database = await createTestDatabase();
    databases.push(database);
    const seeded = await seedTestUser(database);
    const kde = { tenantId: seeded.tenantId, organizationId: seeded.organizationId };
    const config = testConfig({ openai: { ...testConfig().openai, apiKey: 'sk-test' } });
    const vloz = async (tabulka: string, hodnoty: Record<string, unknown>) => {
      const stlpce = { id: randomUUID(), tenant_id: kde.tenantId, organization_id: kde.organizationId, ...hodnoty };
      await database.query(
        `INSERT INTO ${tabulka} (${Object.keys(stlpce).join(',')}) VALUES (${Object.keys(stlpce).map((_, index) => `$${index + 1}`).join(',')})`,
        Object.values(stlpce),
      );
      return stlpce.id;
    };
    const predkontacia = await vloz('code_list_items', { kind: 'predkontacie', code: '518/321', name: '518/321', source: 'pohoda' });
    for (const [cislo, datum] of [['26FP001', '2026-01-15'], ['26FP090', '2026-08-20']]) {
      await vloz('ucto_historia', {
        agenda: 'FP', doklad_cislo: cislo, datum, riadok_index: 0, supplier_name_normalized: 'preprava s.r.o.',
        line_text_normalized: 'preprava tovaru', predkontacia_id: predkontacia, source: 'mdb', riadok_hash: randomUUID(),
      });
    }
    // Kategória bez zhody v slovníku, ale s vektorom — presne tá, pre ktorú by sa volal embedding.
    await vloz('ucto_kategorie', {
      nazov: 'Iné', slovnik: JSON.stringify(['nic spolocne']), predkontacia_id: predkontacia, agendy: JSON.stringify(['FP']),
      pocet: 5, vektor: JSON.stringify([0.1, 0.2]), vektor_model: config.openai.embeddingModel,
    });

    const vysledok = await zmerajPresnost(database, config, kde, { deliciDatum: '2026-08-01', kategorie: true });

    expect(vysledok.doklady.map((doklad) => doklad.chyba)).toEqual([undefined]);
    expect(embeddingy).not.toHaveBeenCalled();
    expect(vysledok.manifest).toMatchObject({ kategorie: 'horna_hranica', embeddingy: null });
  }, 90_000);
});

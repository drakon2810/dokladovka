import { loadConfig } from '../config.js';
import { createDatabase } from '../db/database.js';
import { prepocitajPrax } from '../services/uctoProfileService.js';

/**
 * Prepočet praxe všetkých firiem bez AI: pravidlá protistrán zo spoločných
 * podôb dokladov, kódy existujúcich kategórií a ich rozpis. Po nasadení
 * spoločných variantov sa tak firmy nemusia analyzovať znova (a platiť model).
 *
 * Produkcia (obraz má len skompilovaný JS):
 *   docker compose exec api node build/server/scripts/prepocitajPrax.js [--dry-run]
 *
 * --dry-run prepočíta každú firmu v transakcii, vypíše čísla a transakciu
 * vráti — nič sa nezapíše.
 */
const naSkusku = process.argv.includes('--dry-run');
class NaSkusku extends Error {}

const database = await createDatabase(loadConfig());
try {
  const firmy = (await database.query<{ id: string; tenant_id: string; name: string } & Record<string, unknown>>(
    'SELECT id, tenant_id, name FROM organizations WHERE archived=false ORDER BY name',
  )).rows;
  for (const firma of firmy) {
    let vysledok: Awaited<ReturnType<typeof prepocitajPrax>> | undefined;
    try {
      await database.transaction(async (tx) => {
        vysledok = await prepocitajPrax(tx, { tenantId: firma.tenant_id, organizationId: firma.id });
        if (naSkusku) throw new NaSkusku();
      });
    } catch (chyba) {
      if (!(chyba instanceof NaSkusku)) throw chyba;
    }
    const v = vysledok!;
    const vKonflikte = v.pravidiel > 0 ? ((v.konfliktov / v.pravidiel) * 100).toFixed(1) : '0.0';
    console.log(`${firma.name}: pravidiel ${v.pravidiel} (s rozpisom ${v.sRozpisom}), v konflikte ${vKonflikte} %,`
      + ` zmien režimu ${v.zmienRezimu}, kategórií zmenených ${v.kategoriiZmenenych}`
      + `${naSkusku ? ' — na skúšku, nezapísané' : ''}`);
  }
} finally {
  await database.close();
}

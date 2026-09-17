import { parseArgs } from 'node:util';
import { loadConfig } from '../config.js';
import { createDatabase } from '../db/database.js';
import { zmerajPraxBanky } from '../services/bankaPraxService.js';

/**
 * Pokrytie a presnosť návrhu predkontácie z praxe banky po firmách: replay po
 * riadkoch denníka Banka, každý riadok vidí len prax z predošlých dní. Bez AI,
 * nič nezapisuje.
 *
 * Produkcia, len na čítanie — databáza každý pokus o zápis odmietne:
 *   docker compose exec -T -e PGOPTIONS='-c default_transaction_read_only=on' api node build/server/scripts/zmerajBanku.js --firma ALPINA
 * Voľby: --firma časť_názvu|id
 */
const { values } = parseArgs({ options: { firma: { type: 'string' } } });
const percento = (cast: number, celok: number) => (celok > 0 ? `${((cast / celok) * 100).toFixed(1)} %` : '—');

const database = await createDatabase(loadConfig());
try {
  const firmy = (await database.query<{ id: string; tenant_id: string; name: string } & Record<string, unknown>>(
    `SELECT id, tenant_id, name FROM organizations
      WHERE archived=false AND ($1::text IS NULL OR id=$1 OR name ILIKE '%' || $1 || '%')
      ORDER BY name`,
    [values.firma ?? null],
  )).rows;
  if (firmy.length === 0) throw new Error(`Žiadna firma nezodpovedá „${values.firma}".`);
  console.log('firma                    riadkov  navrhnutých  správnych  pokrytie  presnosť   z textu (správnych)');
  for (const firma of firmy) {
    const v = await zmerajPraxBanky(database, { tenantId: firma.tenant_id, organizationId: firma.id });
    console.log(`${firma.name.slice(0, 24).padEnd(24)} ${String(v.riadkov).padStart(7)}  ${String(v.navrhnutych).padStart(11)}`
      + `  ${String(v.spravnych).padStart(9)}  ${percento(v.navrhnutych, v.riadkov).padStart(8)}  ${percento(v.spravnych, v.navrhnutych).padStart(8)}`
      + `   ${v.navrhnutychZTextu} (${v.spravnychZTextu})`);
  }
} finally {
  await database.close();
}

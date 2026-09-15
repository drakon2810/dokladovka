import { loadConfig } from '../config.js';
import { createDatabase } from '../db/database.js';
import { zmerajRady } from '../services/uctoPresnostService.js';

/**
 * Presnosť výberu číselného radu pre všetky firmy naraz — overenie, že rad
 * z histórie sedí naprieč firmami, nie len na jednej. Bez AI, nič nezapisuje.
 *
 * Produkcia (obraz má len skompilovaný JS):
 *   docker compose exec api node build/server/scripts/zmerajRady.js [od YYYY-MM-DD] [predkontacia]
 *
 * „predkontacia" pridá výberu skutočnú predkontáciu hlavičky z histórie — horná
 * hranica skupiny podľa predkontácie; porovnať s behom bez nej (A/B).
 */
const argumenty = process.argv.slice(2);
const predkontacia = argumenty.includes('predkontacia');
const od = argumenty.find((argument) => argument !== 'predkontacia');
const database = await createDatabase(loadConfig());
try {
  const firmy = (await database.query<{ id: string; tenant_id: string; name: string } & Record<string, unknown>>(
    'SELECT id, tenant_id, name FROM organizations WHERE archived=false ORDER BY name',
  )).rows;
  for (const firma of firmy) {
    const vysledok = await zmerajRady(database, { tenantId: firma.tenant_id, organizationId: firma.id }, { od, predkontacia });
    if (!vysledok.od) {
      console.log(`\n${firma.name}: história rad dokladu nenesie`);
      continue;
    }
    console.log(`\n${firma.name} (od ${vysledok.od})`);
    for (const [agenda, skore] of Object.entries(vysledok.podlaAgendy)) {
      const percento = ((skore.spravne / skore.dokladov) * 100).toFixed(1);
      console.log(`  ${agenda.padEnd(5)} ${String(skore.dokladov).padStart(5)} dokl.  ${percento.padStart(5)} %  prázdne ${skore.prazdne}`);
    }
    for (const rozdiel of vysledok.rozdiely.slice(0, 10)) {
      console.log(`    ${rozdiel.agenda} ${rozdiel.doklad} ${rozdiel.datum} ${rozdiel.protistrana ?? '—'}: `
        + `skutočne ${rozdiel.skutocne ?? '—'}, návrh ${rozdiel.navrh ?? '—'}`);
    }
  }
} finally {
  await database.close();
}

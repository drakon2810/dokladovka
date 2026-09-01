// SharePoint poller — samostatný proces, ako imap/monitor.
//
// Beží na serveri, nie na počítači účtovníka: klient hodí doklad do priečinka
// v sobotu v noci a o pár minút je v projekte, bez toho, aby bol niekto pri
// počítači. Presun do „spracované" rieši job pri potvrdení prenosu, nie tento
// proces — ten iba prináša.
import { setTimeout as delay } from 'node:timers/promises';
import { loadConfig } from './config.js';
import { createDatabase } from './db/database.js';
import { migrateDatabase } from './db/migrate.js';
import { pollAllFolders } from './services/sharepointPollService.js';
import { graphClient } from './services/sharepointService.js';
import { createObjectStorage } from './storage.js';

const config = loadConfig();
if (!config.sharepoint.clientId || !config.sharepoint.clientSecret) {
  throw new Error('SHAREPOINT_CLIENT_ID a SHAREPOINT_CLIENT_SECRET sú povinné pre SharePoint poller (.env)');
}
if (!config.secretEncryptionKey) {
  throw new Error('SECRET_ENCRYPTION_KEY je povinný — bez neho sa nedá prečítať uložené pripojenie');
}

const log = (message: string) => console.log(`[sharepoint ${new Date().toISOString()}] ${message}`);

const database = await createDatabase(config);
await migrateDatabase(database);
const storage = createObjectStorage(config);

let stopping = false;
const stop = () => { stopping = true; };
process.on('SIGINT', stop);
process.on('SIGTERM', stop);

log(`štart, interval ${config.sharepoint.pollIntervalSeconds}s`);
while (!stopping) {
  try {
    const vysledky = await pollAllFolders({ database, storage, config }, graphClient);
    for (const [organizationId, vysledok] of vysledky) {
      // Ticho sa neloguje — inak by sa v pokojnom priečinku každé tri minúty
      // objavil riadok a skutočné udalosti by v ňom zanikli.
      if (vysledok.prijate > 0 || vysledok.chybne > 0 || vysledok.presunute > 0 || vysledok.chyba) {
        log(`${organizationId}: prijaté=${vysledok.prijate}, presunuté=${vysledok.presunute}, chybné=${vysledok.chybne}` +
          `, preskočené=${vysledok.preskocene}${vysledok.chyba ? `, chyba: ${vysledok.chyba}` : ''}`);
      }
    }
  } catch (error) {
    log(`cyklus zlyhal — ${error instanceof Error ? error.message : String(error)}`);
  }
  if (!stopping) await delay(config.sharepoint.pollIntervalSeconds * 1000);
}
await database.close();

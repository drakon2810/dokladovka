// SharePoint poller — samostatný proces, ako imap/monitor.
//
// Dve úlohy: nahrá súbory, ktoré si účtovník vybral v okne „Nahrať zo
// SharePointu", a presunie do „spracované" tie, ktorých doklad prešiel do
// POHODY. Sám od seba z priečinka nič nesťahuje.
import { setTimeout as delay } from 'node:timers/promises';
import { loadConfig } from './config.js';
import { createDatabase } from './db/database.js';
import { migrateDatabase } from './db/migrate.js';
import { pollAllFolders, pribudliZiadosti } from './services/sharepointPollService.js';
import { graphClient } from './services/sharepointService.js';
import { createObjectStorage } from './storage.js';

const config = loadConfig();
const log = (message: string) => console.log(`[sharepoint ${new Date().toISOString()}] ${message}`);

// Nenakonfigurované NIE JE chyba — funkciu si zapína až ten, kto ju chce.
// Pád na štarte by pri `restart: unless-stopped` znamenal kontajner, ktorý sa
// donekonečna reštartuje a zaplní log; cyklus bez registrácie aplikácie
// jednoducho nič nerobí a rozbehne sa, keď premenné pribudnú.
const nakonfigurovane = Boolean(
  config.sharepoint.clientId && config.sharepoint.clientSecret && config.secretEncryptionKey,
);
if (!nakonfigurovane) {
  log('SHAREPOINT_CLIENT_ID, SHAREPOINT_CLIENT_SECRET alebo SECRET_ENCRYPTION_KEY chýba — poller beží naprázdno');
}

const database = await createDatabase(config);
await migrateDatabase(database);
const storage = createObjectStorage(config);

let stopping = false;
const stop = () => { stopping = true; };
process.on('SIGINT', stop);
process.on('SIGTERM', stop);

log(`štart, interval ${config.sharepoint.pollIntervalSeconds}s`);
/** Ako často sa pri čakaní pozrie, či účtovník niečo nevybral — len databáza, nie Graph. */
const KONTROLA_ZIADOSTI_MS = 5_000;

while (!stopping) {
  const zaciatokCyklu = new Date();
  try {
    // pollAllFolders sa bez registrácie aplikácie vráti prázdny — kontrola je
    // tu len preto, aby sa zbytočne nechodilo do databázy.
    const vysledky = nakonfigurovane
      ? await pollAllFolders({ database, storage, config }, graphClient)
      : new Map();
    for (const [organizationId, vysledok] of vysledky) {
      // Ticho sa neloguje — inak by sa v pokojnom priečinku každé tri minúty
      // objavil riadok a skutočné udalosti by v ňom zanikli.
      if (vysledok.prijate > 0 || vysledok.chybne > 0 || vysledok.presunute > 0
        || vysledok.duplicity > 0 || vysledok.chyba) {
        log(`${organizationId}: prijaté=${vysledok.prijate}, presunuté=${vysledok.presunute}` +
          `, duplicity=${vysledok.duplicity}, chybné=${vysledok.chybne}` +
          `, preskočené=${vysledok.preskocene}${vysledok.chyba ? `, chyba: ${vysledok.chyba}` : ''}`);
      }
    }
  } catch (error) {
    log(`cyklus zlyhal — ${error instanceof Error ? error.message : String(error)}`);
  }
  // Čaká sa celý interval — kvôli presunom po prenose do POHODY. Nová žiadosť
  // z okna „Nahrať zo SharePointu" však spustí cyklus hneď: účtovník po kliknutí
  // nemá minútu pozerať, ako sa nič nedeje.
  const koniecCakania = Date.now() + config.sharepoint.pollIntervalSeconds * 1000;
  while (!stopping && Date.now() < koniecCakania) {
    await delay(KONTROLA_ZIADOSTI_MS);
    try {
      if (nakonfigurovane && await pribudliZiadosti(database, zaciatokCyklu)) break;
    } catch {
      // Výpadok databázy počká na riadny cyklus, ten ho zapíše do logu.
    }
  }
}
await database.close();

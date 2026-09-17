import { setTimeout as delay } from 'node:timers/promises';
import { loadConfig } from './config.js';
import { createDatabase } from './db/database.js';
import { migrateDatabase } from './db/migrate.js';
import { processNextJob, uvolniZaseknuteDoklady } from './workerService.js';
import { createObjectStorage } from './storage.js';

const config = loadConfig();
if (config.extractionProvider === 'openai' && !config.openai.apiKey) {
  throw new Error('OPENAI_API_KEY je povinné pre DOCUMENT_EXTRACTION_PROVIDER=openai');
}
const database = await createDatabase(config);
await migrateDatabase(database);
const storage = createObjectStorage(config);

// Doklad, ktorého chvost (kontrola DPH, návrh zaúčtovania) prerušilo zabitie
// procesu, ostal neotvoriteľný v 'normalizing' — jeho job je už 'succeeded',
// takže ho nič nevyzdvihne. Zabitie procesu je jediná cesta, ako sa to stane,
// a po ňom nasleduje práve tento štart.
await uvolniZaseknuteDoklady(database, config);

let stopping = false;
const stop = () => { stopping = true; };
process.on('SIGINT', stop);
process.on('SIGTERM', stop);

// Súbežné slučky nad tou istou frontou: claimJob berie job cez FOR UPDATE
// SKIP LOCKED, takže dva bežce nikdy nedostanú ten istý doklad. Prázdna fronta
// každú slučku uspí, takže nečinný worker nezaťažuje databázu viac než predtým.
// Uvoľnenie zaseknutých dokladov nestačí raz po štarte: worker sa reštartuje
// pri každom nasadení, takže doklad zaseknutý pol minúty pred reštartom je pre
// štartovací zmet ešte „čerstvý" a ďalší štart môže byť o týždeň. Prázdna
// fronta je na to správny okamih — vtedy žiadny chvost nebeží.
const UVOLNENIE_KAZDYCH_MS = 5 * 60_000;
let posledneUvolnenie = Date.now();

async function slucka(): Promise<void> {
  while (!stopping) {
    const processed = await processNextJob(database, config, undefined, { storage });
    if (processed) continue;
    if (Date.now() - posledneUvolnenie >= UVOLNENIE_KAZDYCH_MS) {
      posledneUvolnenie = Date.now();
      await uvolniZaseknuteDoklady(database, config)
        .catch((chyba) => console.warn('[worker] uvoľnenie zaseknutých dokladov zlyhalo', chyba instanceof Error ? chyba.message : chyba));
    }
    await delay(config.workerPollIntervalMs);
  }
}

await Promise.all(Array.from({ length: config.workerConcurrency }, () => slucka()));
await database.close();

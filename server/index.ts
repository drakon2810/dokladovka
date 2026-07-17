import { setTimeout as delay } from 'node:timers/promises';
import { buildApp } from './app.js';
import { loadConfig } from './config.js';
import { createDatabase } from './db/database.js';
import { migrateDatabase } from './db/migrate.js';
import { processNextJob } from './workerService.js';
import { createObjectStorage } from './storage.js';

const config = loadConfig();

// PGlite (dev): pri reštarte tsx watch môže starý proces ešte držať data dir,
// prvé otvorenie potom spadne WASM abortom. Krátky retry rieši túto race.
async function openDatabaseWithRetry(attempts = 4, delayMs = 3_000): Promise<Awaited<ReturnType<typeof createDatabase>>> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return await createDatabase(config);
    } catch (error) {
      lastError = error;
      console.error(`Databáza sa nepodarilo otvoriť (pokus ${attempt}/${attempts}); skúšam znova o ${delayMs / 1000}s`);
      await delay(delayMs);
    }
  }
  throw lastError;
}

const database = await openDatabaseWithRetry();
await migrateDatabase(database);
const storage = createObjectStorage(config);
const app = await buildApp({ database, storage, config });

// PGlite (dev bez DATABASE_URL) je single-process — samostatný worker proces by
// sa k dátam nedostal. V takom prípade beží worker slučka priamo v API procese.
let workerStopping = false;
const inlineWorker = !config.databaseUrl
  ? (async () => {
      app.log.info('Inline worker beží v API procese (PGlite režim)');
      while (!workerStopping) {
        try {
          const processed = await processNextJob(database, config, `inline-${process.pid}`, { storage });
          if (!processed) await delay(config.workerPollIntervalMs);
        } catch (error) {
          app.log.error({ err: error }, 'Inline worker: chyba spracovania jobu');
          await delay(config.workerPollIntervalMs);
        }
      }
    })()
  : Promise.resolve();

const close = async () => {
  workerStopping = true;
  await inlineWorker;
  await app.close();
  await database.close();
};
process.on('SIGINT', () => void close());
process.on('SIGTERM', () => void close());

await app.listen({ port: config.port, host: '0.0.0.0' });

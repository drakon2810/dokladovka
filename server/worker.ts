import { setTimeout as delay } from 'node:timers/promises';
import { loadConfig } from './config.js';
import { createDatabase } from './db/database.js';
import { migrateDatabase } from './db/migrate.js';
import { processNextJob } from './workerService.js';
import { createObjectStorage } from './storage.js';

const config = loadConfig();
if (config.extractionProvider === 'openai' && !config.openai.apiKey) {
  throw new Error('OPENAI_API_KEY je povinné pre DOCUMENT_EXTRACTION_PROVIDER=openai');
}
const database = await createDatabase(config);
await migrateDatabase(database);
const storage = createObjectStorage(config);

let stopping = false;
const stop = () => { stopping = true; };
process.on('SIGINT', stop);
process.on('SIGTERM', stop);

// Súbežné slučky nad tou istou frontou: claimJob berie job cez FOR UPDATE
// SKIP LOCKED, takže dva bežce nikdy nedostanú ten istý doklad. Prázdna fronta
// každú slučku uspí, takže nečinný worker nezaťažuje databázu viac než predtým.
async function slucka(): Promise<void> {
  while (!stopping) {
    const processed = await processNextJob(database, config, undefined, { storage });
    if (!processed) await delay(config.workerPollIntervalMs);
  }
}

await Promise.all(Array.from({ length: config.workerConcurrency }, () => slucka()));
await database.close();

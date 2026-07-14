import { setTimeout as delay } from 'node:timers/promises';
import { loadConfig } from './config.js';
import { createDatabase } from './db/database.js';
import { migrateDatabase } from './db/migrate.js';
import { processNextJob } from './workerService.js';

const config = loadConfig();
const database = await createDatabase(config);
await migrateDatabase(database);

let stopping = false;
const stop = () => { stopping = true; };
process.on('SIGINT', stop);
process.on('SIGTERM', stop);

while (!stopping) {
  const processed = await processNextJob(database, config);
  if (!processed) await delay(config.workerPollIntervalMs);
}
await database.close();

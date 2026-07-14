import { setTimeout as delay } from 'node:timers/promises';
import { loadConfig } from './config.js';
import { createDatabase } from './db/database.js';
import { migrateDatabase } from './db/migrate.js';
import { runHealthMonitor } from './monitorService.js';

const config = loadConfig();
const database = await createDatabase(config);
await migrateDatabase(database);

let stopping = false;
const stop = () => { stopping = true; };
process.on('SIGINT', stop);
process.on('SIGTERM', stop);

while (!stopping) {
  try {
    const result = await runHealthMonitor(database, config);
    if (result.offline > 0 || result.failureRates > 0) console.warn('Mostík health alerts queued', result);
  } catch (error) {
    console.error('Mostík health monitor failed', error instanceof Error ? error.message : 'unknown_error');
  }
  if (!stopping) await delay(config.monitorIntervalMs);
}
await database.close();

import { buildApp } from './app.js';
import { loadConfig } from './config.js';
import { createDatabase } from './db/database.js';
import { migrateDatabase } from './db/migrate.js';
import { createObjectStorage } from './storage.js';

const config = loadConfig();
const database = await createDatabase(config);
await migrateDatabase(database);
const storage = createObjectStorage(config);
const app = await buildApp({ database, storage, config });

const close = async () => {
  await app.close();
  await database.close();
};
process.on('SIGINT', () => void close());
process.on('SIGTERM', () => void close());

await app.listen({ port: config.port, host: '0.0.0.0' });

import { loadConfig } from '../config.js';
import { createDatabase } from './database.js';
import { migrateDatabase } from './migrate.js';

const database = await createDatabase(loadConfig());
try {
  const applied = await migrateDatabase(database);
  process.stdout.write(applied.length > 0
    ? `Aplikované migrácie: ${applied.join(', ')}\n`
    : 'Žiadne nové migrácie.\n');
} finally {
  await database.close();
}

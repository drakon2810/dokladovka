import { readdir, readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { join, resolve } from 'node:path';
import type { Database, Queryable } from './database.js';

// Konštantný kľúč pre transakčný advisory lock, ktorý serializuje migrácie
// naprieč procesmi (api/worker/monitor štartujú súčasne).
const MIGRATION_LOCK_KEY = 4242424242;

async function migrationsDirectory(): Promise<string> {
  const adjacent = fileURLToPath(new URL('./migrations/', import.meta.url));
  try {
    await readdir(adjacent);
    return adjacent;
  } catch {
    return resolve(process.cwd(), 'server/db/migrations');
  }
}

async function applyPending(db: Queryable): Promise<string[]> {
  await db.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      name text PRIMARY KEY,
      applied_at timestamptz NOT NULL DEFAULT now()
    )
  `);
  const directory = await migrationsDirectory();
  const files = (await readdir(directory)).filter((file) => file.endsWith('.sql')).sort();
  const applied: string[] = [];

  for (const file of files) {
    const existing = await db.query<{ name: string }>(
      'SELECT name FROM schema_migrations WHERE name = $1',
      [file],
    );
    if (existing.rowCount > 0) continue;
    const sql = await readFile(join(directory, file), 'utf8');
    await db.exec(sql);
    await db.query('INSERT INTO schema_migrations (name) VALUES ($1)', [file]);
    applied.push(file);
  }
  return applied;
}

export async function migrateDatabase(database: Database): Promise<string[]> {
  // Celá migrácia v jednej transakcii. Pri postgrese (api/worker/monitor bežia
  // súbežne) ju chráni transakčný advisory lock — inak súbežné CREATE TABLE
  // spadnú na "duplicate key ... pg_type_typname_nsp_index". Druhý proces počká,
  // po commite prvého vidí migrácie ako aplikované a preskočí ich.
  // PGlite (dev) je jednoprocesový — lock netreba (ani ho nepodporuje).
  return database.transaction(async (tx) => {
    if (database.kind === 'postgres') {
      await tx.query(`SELECT pg_advisory_xact_lock(${MIGRATION_LOCK_KEY})`);
    }
    return applyPending(tx);
  });
}

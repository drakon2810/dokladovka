import { readdir, readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { join, resolve } from 'node:path';
import type { Database } from './database.js';

async function migrationsDirectory(): Promise<string> {
  const adjacent = fileURLToPath(new URL('./migrations/', import.meta.url));
  try {
    await readdir(adjacent);
    return adjacent;
  } catch {
    return resolve(process.cwd(), 'server/db/migrations');
  }
}

export async function migrateDatabase(database: Database): Promise<string[]> {
  await database.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      name text PRIMARY KEY,
      applied_at timestamptz NOT NULL DEFAULT now()
    )
  `);
  const directory = await migrationsDirectory();
  const files = (await readdir(directory)).filter((file) => file.endsWith('.sql')).sort();
  const applied: string[] = [];

  for (const file of files) {
    const existing = await database.query<{ name: string }>(
      'SELECT name FROM schema_migrations WHERE name = $1',
      [file],
    );
    if (existing.rowCount > 0) continue;
    const sql = await readFile(join(directory, file), 'utf8');
    await database.transaction(async (tx) => {
      await tx.exec(sql);
      await tx.query('INSERT INTO schema_migrations (name) VALUES ($1)', [file]);
    });
    applied.push(file);
  }
  return applied;
}

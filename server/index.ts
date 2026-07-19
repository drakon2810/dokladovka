import { setTimeout as delay } from 'node:timers/promises';
import { buildApp } from './app.js';
import { loadConfig } from './config.js';
import { createDatabase } from './db/database.js';
import { migrateDatabase } from './db/migrate.js';
import { processNextJob } from './workerService.js';
import { createObjectStorage } from './storage.js';

const config = loadConfig();

// PGlite (dev): pri reštarte môže starý proces ešte držať data dir, prvé
// otvorenie potom spadne WASM abortom. Krátky retry rieši túto race.
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

// Samoobnova PGlite v dev režime: tvrdé ukončenie procesu vie data dir
// nenávratne poškodiť. Zdravie sa overuje v DETSKOM procese — jeho file
// handles zaniknú s ním, takže rename poškodeného adresára neskončí na EPERM
// (otvorenie v tomto procese by handles držalo). Poškodený adresár sa odloží
// bokom (pglite-corrupt-*) a vytvorí sa čerstvá databáza s demo seedom.
// Len dev + PGlite; produkčný PostgreSQL sa tejto vetvy nikdy nedotkne.
async function pgliteHealthy(dataDir: string): Promise<boolean> {
  const { execFile } = await import('node:child_process');
  const { promisify } = await import('node:util');
  const probe = "const {PGlite}=await import('@electric-sql/pglite');const c=new PGlite(process.argv[1]);await c.waitReady;await c.query('SELECT 1');await c.close();";
  try {
    await promisify(execFile)(process.execPath, ['--input-type=module', '-e', probe, dataDir], {
      timeout: 90_000,
      windowsHide: true,
      cwd: process.cwd(),
    });
    return true;
  } catch {
    return false;
  }
}

async function openDatabaseWithRecovery(): Promise<Awaited<ReturnType<typeof createDatabase>>> {
  const { existsSync } = await import('node:fs');
  if (config.nodeEnv === 'development' && !config.databaseUrl && existsSync(config.pgliteDataDir)
    && !(await pgliteHealthy(config.pgliteDataDir))) {
    const { rename } = await import('node:fs/promises');
    const backupDir = `${config.pgliteDataDir}-corrupt-${new Date().toISOString().replace(/[:.]/g, '-')}`;
    console.error(`PGlite databáza je poškodená — odkladám ju do ${backupDir} a zakladám novú s demo seedom.`);
    await rename(config.pgliteDataDir, backupDir);
    const fresh = await createDatabase(config);
    await migrateDatabase(fresh);
    const { seedDemoData } = await import('./db/seedDemo.js');
    await seedDemoData(fresh, config, (line) => console.log(line));
    return fresh;
  }
  return openDatabaseWithRetry();
}

const database = await openDatabaseWithRecovery();
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

// Daňové identifikátory slovenských firiem z OpenData API Finančnej správy SR.
// RPO (Štatistický úrad) zverejňuje len IČO, názov a sídlo — DIČ a IČ DPH sú
// v informačných zoznamoch FS, ktoré vyžadujú API kľúč. Kľúč je secret, takže
// volanie beží tu na serveri a prehliadač vidí len výsledok.
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { requireBrowserAuth } from '../auth.js';
import type { ServerConfig } from '../config.js';
import type { Database } from '../db/database.js';

const FS_BASE = 'https://iz.opendata.financnasprava.sk/api/data';
/** Zoznam daňových subjektov registrovaných na daň z príjmov — obsahuje DIČ. */
const LIST_INCOME_TAX = 'ds_dsrdp';
/** Zoznam subjektov registrovaných k DPH — obsahuje IČ DPH. */
const LIST_VAT = 'ds_dphs';

interface FsRow {
  dic?: string;
  ic_dph?: string;
  nazov_ds?: string;
}

async function fsLookup(key: string, list: string, ico: string): Promise<FsRow | undefined> {
  const url = `${FS_BASE}/${list}/search?page=1&column=ico&search=${encodeURIComponent(ico)}`;
  const response = await fetch(url, { headers: { key } });
  // 404 = subjekt v zozname nie je (napr. neplatiteľ DPH) — nie je to chyba.
  if (!response.ok) return undefined;
  const body = (await response.json()) as { data?: FsRow[] };
  return body.data?.[0];
}

export function registerCompanyRegistryRoutes(
  app: FastifyInstance,
  database: Database,
  config: ServerConfig,
): void {
  app.get('/api/company-registry/sk-tax-ids', {
    // Externé API má limit 1 000 volaní za hodinu — držíme sa hlboko pod ním.
    config: { rateLimit: { max: 60, timeWindow: '1 minute' } },
  }, async (request) => {
    await requireBrowserAuth(request, database);
    const { ico } = z.object({ ico: z.string().regex(/^\d{8}$/) }).parse(request.query);
    const key = config.fsOpenDataApiKey;
    if (!key) return { dic: null, icDph: null, configured: false };
    const [incomeTax, vat] = await Promise.all([
      fsLookup(key, LIST_INCOME_TAX, ico).catch(() => undefined),
      fsLookup(key, LIST_VAT, ico).catch(() => undefined),
    ]);
    return {
      dic: incomeTax?.dic ?? null,
      icDph: vat?.ic_dph ?? null,
      nazov: incomeTax?.nazov_ds ?? vat?.nazov_ds ?? null,
      configured: true,
    };
  });
}

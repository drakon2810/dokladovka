// Daňové identifikátory slovenských firiem z OpenData API Finančnej správy SR.
// RPO (Štatistický úrad) zverejňuje len IČO, názov a sídlo — DIČ a IČ DPH sú
// v informačných zoznamoch FS, ktoré vyžadujú API kľúč. Kľúč je secret, takže
// volanie beží tu na serveri a prehliadač vidí len výsledok.
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { requireBrowserAuth } from '../auth.js';
import type { ServerConfig } from '../config.js';
import type { Database } from '../db/database.js';
import { najdiSkDanoveIdentifikatory } from '../services/skTaxIdsService.js';

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
    const register = await najdiSkDanoveIdentifikatory(key, ico);
    return {
      dic: register.dic ?? null,
      icDph: register.icDph ?? null,
      nazov: register.nazov ?? null,
      configured: true,
    };
  });
}

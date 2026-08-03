import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { requireBrowserAuth, requireCsrf, requireOrganizationAccess, requireRole } from '../auth.js';
import { writeAudit } from '../audit.js';
import type { ServerConfig } from '../config.js';
import type { Database } from '../db/database.js';
import {
  backfillHistoryFromDecisions,
  historyImportSchema,
  historyStats,
  importUctoHistory,
} from '../services/uctoHistoryService.js';
import { analyzujUctovnyProfil, listUctoKategorie } from '../services/uctoProfileService.js';

// Účtovný profil firmy: import úplnej histórie z POHODY (po riadkoch, všetky
// agendy) a jednorazová analýza, ktorá z nej spraví kategórie plnení.

const orgSchema = z.object({ id: z.string().uuid() });

export function registerUctoProfileRoutes(
  app: FastifyInstance,
  database: Database,
  config: ServerConfig,
  injectedParser?: { parse(body: unknown): Promise<{ output_parsed?: unknown }> },
): void {
  const pristup = async (request: Parameters<typeof requireBrowserAuth>[0], write: boolean) => {
    const auth = await requireBrowserAuth(request, database);
    if (write) requireCsrf(request, auth);
    requireRole(auth, ['admin', 'uctovnik']);
    const { id } = orgSchema.parse(request.params);
    await requireOrganizationAccess(database, auth, id);
    return { auth, organizationId: id };
  };

  app.put('/api/organizations/:id/ucto-history', async (request) => {
    const { auth, organizationId } = await pristup(request, true);
    const body = historyImportSchema.parse(request.body);
    return importUctoHistory(database, {
      tenantId: auth.tenantId,
      organizationId,
      rows: body.rows,
      source: 'mdb',
    });
  });

  // Preklopenie existujúcej pamäte rozhodnutí do korpusu — aby analýza mala
  // z čoho vychádzať aj pred prvým plným exportom z POHODY.
  app.post('/api/organizations/:id/ucto-history/backfill', async (request) => {
    const { auth, organizationId } = await pristup(request, true);
    return backfillHistoryFromDecisions(database, auth.tenantId, organizationId);
  });

  app.get('/api/organizations/:id/ucto-history/stats', async (request) => {
    const { auth, organizationId } = await pristup(request, false);
    return historyStats(database, auth.tenantId, organizationId);
  });

  // Jednorazová analýza. Beží synchrónne v požiadavke — pri veľkej histórii to
  // môže trvať desiatky minút.
  // ponytail: synchrónne volanie, pri stovkách dávok prejsť na durable job
  // (rovnaká tabuľka processing_jobs ako extrakcia).
  app.post('/api/organizations/:id/ucto-profile/analyze', async (request) => {
    const { auth, organizationId } = await pristup(request, true);
    const vysledok = await analyzujUctovnyProfil(database, config, {
      tenantId: auth.tenantId,
      organizationId,
    }, injectedParser);
    await writeAudit(database, {
      tenantId: auth.tenantId,
      organizationId,
      actorType: 'user',
      actorId: auth.userId,
      action: 'ucto_profile.analyzed',
      entityType: 'organization',
      entityId: organizationId,
      correlationId: request.id,
      metadata: { ...vysledok },
    });
    return vysledok;
  });

  app.get('/api/organizations/:id/ucto-profile', async (request) => {
    const { auth, organizationId } = await pristup(request, false);
    return { kategorie: await listUctoKategorie(database, auth.tenantId, organizationId) };
  });
}

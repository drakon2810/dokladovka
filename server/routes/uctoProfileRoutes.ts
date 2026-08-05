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
import {
  analyzujUctovnyProfil,
  deleteUctoKategoria,
  kategoriaZmenaSchema,
  listUctoKategorie,
  updateUctoKategoria,
} from '../services/uctoProfileService.js';

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

  // Ručná úprava kategórie po analýze — účtovník opraví názov, slovník či kódy
  // bez toho, aby musel celú analýzu púšťať znova.
  const kategoriaSchema = z.object({ kategoriaId: z.string().uuid() });

  app.patch('/api/organizations/:id/ucto-profile/:kategoriaId', async (request) => {
    const { auth, organizationId } = await pristup(request, true);
    const { kategoriaId } = kategoriaSchema.parse(request.params);
    const zmena = kategoriaZmenaSchema.parse(request.body);
    const kategoria = await updateUctoKategoria(
      database, auth.tenantId, organizationId, kategoriaId, zmena,
    );
    // Kategórie riadia návrhy zaúčtovania — ich zmena patrí do audit logu
    // rovnako ako spustenie analýzy.
    await writeAudit(database, {
      tenantId: auth.tenantId,
      organizationId,
      actorType: 'user',
      actorId: auth.userId,
      action: 'ucto_profile.kategoria_updated',
      entityType: 'ucto_kategoria',
      entityId: kategoriaId,
      correlationId: request.id,
      metadata: { polia: Object.keys(zmena) },
    });
    return kategoria;
  });

  app.delete('/api/organizations/:id/ucto-profile/:kategoriaId', async (request) => {
    const { auth, organizationId } = await pristup(request, true);
    const { kategoriaId } = kategoriaSchema.parse(request.params);
    await deleteUctoKategoria(database, auth.tenantId, organizationId, kategoriaId);
    await writeAudit(database, {
      tenantId: auth.tenantId,
      organizationId,
      actorType: 'user',
      actorId: auth.userId,
      action: 'ucto_profile.kategoria_deleted',
      entityType: 'ucto_kategoria',
      entityId: kategoriaId,
      correlationId: request.id,
    });
    return { ok: true };
  });
}

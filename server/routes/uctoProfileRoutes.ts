import { randomUUID } from 'node:crypto';
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
import { parseHistoriaXml } from '../services/uctoHistoriaXml.js';
import { zmerajPresnost } from '../services/uctoPresnostService.js';
import { ANALYZA_KIND } from '../workerService.js';
import {
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

  // Doklady s položkami priamo z POHODY, bez agenta: účtovník si stiahne
  // request, prežene ho v POHODE a odpoveď nahrá sem.
  //
  // NEROBÍ reset korpusu, na rozdiel od prenosu agentom. Ručný export býva
  // filtrovaný — ten prvý mal štyroch dodávateľov a 45 dokladov —, takže reset
  // by z korpusu spravil práve tie štyri firmy a zvyšok roka by zmizol. Riadky
  // sa preto zlievajú; duplicitu drží riadok_hash.
  app.put('/api/organizations/:id/ucto-historia-xml', {
    // Predvolený bodyLimit Fastify je 1 MB a nastavuje sa pre každú cestu
    // zvlášť. Doklady s položkami majú ~4,5 kB na doklad, celý rok teda desiatky MB.
    bodyLimit: 30 * 1024 * 1024,
  }, async (request) => {
    const { auth, organizationId } = await pristup(request, true);
    const { xml } = z.object({ xml: z.string().min(1).max(28_000_000) }).strict().parse(request.body);
    const { rows, warnings } = parseHistoriaXml(xml);
    const vysledok = await importUctoHistory(database, {
      tenantId: auth.tenantId, organizationId, rows, source: 'mdb',
    });
    return { ...vysledok, dokladov: rows.filter((row) => row.riadokIndex === 0).length, warnings };
  });

  // Pravidlá protistrán — odvodenina korpusu, nie samostatný záznam. Počítajú
  // sa pri analýze profilu; toto je len čítanie pre obrazovku.
  app.get('/api/organizations/:id/ucto-pravidla', async (request) => {
    const { auth, organizationId } = await pristup(request, false);
    const pravidla = await database.query<Record<string, any>>(
      `SELECT agenda, protistrana, dokladov, zhoda, predkontacia_kod, clenenie_dph_kod,
              clenenie_kv_kod, rozpis
         FROM ucto_pravidla WHERE tenant_id=$1 AND organization_id=$2
        ORDER BY dokladov DESC LIMIT 300`,
      [auth.tenantId, organizationId],
    );
    return { pravidla: pravidla.rows };
  });

  // Meranie presnosti: čo by AI navrhla na dokladoch, ktoré účtovník už
  // zaúčtoval. Beží synchrónne a dlho — sto dokladov je sto volaní modelu.
  // ponytail: pri väčších vzorkách presunúť do processing_jobs ako extrakciu.
  app.post('/api/organizations/:id/ucto-presnost', async (request) => {
    const { auth, organizationId } = await pristup(request, true);
    const body = z.object({
      vzorka: z.number().int().min(1).max(500).optional(),
      deliciDatum: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
    }).strict().parse(request.body ?? {});
    const vysledok = await zmerajPresnost(database, config, {
      tenantId: auth.tenantId, organizationId,
    }, body, injectedParser as never);
    await writeAudit(database, {
      tenantId: auth.tenantId, organizationId, actorType: 'user', actorId: auth.userId,
      action: 'ucto_presnost.measured', entityType: 'organization', entityId: organizationId,
      correlationId: request.id, metadata: { vzorka: vysledok.vzorka, deliciDatum: vysledok.deliciDatum },
    });
    return vysledok;
  });

  app.get('/api/organizations/:id/ucto-presnost', async (request) => {
    const { auth, organizationId } = await pristup(request, false);
    const behy = await database.query<Record<string, any>>(
      `SELECT id, delici_datum::text AS delici_datum, vzorka, vysledok, rozdiely, trvanie_ms, created_at
         FROM ucto_presnost WHERE tenant_id=$1 AND organization_id=$2
        ORDER BY created_at DESC LIMIT 5`,
      [auth.tenantId, organizationId],
    );
    return { behy: behy.rows };
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

  // Jednorazová analýza. Beží ako job vo workeri, nie v tejto požiadavke:
  // pri ALPINE trvala 26 minút a odpoveď sa k prehliadaču nikdy nevrátila —
  // účtovník stlačil tlačidlo a nedozvedel sa ani že beží, ani že skončila.
  app.post('/api/organizations/:id/ucto-profile/analyze', async (request, reply) => {
    const { auth, organizationId } = await pristup(request, true);
    // Druhé stlačenie nesmie spustiť druhý beh: je to osemnásť volaní modelu
    // a obidva by písali do tých istých tabuliek.
    const bezi = await database.query<{ id: string }>(
      `SELECT id FROM processing_jobs
        WHERE tenant_id=$1 AND organization_id=$2 AND kind=$3 AND status IN ('queued','running')
        LIMIT 1`,
      [auth.tenantId, organizationId, ANALYZA_KIND],
    );
    if (bezi.rows[0]) return reply.code(202).send({ jobId: bezi.rows[0].id, uzBezi: true });

    const jobId = randomUUID();
    await database.query(
      `INSERT INTO processing_jobs (id,tenant_id,organization_id,kind,status,max_attempts,correlation_id,payload)
       VALUES ($1,$2,$3,$4,'queued',1,$5,'{}'::jsonb)`,
      [jobId, auth.tenantId, organizationId, ANALYZA_KIND, String(request.id)],
    );
    await writeAudit(database, {
      tenantId: auth.tenantId,
      organizationId,
      actorType: 'user',
      actorId: auth.userId,
      action: 'ucto_profile.analysis_queued',
      entityType: 'organization',
      entityId: organizationId,
      correlationId: request.id,
      metadata: { jobId },
    });
    return reply.code(202).send({ jobId, uzBezi: false });
  });

  // Stav posledného behu — jediné, z čoho sa účtovník dozvie, ako to dopadlo.
  app.get('/api/organizations/:id/ucto-profile/analyze', async (request) => {
    const { auth, organizationId } = await pristup(request, false);
    const beh = await database.query<Record<string, any>>(
      `SELECT id, status, error_message, created_at, updated_at, payload->'vysledok' AS vysledok
         FROM processing_jobs
        WHERE tenant_id=$1 AND organization_id=$2 AND kind=$3
        ORDER BY created_at DESC LIMIT 1`,
      [auth.tenantId, organizationId, ANALYZA_KIND],
    );
    return { beh: beh.rows[0] ?? null };
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

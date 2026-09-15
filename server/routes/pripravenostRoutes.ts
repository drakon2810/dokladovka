import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { requireBrowserAuth, requireOrganizationAccess } from '../auth.js';
import type { ServerConfig } from '../config.js';
import type { Database } from '../db/database.js';
import { vypocitajPripravenost, type ImportHistorie } from '../services/pripravenostService.js';
import { ANALYZA_KIND } from '../workerService.js';

// Bez nich sa návrh zaúčtovania nemá o čo oprieť; strediská sú voliteľné.
const POVINNE_CISELNIKY = ['predkontacie', 'cleneniaDph', 'ciselneRady'];

/**
 * Pripravenosť firmy pre sprievodcu a detail dokladu. Zámerne nie v snapshote:
 * ten sa ťahá každých päť sekúnd pre všetky firmy, toto len pri otvorení.
 * Každý dopyt je posledný riadok firmy na indexe (LIMIT 1) — žiadne agregáty
 * nad históriou okrem EXISTS pre starší Mostík.
 */
export function registerPripravenostRoutes(app: FastifyInstance, database: Database, config: ServerConfig): void {
  app.get('/api/organizations/:id/pripravenost', async (request) => {
    const auth = await requireBrowserAuth(request, database);
    const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
    await requireOrganizationAccess(database, auth, id);
    const scope = [auth.tenantId, id];
    const importHistorie = (podmienka: string) => database.query<Record<string, any>>(
      `SELECT stav, chyba, manifest, created_at, published_at FROM pohoda_importy
        WHERE tenant_id=$1 AND organization_id=$2 AND druh='historia' ${podmienka}
        ORDER BY created_at DESC LIMIT 1`, scope,
    );
    const [integracia, agenti, prepojenie, synchronizacia, ciselniky, posledny, publikovany, stara, analyza, kategorie, meranie] = await Promise.all([
      database.query<Record<string, any>>('SELECT mostik_enabled FROM tenant_integrations WHERE tenant_id=$1', [auth.tenantId]),
      database.query<Record<string, any>>(
        `SELECT count(*)::int AS pocet, max(last_seen_at) AS videny FROM agent_installations
          WHERE tenant_id=$1 AND status='connected'`, [auth.tenantId],
      ),
      database.query<Record<string, any>>(
        'SELECT db_name, accounting_year, match_rule FROM pohoda_company_links WHERE tenant_id=$1 AND organization_id=$2', scope,
      ),
      database.query<Record<string, any>>(
        'SELECT created_at FROM agent_sync_runs WHERE tenant_id=$1 AND organization_id=$2 ORDER BY created_at DESC LIMIT 1', scope,
      ),
      database.query<Record<string, any>>(
        `SELECT d.druh, r.state, r.item_count, r.error_code,
                (SELECT count(*)::int FROM code_list_items c
                  WHERE c.tenant_id=$1 AND c.organization_id=$2 AND c.kind=d.druh AND c.active AND c.source<>'manual') AS z_pohody,
                (SELECT count(*)::int FROM code_list_items c
                  WHERE c.tenant_id=$1 AND c.organization_id=$2 AND c.kind=d.druh AND c.active) AS spolu
           FROM unnest($3::text[]) AS d(druh)
           LEFT JOIN LATERAL (
             SELECT state, item_count, error_code FROM agent_sync_runs
              WHERE tenant_id=$1 AND organization_id=$2 AND kind=d.druh
              ORDER BY created_at DESC LIMIT 1
           ) r ON true`, [...scope, POVINNE_CISELNIKY],
      ),
      importHistorie(''),
      importHistorie("AND stav='publikovany'"),
      database.query<Record<string, any>>(
        'SELECT EXISTS (SELECT 1 FROM ucto_historia WHERE tenant_id=$1 AND organization_id=$2) AS existuje', scope,
      ),
      database.query<Record<string, any>>(
        `SELECT status, error_message, updated_at, payload->'vysledok' AS vysledok FROM processing_jobs
          WHERE tenant_id=$1 AND organization_id=$2 AND kind=$3 ORDER BY created_at DESC LIMIT 1`, [...scope, ANALYZA_KIND],
      ),
      database.query<Record<string, any>>(
        'SELECT EXISTS (SELECT 1 FROM ucto_kategorie WHERE tenant_id=$1 AND organization_id=$2 AND active) AS existuje', scope,
      ),
      database.query<Record<string, any>>(
        `SELECT created_at, vysledok FROM ucto_presnost
          WHERE tenant_id=$1 AND organization_id=$2 AND metodika=2 ORDER BY created_at DESC LIMIT 1`, scope,
      ),
    ]);
    const importRiadok = (row: Record<string, any> | undefined): ImportHistorie | null => row
      ? { stav: row.stav, chyba: row.chyba, manifest: row.manifest, vytvoreny: row.created_at, publikovany: row.published_at }
      : null;
    const link = prepojenie.rows[0];
    const job = analyza.rows[0];
    return vypocitajPripravenost({
      mostikZapnuty: integracia.rows[0]?.mostik_enabled === true,
      pripojenychAgentov: Number(agenti.rows[0]?.pocet ?? 0),
      agentVideny: agenti.rows[0]?.videny,
      prepojenie: link ? { dbName: link.db_name, uctovnyRok: link.accounting_year, matchRule: link.match_rule } : null,
      poslednaSynchronizacia: synchronizacia.rows[0]?.created_at,
      ciselniky: ciselniky.rows.map((row) => ({
        druh: row.druh,
        beh: row.state ? { stav: row.state, poloziek: Number(row.item_count), chyba: row.error_code } : null,
        zPohody: Number(row.z_pohody),
        spolu: Number(row.spolu),
      })),
      historia: {
        posledny: importRiadok(posledny.rows[0]),
        publikovany: importRiadok(publikovany.rows[0]),
        bezManifestu: stara.rows[0]?.existuje === true,
      },
      analyza: job ? {
        stav: job.status, chyba: job.error_message, kedy: job.updated_at,
        kategorii: job.vysledok?.kategorii, zlyhanychDavok: job.vysledok?.zlyhanychDavok,
      } : null,
      kategorie: kategorie.rows[0]?.existuje === true,
      meranie: meranie.rows[0] ? { kedy: meranie.rows[0].created_at, agendy: Object.keys(meranie.rows[0].vysledok ?? {}) } : null,
    }, { teraz: new Date(), agentOfflineHodin: config.agentOfflineAlertHours });
  });
}

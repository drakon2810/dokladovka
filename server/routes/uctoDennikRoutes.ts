import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { requireBrowserAuth, requireCsrf, requireOrganizationAccess, requireRole } from '../auth.js';
import { writeAudit } from '../audit.js';
import type { Database } from '../db/database.js';
import { parseDennik, ulozDennik } from '../services/uctoDennikService.js';

// Účtovný denník sa zatiaľ nahráva ručne: účtovník si stiahne request, prežene
// ho v POHODE a odpoveď nahrá sem. Agent to raz bude robiť sám, ale je to len
// automatizácia tohto kroku — bez neho by sa nedalo začať skôr, než bude nová
// verzia agenta na pilotnom počítači.
const dennikSchema = z.object({
  // Celý ročný denník ALPINY má 4,9 MB; bodyLimit servera je 30 MB.
  xml: z.string().min(1).max(28_000_000),
}).strict();

export function registerUctoDennikRoutes(app: FastifyInstance, database: Database): void {
  app.put('/api/organizations/:id/ucto-dennik', async (request) => {
    const auth = await requireBrowserAuth(request, database);
    requireCsrf(request, auth);
    requireRole(auth, ['admin', 'uctovnik']);
    const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
    await requireOrganizationAccess(database, auth, id);
    const { xml } = dennikSchema.parse(request.body);
    const { riadky, preskocene } = parseDennik(xml);
    const vysledok = await ulozDennik(database, { tenantId: auth.tenantId, organizationId: id, riadky });
    await writeAudit(database, {
      tenantId: auth.tenantId, organizationId: id, actorType: 'user', actorId: auth.userId,
      action: 'ucto_dennik.imported', entityType: 'organization', entityId: id,
      correlationId: request.id, metadata: { ...vysledok, preskocene },
    });
    return { ...vysledok, preskocene };
  });

  // Prehľad pre účtovníka: čo v denníku je a koľko dokladov je rozdelených.
  app.get('/api/organizations/:id/ucto-dennik/prehlad', async (request) => {
    const auth = await requireBrowserAuth(request, database);
    requireRole(auth, ['admin', 'uctovnik', 'schvalovatel']);
    const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
    await requireOrganizationAccess(database, auth, id);
    const suhrn = await database.query<{ proviozok: string; dokladov: string; od: string; do: string } & Record<string, unknown>>(
      `SELECT count(*) AS proviozok, count(DISTINCT (agenda, doklad_cislo)) AS dokladov,
              min(datum)::text AS od, max(datum)::text AS do
         FROM ucto_dennik WHERE tenant_id=$1 AND organization_id=$2`,
      [auth.tenantId, id],
    );
    // Skutočné rozdelenie = viac RÔZNYCH nákladových účtov na doklade. Rozpad na
    // základ a DPH robí jedna predkontácia sama, rozhodnutie účtovníka v ňom nie je.
    const delene = await database.query<{ pocet: string } & Record<string, unknown>>(
      `SELECT count(*) AS pocet FROM (
         SELECT agenda, doklad_cislo FROM ucto_dennik
          WHERE tenant_id=$1 AND organization_id=$2 AND doklad_cislo IS NOT NULL
            AND ucet_md NOT LIKE '343%'
          GROUP BY 1,2 HAVING count(DISTINCT ucet_md) > 1) t`,
      [auth.tenantId, id],
    );
    const agendy = await database.query<{ agenda: string; pocet: string } & Record<string, unknown>>(
      `SELECT agenda, count(*) AS pocet FROM ucto_dennik
        WHERE tenant_id=$1 AND organization_id=$2 GROUP BY 1 ORDER BY 2 DESC`,
      [auth.tenantId, id],
    );
    const row = suhrn.rows[0];
    return {
      proviozok: Number(row?.proviozok ?? 0),
      dokladov: Number(row?.dokladov ?? 0),
      rozdelenychDokladov: Number(delene.rows[0]?.pocet ?? 0),
      od: row?.od ?? null,
      do: row?.do ?? null,
      podlaAgendy: agendy.rows.map((item) => ({ agenda: item.agenda, pocet: Number(item.pocet) })),
    };
  });
}

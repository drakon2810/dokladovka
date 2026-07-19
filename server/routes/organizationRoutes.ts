import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { requireBrowserAuth, requireCsrf, requireOrganizationAccess, requireRole } from '../auth.js';
import { writeAudit } from '../audit.js';
import type { ServerConfig } from '../config.js';
import type { Database } from '../db/database.js';
import { HttpError } from '../http.js';
import { insertUniqueAlias, type AliasRecord } from '../services/organizationService.js';
import { loadDphProfil } from '../services/dphProfileService.js';

const organizationSchema = z.object({
  nazov: z.string().trim().min(1).max(200),
  ico: z.string().regex(/^\d{8}$/),
  dic: z.string().trim().max(20).default(''),
  icDph: z.string().trim().max(20).optional(),
  farba: z.string().regex(/^#[0-9A-Fa-f]{6}$/),
}).strict();

const patchSchema = organizationSchema.partial().strict();

const dphPravidloSchema = z.object({
  kategoria: z.string().trim().min(1).max(120),
  percento: z.number().min(0).max(100),
  klucoveSlova: z.array(z.string().trim().min(1).max(60)).max(30),
}).strict();

const dphProfilSchema = z.object({
  platitelDph: z.enum(['platitel', 'neplatitel', 'registracia_7a']),
  obdobieDph: z.enum(['mesacne', 'stvrtrocne']),
  uzavreteDo: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  koeficient: z.array(z.object({
    rok: z.number().int().min(2000).max(2100),
    typ: z.enum(['zalohovy', 'rocny']),
    hodnota: z.number().min(0).max(1),
    platnostOd: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
    platnostDo: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  }).strict()).max(20).default([]),
  pomerneOdpocitanie: z.array(dphPravidloSchema).max(50).default([]),
  rezim: z.enum(['tuzemsky', 'zahranicny']),
  nakupyZEu: z.boolean(),
  sluzbyZEu: z.boolean(),
  prenesenieDp: z.boolean(),
  pravidlaAut: z.array(dphPravidloSchema).max(50).default([]),
  bezNaroku: z.array(z.object({
    kategoria: z.string().trim().min(1).max(120),
    klucoveSlova: z.array(z.string().trim().min(1).max(60)).max(30),
  }).strict()).max(50).default([]),
  samozdanenieAktivne: z.boolean(),
  samozdanenieClenenieDphId: z.string().optional(),
  samozdanenieClenenieKvKod: z.string().trim().max(10).optional(),
  clenenieBezOdpoctuId: z.string().optional(),
}).strict();

interface OrganizationRow extends Record<string, unknown> {
  id: string;
  tenant_id: string;
  name: string;
  ico: string;
  dic: string;
  ic_dph?: string;
  color: string;
  archived: boolean;
  email_alias?: string;
}

interface AliasRow extends Record<string, unknown> {
  id: string;
  tenant_id: string;
  organization_id: string;
  address: string;
  address_normalized: string;
  local_part: string;
  domain: string;
  slug_at_creation: string;
  token: string;
  status: AliasRecord['status'];
  is_primary: boolean;
  created_at: string | Date;
  grace_until?: string | Date;
  disabled_at?: string | Date;
}

function mapOrganization(row: OrganizationRow) {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    nazov: row.name,
    ico: row.ico,
    dic: row.dic,
    icDph: row.ic_dph ?? undefined,
    emailAlias: row.email_alias ?? '',
    farba: row.color,
    archived: row.archived,
  };
}

function mapAlias(row: AliasRow): AliasRecord {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    organizationId: row.organization_id,
    address: row.address,
    addressNormalized: row.address_normalized,
    localPart: row.local_part,
    domain: row.domain,
    slugAtCreation: row.slug_at_creation,
    token: row.token,
    status: row.status,
    isPrimary: row.is_primary,
    createdAt: new Date(row.created_at).toISOString(),
    graceUntil: row.grace_until ? new Date(row.grace_until).toISOString() : undefined,
    disabledAt: row.disabled_at ? new Date(row.disabled_at).toISOString() : undefined,
  };
}

export function registerOrganizationRoutes(app: FastifyInstance, database: Database, config: ServerConfig): void {
  // Schvaľovanie podľa sumy — jedno pravidlo na organizáciu, upsert (admin).
  app.put('/api/organizations/:organizationId/approval-rule', async (request) => {
    const auth = await requireBrowserAuth(request, database);
    requireCsrf(request, auth);
    requireRole(auth, ['admin']);
    const { organizationId } = z.object({ organizationId: z.string().uuid() }).parse(request.params);
    await requireOrganizationAccess(database, auth, organizationId);
    const body = z.object({
      minAmount: z.number().min(0).max(100_000_000),
      requiredRole: z.enum(['admin', 'schvalovatel']),
      active: z.boolean(),
    }).strict().parse(request.body);
    await database.query(
      `INSERT INTO approval_rules (organization_id, tenant_id, min_amount, required_role, active, updated_by, updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,now())
       ON CONFLICT (organization_id) DO UPDATE SET
         min_amount=excluded.min_amount, required_role=excluded.required_role,
         active=excluded.active, updated_by=excluded.updated_by, updated_at=now()`,
      [organizationId, auth.tenantId, Math.round(body.minAmount * 100) / 100, body.requiredRole, body.active, auth.userId],
    );
    await writeAudit(database, {
      tenantId: auth.tenantId,
      organizationId,
      actorType: 'user',
      actorId: auth.userId,
      action: 'organization.approval_rule_updated',
      entityType: 'organization',
      entityId: organizationId,
      correlationId: request.id,
      metadata: { minAmount: body.minAmount, requiredRole: body.requiredRole, active: body.active },
    });
    return { organizationId, minAmount: body.minAmount, requiredRole: body.requiredRole, active: body.active };
  });

  // DPH profil klienta — jeden profil na organizáciu, upsert (admin).
  // Odkazy na číselníky sa overujú proti aktívnym položkám organizácie.
  app.put('/api/organizations/:organizationId/dph-profile', async (request) => {
    const auth = await requireBrowserAuth(request, database);
    requireCsrf(request, auth);
    requireRole(auth, ['admin']);
    const { organizationId } = z.object({ organizationId: z.string().uuid() }).parse(request.params);
    await requireOrganizationAccess(database, auth, organizationId);
    const body = dphProfilSchema.parse(request.body);
    const clenenieIds = [body.samozdanenieClenenieDphId, body.clenenieBezOdpoctuId]
      .filter((value): value is string => Boolean(value));
    if (clenenieIds.length > 0) {
      const valid = await database.query(
        `SELECT id FROM code_list_items
          WHERE tenant_id=$1 AND organization_id=$2 AND kind='cleneniaDph' AND active=true AND id=ANY($3::text[])`,
        [auth.tenantId, organizationId, clenenieIds],
      );
      if (valid.rowCount !== new Set(clenenieIds).size) {
        throw new HttpError(400, 'dph_clenenie_invalid', 'Členenie DPH nepatrí organizácii alebo nie je aktívne');
      }
    }
    await database.query(
      `INSERT INTO organization_dph_profiles
        (organization_id, tenant_id, platitel_dph, obdobie_dph, uzavrete_do, koeficient,
         pomerne_odpocitanie, rezim, nakupy_z_eu, sluzby_z_eu, prenesenie_dp, pravidla_aut,
         bez_naroku, samozdanenie_aktivne, samozdanenie_clenenie_dph_id, samozdanenie_clenenie_kv_kod,
         clenenie_bez_odpoctu_id, updated_by, updated_at)
       VALUES ($1,$2,$3,$4,$5,$6::jsonb,$7::jsonb,$8,$9,$10,$11,$12::jsonb,$13::jsonb,$14,$15,$16,$17,$18,now())
       ON CONFLICT (organization_id) DO UPDATE SET
         platitel_dph=excluded.platitel_dph, obdobie_dph=excluded.obdobie_dph,
         uzavrete_do=excluded.uzavrete_do, koeficient=excluded.koeficient,
         pomerne_odpocitanie=excluded.pomerne_odpocitanie, rezim=excluded.rezim,
         nakupy_z_eu=excluded.nakupy_z_eu, sluzby_z_eu=excluded.sluzby_z_eu,
         prenesenie_dp=excluded.prenesenie_dp, pravidla_aut=excluded.pravidla_aut,
         bez_naroku=excluded.bez_naroku, samozdanenie_aktivne=excluded.samozdanenie_aktivne,
         samozdanenie_clenenie_dph_id=excluded.samozdanenie_clenenie_dph_id,
         samozdanenie_clenenie_kv_kod=excluded.samozdanenie_clenenie_kv_kod,
         clenenie_bez_odpoctu_id=excluded.clenenie_bez_odpoctu_id,
         updated_by=excluded.updated_by, updated_at=now()`,
      [organizationId, auth.tenantId, body.platitelDph, body.obdobieDph, body.uzavreteDo ?? null,
        JSON.stringify(body.koeficient), JSON.stringify(body.pomerneOdpocitanie), body.rezim,
        body.nakupyZEu, body.sluzbyZEu, body.prenesenieDp, JSON.stringify(body.pravidlaAut),
        JSON.stringify(body.bezNaroku), body.samozdanenieAktivne,
        body.samozdanenieClenenieDphId ?? null, body.samozdanenieClenenieKvKod ?? null,
        body.clenenieBezOdpoctuId ?? null, auth.userId],
    );
    await writeAudit(database, {
      tenantId: auth.tenantId,
      organizationId,
      actorType: 'user',
      actorId: auth.userId,
      action: 'organization.dph_profile_updated',
      entityType: 'organization',
      entityId: organizationId,
      correlationId: request.id,
      metadata: { platitelDph: body.platitelDph, obdobieDph: body.obdobieDph, rezim: body.rezim },
    });
    return await loadDphProfil(database, auth.tenantId, organizationId);
  });

  app.get('/api/organizations', async (request) => {
    const auth = await requireBrowserAuth(request, database);
    const result = await database.query<OrganizationRow>(
      `SELECT o.id, o.tenant_id, o.name, o.ico, o.dic, o.ic_dph, o.color, o.archived, a.address AS email_alias
         FROM organizations o
         JOIN organization_memberships m ON m.organization_id = o.id AND m.tenant_id = o.tenant_id
         LEFT JOIN organization_email_aliases a
           ON a.organization_id = o.id AND a.is_primary = true AND a.status <> 'disabled'
        WHERE m.user_id = $1 AND o.tenant_id = $2
        ORDER BY o.name`,
      [auth.userId, auth.tenantId],
    );
    return result.rows.map(mapOrganization);
  });

  app.get('/api/organizations/:id', async (request) => {
    const auth = await requireBrowserAuth(request, database);
    const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
    await requireOrganizationAccess(database, auth, id);
    const result = await database.query<OrganizationRow>(
      `SELECT o.id, o.tenant_id, o.name, o.ico, o.dic, o.ic_dph, o.color, o.archived, a.address AS email_alias
         FROM organizations o LEFT JOIN organization_email_aliases a
           ON a.organization_id = o.id AND a.is_primary = true AND a.status <> 'disabled'
        WHERE o.id = $1 AND o.tenant_id = $2`,
      [id, auth.tenantId],
    );
    if (!result.rows[0]) throw new HttpError(404, 'organization_not_found', 'Organizácia neexistuje');
    return mapOrganization(result.rows[0]);
  });

  app.post('/api/organizations', async (request, reply) => {
    const auth = await requireBrowserAuth(request, database);
    requireCsrf(request, auth);
    requireRole(auth, ['admin', 'uctovnik']);
    const body = organizationSchema.parse(request.body);
    const organizationId = randomUUID();
    const result = await database.transaction(async (tx) => {
      const duplicate = await tx.query('SELECT 1 FROM organizations WHERE tenant_id = $1 AND ico = $2', [auth.tenantId, body.ico]);
      if (duplicate.rowCount > 0) throw new HttpError(409, 'organization_ico_exists', 'Organizácia s týmto IČO už existuje');
      await tx.query(
        `INSERT INTO organizations (id, tenant_id, name, ico, dic, ic_dph, color)
         VALUES ($1,$2,$3,$4,$5,$6,$7)`,
        [organizationId, auth.tenantId, body.nazov, body.ico, body.dic, body.icDph ?? null, body.farba],
      );
      await tx.query(
        'INSERT INTO organization_memberships (user_id, organization_id, tenant_id) VALUES ($1,$2,$3)',
        [auth.userId, organizationId, auth.tenantId],
      );
      for (const queue of [
        { name: 'Prijaté faktúry', kind: 'received_invoices', types: ['FP', 'OZ'] },
        { name: 'Vydané faktúry', kind: 'issued_invoices', types: ['FV'] },
        { name: 'Pokladňa', kind: 'cash_documents', types: ['PD'] },
      ]) {
        await tx.query(
          `INSERT INTO document_queues
            (id, tenant_id, organization_id, name, kind, document_types, features, automation)
           VALUES ($1,$2,$3,$4,$5,$6::jsonb,$7::jsonb,'{}'::jsonb)`,
          [randomUUID(), auth.tenantId, organizationId, queue.name, queue.kind, JSON.stringify(queue.types),
            JSON.stringify({ extraction: true, approval: true, validation: true, spamDetection: true, requireApprovalNote: false, autoAttachEmailAttachments: true })],
        );
      }
      await tx.query(
        `INSERT INTO pohoda_company_links (organization_id, tenant_id, ico)
         VALUES ($1,$2,$3)`,
        [organizationId, auth.tenantId, body.ico],
      );
      const alias = await insertUniqueAlias(tx, {
        tenantId: auth.tenantId,
        organizationId,
        organizationName: body.nazov,
        domain: config.mailReceivingDomain,
        primary: true,
      });
      await writeAudit(tx, {
        tenantId: auth.tenantId,
        organizationId,
        actorType: 'user',
        actorId: auth.userId,
        action: 'organization.created',
        entityType: 'organization',
        entityId: organizationId,
        correlationId: request.id,
      });
      return alias;
    });
    return reply.code(201).send({
      organization: mapOrganization({
        id: organizationId,
        tenant_id: auth.tenantId,
        name: body.nazov,
        ico: body.ico,
        dic: body.dic,
        ic_dph: body.icDph,
        color: body.farba,
        archived: false,
        email_alias: result.address,
      }),
      primaryEmailAlias: result,
    });
  });

  app.patch('/api/organizations/:id', async (request) => {
    const auth = await requireBrowserAuth(request, database);
    requireCsrf(request, auth);
    requireRole(auth, ['admin', 'uctovnik']);
    const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
    await requireOrganizationAccess(database, auth, id);
    const body = patchSchema.parse(request.body);
    const current = await database.query<OrganizationRow>(
      'SELECT id, tenant_id, name, ico, dic, ic_dph, color, archived FROM organizations WHERE id = $1 AND tenant_id = $2',
      [id, auth.tenantId],
    );
    const row = current.rows[0];
    if (!row) throw new HttpError(404, 'organization_not_found', 'Organizácia neexistuje');
    await database.query(
      `UPDATE organizations SET name=$1, ico=$2, dic=$3, ic_dph=$4, color=$5, updated_at=now()
        WHERE id=$6 AND tenant_id=$7`,
      [body.nazov ?? row.name, body.ico ?? row.ico, body.dic ?? row.dic, body.icDph ?? row.ic_dph ?? null, body.farba ?? row.color, id, auth.tenantId],
    );
    await database.query('UPDATE pohoda_company_links SET ico=$1, updated_at=now() WHERE organization_id=$2 AND tenant_id=$3', [body.ico ?? row.ico, id, auth.tenantId]);
    return { ...mapOrganization(row), nazov: body.nazov ?? row.name, ico: body.ico ?? row.ico, dic: body.dic ?? row.dic, icDph: body.icDph ?? row.ic_dph, farba: body.farba ?? row.color };
  });

  app.post('/api/organizations/:id/archive', async (request, reply) => {
    const auth = await requireBrowserAuth(request, database);
    requireCsrf(request, auth);
    requireRole(auth, ['admin']);
    const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
    await requireOrganizationAccess(database, auth, id);
    await database.query('UPDATE organizations SET archived=true, updated_at=now() WHERE id=$1 AND tenant_id=$2', [id, auth.tenantId]);
    await writeAudit(database, { tenantId: auth.tenantId, organizationId: id, actorType: 'user', actorId: auth.userId, action: 'organization.archived', entityType: 'organization', entityId: id, correlationId: request.id });
    return reply.code(204).send();
  });

  app.get('/api/organizations/:id/email-aliases', async (request) => {
    const auth = await requireBrowserAuth(request, database);
    const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
    await requireOrganizationAccess(database, auth, id);
    const result = await database.query<AliasRow>(
      `SELECT id, tenant_id, organization_id, address, address_normalized, local_part, domain,
              slug_at_creation, token, status, is_primary, created_at, grace_until, disabled_at
         FROM organization_email_aliases WHERE tenant_id=$1 AND organization_id=$2 ORDER BY created_at DESC`,
      [auth.tenantId, id],
    );
    return result.rows.map(mapAlias);
  });

  app.post('/api/organizations/:id/email-aliases/regenerate', async (request, reply) => {
    const auth = await requireBrowserAuth(request, database);
    requireCsrf(request, auth);
    requireRole(auth, ['admin']);
    const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
    await requireOrganizationAccess(database, auth, id);
    const organization = await database.query<{ name: string } & Record<string, unknown>>('SELECT name FROM organizations WHERE id=$1 AND tenant_id=$2', [id, auth.tenantId]);
    const alias = await database.transaction(async (tx) => {
      await tx.query(
        `UPDATE organization_email_aliases
            SET is_primary=false, status='grace_period', grace_until=now() + interval '30 days'
          WHERE tenant_id=$1 AND organization_id=$2 AND is_primary=true AND status='active'`,
        [auth.tenantId, id],
      );
      return insertUniqueAlias(tx, { tenantId: auth.tenantId, organizationId: id, organizationName: organization.rows[0]?.name ?? 'firma', domain: config.mailReceivingDomain, primary: true });
    });
    return reply.code(201).send(alias);
  });

  app.post('/api/organizations/:id/email-aliases/:aliasId/disable', async (request, reply) => {
    const auth = await requireBrowserAuth(request, database);
    requireCsrf(request, auth);
    requireRole(auth, ['admin']);
    const { id, aliasId } = z.object({ id: z.string().uuid(), aliasId: z.string().uuid() }).parse(request.params);
    await requireOrganizationAccess(database, auth, id);
    const result = await database.query(
      `UPDATE organization_email_aliases SET status='disabled', is_primary=false, disabled_at=now()
        WHERE id=$1 AND organization_id=$2 AND tenant_id=$3 AND is_primary=false`,
      [aliasId, id, auth.tenantId],
    );
    if (result.rowCount === 0) throw new HttpError(409, 'alias_not_disabled', 'Primárny alias nemožno vypnúť bez náhrady');
    return reply.code(204).send();
  });
}

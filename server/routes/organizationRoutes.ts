import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { requireBrowserAuth, requireCsrf, requireOrganizationAccess, requireRole } from '../auth.js';
import { writeAudit } from '../audit.js';
import type { ServerConfig } from '../config.js';
import type { Database } from '../db/database.js';
import { HttpError } from '../http.js';
import { insertCustomAlias, insertUniqueAlias, type AliasRecord } from '../services/organizationService.js';
import { loadDphProfil } from '../services/dphProfileService.js';
import { loadUctovnyProfil } from '../services/accountingProfileService.js';

const organizationSchema = z.object({
  nazov: z.string().trim().min(1).max(200),
  // FO nepodnikateľ nemá IČO — povinnosť pre firmu sa vynucuje v handleri.
  ico: z.string().regex(/^\d{8}$/).or(z.literal('')).default(''),
  dic: z.string().trim().max(20).default(''),
  icDph: z.string().trim().max(20).optional(),
  farba: z.string().regex(/^#[0-9A-Fa-f]{6}$/),
  typSubjektu: z.enum(['company', 'fo_nepodnikatel']).default('company'),
  ulica: z.string().trim().max(200).optional(),
  mesto: z.string().trim().max(120).optional(),
  psc: z.string().trim().max(12).optional(),
  krajina: z.string().trim().max(56).optional(),
  senderWhitelist: z.array(z.string().trim().min(3).max(200)).max(200).default([]),
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

const uctovnyProfilSchema = z.object({
  obdobieUctovania: z.enum(['mesacne', 'stvrtrocne']),
  zaokruhlovanieCelkom: z.enum(['centy', 'pat_centov', 'eura']),
  zaokruhlovanieDph: z.enum(['matematicky', 'nahor', 'nadol']),
  parovanieDodavatelov: z.array(z.enum(['ico', 'ic_dph', 'iban', 'nazov'])).min(1).max(4)
    .refine((values) => new Set(values).size === values.length, 'Kritériá párovania sa nesmú opakovať'),
  uctovnyRozvrh: z.array(z.object({
    ucet: z.string().trim().min(1).max(10),
    nazov: z.string().trim().min(1).max(200),
    analytiky: z.array(z.string().trim().min(1).max(10)).max(50),
  }).strict()).max(500).default([]),
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
  subject_type?: string;
  street?: string;
  city?: string;
  zip?: string;
  country?: string;
  sender_whitelist?: string[];
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
    typSubjektu: (row.subject_type as 'company' | 'fo_nepodnikatel' | undefined) ?? 'company',
    ulica: row.street ?? undefined,
    mesto: row.city ?? undefined,
    psc: row.zip ?? undefined,
    krajina: row.country ?? undefined,
    senderWhitelist: row.sender_whitelist ?? [],
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

  // Účtovný profil klienta (2. časť) — obdobie, zaokrúhľovanie, párovanie
  // dodávateľov a účtovný rozvrh s analytikami. Upsert (admin).
  app.put('/api/organizations/:organizationId/accounting-profile', async (request) => {
    const auth = await requireBrowserAuth(request, database);
    requireCsrf(request, auth);
    requireRole(auth, ['admin']);
    const { organizationId } = z.object({ organizationId: z.string().uuid() }).parse(request.params);
    await requireOrganizationAccess(database, auth, organizationId);
    const body = uctovnyProfilSchema.parse(request.body);
    await database.query(
      `INSERT INTO organization_accounting_profiles
        (organization_id, tenant_id, obdobie_uctovania, zaokruhlovanie_celkom, zaokruhlovanie_dph,
         parovanie_dodavatelov, uctovny_rozvrh, updated_by, updated_at)
       VALUES ($1,$2,$3,$4,$5,$6::jsonb,$7::jsonb,$8,now())
       ON CONFLICT (organization_id) DO UPDATE SET
         obdobie_uctovania=excluded.obdobie_uctovania,
         zaokruhlovanie_celkom=excluded.zaokruhlovanie_celkom,
         zaokruhlovanie_dph=excluded.zaokruhlovanie_dph,
         parovanie_dodavatelov=excluded.parovanie_dodavatelov,
         uctovny_rozvrh=excluded.uctovny_rozvrh,
         updated_by=excluded.updated_by, updated_at=now()`,
      [organizationId, auth.tenantId, body.obdobieUctovania, body.zaokruhlovanieCelkom,
        body.zaokruhlovanieDph, JSON.stringify(body.parovanieDodavatelov),
        JSON.stringify(body.uctovnyRozvrh), auth.userId],
    );
    await writeAudit(database, {
      tenantId: auth.tenantId,
      organizationId,
      actorType: 'user',
      actorId: auth.userId,
      action: 'organization.accounting_profile_updated',
      entityType: 'organization',
      entityId: organizationId,
      correlationId: request.id,
      metadata: { obdobieUctovania: body.obdobieUctovania },
    });
    return await loadUctovnyProfil(database, auth.tenantId, organizationId);
  });

  // Preddefinované poznámky — celý zoznam sa nahrádza naraz (jednoduchý PUT).
  app.put('/api/organizations/:organizationId/note-templates', async (request) => {
    const auth = await requireBrowserAuth(request, database);
    requireCsrf(request, auth);
    requireRole(auth, ['admin', 'uctovnik']);
    const { organizationId } = z.object({ organizationId: z.string().uuid() }).parse(request.params);
    await requireOrganizationAccess(database, auth, organizationId);
    const body = z.object({
      poznamky: z.array(z.string().trim().min(1).max(500)).max(100),
    }).strict().parse(request.body);
    await database.transaction(async (tx) => {
      await tx.query('DELETE FROM note_templates WHERE organization_id=$1 AND tenant_id=$2', [organizationId, auth.tenantId]);
      for (const text of body.poznamky) {
        await tx.query(
          'INSERT INTO note_templates (id, tenant_id, organization_id, text, created_by) VALUES ($1,$2,$3,$4,$5)',
          [randomUUID(), auth.tenantId, organizationId, text, auth.userId],
        );
      }
    });
    await writeAudit(database, {
      tenantId: auth.tenantId,
      organizationId,
      actorType: 'user',
      actorId: auth.userId,
      action: 'organization.note_templates_updated',
      entityType: 'organization',
      entityId: organizationId,
      correlationId: request.id,
      metadata: { count: body.poznamky.length },
    });
    return { poznamky: body.poznamky };
  });

  // E-mailové šablóny — celý zoznam sa nahrádza naraz.
  app.put('/api/organizations/:organizationId/email-templates', async (request) => {
    const auth = await requireBrowserAuth(request, database);
    requireCsrf(request, auth);
    requireRole(auth, ['admin', 'uctovnik']);
    const { organizationId } = z.object({ organizationId: z.string().uuid() }).parse(request.params);
    await requireOrganizationAccess(database, auth, organizationId);
    const body = z.object({
      sablony: z.array(z.object({
        nazov: z.string().trim().min(1).max(120),
        predmet: z.string().trim().min(1).max(300),
        telo: z.string().trim().min(1).max(5000),
      }).strict()).max(100),
    }).strict().parse(request.body);
    await database.transaction(async (tx) => {
      await tx.query('DELETE FROM email_templates WHERE organization_id=$1 AND tenant_id=$2', [organizationId, auth.tenantId]);
      for (const sablona of body.sablony) {
        await tx.query(
          `INSERT INTO email_templates (id, tenant_id, organization_id, name, subject, body, updated_by)
           VALUES ($1,$2,$3,$4,$5,$6,$7)`,
          [randomUUID(), auth.tenantId, organizationId, sablona.nazov, sablona.predmet, sablona.telo, auth.userId],
        );
      }
    });
    await writeAudit(database, {
      tenantId: auth.tenantId,
      organizationId,
      actorType: 'user',
      actorId: auth.userId,
      action: 'organization.email_templates_updated',
      entityType: 'organization',
      entityId: organizationId,
      correlationId: request.id,
      metadata: { count: body.sablony.length },
    });
    return { sablony: body.sablony };
  });

  app.get('/api/organizations', async (request) => {
    const auth = await requireBrowserAuth(request, database);
    const result = await database.query<OrganizationRow>(
      `SELECT o.*, a.address AS email_alias
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
      `SELECT o.*, a.address AS email_alias
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
    if (body.typSubjektu === 'company' && !body.ico) {
      throw new HttpError(400, 'organization_ico_required', 'IČO je pre firmu povinné');
    }
    const organizationId = randomUUID();
    const result = await database.transaction(async (tx) => {
      if (body.ico) {
        const duplicate = await tx.query('SELECT 1 FROM organizations WHERE tenant_id = $1 AND ico = $2', [auth.tenantId, body.ico]);
        if (duplicate.rowCount > 0) throw new HttpError(409, 'organization_ico_exists', 'Organizácia s týmto IČO už existuje');
      }
      await tx.query(
        `INSERT INTO organizations (id, tenant_id, name, ico, dic, ic_dph, color,
           subject_type, street, city, zip, country, sender_whitelist)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13::jsonb)`,
        [organizationId, auth.tenantId, body.nazov, body.ico, body.dic, body.icDph ?? null, body.farba,
          body.typSubjektu, body.ulica ?? null, body.mesto ?? null, body.psc ?? null, body.krajina ?? null,
          JSON.stringify(body.senderWhitelist)],
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
        subject_type: body.typSubjektu,
        street: body.ulica,
        city: body.mesto,
        zip: body.psc,
        country: body.krajina,
        sender_whitelist: body.senderWhitelist,
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
      'SELECT * FROM organizations WHERE id = $1 AND tenant_id = $2',
      [id, auth.tenantId],
    );
    const row = current.rows[0];
    if (!row) throw new HttpError(404, 'organization_not_found', 'Organizácia neexistuje');
    const typSubjektu = body.typSubjektu ?? (row.subject_type as 'company' | 'fo_nepodnikatel' | undefined) ?? 'company';
    if (typSubjektu === 'company' && !(body.ico ?? row.ico)) {
      throw new HttpError(400, 'organization_ico_required', 'IČO je pre firmu povinné');
    }
    await database.query(
      `UPDATE organizations SET name=$1, ico=$2, dic=$3, ic_dph=$4, color=$5,
              subject_type=$6, street=$7, city=$8, zip=$9, country=$10, sender_whitelist=$11::jsonb,
              updated_at=now()
        WHERE id=$12 AND tenant_id=$13`,
      [body.nazov ?? row.name, body.ico ?? row.ico, body.dic ?? row.dic, body.icDph ?? row.ic_dph ?? null, body.farba ?? row.color,
        typSubjektu, body.ulica ?? row.street ?? null, body.mesto ?? row.city ?? null,
        body.psc ?? row.zip ?? null, body.krajina ?? row.country ?? null,
        JSON.stringify(body.senderWhitelist ?? row.sender_whitelist ?? []),
        id, auth.tenantId],
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

  // Vlastný alias: ručne priradí organizácii ľubovoľnú e-mailovú adresu (napr.
  // plus-adresu Gmailu firma+ags@gmail.com). Umožní smerovať doklady na správnu
  // firmu aj z jednej reálnej schránky bez vlastného poštového domény.
  app.post('/api/organizations/:id/email-aliases/custom', async (request, reply) => {
    const auth = await requireBrowserAuth(request, database);
    requireCsrf(request, auth);
    requireRole(auth, ['admin']);
    const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
    const { address } = z.object({ address: z.string().trim().min(3).max(200) }).strict().parse(request.body);
    await requireOrganizationAccess(database, auth, id);
    const organization = await database.query<{ name: string } & Record<string, unknown>>(
      'SELECT name FROM organizations WHERE id=$1 AND tenant_id=$2',
      [id, auth.tenantId],
    );
    if (!organization.rows[0]) throw new HttpError(404, 'organization_not_found', 'Organizácia neexistuje');
    const alias = await insertCustomAlias(database, {
      tenantId: auth.tenantId,
      organizationId: id,
      organizationName: organization.rows[0].name,
      address,
    });
    await writeAudit(database, {
      tenantId: auth.tenantId,
      organizationId: id,
      actorType: 'user',
      actorId: auth.userId,
      action: 'alias.custom_added',
      entityType: 'organization',
      entityId: id,
      correlationId: request.id,
    });
    return reply.code(201).send(alias);
  });
}

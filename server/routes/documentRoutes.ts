import { contentDisposition } from '../contentDisposition.js';
import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { writeAudit } from '../audit.js';
import { requireBrowserAuth, requireCsrf, requireOrganizationAccess, requireRole } from '../auth.js';
import type { Database } from '../db/database.js';
import { HttpError } from '../http.js';
import { buildApprovedDocumentsXml } from '../services/exportService.js';
import type { ObjectStorage } from '../storage.js';
import type { ServerConfig } from '../config.js';
import { sha256 } from '../security.js';
import { classifyXml } from '../inbound/xmlClassifier.js';
import { detectedMimeType, safeName } from '../inbound/attachmentMime.js';
import { extractionResultSchema } from '../extraction/contract.js';
import { normalizeExtractionResult, validateExtractionResult, validateNormalizedExtraction } from '../extraction/normalize.js';
import { forgetUctoDecision, rebuildAccountingSuggestion, recordUctoDecision, updateRuleFeedback } from '../services/accountingSuggestionService.js';
import { posudDph } from '../services/dphAdvisor.js';
import { loadDphProfil, predvolenyDphProfil } from '../services/dphProfileService.js';
import { PRECO_POLIA, precoVysvetlenie } from '../services/precoVysvetlenieService.js';
import { isTechnicalDuplicate } from '../inbound/duplicateCheck.js';

interface DocumentScope extends Record<string, unknown> {
  id: string;
  organization_id: string;
  status: string;
  processing_status: string;
  version: number;
  document_type: string;
  extracted: Record<string, unknown>;
  accounting: Record<string, string | undefined>;
  history: Array<Record<string, unknown>>;
  split_from_document_id?: string | null;
}

async function scopedDocument(database: Database, tenantId: string, id: string): Promise<DocumentScope> {
  const result = await database.query<DocumentScope>(
    `SELECT id, organization_id, status, processing_status, version, document_type, extracted, accounting,
            history, split_from_document_id
       FROM documents WHERE id=$1 AND tenant_id=$2`, [id, tenantId],
  );
  if (!result.rows[0]) throw new HttpError(404, 'document_not_found', 'Doklad neexistuje');
  return result.rows[0];
}

/**
 * Doklad, na ktorom visí zdrojová príloha. Časti rozdelenia (či už ich vyrobil
 * účtovník ručne, alebo pravidlo firmy z jedného rozboru miezd) vlastný záznam
 * v inbound_attachments nemajú — zdieľajú sken pôvodného dokladu. Bez tohto
 * presmerovania sa im náhľad aj sťahovanie skončí na „Zdrojový súbor neexistuje".
 */
function dokladSPrilohou(document: DocumentScope, id: string): string {
  return document.split_from_document_id ?? id;
}

/**
 * Sumy dokladu po presune položiek. Rozpis DPH sa skladá zo sadzieb položiek —
 * inak by po rozdelení jedna časť niesla DPH tej druhej a doklad by neprešiel
 * validáciou pred schválením.
 */
function sumyZPoloziek(polozky: Array<Record<string, any>>): { rozpisDph: Array<Record<string, number>>; sumaSpolu: number } {
  const round2 = (value: number) => Math.round((value + Number.EPSILON) * 100) / 100;
  const podlaSadzby = new Map<number, { sadzba: number; zaklad: number; dph: number }>();
  let sumaSpolu = 0;
  for (const polozka of polozky) {
    const sadzba = Number(polozka?.sadzbaDph ?? 0);
    const zaklad = Number(polozka?.sumaBezDph ?? 0);
    const dph = Number(polozka?.sumaDph ?? 0);
    const riadok = podlaSadzby.get(sadzba) ?? { sadzba, zaklad: 0, dph: 0 };
    riadok.zaklad = round2(riadok.zaklad + (Number.isFinite(zaklad) ? zaklad : 0));
    riadok.dph = round2(riadok.dph + (Number.isFinite(dph) ? dph : 0));
    podlaSadzby.set(sadzba, riadok);
    const spolu = Number(polozka?.sumaSpolu ?? 0);
    sumaSpolu = round2(sumaSpolu + (Number.isFinite(spolu) ? spolu : 0));
  }
  return {
    rozpisDph: [...podlaSadzby.values()].sort((left, right) => right.sadzba - left.sadzba),
    sumaSpolu,
  };
}

/** Zvolené členenie DPH dokladu rozpísané z číselníka (pre dphAdvisor). */
async function clenenieDphDokladu(
  database: Database,
  tenantId: string,
  document: DocumentScope,
): Promise<{ id: string; kod: string; nazov: string } | undefined> {
  const clenenieDphId = document.accounting?.clenenieDphId;
  if (!clenenieDphId) return undefined;
  const result = await database.query<{ id: string; code: string; name: string } & Record<string, unknown>>(
    'SELECT id, code, name FROM code_list_items WHERE id=$1 AND tenant_id=$2 AND organization_id=$3',
    [clenenieDphId, tenantId, document.organization_id],
  );
  const row = result.rows[0];
  return row ? { id: row.id, kod: row.code, nazov: row.name } : undefined;
}

export function registerDocumentRoutes(app: FastifyInstance, database: Database, storage: ObjectStorage, config: ServerConfig): void {
  app.get('/api/documents', async (request) => {
    const auth = await requireBrowserAuth(request, database);
    const query = z.object({ organizationId: z.string().uuid().optional(), status: z.string().max(40).optional() }).parse(request.query);
    if (query.organizationId) await requireOrganizationAccess(database, auth, query.organizationId);
    const result = await database.query(
      `SELECT d.* FROM documents d
        JOIN organization_memberships m ON m.organization_id=d.organization_id AND m.tenant_id=d.tenant_id
       WHERE d.tenant_id=$1 AND m.user_id=$2
         AND ($3::text IS NULL OR d.organization_id=$3)
         AND ($4::text IS NULL OR d.status=$4)
       ORDER BY d.created_at DESC LIMIT 500`,
      [auth.tenantId, auth.userId, query.organizationId ?? null, query.status ?? null],
    );
    return result.rows;
  });

  // Účtovník uzavrel rozpor medzi pamäťou a právnou kontrolou. Verdikt sa
  // nemaže — zostáva ako stopa toho, čo kontrola hovorila, aj keď sa účtovník
  // rozhodol inak. Bez toho by sa pri spätnej kontrole nedalo zistiť, či bol
  // rozpor prehliadnutý alebo vedome zamietnutý.
  app.post('/api/documents/:id/dph-audit/rozhodnutie', async (request) => {
    const auth = await requireBrowserAuth(request, database);
    requireCsrf(request, auth);
    const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
    const body = z.object({ rozhodnutie: z.enum(['prijate', 'ponechane']) }).strict().parse(request.body);
    const document = await scopedDocument(database, auth.tenantId, id);
    await requireOrganizationAccess(database, auth, document.organization_id);
    const result = await database.query(
      `UPDATE dph_audit SET rozhodnutie=$1, rozhodol_uzivatel=$2, rozhodnute_at=now(), updated_at=now()
        WHERE document_id=$3 AND tenant_id=$4`,
      [body.rozhodnutie, auth.name, id, auth.tenantId],
    );
    if (result.rowCount === 0) throw new HttpError(404, 'audit_not_found', 'Kontrola DPH pre tento doklad neexistuje');
    return { ok: true };
  });

  app.get('/api/documents/:id', async (request) => {
    const auth = await requireBrowserAuth(request, database);
    const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
    const document = await scopedDocument(database, auth.tenantId, id);
    await requireOrganizationAccess(database, auth, document.organization_id);
    const details = await database.query<Record<string, unknown>>('SELECT * FROM documents WHERE id=$1 AND tenant_id=$2', [id, auth.tenantId]);
    const attachment = await database.query<{ storage_key?: string } & Record<string, unknown>>(
      'SELECT storage_key FROM inbound_attachments WHERE document_id=$1 AND tenant_id=$2',
      [dokladSPrilohou(document, id), auth.tenantId],
    );
    const storageKey = attachment.rows[0]?.storage_key;
    return { ...details.rows[0], fileUrl: storageKey ? await storage.signedDownloadUrl(storageKey, 300) : undefined };
  });

  app.get('/api/documents/:id/file', async (request, reply) => {
    const auth = await requireBrowserAuth(request, database);
    const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
    const document = await scopedDocument(database, auth.tenantId, id);
    await requireOrganizationAccess(database, auth, document.organization_id);
    const attachment = await database.query<{
      storage_key?: string; detected_mime_type?: string; original_file_name: string;
    } & Record<string, unknown>>(
      `SELECT storage_key,detected_mime_type,original_file_name FROM inbound_attachments
        WHERE document_id=$1 AND tenant_id=$2 AND organization_id=$3 ORDER BY created_at LIMIT 1`,
      [dokladSPrilohou(document, id), auth.tenantId, document.organization_id],
    );
    const source = attachment.rows[0];
    if (!source?.storage_key) throw new HttpError(404, 'attachment_missing', 'Zdrojový súbor neexistuje');
    reply.header('Content-Type', source.detected_mime_type ?? 'application/octet-stream');
    reply.header('Content-Disposition', contentDisposition('inline', source.original_file_name));
    return reply.send(Buffer.from(await storage.get(source.storage_key)));
  });

  app.patch('/api/documents/:id', async (request) => {
    const auth = await requireBrowserAuth(request, database);
    requireCsrf(request, auth);
    requireRole(auth, ['admin', 'uctovnik']);
    const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
    const body = z.object({
      documentType: z.enum(['FP','FV','BV','MZDY','OZ','PD']).optional(),
      extracted: z.record(z.string(), z.unknown()).optional(),
      accounting: z.record(z.string(), z.string().optional()).optional(),
      expectedVersion: z.number().int().positive(),
    }).strict().parse(request.body);
    const document = await scopedDocument(database, auth.tenantId, id);
    await requireOrganizationAccess(database, auth, document.organization_id);
    if (document.version !== body.expectedVersion) throw new HttpError(409, 'version_conflict', 'Doklad bol medzitým zmenený');
    // Exportovaný doklad je uzamknutý — PATCH by potichu zmazal approved_snapshot
    // a rozišiel obsah s už vytvoreným exportom pre POHODU.
    if (document.status === 'exportovany') {
      throw new HttpError(409, 'document_exported', 'Exportovaný doklad nie je možné upravovať');
    }
    const approvedChanged = document.status === 'schvaleny';
    const result = await database.query<Record<string, unknown>>(
      `UPDATE documents SET document_type=$1, extracted=$2::jsonb, accounting=$3::jsonb,
              version=version+1, status=$4, approved_version=NULL, approved_snapshot=NULL, updated_at=now()
        WHERE id=$5 AND tenant_id=$6 AND version=$7 RETURNING *`,
      [body.documentType ?? document.document_type, JSON.stringify(body.extracted ?? document.extracted),
        JSON.stringify(body.accounting ?? document.accounting), approvedChanged ? 'na_kontrole' : document.status,
        id, auth.tenantId, body.expectedVersion],
    );
    if (!result.rows[0]) throw new HttpError(409, 'version_conflict', 'Doklad bol medzitým zmenený');
    // Úprava schváleného dokladu ruší potvrdenie — rozhodnutie sa vyradí z pamäte.
    if (approvedChanged) await forgetUctoDecision(database, auth.tenantId, id);
    return result.rows[0];
  });

  app.post('/api/documents/:id/approve', async (request) => {
    const auth = await requireBrowserAuth(request, database);
    requireCsrf(request, auth);
    requireRole(auth, ['admin', 'uctovnik', 'schvalovatel']);
    const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
    const { expectedVersion } = z.object({ expectedVersion: z.number().int().positive() }).strict().parse(request.body);
    const document = await scopedDocument(database, auth.tenantId, id);
    await requireOrganizationAccess(database, auth, document.organization_id);
    if (document.version !== expectedVersion) throw new HttpError(409, 'version_conflict', 'Doklad bol medzitým zmenený');
    if (!['na_kontrole', 'extrahovany'].includes(document.status) || document.processing_status !== 'ready_for_review') {
      throw new HttpError(409, 'document_not_ready', 'Doklad ešte nie je pripravený na schválenie');
    }
    // Schvaľovanie podľa sumy: od prahu smie schváliť len vyhradená rola
    // (admin vždy). Deterministická kontrola pred všetkými ostatnými.
    const approvalRule = await database.query<{ min_amount: string | number; required_role: string } & Record<string, unknown>>(
      'SELECT min_amount, required_role FROM approval_rules WHERE organization_id=$1 AND tenant_id=$2 AND active=true',
      [document.organization_id, auth.tenantId],
    );
    const rule = approvalRule.rows[0];
    const documentTotal = Number((document.extracted as any)?.sumaSpolu ?? 0);
    if (rule && documentTotal >= Number(rule.min_amount)) {
      const allowedRoles = rule.required_role === 'admin' ? ['admin'] : ['admin', 'schvalovatel'];
      if (!allowedRoles.includes(auth.role)) {
        throw new HttpError(
          403,
          'approval_threshold',
          `Doklad od ${Number(rule.min_amount).toFixed(2)} € musí schváliť ${rule.required_role === 'admin' ? 'administrátor' : 'schvaľovateľ'}`,
        );
      }
    }
    const organization = await database.query<{ ico: string; dic?: string; ic_dph?: string } & Record<string, unknown>>(
      'SELECT ico,dic,ic_dph FROM organizations WHERE id=$1 AND tenant_id=$2',
      [document.organization_id, auth.tenantId],
    );
    const extracted = document.extracted as any;
    const validationIssues = validateNormalizedExtraction({
      documentType: document.document_type as any,
      extracted,
      fieldConfidence: {},
      confidence: 0,
      totalAmount: Number(extracted.sumaSpolu),
      currency: extracted.mena,
    }, organization.rows[0]);
    const validationErrors = validationIssues.filter((issue) => issue.severity === 'error');
    if (validationErrors.length > 0) {
      // Konkrétne dôvody v message — generická hláška nechala používateľa
      // hádať, ktoré pole blokuje schválenie.
      throw new HttpError(
        409,
        'document_validation_failed',
        `Doklad obsahuje údaje, ktoré treba opraviť pred schválením: ${validationErrors.map((issue) => issue.message).join('; ')}`,
        { issues: validationErrors },
      );
    }
    // BV nemá číselný rad ani členenie DPH (POHODA čísluje pohyby výpisom);
    // povinný je bankový účet a zaúčtovanie každého pohybu — pohyb bez vlastnej
    // predkontácie dedí hlavičkovú, presne ako pri exporte.
    const requiredIds = document.document_type === 'BV'
      ? [document.accounting.predkontaciaId].filter(Boolean)
      : [document.accounting.predkontaciaId, document.accounting.clenenieDphId, document.accounting.ciselnyRadId];
    if (document.document_type !== 'BV' && requiredIds.some((value) => !value)) {
      throw new HttpError(409, 'accounting_incomplete', 'Zaúčtovanie nie je kompletné');
    }
    if (document.document_type === 'PD' && (!document.accounting.pokladnaKod || !['receipt', 'expense'].includes(document.accounting.pokladnaTyp ?? ''))) {
      throw new HttpError(409, 'cash_account_required', 'Pre pokladničný doklad je povinný kód pokladne a typ príjem/výdaj');
    }
    if (document.document_type === 'BV') {
      if (!String(document.accounting.bankUcetKod ?? '').trim()) {
        throw new HttpError(409, 'bank_account_required', 'Pre bankový výpis je povinný účet POHODY (skratka z číselníka bankových účtov)');
      }
      // Export podporuje zatiaľ len domácu menu — schválený devízový výpis by
      // zhodil celú exportnú dávku, tak sa zastaví už tu s jasným dôvodom.
      if ((extracted.mena ?? 'EUR') !== 'EUR') {
        throw new HttpError(409, 'bank_currency_unsupported', `Výpis v mene ${extracted.mena} sa zatiaľ nedá exportovať — podporovaná je len mena EUR`);
      }
      const pohyby = Array.isArray(extracted.polozky) ? extracted.polozky : [];
      if (pohyby.length === 0) throw new HttpError(409, 'bank_movements_required', 'Bankový výpis nemá žiadne pohyby');
      const bezSumy = pohyby.filter((pohyb: any) => !Number.isFinite(Number(pohyb?.sumaSpolu)));
      if (bezSumy.length > 0) {
        throw new HttpError(409, 'movement_amount_required', `${bezSumy.length} pohybov výpisu nemá sumu — AI ju z podkladu neprečítala, doplňte ju ručne`);
      }
      const bezPredkontacie = pohyby.filter((pohyb: any) => !pohyb?.ucto?.predkontaciaId && !document.accounting.predkontaciaId);
      if (bezPredkontacie.length > 0) {
        throw new HttpError(409, 'movement_accounting_incomplete', `${bezPredkontacie.length} pohybov výpisu nemá predkontáciu`);
      }
      // POHODA má pre banku vlastné predkontácie a smer nesie agenda:
      // bankReceived = príjem, bankIssued = výdaj. Predkontácia so ZNÁMOU inou
      // agendou (fakturová, pokladničná či opačný smer) by import zaúčtovala
      // zle — blokuje sa tu; položky bez agendy (ručné) prechádzajú.
      const pouziteIds = [...new Set<string>([
        ...pohyby.map((pohyb: any) => pohyb?.ucto?.predkontaciaId).filter(Boolean),
        ...(document.accounting.predkontaciaId ? [document.accounting.predkontaciaId] : []),
      ])];
      if (pouziteIds.length > 0) {
        const agendy = new Map((await database.query<{ id: string; agenda: string | null } & Record<string, unknown>>(
          `SELECT id, agenda FROM code_list_items WHERE tenant_id=$1 AND organization_id=$2 AND id=ANY($3::text[])`,
          [auth.tenantId, document.organization_id, pouziteIds],
        )).rows.map((row) => [row.id, row.agenda]));
        pohyby.forEach((pohyb: any, index: number) => {
          const agenda = agendy.get(pohyb?.ucto?.predkontaciaId ?? document.accounting.predkontaciaId ?? '');
          if (!agenda) return; // bez agendy = ručná položka, nechá sa prejsť
          const suma = Number(pohyb?.sumaSpolu);
          const chcena = suma < 0 ? 'bankIssued' : 'bankReceived';
          if (agenda !== chcena) {
            throw new HttpError(409, 'movement_accounting_wrong_agenda',
              `Pohyb ${index + 1} má predkontáciu agendy „${agenda}" — ${suma < 0 ? 'výdaj' : 'príjem'} banky potrebuje predkontáciu ${chcena === 'bankIssued' ? 'Banka výdaj' : 'Banka príjem'}`);
          }
        });
      }
      // Predkontácie pohybov musia patriť organizácii a byť aktívne.
      requiredIds.push(...new Set<string>(pohyby.map((pohyb: any) => pohyb?.ucto?.predkontaciaId).filter(Boolean)));
    }
    if (requiredIds.length > 0) {
      const valid = await database.query(
        `SELECT id FROM code_list_items
          WHERE tenant_id=$1 AND organization_id=$2 AND active=true AND id=ANY($3::text[])`,
        [auth.tenantId, document.organization_id, requiredIds],
      );
      if (valid.rowCount !== new Set(requiredIds).size) throw new HttpError(409, 'code_list_invalid', 'Číselník nepatrí organizácii alebo nie je aktívny');
    }
    if (document.document_type === 'BV') {
      const ucet = await database.query(
        `SELECT 1 FROM code_list_items
          WHERE tenant_id=$1 AND organization_id=$2 AND kind='bankoveUcty' AND active=true AND trim(code)=trim($3)`,
        [auth.tenantId, document.organization_id, String(document.accounting.bankUcetKod)],
      );
      if (ucet.rowCount === 0) throw new HttpError(409, 'bank_account_invalid', 'Bankový účet nie je v číselníku organizácie');
    }
    // DPH profil klienta: deterministické blokácie (napr. neplatiteľ so
    // zvoleným odpočtom) sa nedajú obísť klientom — kontrola beží na serveri.
    // Firma bez vyplneného profilu dostane predvolený: kontroly zo samotného
    // dokladu (cudzia daň zahraničného dodávateľa) musia platiť pre všetkých.
    const dphProfil = await loadDphProfil(database, auth.tenantId, document.organization_id)
      ?? predvolenyDphProfil(auth.tenantId, document.organization_id);
    const dphPosudok = posudDph({
      documentType: document.document_type,
      extracted: document.extracted,
      accounting: document.accounting,
      clenenieDph: await clenenieDphDokladu(database, auth.tenantId, document),
    }, dphProfil);
    if (dphPosudok.blokacie.length > 0) {
      throw new HttpError(409, 'dph_profil_blokacia', dphPosudok.blokacie[0].sprava);
    }
    const approvedVersion = expectedVersion + 1;
    // Podtyp ide do snapshotu spolu s typom — invoiceType pre POHODU sa určuje
    // z dvojice a bez neho by dobropis odišiel ako bežná faktúra.
    const snapshot = { version: approvedVersion, approvedAt: new Date().toISOString(), typ: document.document_type, podtyp: document.podtyp ?? 'bezna', extracted: document.extracted, ucto: document.accounting };
    const result = await database.query<Record<string, unknown>>(
      `UPDATE documents SET status='schvaleny', version=$1, approved_version=$1, approved_snapshot=$2::jsonb, updated_at=now()
        WHERE id=$3 AND tenant_id=$4 AND version=$5 RETURNING *`,
      [approvedVersion, JSON.stringify(snapshot), id, auth.tenantId, expectedVersion],
    );
    if (!result.rows[0]) throw new HttpError(409, 'version_conflict', 'Doklad bol medzitým zmenený');
    // Pamäť rozhodnutí: potvrdené zaúčtovanie sa uloží ako vzor pre budúce návrhy.
    await recordUctoDecision(database, {
      tenantId: auth.tenantId,
      organizationId: document.organization_id,
      documentId: id,
      documentType: String(document.document_type ?? '') || undefined,
      podtyp: String(document.podtyp ?? 'bezna'),
      extracted: document.extracted,
      accounting: document.accounting,
    });
    // Samokontrola pravidiel: zhoda so schváleným = potvrdenie, rozdiel = oprava.
    await updateRuleFeedback(database, { tenantId: auth.tenantId, documentId: id, accounting: document.accounting });
    await writeAudit(database, { tenantId: auth.tenantId, organizationId: document.organization_id, actorType: 'user', actorId: auth.userId, action: 'document.approved', entityType: 'document', entityId: id, correlationId: request.id, metadata: { version: approvedVersion } });
    return result.rows[0];
  });

  // Komunikácia na doklade: komentár s @-spomenutiami. Spomenutia sa
  // rozpoznávajú deterministicky na serveri podľa mien aktívnych používateľov
  // tenanta. Verzia dokladu sa nemení — komentár nie je účtovná zmena.
  app.post('/api/documents/:id/comments', async (request) => {
    const auth = await requireBrowserAuth(request, database);
    requireCsrf(request, auth);
    requireRole(auth, ['admin', 'uctovnik', 'schvalovatel']);
    const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
    const { text } = z.object({ text: z.string().trim().min(1).max(4000) }).strict().parse(request.body);
    const document = await scopedDocument(database, auth.tenantId, id);
    await requireOrganizationAccess(database, auth, document.organization_id);
    const users = await database.query<{ id: string; name: string } & Record<string, unknown>>(
      'SELECT id, name FROM users WHERE tenant_id=$1 AND active=true', [auth.tenantId],
    );
    const author = users.rows.find((row) => row.id === auth.userId);
    const mentions = users.rows
      .filter((row) => row.name && text.includes(`@${row.name}`))
      .map((row) => row.id);
    const comment = {
      ts: new Date().toISOString(),
      user: author?.name ?? 'Používateľ',
      text,
      mentions,
    };
    const historyEntry = { ts: comment.ts, user: comment.user, akcia: 'Komentár pridaný' };
    const result = await database.query<Record<string, unknown>>(
      `UPDATE documents SET comments = comments || $1::jsonb, history = history || $2::jsonb, updated_at=now()
        WHERE id=$3 AND tenant_id=$4 RETURNING *`,
      [JSON.stringify([comment]), JSON.stringify([historyEntry]), id, auth.tenantId],
    );
    await writeAudit(database, {
      tenantId: auth.tenantId,
      organizationId: document.organization_id,
      actorType: 'user',
      actorId: auth.userId,
      action: 'document.commented',
      entityType: 'document',
      entityId: id,
      correlationId: request.id,
      // Obsah komentára sa do auditu nekopíruje — len počet spomenutí.
      metadata: { mentionCount: mentions.length },
    });
    return result.rows[0];
  });

  // DPH poradca: posúdenie dokladu podľa DPH profilu organizácie. Počíta sa
  // vždy nanovo — zmena profilu sa prejaví okamžite bez prepočtu dokladov.
  app.get('/api/documents/:id/dph-advisor', async (request) => {
    const auth = await requireBrowserAuth(request, database);
    const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
    const document = await scopedDocument(database, auth.tenantId, id);
    await requireOrganizationAccess(database, auth, document.organization_id);
    // Bez vyplneného profilu sa použije predvolený — doklad so zahraničnou
    // daňou má dostať varovanie aj vo firme, ktorá profil ešte nenastavila.
    const profil = await loadDphProfil(database, auth.tenantId, document.organization_id)
      ?? predvolenyDphProfil(auth.tenantId, document.organization_id);
    return posudDph({
      documentType: document.document_type,
      extracted: document.extracted,
      accounting: document.accounting,
      clenenieDph: await clenenieDphDokladu(database, auth.tenantId, document),
    }, profil);
  });

  // „Prečo?" — pôvod zaúčtovania dokladu: zdroj návrhu, istota, dôvod a
  // pravidlo, ktoré ho vytvorilo (vrátane ľudského dôvodu pravidla). Čisto
  // deterministické — žiadne LLM, len provenience z accounting_suggestions.
  app.get('/api/documents/:id/preco', async (request) => {
    const auth = await requireBrowserAuth(request, database);
    const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
    const document = await scopedDocument(database, auth.tenantId, id);
    await requireOrganizationAccess(database, auth, document.organization_id);

    const suggestion = (await database.query<Record<string, any>>(
      `SELECT source, confidence, reason, rule_id, predkontacia_id, clenenie_dph_id, clenenie_kv_kod, created_at
         FROM accounting_suggestions
        WHERE document_id=$1 AND tenant_id=$2 AND organization_id=$3`,
      [id, auth.tenantId, document.organization_id],
    )).rows[0];

    const navrh = {
      predkontaciaId: suggestion?.predkontacia_id ?? undefined,
      clenenieDphId: suggestion?.clenenie_dph_id ?? undefined,
      clenenieKvKod: suggestion?.clenenie_kv_kod ?? undefined,
    };
    const aktualne = {
      predkontaciaId: document.accounting.predkontaciaId ?? undefined,
      clenenieDphId: document.accounting.clenenieDphId ?? undefined,
      clenenieKvKod: document.accounting.clenenieKvKod ?? undefined,
    };

    // Názvy kódov pre všetky zúčastnené ID (návrh aj aktuálna hodnota).
    const ids = [...new Set([navrh.predkontaciaId, navrh.clenenieDphId, aktualne.predkontaciaId, aktualne.clenenieDphId].filter(Boolean))] as string[];
    const polozky: Record<string, { kod: string; nazov: string }> = {};
    if (ids.length > 0) {
      const rows = await database.query<{ id: string; code: string; name: string }>(
        `SELECT id, code, name FROM code_list_items
          WHERE tenant_id=$1 AND organization_id=$2 AND id=ANY($3::text[])`,
        [auth.tenantId, document.organization_id, ids],
      );
      for (const row of rows.rows) polozky[row.id] = { kod: row.code, nazov: row.name };
    }

    let pravidlo: Record<string, unknown> | null = null;
    if (suggestion?.rule_id) {
      const rule = (await database.query<Record<string, any>>(
        `SELECT id, supplier_ico, supplier_name_normalized, keywords, dovod, dovod_source
           FROM accounting_rules WHERE id=$1 AND tenant_id=$2 AND organization_id=$3`,
        [suggestion.rule_id, auth.tenantId, document.organization_id],
      )).rows[0];
      if (rule) {
        const pouzite = await database.query<{ n: string }>(
          `SELECT count(*) AS n FROM accounting_suggestions
            WHERE rule_id=$1 AND tenant_id=$2 AND organization_id=$3`,
          [rule.id, auth.tenantId, document.organization_id],
        );
        pravidlo = {
          id: rule.id,
          supplierIco: rule.supplier_ico ?? undefined,
          supplierName: rule.supplier_name_normalized ?? undefined,
          klucoveSlova: Array.isArray(rule.keywords) ? rule.keywords : [],
          dovod: rule.dovod ?? undefined,
          dovodSource: rule.dovod_source ?? undefined,
          navrhnutePre: Number(pouzite.rows[0]?.n ?? 0),
        };
      }
    }

    return {
      organizationId: document.organization_id,
      source: suggestion?.source ?? 'none',
      confidence: Number(suggestion?.confidence ?? 0),
      reason: suggestion?.reason ?? undefined,
      createdAt: suggestion?.created_at ? new Date(String(suggestion.created_at)).toISOString() : undefined,
      navrh,
      aktualne,
      polozky,
      pravidlo,
    };
  });

  // AI vysvetlenie k „Prečo?" — druhá rýchlosť panelu: fakty prídu okamžite
  // z /preco, vysvetlenie sa dogeneruje (a kešuje) tu, zvlášť pre každé pole.
  // Best-effort: null je platná odpoveď (bez API kľúča, bez návrhu, chyba LLM).
  app.get('/api/documents/:id/preco/vysvetlenie', async (request) => {
    const auth = await requireBrowserAuth(request, database);
    const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
    const { pole } = z.object({ pole: z.enum(PRECO_POLIA) }).parse(request.query);
    const document = await scopedDocument(database, auth.tenantId, id);
    await requireOrganizationAccess(database, auth, document.organization_id);
    const vysledok = await precoVysvetlenie(database, config, {
      tenantId: auth.tenantId, organizationId: document.organization_id, documentId: id,
    }, pole);
    return { vysvetlenie: vysledok?.vysvetlenie ?? null, zdroje: vysledok?.zdroje ?? [] };
  });

  for (const [route, status, action] of [
    ['reject', 'zamietnuty', 'document.rejected'],
    ['quarantine', 'karantena', 'document.quarantined'],
  ] as const) {
    app.post(`/api/documents/:id/${route}`, async (request) => {
      const auth = await requireBrowserAuth(request, database);
      requireCsrf(request, auth);
      requireRole(auth, route === 'reject' ? ['admin', 'uctovnik', 'schvalovatel'] : ['admin', 'uctovnik']);
      const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
      const document = await scopedDocument(database, auth.tenantId, id);
      await requireOrganizationAccess(database, auth, document.organization_id);
      const decision = route === 'reject'
        ? z.object({ expectedVersion: z.number().int().positive(), reason: z.string().trim().min(1).max(1000) }).strict().parse(request.body)
        : undefined;
      if (decision && document.version !== decision.expectedVersion) {
        throw new HttpError(409, 'version_conflict', 'Doklad bol medzitým zmenený');
      }
      const history = [
        ...document.history,
        {
          ts: new Date().toISOString(),
          user: auth.name,
          akcia: decision ? `Doklad zamietnutý — dôvod: ${decision.reason}` : 'Doklad presunutý do karantény',
        },
      ];
      const result = await database.query<Record<string, unknown>>(
        `UPDATE documents SET status=$1, version=version+1, approved_version=NULL, approved_snapshot=NULL,
              history=$2::jsonb, updated_at=now()
          WHERE id=$3 AND tenant_id=$4 RETURNING *`,
        [status, JSON.stringify(history), id, auth.tenantId],
      );
      // Zamietnutie/karanténa ruší prípadné schválenie — rozhodnutie von z pamäte.
      await forgetUctoDecision(database, auth.tenantId, id);
      await writeAudit(database, { tenantId: auth.tenantId, organizationId: document.organization_id, actorType: 'user', actorId: auth.userId, action, entityType: 'document', entityId: id, correlationId: request.id });
      return result.rows[0];
    });
  }

  // „Spracovať ručne" — prevzatie problémového dokladu (karanténa/duplicita/
  // chyba) na ručnú kontrolu. Presunie doklad do stavu „na_kontrole", aby ho
  // účtovník/admin mohol doplniť a schváliť. Schvaľovateľ toto právo nemá.
  app.post('/api/documents/:id/process-manually', async (request) => {
    const auth = await requireBrowserAuth(request, database);
    requireCsrf(request, auth);
    requireRole(auth, ['admin', 'uctovnik']);
    const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
    const document = await scopedDocument(database, auth.tenantId, id);
    await requireOrganizationAccess(database, auth, document.organization_id);
    if (!['chyba', 'karantena', 'duplicita'].includes(document.status)) {
      throw new HttpError(409, 'not_problematic', 'Ručné spracovanie je dostupné iba pre problémové doklady (karanténa, duplicita, chyba)');
    }
    const wasDuplicate = document.status === 'duplicita';
    const history = [
      ...document.history,
      { ts: new Date().toISOString(), user: auth.name, akcia: 'Prevzaté na ručné spracovanie' },
    ];
    const result = await database.query<Record<string, unknown>>(
      `UPDATE documents SET status='na_kontrole', quarantine_reason=NULL,
              not_duplicate=CASE WHEN $1 THEN true ELSE not_duplicate END,
              version=version+1, approved_version=NULL, approved_snapshot=NULL,
              history=$2::jsonb, updated_at=now()
        WHERE id=$3 AND tenant_id=$4 RETURNING *`,
      [wasDuplicate, JSON.stringify(history), id, auth.tenantId],
    );
    await writeAudit(database, { tenantId: auth.tenantId, organizationId: document.organization_id, actorType: 'user', actorId: auth.userId, action: 'document.process_manually', entityType: 'document', entityId: id, correlationId: request.id });
    return result.rows[0];
  });

  /**
   * Rozdelenie dokladu: vybrané položky sa presunú do NOVÉHO dokladu (spravidla
   * inej agendy). Jeden prijatý súbor tak môže skončiť v POHODE ako dva zápisy —
   * napr. rekapitulácia miezd: hrubé mzdy interným dokladom, odvody poisťovni
   * ako ostatný záväzok. Sken ostáva pri pôvodnom doklade, nový sa naň odkazuje.
   */
  app.post('/api/documents/:id/split', async (request, reply) => {
    const auth = await requireBrowserAuth(request, database);
    requireCsrf(request, auth);
    requireRole(auth, ['admin', 'uctovnik']);
    const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
    const body = z.object({
      polozkaIds: z.array(z.string().min(1).max(64)).min(1).max(200),
      typ: z.enum(['FP', 'FV', 'BV', 'MZDY', 'OZ', 'PD']),
      expectedVersion: z.number().int().positive(),
    }).strict().parse(request.body);
    const document = await scopedDocument(database, auth.tenantId, id);
    await requireOrganizationAccess(database, auth, document.organization_id);
    if (document.status === 'exportovany') {
      throw new HttpError(409, 'document_exported', 'Exportovaný doklad nie je možné rozdeliť');
    }
    if (document.version !== body.expectedVersion) {
      throw new HttpError(409, 'version_conflict', 'Doklad medzitým niekto zmenil, načítajte ho znova');
    }
    // Rozdeľovať sa dá len doklad, ktorý vznikol priamo zo súboru — reťaz
    // rozdelení by rozbila väzbu na sken aj prehľad, čo z čoho vzniklo.
    if (document.split_from_document_id) {
      throw new HttpError(409, 'already_split', 'Časť rozdeleného dokladu sa už ďalej rozdeliť nedá');
    }

    const extracted = (document.extracted ?? {}) as Record<string, any>;
    const polozky: Array<Record<string, any>> = Array.isArray(extracted.polozky) ? extracted.polozky : [];
    const vybrane = polozky.filter((polozka) => body.polozkaIds.includes(String(polozka?.id)));
    const zostavajuce = polozky.filter((polozka) => !body.polozkaIds.includes(String(polozka?.id)));
    if (vybrane.length === 0) throw new HttpError(422, 'no_items', 'Vyberte aspoň jednu položku');
    if (zostavajuce.length === 0) {
      throw new HttpError(422, 'all_items', 'V pôvodnom doklade musí ostať aspoň jedna položka — inak stačí zmeniť jeho typ');
    }

    const noveId = randomUUID();
    const teraz = new Date().toISOString();
    const novyExtracted = { ...extracted, polozky: vybrane, ...sumyZPoloziek(vybrane) };
    const povodnyExtracted = { ...extracted, polozky: zostavajuce, ...sumyZPoloziek(zostavajuce) };

    await database.transaction(async (tx) => {
      await tx.query(
        `INSERT INTO documents
          (id,tenant_id,organization_id,queue_id,document_type,status,processing_status,source,extracted,
           accounting,field_confidence,confidence,total_amount,currency,history,split_from_document_id)
         SELECT $1,tenant_id,organization_id,queue_id,$2,'na_kontrole','ready_for_review',source,$3::jsonb,
           accounting,field_confidence,confidence,$4,currency,$5::jsonb,$6
           FROM documents WHERE id=$6 AND tenant_id=$7`,
        [noveId, body.typ, JSON.stringify(novyExtracted), novyExtracted.sumaSpolu,
          JSON.stringify([{ ts: teraz, user: auth.name, akcia: `Doklad vznikol rozdelením dokladu ${extracted.cisloFaktury ?? id}` }]),
          id, auth.tenantId],
      );
      await tx.query(
        `UPDATE documents SET extracted=$1::jsonb, total_amount=$2, version=version+1,
                status=CASE WHEN status='schvaleny' THEN 'na_kontrole' ELSE status END,
                approved_version=NULL, approved_snapshot=NULL, history=$3::jsonb, updated_at=now()
          WHERE id=$4 AND tenant_id=$5 AND version=$6`,
        [JSON.stringify(povodnyExtracted), povodnyExtracted.sumaSpolu,
          JSON.stringify([...document.history, { ts: teraz, user: auth.name, akcia: `Z dokladu bolo oddelených ${vybrane.length} položiek` }]),
          id, auth.tenantId, body.expectedVersion],
      );
    });
    await writeAudit(database, {
      tenantId: auth.tenantId, organizationId: document.organization_id, actorType: 'user', actorId: auth.userId,
      action: 'document.split', entityType: 'document', entityId: id, correlationId: request.id,
      metadata: { noveId, polozky: vybrane.length, typ: body.typ },
    });
    return reply.code(201).send({ id: noveId });
  });

  // „Nie je duplicita" — rozhodnutie, že technicky zhodný doklad je predsa len
  // samostatný. Uloží sa príznak a doklad ide na kontrolu (SPEC §11.11).
  app.post('/api/documents/:id/not-duplicate', async (request) => {
    const auth = await requireBrowserAuth(request, database);
    requireCsrf(request, auth);
    requireRole(auth, ['admin', 'uctovnik']);
    const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
    const document = await scopedDocument(database, auth.tenantId, id);
    await requireOrganizationAccess(database, auth, document.organization_id);
    if (document.status !== 'duplicita') {
      throw new HttpError(409, 'not_duplicate_state', 'Rozhodnutie o duplicite je dostupné iba pre doklad označený ako duplicita');
    }
    const history = [
      ...document.history,
      { ts: new Date().toISOString(), user: auth.name, akcia: 'Rozhodnutie: nie je duplicita' },
    ];
    const result = await database.query<Record<string, unknown>>(
      `UPDATE documents SET status='na_kontrole', not_duplicate=true,
              version=version+1, approved_version=NULL, approved_snapshot=NULL,
              history=$1::jsonb, updated_at=now()
        WHERE id=$2 AND tenant_id=$3 RETURNING *`,
      [JSON.stringify(history), id, auth.tenantId],
    );
    await writeAudit(database, { tenantId: auth.tenantId, organizationId: document.organization_id, actorType: 'user', actorId: auth.userId, action: 'document.not_duplicate', entityType: 'document', entityId: id, correlationId: request.id });
    return result.rows[0];
  });

  // Bulk presun do pracovnej fronty — exportované/schválené doklady nemení.
  app.post('/api/documents/:id/move-to-review', async (request) => {
    const auth = await requireBrowserAuth(request, database);
    requireCsrf(request, auth);
    requireRole(auth, ['admin', 'uctovnik']);
    const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
    const document = await scopedDocument(database, auth.tenantId, id);
    await requireOrganizationAccess(database, auth, document.organization_id);
    if (['schvaleny', 'exportovany'].includes(document.status)) {
      throw new HttpError(409, 'document_locked', 'Schválený alebo exportovaný doklad nie je možné presunúť');
    }
    const history = [
      ...document.history,
      { ts: new Date().toISOString(), user: auth.name, akcia: 'Doklad presunutý na kontrolu' },
    ];
    const result = await database.query<Record<string, unknown>>(
      `UPDATE documents SET status='na_kontrole', quarantine_reason=NULL,
              version=version+1, approved_version=NULL, approved_snapshot=NULL,
              history=$1::jsonb, updated_at=now()
        WHERE id=$2 AND tenant_id=$3 RETURNING *`,
      [JSON.stringify(history), id, auth.tenantId],
    );
    await writeAudit(database, { tenantId: auth.tenantId, organizationId: document.organization_id, actorType: 'user', actorId: auth.userId, action: 'document.moved_to_review', entityType: 'document', entityId: id, correlationId: request.id });
    return result.rows[0];
  });

  app.post('/api/documents/:id/restore', async (request) => {
    const auth = await requireBrowserAuth(request, database);
    requireCsrf(request, auth);
    requireRole(auth, ['admin', 'uctovnik']);
    const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
    const document = await scopedDocument(database, auth.tenantId, id);
    await requireOrganizationAccess(database, auth, document.organization_id);
    if (document.status !== 'zamietnuty') {
      throw new HttpError(409, 'not_rejected', 'Obnoviť možno len zamietnutý doklad');
    }
    // Späť na kontrolu, ak je extrakcia hotová; inak do stavu chyba na došetrenie.
    const restoredStatus = document.processing_status === 'ready_for_review' ? 'na_kontrole' : 'chyba';
    const history = [
      ...document.history,
      { ts: new Date().toISOString(), user: auth.name, akcia: 'Doklad obnovený z koša' },
    ];
    const result = await database.query<Record<string, unknown>>(
      `UPDATE documents SET status=$1, version=version+1, history=$2::jsonb, updated_at=now()
        WHERE id=$3 AND tenant_id=$4 RETURNING *`,
      [restoredStatus, JSON.stringify(history), id, auth.tenantId],
    );
    await writeAudit(database, {
      tenantId: auth.tenantId,
      organizationId: document.organization_id,
      actorType: 'user',
      actorId: auth.userId,
      action: 'document.restored',
      entityType: 'document',
      entityId: id,
      correlationId: request.id,
    });
    return result.rows[0];
  });

  /**
   * Trvalé zmazanie dokladu z koša — aj s naskenovaným súborom.
   *
   * Zamietnutie je len mäkké: doklad ostáva v databáze, sken v úložisku a
   * z e-mailu sa preto nedal zmazať ani ten („najprv zmažte doklad", lenže
   * mazať doklad sa nedalo vôbec). Toto je tá chýbajúca cesta.
   *
   * Nevratné. Preto len admin a len na zamietnutom doklade: čokoľvek, čo ešte
   * žije v pracovnom postupe, sa musí najprv zamietnuť, aby bol krok vedomý.
   */
  app.delete('/api/documents/:id', async (request, reply) => {
    const auth = await requireBrowserAuth(request, database);
    requireCsrf(request, auth);
    requireRole(auth, ['admin']);
    const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
    const document = await scopedDocument(database, auth.tenantId, id);
    await requireOrganizationAccess(database, auth, document.organization_id);
    if (document.status !== 'zamietnuty') {
      throw new HttpError(409, 'not_rejected', 'Natrvalo zmazať možno len doklad z koša');
    }

    // Kľúče skenov si vypýtame ešte pred mazaním — potom už nebude odkiaľ.
    const prilohy = await database.query<{ storage_key: string | null }>(
      'SELECT storage_key FROM inbound_attachments WHERE document_id=$1 AND tenant_id=$2',
      [id, auth.tenantId],
    );

    await database.transaction(async (tx) => {
      // Väzby bez ON DELETE CASCADE by mazanie zablokovali. Cudzie doklady sa
      // nemažú — len sa im odkaz uvoľní, aby po zmazanom nezostal visieť.
      //
      // Poradie nie je ľubovoľné: doklad ukazuje na svoj použitý beh extrakcie
      // (applied_extraction_run_id), takže odkaz musí padnúť skôr, než behy.
      await tx.query('UPDATE documents SET applied_extraction_run_id=NULL WHERE id=$1', [id]);
      await tx.query('DELETE FROM extraction_runs WHERE document_id=$1', [id]);
      // Job môže visieť na prílohe aj bez document_id (spracovanie sa spustí
      // skôr, než doklad vznikne). processing_jobs.attachment_id nemá CASCADE,
      // takže by inak zablokoval mazanie prílohy — ide preč po oboch väzbách.
      await tx.query(
        `DELETE FROM processing_jobs
          WHERE document_id=$1
             OR attachment_id IN (SELECT id FROM inbound_attachments WHERE document_id=$1)`,
        [id],
      );
      await tx.query('UPDATE accounting_suggestions SET based_on_document_id=NULL WHERE based_on_document_id=$1', [id]);
      await tx.query('UPDATE document_payments SET bank_statement_document_id=NULL WHERE bank_statement_document_id=$1', [id]);
      await tx.query('UPDATE documents SET split_from_document_id=NULL WHERE split_from_document_id=$1', [id]);
      await tx.query('UPDATE documents SET duplicate_of_document_id=NULL WHERE duplicate_of_document_id=$1', [id]);
      // Príloha odchádza s dokladom: inak by sa súbor bez bajtov vrátil medzi
      // nespracované a účtovník by ho videl znova.
      await tx.query('DELETE FROM inbound_attachments WHERE document_id=$1 AND tenant_id=$2', [id, auth.tenantId]);
      // Zvyšok (návrh zaúčtovania, úhrady, verdikt DPH, pamäť rozhodnutí)
      // odíde kaskádou.
      await tx.query('DELETE FROM documents WHERE id=$1 AND tenant_id=$2', [id, auth.tenantId]);
    });

    // Bajty až po transakcii: úložisko nie je transakčné a mazanie je
    // opakovateľné, takže zlyhanie tu nechá databázu čistú a súbor osirie —
    // opačné poradie by nechalo doklad bez skenu.
    for (const priloha of prilohy.rows) {
      if (!priloha.storage_key) continue;
      try {
        await storage.delete(priloha.storage_key);
      } catch (error) {
        request.log.warn({ err: error, documentId: id }, 'sken sa nepodarilo zmazať z úložiska');
      }
    }

    await writeAudit(database, {
      tenantId: auth.tenantId,
      organizationId: document.organization_id,
      actorType: 'user',
      actorId: auth.userId,
      action: 'document.deleted',
      entityType: 'document',
      entityId: id,
      correlationId: request.id,
    });
    return reply.code(204).send();
  });

  app.post('/api/documents/:id/reprocess', async (request, reply) => {
    const auth = await requireBrowserAuth(request, database);
    requireCsrf(request, auth);
    requireRole(auth, ['admin', 'uctovnik']);
    const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
    const document = await scopedDocument(database, auth.tenantId, id);
    await requireOrganizationAccess(database, auth, document.organization_id);
    // Časť rozdelenia sa preextrahovať nedá: sken je celý pôvodný súbor, takže
    // by ju extrakcia prepísala celým dokladom namiesto jej podielu. Opakovať sa
    // dá len pôvodný doklad — a ten si časti vytvorí nanovo.
    if (document.split_from_document_id) {
      throw new HttpError(409, 'document_is_split_part', 'Časť rozdeleného dokladu sa nedá spracovať znova — spustite to na pôvodnom doklade');
    }
    const attachment = await database.query<{ id: string } & Record<string, unknown>>('SELECT id FROM inbound_attachments WHERE document_id=$1 AND tenant_id=$2', [id, auth.tenantId]);
    if (!attachment.rows[0]) throw new HttpError(409, 'attachment_missing', 'Doklad nemá zdrojovú prílohu');
    await database.query(
      `INSERT INTO processing_jobs (id, tenant_id, organization_id, attachment_id, document_id, kind, status, correlation_id, max_attempts)
       VALUES ($1,$2,$3,$4,$5,'reprocess_document','queued',$6,$7)`,
      [randomUUID(), auth.tenantId, document.organization_id, attachment.rows[0].id, id, request.id,
        config.extractionProvider === 'openai' ? config.openai.maxRetries + 1 : 5],
    );
    return reply.code(202).send({ queued: true });
  });

  // Ručné nahratie dokladov (drag & drop / výber súborov). Súbory prejdú tou
  // istou pipeline ako e-mailové prílohy: uložia sa do object storage a založí
  // sa extract_document job, ktorý AI extrakciou vytvorí doklad. Zdrojový e-mail
  // je syntetický (provider 'manual-upload') — worker cezeň číta kontext prílohy.
  app.post('/api/documents/upload', {
    config: { rateLimit: { max: 60, timeWindow: '1 minute' } },
    bodyLimit: 30 * 1024 * 1024,
  }, async (request, reply) => {
    const auth = await requireBrowserAuth(request, database);
    requireCsrf(request, auth);
    requireRole(auth, ['admin', 'uctovnik']);
    const body = z.object({
      organizationId: z.string().uuid(),
      files: z.array(z.object({
        fileName: z.string().min(1).max(255),
        mimeType: z.string().min(1).max(120),
        contentBase64: z.string().min(1),
      }).strict()).min(1).max(20),
    }).strict().parse(request.body);
    await requireOrganizationAccess(database, auth, body.organizationId);

    const emailId = randomUUID();
    const correlationId = request.id;
    const maxAttempts = config.extractionProvider === 'openai' ? config.openai.maxRetries + 1 : 5;
    await database.query(
      `INSERT INTO inbound_emails
        (id, tenant_id, organization_id, alias_id, provider, provider_message_id, envelope_recipients,
         sender_email, sender_name, subject, received_at, status, attachment_count, correlation_id)
       VALUES ($1,$2,$3,NULL,'manual-upload',$4,'[]'::jsonb,$5,$6,'Ručné nahratie',now(),'received',$7,$8)`,
      [emailId, auth.tenantId, body.organizationId, randomUUID(), auth.email, auth.name,
        body.files.length, correlationId],
    );

    const results: Array<{ fileName: string; status: string; reason?: string }> = [];
    let queued = 0;
    for (const file of body.files) {
      const attachmentId = randomUUID();
      const bytes = Buffer.from(file.contentBase64, 'base64');
      // Magic-byte detekcia je autorita; deklarovaný MIME z prehliadača je len záznam.
      const actualMime = detectedMimeType(bytes);
      const hash = sha256(bytes);
      let status: 'queued' | 'quarantine' | 'duplicate' = 'quarantine';
      let reason: string | undefined;
      let storageKey: string | undefined;

      if (bytes.byteLength === 0) reason = 'empty_file';
      if (!reason && bytes.byteLength > config.extractionMaxFileBytes) reason = 'attachment_too_large';
      if (!reason && !actualMime) reason = 'unsupported_or_corrupted_file';
      if (!reason && actualMime === 'application/xml' && classifyXml(bytes) === 'unknown_xml') reason = 'unsupported_xml';
      if (!reason) {
        const duplicate = await isTechnicalDuplicate(database, {
          tenantId: auth.tenantId, organizationId: body.organizationId, sha256: hash,
        });
        if (duplicate) {
          status = 'duplicate';
          reason = 'technical_duplicate';
        } else {
          storageKey = `upload/${auth.tenantId}/${body.organizationId}/${emailId}/${attachmentId}/${safeName(file.fileName)}`;
          await storage.put(storageKey, bytes, actualMime!);
          status = 'queued';
          queued += 1;
        }
      }

      await database.query(
        `INSERT INTO inbound_attachments
          (id, tenant_id, inbound_email_id, organization_id, original_file_name, safe_file_name,
           declared_mime_type, detected_mime_type, byte_size, sha256, storage_key, status, quarantine_reason)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
        [attachmentId, auth.tenantId, emailId, body.organizationId, file.fileName, safeName(file.fileName),
          file.mimeType, actualMime ?? null, bytes.byteLength, hash, storageKey ?? null, status, reason ?? null],
      );
      if (status === 'queued') {
        await database.query(
          `INSERT INTO processing_jobs
            (id, tenant_id, organization_id, attachment_id, kind, status, correlation_id, payload, max_attempts)
           VALUES ($1,$2,$3,$4,'extract_document','queued',$5,'{}'::jsonb,$6)`,
          [randomUUID(), auth.tenantId, body.organizationId, attachmentId, correlationId, maxAttempts],
        );
      }
      results.push({ fileName: file.fileName, status, reason });
    }

    await database.query(
      'UPDATE inbound_emails SET status=$1 WHERE id=$2',
      [queued > 0 ? 'queued' : 'quarantine', emailId],
    );
    await writeAudit(database, {
      tenantId: auth.tenantId,
      organizationId: body.organizationId,
      actorType: 'user',
      actorId: auth.userId,
      action: 'document.uploaded',
      entityType: 'inbound_email',
      entityId: emailId,
      correlationId,
      metadata: { attachmentCount: body.files.length, queued },
    });
    return reply.code(202).send({ emailId, queued, results });
  });

  app.get('/api/documents/:id/extraction-runs', async (request) => {
    const auth = await requireBrowserAuth(request, database);
    const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
    const document = await scopedDocument(database, auth.tenantId, id);
    await requireOrganizationAccess(database, auth, document.organization_id);
    const runs = await database.query(
      `SELECT * FROM extraction_runs
        WHERE document_id=$1 AND tenant_id=$2 AND organization_id=$3 ORDER BY created_at DESC`,
      [id, auth.tenantId, document.organization_id],
    );
    return runs.rows;
  });

  app.post('/api/documents/:id/extraction-runs/:runId/apply', async (request) => {
    const auth = await requireBrowserAuth(request, database);
    requireCsrf(request, auth);
    requireRole(auth, ['admin', 'uctovnik']);
    const { id, runId } = z.object({ id: z.string().uuid(), runId: z.string().uuid() }).parse(request.params);
    const { expectedVersion } = z.object({ expectedVersion: z.number().int().positive() }).strict().parse(request.body);
    const document = await scopedDocument(database, auth.tenantId, id);
    await requireOrganizationAccess(database, auth, document.organization_id);
    if (document.version !== expectedVersion) throw new HttpError(409, 'version_conflict', 'Doklad bol medzitým zmenený');
    if (document.status === 'exportovany') throw new HttpError(409, 'document_exported', 'Exportovaný doklad nie je možné meniť');
    const run = await database.query<{ result: unknown } & Record<string, unknown>>(
      `SELECT result FROM extraction_runs
        WHERE id=$1 AND document_id=$2 AND tenant_id=$3 AND organization_id=$4 AND status='succeeded'`,
      [runId, id, auth.tenantId, document.organization_id],
    );
    if (!run.rows[0]?.result) throw new HttpError(404, 'extraction_run_not_found', 'Úspešný výsledok extrakcie neexistuje');
    const result = extractionResultSchema.parse(run.rows[0].result);
    const normalized = normalizeExtractionResult(result, id, new Date().toISOString().slice(0, 10));
    const organization = await database.query<{ ico: string; dic?: string; ic_dph?: string } & Record<string, unknown>>(
      'SELECT ico,dic,ic_dph FROM organizations WHERE id=$1 AND tenant_id=$2',
      [document.organization_id, auth.tenantId],
    );
    const issues = validateExtractionResult(result, normalized, organization.rows[0]);
    const buyerMismatch = issues.some((issue) => ['buyer_ico_mismatch', 'supplier_buyer_may_be_inverted'].includes(issue.code));
    const invoiceNumber = result.invoiceNumber?.trim().toLocaleLowerCase('sk');
    const supplierIco = result.supplier.ico?.replace(/\D/g, '');
    const supplierName = result.supplier.nazov?.trim().toLocaleLowerCase('sk');
    let duplicateId: string | undefined;
    if (invoiceNumber && (supplierIco || supplierName)) {
      const candidates = await database.query<{ id: string; extracted: any } & Record<string, unknown>>(
        `SELECT id,extracted FROM documents
          WHERE tenant_id=$1 AND organization_id=$2 AND id<>$3 AND status<>'zamietnuty'
          ORDER BY created_at DESC LIMIT 500`,
        [auth.tenantId, document.organization_id, id],
      );
      duplicateId = candidates.rows.find((candidate) => {
        const supplier = candidate.extracted?.dodavatel ?? {};
        const sameSupplier = supplierIco
          ? String(supplier.ico ?? '').replace(/\D/g, '') === supplierIco
          : String(supplier.nazov ?? '').trim().toLocaleLowerCase('sk') === supplierName;
        return sameSupplier && String(candidate.extracted?.cisloFaktury ?? '').trim().toLocaleLowerCase('sk') === invoiceNumber;
      })?.id;
    }
    const status = buyerMismatch ? 'karantena' : duplicateId ? 'duplicita' : 'na_kontrole';
    const history = [...document.history, { ts: new Date().toISOString(), user: auth.name, akcia: `Použitá extrakcia ${runId}` }];
    const updated = await database.transaction(async (tx) => {
      const changed = await tx.query<Record<string, unknown>>(
        `UPDATE documents SET document_type=$1,status=$2,processing_status='ready_for_review',extracted=$3::jsonb,
                field_confidence=$4::jsonb,confidence=$5,total_amount=$6,currency=$7,history=$8::jsonb,
                quarantine_reason=$9,duplicate_of_document_id=$10,not_duplicate=false,
                applied_extraction_run_id=$11,version=version+1,approved_version=NULL,approved_snapshot=NULL,updated_at=now()
          WHERE id=$12 AND tenant_id=$13 AND organization_id=$14 AND version=$15 RETURNING *`,
        [normalized.documentType, status, JSON.stringify(normalized.extracted), JSON.stringify(normalized.fieldConfidence),
          normalized.confidence, normalized.totalAmount, normalized.currency, JSON.stringify(history),
          buyerMismatch ? 'buyer_ico_mismatch' : null, duplicateId ?? null, runId,
          id, auth.tenantId, document.organization_id, expectedVersion],
      );
      if (!changed.rows[0]) throw new HttpError(409, 'version_conflict', 'Doklad bol medzitým zmenený');
      // Aplikovanie extrakcie ruší prípadné schválenie — rozhodnutie von z pamäte.
      await forgetUctoDecision(tx, auth.tenantId, id);
      await rebuildAccountingSuggestion(tx, {
        tenantId: auth.tenantId, organizationId: document.organization_id, documentId: id,
        supplierIco: result.supplier.ico, supplierName: result.supplier.nazov,
        supplierIcDph: result.supplier.icDph, supplierIban: result.supplier.iban,
      });
      await writeAudit(tx, {
        tenantId: auth.tenantId, organizationId: document.organization_id, actorType: 'user', actorId: auth.userId,
        action: 'document.extraction_applied', entityType: 'document', entityId: id, correlationId: request.id,
        metadata: { extractionRunId: runId },
      });
      return changed.rows[0];
    });
    return updated;
  });

  app.post('/api/exports/pohoda/xml', async (request, reply) => {
    const auth = await requireBrowserAuth(request, database);
    requireCsrf(request, auth);
    requireRole(auth, ['admin', 'uctovnik']);
    const body = z.object({ organizationId: z.string().uuid(), documentIds: z.array(z.string().uuid()).min(1) }).strict().parse(request.body);
    await requireOrganizationAccess(database, auth, body.organizationId);
    const organization = await database.query<{ ico: string; name: string } & Record<string, unknown>>('SELECT ico, name FROM organizations WHERE id=$1 AND tenant_id=$2', [body.organizationId, auth.tenantId]);
    if (!organization.rows[0]) throw new HttpError(404, 'organization_not_found', 'Organizácia neexistuje');
    const id = randomUUID();
    const xml = await buildApprovedDocumentsXml(database, { tenantId: auth.tenantId, organizationId: body.organizationId, ico: organization.rows[0].ico, documentIds: body.documentIds, packId: id });
    const fileName = `pohoda-${organization.rows[0].ico}-${new Date().toISOString().slice(0, 10).replaceAll('-', '')}.xml`;
    await database.transaction(async (tx) => {
      await tx.query(
        `INSERT INTO export_batches (id, tenant_id, organization_id, created_by, document_ids, xml_file_name, xml_snapshot)
         VALUES ($1,$2,$3,$4,$5::jsonb,$6,$7)`,
        [id, auth.tenantId, body.organizationId, auth.userId, JSON.stringify(body.documentIds), fileName, xml],
      );
      await tx.query(
        `UPDATE documents SET status='exportovany', export_id=$1, updated_at=now()
          WHERE tenant_id=$2 AND organization_id=$3 AND id=ANY($4::text[])`,
        [id, auth.tenantId, body.organizationId, body.documentIds],
      );
      await writeAudit(tx, { tenantId: auth.tenantId, organizationId: body.organizationId, actorType: 'user', actorId: auth.userId, action: 'export.xml_created', entityType: 'export_batch', entityId: id, correlationId: request.id, metadata: { documentCount: body.documentIds.length } });
    });
    return reply.code(201).send({ batch: { id, tenantId: auth.tenantId, orgId: body.organizationId, createdAt: new Date().toISOString(), user: auth.name, documentIds: body.documentIds, xmlFileName: fileName }, xml });
  });

  app.get('/api/exports', async (request) => {
    const auth = await requireBrowserAuth(request, database);
    const result = await database.query(
      `SELECT e.id, e.tenant_id AS "tenantId", e.organization_id AS "orgId", e.created_at AS "createdAt",
              u.name AS "user", e.document_ids AS "documentIds", e.xml_file_name AS "xmlFileName"
         FROM export_batches e JOIN users u ON u.id=e.created_by
        WHERE e.tenant_id=$1 ORDER BY e.created_at DESC`,
      [auth.tenantId],
    );
    return result.rows;
  });

  app.get('/api/exports/:id/download', async (request, reply) => {
    const auth = await requireBrowserAuth(request, database);
    const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
    const result = await database.query<{ xml_snapshot: string; xml_file_name: string; organization_id: string } & Record<string, unknown>>(
      'SELECT xml_snapshot, xml_file_name, organization_id FROM export_batches WHERE id=$1 AND tenant_id=$2', [id, auth.tenantId],
    );
    if (!result.rows[0]) throw new HttpError(404, 'export_not_found', 'Export neexistuje');
    await requireOrganizationAccess(database, auth, result.rows[0].organization_id);
    reply.header('Content-Type', 'application/xml; charset=windows-1250');
    reply.header('Content-Disposition', contentDisposition('attachment', String(result.rows[0].xml_file_name)));
    return result.rows[0].xml_snapshot;
  });
}

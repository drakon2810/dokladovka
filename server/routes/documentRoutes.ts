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
import { agendaRadu, forgetUctoDecision, kvPreDruh, normalizeName, protistranaDokladu, rebuildAccountingSuggestion, recordUctoDecision, resolveSeriesDefault, updateRuleFeedback, zaznamenajOpravu } from '../services/accountingSuggestionService.js';
import { posudDph, type DphPosudokDokument } from '../services/dphAdvisor.js';
import { zaradNavrhZauctovania } from '../services/navrhZauctovaniaJob.js';
import { ulozPravidloProtistrany } from '../services/pravidloProtistrany.js';
import { loadDphProfil, predvolenyDphProfil } from '../services/dphProfileService.js';
import { PRECO_POLIA, precoVysvetlenie } from '../services/precoVysvetlenieService.js';
import { isTechnicalDuplicate } from '../inbound/duplicateCheck.js';
import { ingestFiles } from '../inbound/ingestFiles.js';
import { zapisOpravuTypu } from '../services/firemnyProfilService.js';
import { ulozFakt } from '../services/profilService.js';
import {
  DOVODY_NEVZNIKA, DRUHY_PRIJATEHO, spravaChyby, stavSamozdaneniaDokladu, ulozPamatDodavatela, VOLBY_SAMOZDANENIA, type Samozdanenie,
} from '../services/samozdanenieService.js';
import { zamkniPrax } from '../services/uctoProfileService.js';
import { podtypPreTyp } from '../workerService.js';

interface DocumentScope extends Record<string, unknown> {
  id: string;
  organization_id: string;
  status: string;
  processing_status: string;
  version: number;
  document_type: string;
  podtyp: string;
  extracted: Record<string, unknown>;
  accounting: Record<string, string | undefined>;
  history: Array<Record<string, unknown>>;
  split_from_document_id?: string | null;
  navrh_druhu?: { typ: string; podtyp: string } | null;
  samozdanenie?: Samozdanenie | null;
}

async function scopedDocument(database: Database, tenantId: string, id: string): Promise<DocumentScope> {
  // Podtyp musí ísť so sebou: schválenie z neho skladá snapshot pre export
  // (invoiceType) aj pamäť rozhodnutí — bez neho bol každý dobropis „bežná".
  const result = await database.query<DocumentScope>(
    `SELECT id, organization_id, status, processing_status, version, document_type, podtyp, extracted, accounting,
            history, split_from_document_id, navrh_druhu, samozdanenie
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

function polozkyDokladu(document: DocumentScope): Array<{ ucto?: Record<string, string | undefined> }> {
  const polozky = document.extracted?.polozky;
  return Array.isArray(polozky) ? polozky : [];
}

/** Členenia DPH dokladu rozpísané z číselníka (pre dphAdvisor) — hlavička aj položky. */
async function cleneniaDphDokladu(
  database: Database,
  tenantId: string,
  document: DocumentScope,
): Promise<Pick<DphPosudokDokument, 'clenenieDph' | 'cleneniaPoloziek'>> {
  const hlavicka = document.accounting?.clenenieDphId;
  const ids = [...new Set([hlavicka, ...polozkyDokladu(document).map((polozka) => polozka?.ucto?.clenenieDphId)].filter(Boolean))];
  if (ids.length === 0) return {};
  const clenenia = (await database.query<{ id: string; code: string; name: string } & Record<string, unknown>>(
    'SELECT id, code, name FROM code_list_items WHERE id=ANY($1::text[]) AND tenant_id=$2 AND organization_id=$3',
    [ids, tenantId, document.organization_id],
  )).rows.map((row) => ({ id: row.id, kod: row.code, nazov: row.name }));
  return { clenenieDph: clenenia.find((clenenie) => clenenie.id === hlavicka), cleneniaPoloziek: clenenia };
}

/** Pole zaúčtovania → číselník, z ktorého smie pochádzať jeho id. */
const CISELNIK_POLA = {
  predkontaciaId: 'predkontacie',
  clenenieDphId: 'cleneniaDph',
  ciselnyRadId: 'ciselneRady',
  strediskoId: 'strediska',
  cinnostId: 'cinnosti',
  zakazkaId: 'zakazky',
} as const;

/**
 * Každý odkaz zaúčtovania, ktorý pôjde do POHODY — v hlavičke aj na každej
 * položke. Počet aktívnych id nestačil: predkontácia ukazujúca na členenie DPH
 * tej istej firmy, rad inej agendy či iného roka alebo neznáme id na položke
 * schválením prešli a export ich potom ticho nahradil hlavičkou alebo zhodil
 * celú dávku. Prázdne pole položky dedí hlavičku; vyplnené neplatné nie.
 * Rad bez agendy či roka je ručne založený a prechádza — ako v ponuke editora.
 */
async function overOdkazyZauctovania(database: Database, tenantId: string, document: DocumentScope): Promise<void> {
  const zdroje = [
    { cesta: 'ucto.', ucto: document.accounting ?? {} },
    ...polozkyDokladu(document).map((polozka, index) => ({ cesta: `polozky.${index}.ucto.`, ucto: polozka?.ucto ?? {} })),
  ];
  const druhDokladu = { typ: document.document_type, podtyp: document.podtyp };
  for (const { cesta, ucto } of zdroje) {
    const kv = ucto.clenenieKvKod;
    if (kv && kvPreDruh(kv, druhDokladu) !== kv) {
      throw new HttpError(409, 'kv_invalid', `Sekcia KV DPH „${kv}" k tomuto druhu dokladu nepatrí (${cesta}clenenieKvKod)`,
        { pole: `${cesta}clenenieKvKod` });
    }
  }
  const odkazy = zdroje.flatMap(({ cesta, ucto }) => Object.entries(CISELNIK_POLA)
    .filter(([pole]) => ucto[pole])
    .map(([pole, kind]) => ({ pole: `${cesta}${pole}`, id: String(ucto[pole]), kind })));
  if (odkazy.length === 0) return;
  const polozkyCiselnika = new Map((await database.query<{
    id: string; kind: string; agenda: string | null; accounting_year: string | null;
  } & Record<string, unknown>>(
    `SELECT id, kind, agenda, accounting_year FROM code_list_items
      WHERE tenant_id=$1 AND organization_id=$2 AND active=true AND id=ANY($3::text[])`,
    [tenantId, document.organization_id, [...new Set(odkazy.map((odkaz) => odkaz.id))]],
  )).rows.map((row) => [row.id, row]));
  const agenda = agendaRadu(document.document_type, document.podtyp);
  const rok = /^\d{4}/.exec(String((document.extracted as { datumVystavenia?: unknown })?.datumVystavenia ?? ''))?.[0];
  for (const odkaz of odkazy) {
    const riadok = polozkyCiselnika.get(odkaz.id);
    const chyba = !riadok || riadok.kind !== odkaz.kind
      ? `Pole ${odkaz.pole} neukazuje na aktívnu položku číselníka „${odkaz.kind}" tejto organizácie`
      : riadok.kind === 'ciselneRady' && riadok.agenda && agenda && riadok.agenda !== agenda
        ? `Číselný rad patrí agende „${riadok.agenda}", doklad potrebuje rad agendy „${agenda}" (${odkaz.pole})`
        : riadok.kind === 'ciselneRady' && riadok.accounting_year && rok && riadok.accounting_year !== rok
          ? `Číselný rad je pre účtovný rok ${riadok.accounting_year}, doklad je z roku ${rok} (${odkaz.pole})`
          : undefined;
    if (chyba) throw new HttpError(409, 'code_list_invalid', chyba, { pole: odkaz.pole });
  }
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
         -- Náhradné doklady merania presnosti — rovnaký dôvod ako v snapshote.
         AND coalesce(d.source->>'meranie', '') <> 'true'
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
      podtyp: z.enum(['bezna','dobropis','tarchopis','zalohova']).optional(),
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
    const documentType = body.documentType ?? document.document_type;
    // Rovnaké pravidlo ako pri vzniku dokladu: podtyp prežije len na faktúre,
    // prepnutie na OZ či pokladňu ho vráti na bežnú.
    const podtyp = podtypPreTyp(documentType, body.podtyp ?? document.podtyp);
    const extracted = (body.extracted ?? document.extracted) as {
      dodavatel?: { nazov?: string; ico?: string; icDph?: string; iban?: string }; textPolozky?: string;
    } | undefined;
    const accounting = body.accounting ?? document.accounting;
    // Smer pokladne je tiež druh: príjmový a výdavkový doklad majú každý svoj rad.
    const druhZmeneny = documentType !== document.document_type || podtyp !== document.podtyp
      || (documentType === 'PD' && accounting.pokladnaTyp !== document.accounting.pokladnaTyp);
    const saved = await database.transaction(async (tx) => {
      // Prvá zmena druhu si zapamätá druh od extrakcie — schválenie ho porovná
      // so schváleným (ucto_opravy). SET vidí ešte starý riadok.
      const result = await tx.query<Record<string, unknown>>(
        `UPDATE documents SET document_type=$1, extracted=$2::jsonb, accounting=$3::jsonb,
                version=version+1, status=$4, approved_version=NULL, approved_snapshot=NULL, updated_at=now(), podtyp=$8,
                navrh_druhu=CASE WHEN document_type IS DISTINCT FROM $1 OR podtyp IS DISTINCT FROM $8
                  THEN coalesce(navrh_druhu, jsonb_build_object('typ', document_type, 'podtyp', podtyp)) ELSE navrh_druhu END
          WHERE id=$5 AND tenant_id=$6 AND version=$7 RETURNING *`,
        [documentType, JSON.stringify(extracted), JSON.stringify(accounting), approvedChanged ? 'na_kontrole' : document.status,
          id, auth.tenantId, body.expectedVersion, podtyp],
      );
      if (!result.rows[0]) throw new HttpError(409, 'version_conflict', 'Doklad bol medzitým zmenený');
      // Úprava schváleného dokladu ruší potvrdenie — rozhodnutie sa vyradí
      // z pamäte v tej istej transakcii, inak by pád medzi zápismi nechal
      // neschválený doklad s potvrdeným rozhodnutím.
      if (approvedChanged) await forgetUctoDecision(tx, auth.tenantId, id);
      // Rad pre nový druh — návrh k dokladu byť nemusí, tak sa drží aj tu.
      let radNovehoDruhu: string | null = null;
      if (druhZmeneny) {
        // Iný druh dokladu = iná agenda radu, iné účty aj iná sekcia KV. Rad sa
        // prepočíta hneď; zvyšok návrhu patril starému druhu (predkontácia
        // faktúry na ostatnom záväzku, bežné členenie na dobropise) a nesmie
        // vyzerať ako aktuálny. Zruší sa aj s pravidlom (inak by schválenie
        // počítalo opravu pravidlu, ktoré sa na doklad už nevzťahuje) a nový
        // návrh sa zaradí do fronty v tej istej transakcii. Prestavba z pamäte
        // priamo tu by AI analýzu nahradila slabším návrhom bez modelu.
        radNovehoDruhu = await resolveSeriesDefault(
          tx, { tenantId: auth.tenantId, organizationId: document.organization_id }, documentType,
          (extracted as { datumVystavenia?: string } | undefined)?.datumVystavenia, podtyp,
          protistranaDokladu(documentType, extracted), undefined, accounting.pokladnaTyp) ?? null;
        await tx.query(
          `UPDATE accounting_suggestions
              SET ciselny_rad_id=$1, predkontacia_id=NULL, clenenie_dph_id=NULL, clenenie_kv_kod=NULL,
                  stredisko_id=NULL, riadky=NULL, rule_id=NULL, vysvetlenia=NULL, stopa_id=NULL, confidence=0,
                  reason='Návrh sa prepočítava pre nový druh dokladu.', updated_at=now()
            WHERE document_id=$2 AND tenant_id=$3`,
          [radNovehoDruhu, id, auth.tenantId],
        );
        // Verdikt kontroly DPH posudzoval starý druh — B2 bežnej faktúry by
        // radil nad dobropisom a po prepnutí na mzdy by ho nová kontrola ani
        // neprepísala. Nejde o stopu rozhodnutia k tomu istému návrhu, ktorú
        // drží endpoint rozhodnutia; job návrhu posúdi nový druh znova.
        await tx.query('DELETE FROM dph_audit WHERE document_id=$1 AND tenant_id=$2', [id, auth.tenantId]);
        await zaradNavrhZauctovania(tx, {
          tenantId: auth.tenantId, organizationId: document.organization_id, documentId: id, correlationId: request.id,
        });
      }
      if (accounting.ciselnyRadId) return result.rows[0];
      // Editor pri zmene druhu rad vymaže — ten starý patril inej agende. Doplní
      // sa v tej istej verzii, a to aj keď sa druh vrátil na pôvodný (prepnutie
      // tam a späť rad z konceptu zmazalo — vtedy z návrhu), inak by doklad
      // ostal bez radu a účtovník by ho hľadal ručne.
      const doplneny = await tx.query<Record<string, unknown>>(
        `UPDATE documents d SET accounting = d.accounting || jsonb_build_object('ciselnyRadId', r.rad)
           FROM (SELECT CASE WHEN $3::boolean THEN $4::text
                             ELSE (SELECT ciselny_rad_id FROM accounting_suggestions WHERE document_id=$1) END AS rad) r
          WHERE d.id=$1 AND d.tenant_id=$2 AND r.rad IS NOT NULL
          RETURNING d.*`,
        [id, auth.tenantId, druhZmeneny, radNovehoDruhu],
      );
      return doplneny.rows[0] ?? result.rows[0];
    });
    // Prepnutie typu je oprava kroku „čo je to za papier". Doteraz sa nikam
    // nezapisovala a ďalší rovnaký doklad spravil tú istú chybu — pamäť
    // rozhodnutí drží iba zaúčtovanie, teda krok PO určení typu. Podtyp sa sem
    // nepíše: oprava sa ukladá k dodávateľovi (pri FV je ním sama firma) a jeden
    // dobropis by klasifikáciu naučil, že dobropisom je všetko od neho.
    if (documentType !== document.document_type) {
      await zapisOpravuTypu(database, {
        tenantId: auth.tenantId,
        organizationId: document.organization_id,
        documentId: id,
        povodnyTyp: String(document.document_type),
        novyTyp: documentType,
        userId: auth.userId,
        dodavatel: extracted?.dodavatel?.nazov,
        text: extracted?.textPolozky,
      });
    }
    return saved;
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
      // Podtyp rozhoduje o znamienku: dobropis so zápornou sumou je v poriadku.
    }, organization.rows[0], document.podtyp);
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
    // predkontácie dedí hlavičkovú, presne ako pri exporte. Zálohová faktúra sa
    // neúčtuje: POHODA ju vedie bez predkontácie a členenia DPH, daňový moment
    // nastane až pri úhrade — povinný je len rad, zhodne s checkApprovable.
    const povinne = document.document_type === 'BV' ? []
      : document.podtyp === 'zalohova' ? [document.accounting.ciselnyRadId]
        : [document.accounting.predkontaciaId, document.accounting.clenenieDphId, document.accounting.ciselnyRadId];
    if (povinne.some((value) => !value)) {
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
    }
    await overOdkazyZauctovania(database, auth.tenantId, document);
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
      ...await cleneniaDphDokladu(database, auth.tenantId, document),
    }, dphProfil);
    if (dphPosudok.blokacie.length > 0) {
      throw new HttpError(409, 'dph_profil_blokacia', dphPosudok.blokacie[0].sprava);
    }
    // Samozdanenie: voľba sa určí vždy — bez uloženej sa zapíše predvolená —
    // a spolu s vypočítaným základom a daňou sa zmrazí do snapshotu pre export.
    const samozdanenie = await stavSamozdaneniaDokladu(database, auth.tenantId, document, dphProfil);
    if (samozdanenie && samozdanenie.chyby.length > 0) {
      throw new HttpError(409, 'samozdanenie_neuplne', spravaChyby(samozdanenie.chyby[0], samozdanenie.hodnota, samozdanenie.mena));
    }
    const approvedVersion = expectedVersion + 1;
    // Podtyp ide do snapshotu spolu s typom — invoiceType pre POHODU sa určuje
    // z dvojice a bez neho by dobropis odišiel ako bežná faktúra.
    const snapshot = {
      version: approvedVersion, approvedAt: new Date().toISOString(), typ: document.document_type, podtyp: document.podtyp ?? 'bezna', extracted: document.extracted, ucto: document.accounting,
      ...(samozdanenie ? { samozdanenie: samozdanenie.hodnota } : {}),
    };
    // Schválenie je jeden celok: stav so snapshotom, pamäť rozhodnutí, spätná
    // väzba pravidiel, záznam opravy aj audit. Keď zápisy bežali po jednom,
    // zlyhanie pamäte po uložení stavu vrátilo klientovi chybu pri už
    // schválenom doklade a opakované schválenie narazilo na zmenenú verziu.
    // Vnútri sú len zápisy do databázy — žiadne volanie modelu, ktoré by
    // transakciu držalo otvorenú.
    return database.transaction(async (tx) => {
      const result = await tx.query<Record<string, unknown>>(
        `UPDATE documents SET status='schvaleny', version=$1, approved_version=$1, approved_snapshot=$2::jsonb, updated_at=now(),
                samozdanenie=$6::jsonb
          WHERE id=$3 AND tenant_id=$4 AND version=$5 RETURNING *`,
        [approvedVersion, JSON.stringify(snapshot), id, auth.tenantId, expectedVersion,
          samozdanenie ? JSON.stringify(samozdanenie.hodnota) : null],
      );
      if (!result.rows[0]) throw new HttpError(409, 'version_conflict', 'Doklad bol medzitým zmenený');
      const rozhodnutie = {
        tenantId: auth.tenantId,
        organizationId: document.organization_id,
        documentId: id,
        documentType: String(document.document_type ?? '') || undefined,
        podtyp: String(document.podtyp ?? 'bezna'),
        extracted: document.extracted,
        accounting: document.accounting,
      };
      // Pamäť rozhodnutí: potvrdené zaúčtovanie sa uloží ako vzor pre budúce návrhy.
      await recordUctoDecision(tx, rozhodnutie);
      // Samokontrola pravidiel: zhoda so schváleným = potvrdenie, rozdiel = oprava.
      await updateRuleFeedback(tx, { tenantId: auth.tenantId, documentId: id, accounting: document.accounting });
      // Čo účtovník oproti návrhu zmenil — meranie kvality návrhov aj podklad na učenie.
      await zaznamenajOpravu(tx, {
        ...rozhodnutie, navrhDruhu: document.navrh_druhu ?? undefined,
        ...(samozdanenie ? { samozdanenie: { navrhnute: samozdanenie.predvolene.volba, schvalene: samozdanenie.hodnota.volba } } : {}),
      });
      // Otázka k schválenému dokladu už nie je otvorená.
      await tx.query('UPDATE accounting_suggestions SET otazka=NULL WHERE document_id=$1 AND tenant_id=$2', [id, auth.tenantId]);
      await writeAudit(tx, { tenantId: auth.tenantId, organizationId: document.organization_id, actorType: 'user', actorId: auth.userId, action: 'document.approved', entityType: 'document', entityId: id, correlationId: request.id, metadata: { version: approvedVersion } });
      return result.rows[0];
    });
  });

  // R09 „Vždy pre tohto dodávateľa": podoba praxe, ktorú účtovník vybral, sa
  // stane pravidlom protistrany (ulozPravidloProtistrany). Dodávateľa určí
  // server z dokladu, nie klient.
  app.post('/api/documents/:id/pravidlo-protistrany', async (request) => {
    const auth = await requireBrowserAuth(request, database);
    requireCsrf(request, auth);
    requireRole(auth, ['admin', 'uctovnik']);
    const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
    const body = z.object({
      predkontaciaId: z.string().min(1).max(100),
      clenenieDphId: z.string().min(1).max(100),
      clenenieKvKod: z.string().max(10).optional(),
    }).strict().parse(request.body);
    const document = await scopedDocument(database, auth.tenantId, id);
    await requireOrganizationAccess(database, auth, document.organization_id);
    // Pravidlo z vydanej faktúry by viazalo odberateľa — zatiaľ len prijaté doklady.
    if (document.document_type === 'FV') {
      throw new HttpError(422, 'pravidlo_len_prijate', 'Pravidlo protistrany sa vytvára len z prijatých dokladov');
    }
    const strana = protistranaDokladu(document.document_type, document.extracted);
    const ico = String(strana.ico ?? '').replace(/\D/g, '');
    const nazov = normalizeName(strana.nazov);
    if (!ico && !nazov) throw new HttpError(422, 'protistrana_chyba', 'Doklad nemá dodávateľa, pre ktorého by pravidlo platilo');
    return database.transaction(async (tx) => {
      const pravidlo = await ulozPravidloProtistrany(tx, {
        tenantId: auth.tenantId, organizationId: document.organization_id, userId: auth.userId, correlationId: request.id,
        ico, nazov, ...body, documentId: id, typDokladu: document.document_type,
        zdroj: `doklad ${String((document.extracted as Record<string, unknown>)?.cisloFaktury ?? id).slice(0, 60)}`,
      });
      if (!pravidlo) throw new HttpError(422, 'neplatny_kod', 'Predkontácia alebo členenie DPH nie je aktívne v číselníku firmy');
      await writeAudit(tx, {
        tenantId: auth.tenantId, organizationId: document.organization_id, actorType: 'user', actorId: auth.userId,
        action: 'ucto.pravidlo_z_otazky', entityType: 'document', entityId: id, correlationId: request.id,
        metadata: pravidlo,
      });
      return { ruleId: pravidlo.ruleId };
    });
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
      ...await cleneniaDphDokladu(database, auth.tenantId, document),
    }, profil);
  });

  // Samozdanenie prijatej faktúry: blok nad zaúčtovaním. Schválený doklad
  // ukazuje zmrazené hodnoty — práve tie idú do POHODY.
  // ponytail: schválený doklad, ktorý po zmene profilu (zrušené prijaté
  // prenesenie) prestal byť kandidátom, blok nemá — export ide zo snapshotu aj tak.
  const blokSamozdanenia = async (tenantId: string, document: DocumentScope) => {
    const stav = await stavSamozdaneniaDokladu(database, tenantId, document);
    if (!stav) return null;
    const { profil, pamat, ...blok } = stav;
    const uzamknuty = ['schvaleny', 'exportovany'].includes(document.status);
    return {
      ...blok,
      ...(uzamknuty && document.samozdanenie ? { hodnota: document.samozdanenie, chyby: [] } : {}),
      upravitelny: !uzamknuty,
      dodavatel: String((document.extracted as { dodavatel?: { nazov?: string } })?.dodavatel?.nazov ?? ''),
      robimeVPohode: profil.samozdanenieVPohode === true,
      pamatDodavatela: Boolean(pamat),
    };
  };

  app.get('/api/documents/:id/samozdanenie', async (request) => {
    const auth = await requireBrowserAuth(request, database);
    const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
    const document = await scopedDocument(database, auth.tenantId, id);
    await requireOrganizationAccess(database, auth, document.organization_id);
    return { blok: await blokSamozdanenia(auth.tenantId, document) };
  });

  // Voľbu ukladá účtovník; s ňou aj pamäť dodávateľa („Pamätať pre dodávateľa")
  // a nastavenie firmy („Takto to robíme pri všetkých faktúrach").
  app.put('/api/documents/:id/samozdanenie', async (request) => {
    const auth = await requireBrowserAuth(request, database);
    requireCsrf(request, auth);
    requireRole(auth, ['admin', 'uctovnik']);
    const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
    const { pamatatDodavatela, vsetkyFaktury, ...rozhodnutie } = z.object({
      volba: z.enum(VOLBY_SAMOZDANENIA),
      druh: z.enum(DRUHY_PRIJATEHO).optional(),
      dovod: z.enum(DOVODY_NEVZNIKA).optional(),
      dovodText: z.string().trim().max(240).optional(),
      cislaInternych: z.string().trim().max(240).optional(),
      rucne: z.object({
        datumDanovejPovinnosti: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
        sadzba: z.number().min(0).max(100).optional(),
        kurz: z.number().positive().max(1_000_000).optional(),
      }).strict().optional(),
      pamatatDodavatela: z.boolean().optional(),
      vsetkyFaktury: z.boolean().optional(),
    }).strict().parse(request.body);
    const document = await scopedDocument(database, auth.tenantId, id);
    await requireOrganizationAccess(database, auth, document.organization_id);
    if (['schvaleny', 'exportovany'].includes(document.status)) {
      throw new HttpError(409, 'samozdanenie_uzamknute', 'Schválený doklad má samozdanenie uzamknuté — najprv zrušte schválenie úpravou dokladu');
    }
    const firma = { tenantId: auth.tenantId, organizationId: document.organization_id };
    const stav = await stavSamozdaneniaDokladu(database, auth.tenantId, { ...document, samozdanenie: { ...rozhodnutie, zdroj: 'uctovnik' } });
    if (!stav) throw new HttpError(422, 'samozdanenie_netyka', 'Doklad nie je kandidátom na samozdanenie');
    const { hodnota } = stav;
    await database.transaction(async (tx) => {
      await tx.query('UPDATE documents SET samozdanenie=$1::jsonb, updated_at=now() WHERE id=$2 AND tenant_id=$3',
        [JSON.stringify(hodnota), id, auth.tenantId]);
      if (hodnota.volba === 'nevznika' && pamatatDodavatela === false) {
        await ulozPamatDodavatela(tx, { ...firma, userId: auth.userId, extracted: document.extracted });
      } else if (hodnota.volba === 'nevznika' && pamatatDodavatela && hodnota.dovod && !stav.chyby.includes('dovod')) {
        await ulozPamatDodavatela(tx, {
          ...firma, userId: auth.userId, extracted: document.extracted,
          pamat: { dovod: hodnota.dovod, ...(hodnota.dovodText ? { dovodText: hodnota.dovodText } : {}) },
        });
      }
      if (hodnota.volba === 'v_pohode' && vsetkyFaktury !== undefined && vsetkyFaktury !== (stav.profil.samozdanenieVPohode === true)) {
        await zamkniPrax(tx, firma);
        await ulozFakt(tx, { ...firma, userId: auth.userId }, 'samozdanenie.postup', { stav: 'potvrdene', hodnota: { robimeVPohode: vsetkyFaktury } });
      }
      await writeAudit(tx, {
        tenantId: auth.tenantId, organizationId: document.organization_id, actorType: 'user', actorId: auth.userId,
        action: 'document.samozdanenie_ulozene', entityType: 'document', entityId: id, correlationId: request.id,
        metadata: { volba: hodnota.volba, druh: hodnota.druh, dovod: hodnota.dovod, pamatatDodavatela, vsetkyFaktury },
      });
    });
    return { blok: await blokSamozdanenia(auth.tenantId, { ...document, samozdanenie: hodnota }) };
  });

  // „Prečo?" — pôvod zaúčtovania dokladu: zdroj návrhu, istota, dôvod a
  // pravidlo, ktoré ho vytvorilo (vrátane ľudského dôvodu pravidla). Čisto
  // deterministické — žiadne LLM, len provenience z accounting_suggestions.
  app.get('/api/documents/:id/preco', async (request) => {
    const auth = await requireBrowserAuth(request, database);
    const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
    const document = await scopedDocument(database, auth.tenantId, id);
    await requireOrganizationAccess(database, auth, document.organization_id);

    // Stopa rozhodnutia: jej created_at je čas, keď model naozaj rozhodol —
    // created_at návrhu sa pri prepise (ON CONFLICT) nemení.
    const suggestion = (await database.query<Record<string, any>>(
      `SELECT s.source, s.confidence, s.reason, s.rule_id, s.predkontacia_id, s.clenenie_dph_id, s.clenenie_kv_kod,
              s.created_at, t.created_at AS stopa_vytvorena, t.model AS stopa_model, t.odpoved AS stopa_odpoved,
              t.zmeny AS stopa_zmeny, t.istota AS stopa_istota
         FROM accounting_suggestions s
         LEFT JOIN ucto_navrh_stopa t ON t.id::text=s.stopa_id AND t.tenant_id=s.tenant_id
        WHERE s.document_id=$1 AND s.tenant_id=$2 AND s.organization_id=$3`,
      [id, auth.tenantId, document.organization_id],
    )).rows[0];
    const stopa = suggestion?.stopa_vytvorena ? {
      vytvorena: new Date(String(suggestion.stopa_vytvorena)).toISOString(),
      model: suggestion.stopa_model ?? undefined,
      odpoved: suggestion.stopa_odpoved ?? undefined,
      zmeny: Array.isArray(suggestion.stopa_zmeny) ? suggestion.stopa_zmeny as Array<{ pole: string; z: string | null; na: string | null; dovod: string }> : [],
      istota: suggestion.stopa_istota ?? undefined,
    } : null;

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
    const ids = [...new Set([
      navrh.predkontaciaId, navrh.clenenieDphId, aktualne.predkontaciaId, aktualne.clenenieDphId,
      ...(stopa?.zmeny ?? []).filter((zmena) => zmena.pole !== 'clenenieKvKod').flatMap((zmena) => [zmena.z, zmena.na]),
    ].filter(Boolean))] as string[];
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
      stopa,
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
      // Časť dedí podtyp (dobropis ostáva dobropisom) aj druh od extrakcie —
      // inak by schválenie časti zapísalo opravu podtypu, ktorú nikto neurobil.
      await tx.query(
        `INSERT INTO documents
          (id,tenant_id,organization_id,queue_id,document_type,status,processing_status,source,extracted,
           accounting,field_confidence,confidence,total_amount,currency,history,split_from_document_id,podtyp,navrh_druhu)
         SELECT $1,tenant_id,organization_id,queue_id,$2,'na_kontrole','ready_for_review',source,$3::jsonb,
           accounting,field_confidence,confidence,$4,currency,$5::jsonb,$6,$8,navrh_druhu
           FROM documents WHERE id=$6 AND tenant_id=$7`,
        [noveId, body.typ, JSON.stringify(novyExtracted), novyExtracted.sumaSpolu,
          JSON.stringify([{ ts: teraz, user: auth.name, akcia: `Doklad vznikol rozdelením dokladu ${extracted.cisloFaktury ?? id}` }]),
          id, auth.tenantId, podtypPreTyp(body.typ, document.podtyp)],
      );
      const povodny = await tx.query(
        `UPDATE documents SET extracted=$1::jsonb, total_amount=$2, version=version+1,
                status=CASE WHEN status='schvaleny' THEN 'na_kontrole' ELSE status END,
                approved_version=NULL, approved_snapshot=NULL, history=$3::jsonb, updated_at=now()
          WHERE id=$4 AND tenant_id=$5 AND version=$6 RETURNING id`,
        [JSON.stringify(povodnyExtracted), povodnyExtracted.sumaSpolu,
          JSON.stringify([...document.history, { ts: teraz, user: auth.name, akcia: `Z dokladu bolo oddelených ${vybrane.length} položiek` }]),
          id, auth.tenantId, body.expectedVersion],
      );
      // Súbežná zmena medzi načítaním a zápisom: nová časť by inak ostala
      // a položky by existovali v dvoch dokladoch naraz.
      if (!povodny.rows[0]) throw new HttpError(409, 'version_conflict', 'Doklad medzitým niekto zmenil, načítajte ho znova');
      // Rozdelenie ruší schválenie — rozhodnutie von z pamäte, inak by ďalšie
      // doklady tej protistrany predvypĺňalo ako potvrdené.
      await forgetUctoDecision(tx, auth.tenantId, id);
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

    const correlationId = request.id;
    const { emailId, queued, results } = await ingestFiles(
      { database, storage, config },
      { tenantId: auth.tenantId, organizationId: body.organizationId, correlationId },
      {
        provider: 'manual-upload', storagePrefix: 'upload', subject: 'Ručné nahratie',
        senderEmail: auth.email, senderName: auth.name,
      },
      body.files.map((file) => ({
        fileName: file.fileName,
        declaredMimeType: file.mimeType,
        bytes: Buffer.from(file.contentBase64, 'base64'),
      })),
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
    return reply.code(202).send({
      emailId, queued,
      results: results.map(({ fileName, status, reason }) => ({ fileName, status, reason })),
    });
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
      // Použitá extrakcia je nový návrh druhu: staré navrh_druhu by schválenie
      // porovnalo so zastaraným druhom. Podtyp sa zladí s novým typom ako pri PATCH.
      const changed = await tx.query<Record<string, unknown>>(
        `UPDATE documents SET document_type=$1,status=$2,processing_status='ready_for_review',extracted=$3::jsonb,
                field_confidence=$4::jsonb,confidence=$5,total_amount=$6,currency=$7,history=$8::jsonb,
                quarantine_reason=$9,duplicate_of_document_id=$10,not_duplicate=false,
                applied_extraction_run_id=$11,version=version+1,approved_version=NULL,approved_snapshot=NULL,updated_at=now(),
                podtyp=$16,navrh_druhu=NULL
          WHERE id=$12 AND tenant_id=$13 AND organization_id=$14 AND version=$15 RETURNING *`,
        [normalized.documentType, status, JSON.stringify(normalized.extracted), JSON.stringify(normalized.fieldConfidence),
          normalized.confidence, normalized.totalAmount, normalized.currency, JSON.stringify(history),
          buyerMismatch ? 'buyer_ico_mismatch' : null, duplicateId ?? null, runId,
          id, auth.tenantId, document.organization_id, expectedVersion, podtypPreTyp(normalized.documentType, document.podtyp)],
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

import { randomUUID } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { buildApp } from './app.js';
import { MemoryObjectStorage } from './storage.js';
import { createTestDatabase, seedTestUser, testConfig } from './testHelpers.js';
import { sha256 } from './security.js';

const databases: Awaited<ReturnType<typeof createTestDatabase>>[] = [];
const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(databases.splice(0).map((database) => database.close()));
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe('agent backend contour', () => {
  it('pairs once, syncs code lists and confirms an export idempotently', async () => {
    const database = await createTestDatabase();
    databases.push(database);
    const seeded = await seedTestUser(database);
    const storage = new MemoryObjectStorage();
    const app = await buildApp({ database, storage, config: testConfig(), logger: false });

    const login = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { email: seeded.email, password: seeded.password } });
    const cookie = String(login.headers['set-cookie']).split(';')[0];
    const csrf = login.json().csrfToken as string;
    const browserHeaders = { cookie, 'x-csrf-token': csrf };

    const enabled = await app.inject({ method: 'PUT', url: '/api/mostik/settings', headers: browserHeaders, payload: { enabled: true } });
    expect(enabled.statusCode).toBe(200);
    const pairing = await app.inject({ method: 'POST', url: '/api/mostik/pairing-codes', headers: browserHeaders, payload: { organizationId: seeded.organizationId } });
    expect(pairing.statusCode).toBe(201);
    const code = pairing.json().code as string;
    const mismatch = await app.inject({ method: 'POST', url: '/api/agent/pair', payload: { pairingCode: code, hostname: 'POHODA-SRV', agentVersion: '1.0.0', companyIco: '87654321' } });
    expect(mismatch.statusCode).toBe(409);
    expect(mismatch.json().code).toBe('organization_mismatch');
    const paired = await app.inject({ method: 'POST', url: '/api/agent/pair', payload: { pairingCode: code, hostname: 'POHODA-SRV', agentVersion: '1.0.0', companyIco: '12345678' } });
    expect(paired.statusCode).toBe(201);
    const agentHeaders = { authorization: `Bearer ${paired.json().agentToken as string}` };
    const replay = await app.inject({ method: 'POST', url: '/api/agent/pair', payload: { pairingCode: code, hostname: 'OTHER', agentVersion: '1.0.0', companyIco: '12345678' } });
    expect(replay.statusCode).toBe(409);
    expect(replay.json().code).toBe('pairing_code_used');

    const heartbeat = await app.inject({
      method: 'POST',
      url: '/api/agent/heartbeat',
      headers: agentHeaders,
      payload: { companies: [{ ico: '12345678', dbName: 'StwPh_12345678_2026', uctovnyRok: '2026' }], agentVersion: '1.0.1' },
    });
    expect(heartbeat.statusCode).toBe(200);
    const organizations = await app.inject({ method: 'GET', url: '/api/agent/organizations', headers: agentHeaders });
    expect(organizations.statusCode, organizations.body).toBe(200);
    expect(organizations.json()).toContainEqual(expect.objectContaining({ organizationId: seeded.organizationId }));

    // „Synchronizovať mostíkom": web nastaví žiadosť, agent ju vidí v organizáciách
    // a prvé nahratie číselníkov ju zmaže.
    const syncRequest = await app.inject({
      method: 'POST',
      url: `/api/mostik/organization-links/${seeded.organizationId}/sync-code-lists`,
      headers: browserHeaders,
      payload: {},
    });
    expect(syncRequest.statusCode, syncRequest.body).toBe(202);
    const withFlag = await app.inject({ method: 'GET', url: '/api/agent/organizations', headers: agentHeaders });
    expect(withFlag.json()).toContainEqual(expect.objectContaining({ organizationId: seeded.organizationId, syncRequested: true }));

    const syncedIds: Record<string, string> = {};
    for (const [kind, kod] of [['predkontacie', '518/321'], ['cleneniaDph', 'PD'], ['ciselneRady', '26FP']] as const) {
      const synced = await app.inject({
        method: 'PUT',
        url: `/api/agent/organizations/${seeded.organizationId}/code-lists`,
        headers: agentHeaders,
        // Číselný rad nesie topNumber z POHODY — z neho web predikuje interné číslo.
        payload: { kind, items: [{ kod, nazov: kod, ...(kind === 'ciselneRady' ? { posledneCislo: '2026300' } : {}) }] },
      });
      expect(synced.statusCode, synced.body).toBe(200);
      const row = await database.query<{ id: string; last_number: string | null } & Record<string, unknown>>(
        'SELECT id, last_number FROM code_list_items WHERE tenant_id=$1 AND organization_id=$2 AND kind=$3 AND code=$4',
        [seeded.tenantId, seeded.organizationId, kind, kod],
      );
      syncedIds[kind] = row.rows[0].id;
      expect(row.rows[0].last_number).toBe(kind === 'ciselneRady' ? '2026300' : null);
    }
    const afterSync = await app.inject({ method: 'GET', url: '/api/agent/organizations', headers: agentHeaders });
    expect(afterSync.json()).toContainEqual(expect.objectContaining({ organizationId: seeded.organizationId, syncRequested: false }));

    // Tréning AI cez mostík: žiadosť z webu → agent ju vidí v organizáciách →
    // nahratie rozhodnutí ju zmaže a naplní pamäť; opakovaný upload deduplikuje.
    const trainingRequest = await app.inject({
      method: 'POST',
      url: `/api/mostik/organization-links/${seeded.organizationId}/sync-training`,
      headers: browserHeaders,
      payload: {},
    });
    expect(trainingRequest.statusCode, trainingRequest.body).toBe(202);
    const withTrainingFlag = await app.inject({ method: 'GET', url: '/api/agent/organizations', headers: agentHeaders });
    expect(withTrainingFlag.json()).toContainEqual(expect.objectContaining({ organizationId: seeded.organizationId, trainingSyncRequested: true }));

    // Medziľahlá dávka (done=false) žiadosť nemaže — inak by výpadok uprostred
    // viacdávkového uploadu potichu stratil zvyšok riadkov.
    const trainingRow = { supplierIco: '87654321', supplierName: 'Dodávateľ s.r.o.', lineText: 'Prenájom', predkontaciaKod: '518/321', clenenieDphKod: 'PD', clenenieKvKod: 'B2' };
    const uploaded = await app.inject({
      method: 'PUT',
      url: `/api/agent/organizations/${seeded.organizationId}/training-decisions`,
      headers: agentHeaders,
      payload: { rows: [trainingRow, { supplierName: 'Neznámy kód', predkontaciaKod: 'NEEXISTUJE' }], done: false },
    });
    expect(uploaded.statusCode, uploaded.body).toBe(200);
    expect(uploaded.json()).toEqual({ imported: 1, duplicates: 0, rejected: 1 });
    const decisions = await database.query<{ supplier_ico: string; predkontacia_id: string } & Record<string, unknown>>(
      "SELECT supplier_ico, predkontacia_id FROM ucto_decisions WHERE tenant_id=$1 AND organization_id=$2 AND source='import'",
      [seeded.tenantId, seeded.organizationId],
    );
    expect(decisions.rows).toEqual([{ supplier_ico: '87654321', predkontacia_id: syncedIds.predkontacie }]);
    const midBatch = await app.inject({ method: 'GET', url: '/api/agent/organizations', headers: agentHeaders });
    expect(midBatch.json()).toContainEqual(expect.objectContaining({ organizationId: seeded.organizationId, trainingSyncRequested: true }));
    // Posledná dávka (done neuvedené = true) žiadosť zmaže; opakovaný riadok deduplikuje.
    const repeatedUpload = await app.inject({
      method: 'PUT',
      url: `/api/agent/organizations/${seeded.organizationId}/training-decisions`,
      headers: agentHeaders,
      payload: { rows: [trainingRow] },
    });
    expect(repeatedUpload.json()).toEqual({ imported: 0, duplicates: 1, rejected: 0 });
    const afterTraining = await app.inject({ method: 'GET', url: '/api/agent/organizations', headers: agentHeaders });
    expect(afterTraining.json()).toContainEqual(expect.objectContaining({ organizationId: seeded.organizationId, trainingSyncRequested: false }));
    const trainingMetric = await app.inject({
      method: 'POST',
      url: '/api/agent/sync-results',
      headers: agentHeaders,
      payload: { organizationId: seeded.organizationId, kind: 'treningAi', state: 'ok', itemCount: 1, durationMs: 42 },
    });
    expect(trainingMetric.statusCode, trainingMetric.body).toBe(202);

    const documentId = randomUUID();
    const snapshot = {
      version: 1,
      approvedAt: new Date().toISOString(),
      typ: 'FP',
      extracted: {
        dodavatel: { nazov: 'Dodávateľ s.r.o.', ico: '87654321', dic: '2020999999' },
        cisloFaktury: 'FV-2026-1',
        variabilnySymbol: '20260001',
        datumVystavenia: '2026-07-01',
        datumDodania: '2026-07-01',
        datumSplatnosti: '2026-07-15',
        mena: 'EUR',
        rozpisDph: [{ sadzba: 23, zaklad: 100, dph: 23 }],
        sumaSpolu: 123,
      },
      ucto: {
        predkontaciaId: syncedIds.predkontacie,
        clenenieDphId: syncedIds.cleneniaDph,
        ciselnyRadId: syncedIds.ciselneRady,
      },
    };
    await database.query(
      `INSERT INTO documents
        (id,tenant_id,organization_id,document_type,status,processing_status,source,extracted,accounting,
         confidence,total_amount,currency,version,approved_version,approved_snapshot)
       VALUES ($1,$2,$3,'FP','schvaleny','ready_for_review','{}'::jsonb,$4::jsonb,$5::jsonb,1,123,'EUR',1,1,$6::jsonb)`,
      [documentId, seeded.tenantId, seeded.organizationId, JSON.stringify(snapshot.extracted), JSON.stringify(snapshot.ucto), JSON.stringify(snapshot)],
    );

    const created = await app.inject({
      method: 'POST',
      url: '/api/mostik/export-jobs',
      headers: browserHeaders,
      // „Nekontrolovať duplicity" z exportného dialógu putuje až k agentovi.
      payload: { organizationId: seeded.organizationId, documentIds: [documentId], idempotencyKey: 'test-export-1', checkDuplicity: false },
    });
    expect(created.statusCode).toBe(201);
    const exportJobId = created.json().id as string;

    // Druhý klik na Exportovať (iný idempotency key) nesmie založiť druhý prenos
    // tých istých dokladov — POHODA by ich pri „Nekontrolovať duplicity" naimportovala dvakrát.
    const duplicate = await app.inject({
      method: 'POST',
      url: '/api/mostik/export-jobs',
      headers: browserHeaders,
      payload: { organizationId: seeded.organizationId, documentIds: [documentId], idempotencyKey: 'test-export-2' },
    });
    expect(duplicate.statusCode, duplicate.body).toBe(409);
    expect(duplicate.json().code).toBe('documents_in_transfer');

    const queue = await app.inject({ method: 'GET', url: `/api/agent/export-queue?organizationId=${seeded.organizationId}`, headers: agentHeaders });
    expect(queue.statusCode).toBe(200);
    expect(queue.json()[0]).toMatchObject({ exportJobId, idempotencyKey: 'test-export-1', checkDuplicity: false });
    expect(queue.json()[0].dataPackXml).toContain('ico="12345678"');

    // Sken pre priečinok Dokumenty v POHODE: agent ho smie stiahnuť len k dokladu,
    // ktorý má prenos, a meno s diakritikou musí prejsť hlavičkou HTTP.
    const emailId = randomUUID();
    const attachmentId = randomUUID();
    const storageKey = `upload/${seeded.tenantId}/${seeded.organizationId}/${attachmentId}.pdf`;
    await storage.put(storageKey, new TextEncoder().encode('%PDF-1.4'));
    await database.query(
      `INSERT INTO inbound_emails
        (id,tenant_id,organization_id,alias_id,provider,provider_message_id,envelope_recipients,sender_email,subject,received_at,status,correlation_id)
       VALUES ($1,$2,$3,$4,'imap',$5,'[]'::jsonb,'a@b.sk','Faktúra',now(),'processed',$1)`,
      [emailId, seeded.tenantId, seeded.organizationId, seeded.aliasId, `msg-${emailId}`],
    );
    await database.query(
      `INSERT INTO inbound_attachments
        (id,tenant_id,organization_id,inbound_email_id,document_id,original_file_name,safe_file_name,declared_mime_type,detected_mime_type,byte_size,sha256,storage_key,status)
       VALUES ($1,$2,$3,$4,$5,'faktúra č.1.pdf','faktura-c1.pdf','application/pdf','application/pdf',8,$6,$7,'stored')`,
      [attachmentId, seeded.tenantId, seeded.organizationId, emailId, documentId, `sha-${attachmentId}`, storageKey],
    );
    const scan = await app.inject({ method: 'GET', url: `/api/agent/documents/${documentId}/file`, headers: agentHeaders });
    expect(scan.statusCode, scan.body).toBe(200);
    expect(scan.headers['content-disposition']).toContain("filename*=UTF-8''");
    expect(scan.rawPayload.toString('utf8')).toBe('%PDF-1.4');
    const foreign = await app.inject({ method: 'GET', url: `/api/agent/documents/${randomUUID()}/file`, headers: agentHeaders });
    expect(foreign.statusCode).toBe(404);

    const resultPayload = { exportJobId, perDocument: [{ documentId, state: 'ok', pohodaNumber: '26FP2026301' }], rawResponseMeta: { responsePackState: 'ok' } };
    const result = await app.inject({ method: 'POST', url: '/api/agent/export-results', headers: agentHeaders, payload: resultPayload });
    expect(result.json()).toMatchObject({ accepted: true, idempotent: false, status: 'confirmed' });
    const repeated = await app.inject({ method: 'POST', url: '/api/agent/export-results', headers: agentHeaders, payload: resultPayload });
    expect(repeated.json()).toMatchObject({ accepted: true, idempotent: true, status: 'confirmed' });
    const document = await database.query<{ status: string; export_id: string } & Record<string, unknown>>('SELECT status, export_id FROM documents WHERE id=$1', [documentId]);
    expect(document.rows[0]).toEqual({ status: 'exportovany', export_id: exportJobId });

    // Skutočné číslo z POHODY posunulo číselný rad — odhad ďalšieho čísla už
    // nevychádza zo zastaraného stiahnutia číselníkov.
    const radPoPrenose = async () => (await database.query<{ last_number: string } & Record<string, unknown>>(
      'SELECT last_number FROM code_list_items WHERE id=$1', [syncedIds.ciselneRady],
    )).rows[0].last_number;
    expect(await radPoPrenose()).toBe('26FP2026301');

    // Prenos mimo poradia prinesie nižšie číslo — rad sa nesmie vrátiť späť,
    // inak by web sľuboval číslo, ktoré POHODA už použila.
    const druhyId = randomUUID();
    await database.query(
      `INSERT INTO documents
        (id,tenant_id,organization_id,document_type,status,processing_status,source,extracted,accounting,
         confidence,total_amount,currency,version,approved_version,approved_snapshot)
       VALUES ($1,$2,$3,'FP','schvaleny','ready_for_review','{}'::jsonb,$4::jsonb,$5::jsonb,1,123,'EUR',1,1,$6::jsonb)`,
      [druhyId, seeded.tenantId, seeded.organizationId, JSON.stringify(snapshot.extracted), JSON.stringify(snapshot.ucto), JSON.stringify(snapshot)],
    );
    const druhyExport = await app.inject({
      method: 'POST', url: '/api/mostik/export-jobs', headers: browserHeaders,
      payload: { organizationId: seeded.organizationId, documentIds: [druhyId], idempotencyKey: 'test-export-3' },
    });
    expect(druhyExport.statusCode, druhyExport.body).toBe(201);
    await app.inject({ method: 'GET', url: `/api/agent/export-queue?organizationId=${seeded.organizationId}`, headers: agentHeaders });
    const spatny = await app.inject({
      method: 'POST', url: '/api/agent/export-results', headers: agentHeaders,
      payload: {
        exportJobId: druhyExport.json().id as string,
        perDocument: [{ documentId: druhyId, state: 'ok', pohodaNumber: '26FP2026299' }],
        rawResponseMeta: { responsePackState: 'ok' },
      },
    });
    expect(spatny.json()).toMatchObject({ accepted: true, status: 'confirmed' });
    expect(await radPoPrenose()).toBe('26FP2026301');

    await app.close();
  }, 90_000);

  it('pairs a tenant-wide code without organization and without companyIco', async () => {
    const database = await createTestDatabase();
    databases.push(database);
    const seeded = await seedTestUser(database);
    const app = await buildApp({ database, storage: new MemoryObjectStorage(), config: testConfig(), logger: false });

    const login = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { email: seeded.email, password: seeded.password } });
    const cookie = String(login.headers['set-cookie']).split(';')[0];
    const browserHeaders = { cookie, 'x-csrf-token': login.json().csrfToken as string };
    await app.inject({ method: 'PUT', url: '/api/mostik/settings', headers: browserHeaders, payload: { enabled: true } });

    // Kód pre celú kanceláriu: bez organizationId.
    const pairing = await app.inject({ method: 'POST', url: '/api/mostik/pairing-codes', headers: browserHeaders, payload: {} });
    expect(pairing.statusCode, pairing.body).toBe(201);
    expect(pairing.json().organizationId).toBeUndefined();

    // Agent s automatickým vyhľadaním firiem neposiela IČO.
    const paired = await app.inject({
      method: 'POST',
      url: '/api/agent/pair',
      payload: { pairingCode: pairing.json().code as string, hostname: 'POHODA-SRV', agentVersion: '0.2.0' },
    });
    expect(paired.statusCode, paired.body).toBe(201);
    const agentHeaders = { authorization: `Bearer ${paired.json().agentToken as string}` };

    // Heartbeat spáruje organizáciu podľa IČO aj bez výberu organizácie pri párovaní.
    const heartbeat = await app.inject({
      method: 'POST',
      url: '/api/agent/heartbeat',
      headers: agentHeaders,
      // Firma má v POHODE viac ročníkov — všetky sa musia dostať do ponuky rokov.
      payload: {
        companies: [
          { ico: '12345678', dbName: 'StwPh_12345678_2025.mdb', uctovnyRok: '2025' },
          { ico: '12345678', dbName: 'StwPh_12345678_2026.mdb', uctovnyRok: '2026' },
        ],
        agentVersion: '0.2.0',
      },
    });
    expect(heartbeat.statusCode).toBe(200);
    const links = await database.query<{ db_name: string; matched_at?: string; available_years: Array<{ uctovnyRok: string; dbName: string }> } & Record<string, unknown>>(
      'SELECT db_name, matched_at, available_years FROM pohoda_company_links WHERE organization_id=$1', [seeded.organizationId],
    );
    expect(links.rows[0]?.db_name).toBe('StwPh_12345678_2026.mdb');
    expect(links.rows[0]?.matched_at).toBeTruthy();
    // Najnovší ročník je prvý — UI z neho robí predvoľbu „Najnovší účtovný rok".
    expect(links.rows[0]?.available_years).toEqual([
      { uctovnyRok: '2026', dbName: 'StwPh_12345678_2026.mdb' },
      { uctovnyRok: '2025', dbName: 'StwPh_12345678_2025.mdb' },
    ]);

    // Ručný výber staršieho ročníka nesmie vymazať ponuku rokov.
    const login2 = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { email: seeded.email, password: seeded.password } });
    const patched = await app.inject({
      method: 'PATCH',
      url: `/api/mostik/organization-links/${seeded.organizationId}`,
      headers: { cookie: String(login2.headers['set-cookie']).split(';')[0], 'x-csrf-token': login2.json().csrfToken as string },
      payload: { dbName: 'StwPh_12345678_2025.mdb', uctovnyRok: '2025', preferredYear: '2025' },
    });
    expect(patched.statusCode, patched.body).toBe(200);
    const afterPatch = await database.query<{ available_years: unknown[]; match_rule: string } & Record<string, unknown>>(
      'SELECT available_years, match_rule FROM pohoda_company_links WHERE organization_id=$1', [seeded.organizationId],
    );
    expect(afterPatch.rows[0]?.available_years).toHaveLength(2);
    expect(afterPatch.rows[0]?.match_rule).toBe('manual');
  }, 90_000);

  it('distinguishes expired pairing and publishes only complete signed releases', async () => {
    const database = await createTestDatabase();
    databases.push(database);
    const seeded = await seedTestUser(database);
    const config = testConfig({ agentReleasePublishToken: 'release-test-token', allowSelfSignedAgentReleases: true });
    const app = await buildApp({ database, storage: new MemoryObjectStorage(), config, logger: false });

    const unavailable = await app.inject({ method: 'GET', url: '/api/agent/latest' });
    expect(unavailable.statusCode).toBe(404);
    expect(unavailable.json()).toEqual({ available: false, reason: 'release_not_available' });

    const login = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { email: seeded.email, password: seeded.password } });
    const browserHeaders = {
      cookie: String(login.headers['set-cookie']).split(';')[0],
      'x-csrf-token': login.json().csrfToken as string,
    };
    await app.inject({ method: 'PUT', url: '/api/mostik/settings', headers: browserHeaders, payload: { enabled: true } });
    const pairing = await app.inject({
      method: 'POST', url: '/api/mostik/pairing-codes', headers: browserHeaders,
      payload: { organizationId: seeded.organizationId },
    });
    const pairingCode = pairing.json().code as string;
    await database.query('UPDATE agent_pairing_codes SET expires_at=$1 WHERE code_hash=$2', [new Date(Date.now() - 1_000).toISOString(), sha256(pairingCode)]);
    const expired = await app.inject({ method: 'POST', url: '/api/agent/pair', payload: { pairingCode, hostname: 'POHODA-SRV', agentVersion: '1.0.0', companyIco: '12345678' } });
    expect(expired.statusCode).toBe(410);
    expect(expired.json().code).toBe('pairing_code_expired');

    const commonRelease = {
      version: '1.0.0',
      downloadUrl: 'https://downloads.example.sk/Dokladovka-Agent-Setup-1.0.0.exe',
      sha256: 'a'.repeat(64),
      fileSize: 123456,
      publishedAt: '2026-07-14T12:00:00Z',
      publisher: 'Dokladovka',
      publisherThumbprint: 'B'.repeat(40),
      minimumWindowsVersion: '10',
      signed: true,
    };
    const unauthorized = await app.inject({ method: 'POST', url: '/api/internal/agent-releases', payload: commonRelease });
    expect(unauthorized.statusCode).toBe(401);
    const insecure = await app.inject({
      method: 'POST', url: '/api/internal/agent-releases', headers: { authorization: 'Bearer release-test-token' },
      payload: { ...commonRelease, downloadUrl: 'http://downloads.example.sk/setup.exe' },
    });
    expect(insecure.statusCode).toBe(400);
    const unsigned = await app.inject({
      method: 'POST', url: '/api/internal/agent-releases', headers: { authorization: 'Bearer release-test-token' },
      payload: { ...commonRelease, signed: false },
    });
    expect(unsigned.statusCode).toBe(400);
    const published = await app.inject({
      method: 'POST', url: '/api/internal/agent-releases', headers: { authorization: 'Bearer release-test-token' },
      payload: commonRelease,
    });
    expect(published.statusCode, published.body).toBe(201);
    const latest = await app.inject({ method: 'GET', url: '/api/agent/latest' });
    expect(latest.statusCode).toBe(200);
    expect(latest.headers['cache-control']).toContain('max-age=300');
    expect(latest.json()).toMatchObject({ available: true, version: '1.0.0', signed: true, fileSize: 123456 });

    const temporaryRelease = {
      ...commonRelease,
      version: '1.0.1',
      downloadUrl: '/downloads/Dokladovka-Agent-Setup-1.0.1-SELF-SIGNED-TEMP.exe',
      publisher: 'Dokladovka – DOČASNÝ SELF-SIGNED',
      signatureTrust: 'self-signed',
      certificateUrl: '/downloads/Dokladovka-Agent-Temporary-Code-Signing.cer',
      channel: 'temporary',
    };
    const missingCertificate = await app.inject({
      method: 'POST', url: '/api/internal/agent-releases', headers: { authorization: 'Bearer release-test-token' },
      payload: { ...temporaryRelease, certificateUrl: undefined },
    });
    expect(missingCertificate.statusCode).toBe(400);
    const temporaryPublished = await app.inject({
      method: 'POST', url: '/api/internal/agent-releases', headers: { authorization: 'Bearer release-test-token' },
      payload: temporaryRelease,
    });
    expect(temporaryPublished.statusCode, temporaryPublished.body).toBe(201);
    const temporaryLatest = await app.inject({ method: 'GET', url: '/api/agent/latest' });
    expect(temporaryLatest.json()).toMatchObject({
      available: true,
      version: '1.0.1',
      signatureTrust: 'self-signed',
      channel: 'temporary',
    });

    // Reálne self-signed vydania majú signed=false (tak ich zapísal starší
    // publikačný skript). Podmienka signed=true ich nikdy nevydala, takže
    // autoaktualizácia mlčala a agent sa preinštalovával ručne.
    await database.query(
      `INSERT INTO agent_releases
        (version, download_url, sha256, file_size, published_at, publisher, publisher_thumbprint,
         minimum_windows_version, signed, signature_trust, certificate_url, release_channel, active)
       VALUES ('1.0.2',$1,$2,123456,now(),'Dokladovka – DOČASNÝ SELF-SIGNED',$3,'10',
               false,'self-signed','/downloads/cert.cer','temporary',true)`,
      ['/downloads/Dokladovka-Agent-Setup-1.0.2-SELF-SIGNED-TEMP.exe', 'c'.repeat(64), 'B'.repeat(40)],
    );
    const nepodpisane = await app.inject({ method: 'GET', url: '/api/agent/latest' });
    expect(nepodpisane.json()).toMatchObject({ available: true, version: '1.0.2', signed: false });
    // Agent relatívnu cestu odmietne („nemá HTTPS URL"), preto ju server dopĺňa
    // o verejnú adresu aplikácie. Absolútnu adresu nechá tak.
    expect(nepodpisane.json().downloadUrl).toMatch(/^https?:\/\/.+\/downloads\/Dokladovka-Agent-Setup-1\.0\.2-SELF-SIGNED-TEMP\.exe$/);

    await app.close();
  }, 90_000);

  it('serves only allow-listed installer artifacts from the configured directory', async () => {
    const database = await createTestDatabase();
    databases.push(database);
    const directory = await mkdtemp(join(tmpdir(), 'dokladovka-agent-download-'));
    temporaryDirectories.push(directory);
    const fileName = 'Dokladovka-Agent-Setup-1.0.1-SELF-SIGNED-TEMP.exe';
    await writeFile(join(directory, fileName), 'temporary setup');
    await writeFile(join(directory, 'secret.txt'), 'must not be served');
    const app = await buildApp({
      database,
      storage: new MemoryObjectStorage(),
      config: testConfig({ agentInstallerDirectory: directory }),
      logger: false,
    });

    const download = await app.inject({ method: 'GET', url: `/downloads/${fileName}` });
    expect(download.statusCode).toBe(200);
    expect(download.body).toBe('temporary setup');
    expect(download.headers['content-disposition']).toContain(fileName);
    const blocked = await app.inject({ method: 'GET', url: '/downloads/secret.txt' });
    expect(blocked.statusCode).toBe(404);

    await app.close();
  }, 90_000);

  // POHODA rad bez vyplneného Obdobia do číselníka vôbec nedá — jej schéma má
  // element „period" povinný. Jediná cesta k takému radu vedie cez doklady,
  // ktoré ho nesú v <typ:id>/<typ:ids>.
  it('doplní číselný rad z dokladov a číselník neprepíše', async () => {
    const database = await createTestDatabase();
    databases.push(database);
    const seeded = await seedTestUser(database);
    const app = await buildApp({ database, storage: new MemoryObjectStorage(), config: testConfig(), logger: false });

    const login = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { email: seeded.email, password: seeded.password } });
    const browserHeaders = { cookie: String(login.headers['set-cookie']).split(';')[0], 'x-csrf-token': login.json().csrfToken as string };
    await app.inject({ method: 'PUT', url: '/api/mostik/settings', headers: browserHeaders, payload: { enabled: true } });
    const pairing = await app.inject({ method: 'POST', url: '/api/mostik/pairing-codes', headers: browserHeaders, payload: { organizationId: seeded.organizationId } });
    const paired = await app.inject({
      method: 'POST', url: '/api/agent/pair',
      payload: { pairingCode: pairing.json().code as string, hostname: 'POHODA-SRV', agentVersion: '1.0.0', companyIco: '12345678' },
    });
    const agentHeaders = { authorization: `Bearer ${paired.json().agentToken as string}` };

    // Číselník POHODY prinesie 26PK; 26OZ v ňom nie je a nikdy nebude.
    const ciselnik = await app.inject({
      method: 'PUT', url: `/api/agent/organizations/${seeded.organizationId}/code-lists`, headers: agentHeaders,
      payload: { kind: 'ciselneRady', items: [{ kod: '26PK', nazov: 'Ostatné záväzky-Platba Kartou', agenda: 'ostatni_zavazky', posledneCislo: '26PK474' }] },
    });
    expect(ciselnik.statusCode, ciselnik.body).toBe(200);

    const historia = await app.inject({
      method: 'PUT', url: `/api/agent/organizations/${seeded.organizationId}/ucto-history`, headers: agentHeaders,
      payload: {
        rows: [], reset: true,
        series: [
          { externalId: '575', kod: '26OZ', agenda: 'ostatni_zavazky', posledneCislo: '26OZ371' },
          // Rad, ktorý číselník už má — z dokladu sa nesmie prepísať.
          { externalId: '635', kod: '26PK', agenda: 'ostatni_zavazky', posledneCislo: '26PK400' },
        ],
      },
    });
    expect(historia.statusCode, historia.body).toBe(200);
    expect(historia.json().rady).toEqual({ nove: 1, aktualizovane: 0 });

    const rady = await database.query<{ code: string; name: string; source: string; agenda: string; last_number: string; active: boolean } & Record<string, unknown>>(
      `SELECT code, name, source, agenda, last_number, active FROM code_list_items
        WHERE tenant_id=$1 AND organization_id=$2 AND kind='ciselneRady' ORDER BY code`,
      [seeded.tenantId, seeded.organizationId],
    );
    expect(rady.rows).toEqual([
      expect.objectContaining({ code: '26OZ', name: '26OZ', source: 'pohoda_doklad', agenda: 'ostatni_zavazky', last_number: '26OZ371', active: true }),
      // Číselník má prednosť: názov aj posledné číslo ostali jeho.
      expect.objectContaining({ code: '26PK', name: 'Ostatné záväzky-Platba Kartou', source: 'pohoda', last_number: '26PK474' }),
    ]);

    // Ďalší prenos posunie posledné číslo, ale nezaloží druhý rad.
    const znova = await app.inject({
      method: 'PUT', url: `/api/agent/organizations/${seeded.organizationId}/ucto-history`, headers: agentHeaders,
      payload: { rows: [], series: [{ externalId: '575', kod: '26OZ', agenda: 'ostatni_zavazky', posledneCislo: '26OZ372' }] },
    });
    expect(znova.json().rady).toEqual({ nove: 0, aktualizovane: 1 });

    // A hodinová synchronizácia číselníka ho nesmie zhasnúť — čistí len 'pohoda'.
    await app.inject({
      method: 'PUT', url: `/api/agent/organizations/${seeded.organizationId}/code-lists`, headers: agentHeaders,
      payload: { kind: 'ciselneRady', items: [{ kod: '26PK', nazov: 'Ostatné záväzky-Platba Kartou', agenda: 'ostatni_zavazky' }] },
    });
    const poSynchronizacii = await database.query<{ last_number: string; active: boolean } & Record<string, unknown>>(
      `SELECT last_number, active FROM code_list_items
        WHERE tenant_id=$1 AND organization_id=$2 AND kind='ciselneRady' AND code='26OZ'`,
      [seeded.tenantId, seeded.organizationId],
    );
    expect(poSynchronizacii.rows[0]).toEqual(expect.objectContaining({ last_number: '26OZ372', active: true }));

    await app.close();
  }, 90_000);
});

// Denník sa dovtedy nahrával iba ručne cez prehliadač. Agent posiela surové
// XML — parser je jeden, na serveri. Test drží aj to, kvôli čomu už raz vznikla
// migrácia 0046: kind telemetrie musí prejsť zod schémou AJ CHECK-om tabuľky,
// inak sa synchronizácia zapíše len do lokálneho logu agenta.
describe('agent nahráva účtovný denník', () => {
  it('prijme denník a telemetriu s kindom uctovnyDennik', async () => {
    const database = await createTestDatabase();
    databases.push(database);
    const seeded = await seedTestUser(database);
    const app = await buildApp({ database, storage: new MemoryObjectStorage(), config: testConfig(), logger: false });
    const login = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { email: seeded.email, password: seeded.password } });
    const browserHeaders = {
      cookie: String(login.headers['set-cookie']).split(';')[0],
      'x-csrf-token': login.json().csrfToken as string,
    };
    await app.inject({ method: 'PUT', url: '/api/mostik/settings', headers: browserHeaders, payload: { enabled: true } });
    const pairing = await app.inject({
      method: 'POST', url: '/api/mostik/pairing-codes', headers: browserHeaders,
      payload: { organizationId: seeded.organizationId },
    });
    const paired = await app.inject({
      method: 'POST', url: '/api/agent/pair',
      payload: { pairingCode: pairing.json().code as string, hostname: 'POHODA-SRV', agentVersion: '0.14.0', companyIco: '12345678' },
    });
    const agentHeaders = { authorization: `Bearer ${paired.json().agentToken as string}` };

    const xml = `<?xml version="1.0" encoding="Windows-1250"?>
<rsp:responsePack version="2.0" state="ok"
  xmlns:rsp="http://www.stormware.cz/schema/version_2/response.xsd"
  xmlns:lst="http://www.stormware.cz/schema/version_2/list.xsd"
  xmlns:act="http://www.stormware.cz/schema/version_2/accountancy.xsd"
  xmlns:typ="http://www.stormware.cz/schema/version_2/type.xsd">
  <rsp:responsePackItem version="2.0" state="ok"><lst:listAccountancy version="2.0"><lst:accountancy version="2.0">
    <act:accountingItem>
      <act:id>9001</act:id><act:source>Prijaté faktúry</act:source>
      <act:number><typ:numberRequested>DF260181</typ:numberRequested></act:number>
      <act:text>PHM</act:text>
      <act:homeCurrency><typ:priceSum>151.60</typ:priceSum></act:homeCurrency>
      <act:accounting><act:credit>501200</act:credit><act:debit>321100</act:debit></act:accounting>
      <act:date>2026-07-31</act:date>
    </act:accountingItem>
    <act:accountingItem>
      <act:id>9002</act:id><act:source>Prijaté faktúry</act:source>
      <act:number><typ:numberRequested>DF260181</typ:numberRequested></act:number>
      <act:text>PHM</act:text>
      <act:homeCurrency><typ:priceSum>13.17</typ:priceSum></act:homeCurrency>
      <act:accounting><act:credit>501201</act:credit><act:debit>321100</act:debit></act:accounting>
      <act:date>2026-07-31</act:date>
    </act:accountingItem>
  </lst:accountancy></lst:listAccountancy></rsp:responsePackItem>
</rsp:responsePack>`;
    const nahrate = await app.inject({
      method: 'PUT', url: `/api/agent/organizations/${seeded.organizationId}/ucto-dennik`,
      headers: agentHeaders, payload: { xml },
    });
    expect(nahrate.statusCode, nahrate.body.slice(0, 200)).toBe(200);
    expect(nahrate.json().ulozenych).toBe(2);

    // Telemetria: kind musí prejsť aj CHECK-om tabuľky, nielen zod schémou.
    const telemetria = await app.inject({
      method: 'POST', url: '/api/agent/sync-results', headers: agentHeaders,
      payload: { organizationId: seeded.organizationId, kind: 'uctovnyDennik', state: 'ok', itemCount: 2, durationMs: 120 },
    });
    expect(telemetria.statusCode, telemetria.body.slice(0, 200)).toBe(202);
    // Ten istý kind posiela korpus histórie — dovtedy padal na 400 a na serveri
    // po synchronizácii nebolo ani stopy.
    const profil = await app.inject({
      method: 'POST', url: '/api/agent/sync-results', headers: agentHeaders,
      payload: { organizationId: seeded.organizationId, kind: 'uctovnyProfil', state: 'ok', itemCount: 5, durationMs: 90 },
    });
    expect(profil.statusCode, profil.body.slice(0, 200)).toBe(202);

    const behy = await database.query<{ kind: string } & Record<string, unknown>>(
      'SELECT kind FROM agent_sync_runs ORDER BY kind', [],
    );
    expect(behy.rows.map((row) => row.kind)).toEqual(['uctovnyDennik', 'uctovnyProfil']);

    await app.close();
  }, 90_000);
});

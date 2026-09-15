import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import { buildApp } from '../app.js';
import { buildApprovedDocumentsXml } from '../services/exportService.js';
import { createTestDatabase, seedTestUser, testConfig } from '../testHelpers.js';
import { MemoryObjectStorage } from '../storage.js';

// Podtyp faktúry (dobropis, ťarchopis, zálohová) rozhoduje o invoiceType pre
// POHODU, o číselnom rade aj o tom, z čoho sa AI učí. Doteraz ho úprava
// dokladu neukladala a schválenie ho pri čítaní dokladu vynechalo — každý
// dobropis tak odišiel do POHODY ako bežná faktúra.

const databases: Awaited<ReturnType<typeof createTestDatabase>>[] = [];
afterEach(async () => Promise.all(databases.splice(0).map((database) => database.close())));

function sessionHeaders(response: { headers: Record<string, unknown>; json(): any }) {
  return { cookie: String(response.headers['set-cookie']).split(';')[0], 'x-csrf-token': response.json().csrfToken as string };
}

async function pripravAplikaciu() {
  const database = await createTestDatabase();
  databases.push(database);
  const seeded = await seedTestUser(database);
  const app = await buildApp({ database, storage: new MemoryObjectStorage(), config: testConfig(), logger: false });
  const login = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { email: seeded.email, password: seeded.password } });
  return { database, seeded, app, headers: sessionHeaders(login) };
}

async function pripravDoklad(
  database: Awaited<ReturnType<typeof createTestDatabase>>,
  seeded: { tenantId: string; organizationId: string },
  podtyp: string,
): Promise<{ documentId: string; predkontacia: string; clenenie: string; rad: string; radZalohovy: string }> {
  const id = randomUUID();
  const predkontacia = randomUUID();
  const clenenie = randomUUID();
  const rad = randomUUID();
  const radZalohovy = randomUUID();
  for (const [cid, kind, code, agenda] of [
    [predkontacia, 'predkontacie', '518/321', null], [clenenie, 'cleneniaDph', 'PD', null],
    [rad, 'ciselneRady', '26FP', 'prijate_faktury'], [radZalohovy, 'ciselneRady', '26ZF', 'prijate_zalohove_faktury'],
  ] as const) {
    await database.query(
      `INSERT INTO code_list_items (id,tenant_id,organization_id,kind,code,name,source,agenda)
       VALUES ($1,$2,$3,$4,$5,$5,'manual',$6)`,
      [cid, seeded.tenantId, seeded.organizationId, kind, code, agenda],
    );
  }
  await database.query(
    `INSERT INTO documents (id,tenant_id,organization_id,document_type,podtyp,status,processing_status,extracted,accounting,total_amount,currency)
     VALUES ($1,$2,$3,'FP',$6,'na_kontrole','ready_for_review',$4::jsonb,$5::jsonb,123,'EUR')`,
    [id, seeded.tenantId, seeded.organizationId,
      JSON.stringify({
        dodavatel: { nazov: 'RAINSIDE s.r.o.', ico: '31386946' }, odberatel: {}, cisloFaktury: 'D-1',
        datumVystavenia: '2026-07-01', datumDodania: '2026-07-01', datumSplatnosti: '2026-07-20',
        mena: 'EUR', rozpisDph: [{ sadzba: 23, zaklad: 100, dph: 23 }], sumaSpolu: 123, polozky: [],
      }),
      JSON.stringify({ predkontaciaId: predkontacia, clenenieDphId: clenenie, ciselnyRadId: rad }),
      podtyp],
  );
  return { documentId: id, predkontacia, clenenie, rad, radZalohovy };
}

describe('podtyp dokladu', () => {
  it('úprava podtyp uloží a mimo faktúry ho vráti na bežnú', async () => {
    const { database, seeded, app, headers } = await pripravAplikaciu();
    const { documentId } = await pripravDoklad(database, seeded, 'bezna');

    const tarchopis = await app.inject({
      method: 'PATCH', url: `/api/documents/${documentId}`, headers,
      payload: { documentType: 'FP', podtyp: 'tarchopis', expectedVersion: 1 },
    });
    expect(tarchopis.statusCode, tarchopis.body).toBe(200);
    expect(tarchopis.json().podtyp).toBe('tarchopis');
    const ulozeny = await database.query<{ podtyp: string } & Record<string, unknown>>(
      'SELECT podtyp FROM documents WHERE id=$1', [documentId]);
    expect(ulozeny.rows[0].podtyp).toBe('tarchopis');
    // Samotný podtyp nie je oprava typu: ukladá sa k dodávateľovi a jeden
    // ťarchopis by klasifikáciu naučil, že ťarchopisom je všetko od neho.
    const oprava = await database.query<{ povodny_typ: string; novy_typ: string } & Record<string, unknown>>(
      'SELECT povodny_typ, novy_typ FROM typ_opravy WHERE document_id=$1', [documentId]);
    expect(oprava.rows).toEqual([]);

    // Ostatný záväzok ťarchopis nemá — podtyp by mu zmenil rad aj sekciu KV.
    const oz = await app.inject({
      method: 'PATCH', url: `/api/documents/${documentId}`, headers,
      payload: { documentType: 'OZ', expectedVersion: 2 },
    });
    expect(oz.statusCode, oz.body).toBe(200);
    expect(oz.json().podtyp).toBe('bezna');

    await app.close();
  }, 60_000);

  it('schválený dobropis nesie podtyp do snapshotu, pamäte aj exportu', async () => {
    const { database, seeded, app, headers } = await pripravAplikaciu();
    const { documentId } = await pripravDoklad(database, seeded, 'dobropis');
    // Návrh, voči ktorému sa zapíše oprava — ucto_opravy musí niesť podtyp tiež.
    await database.query(
      `INSERT INTO accounting_suggestions (document_id,tenant_id,organization_id,source,confidence,reason)
       VALUES ($1,$2,$3,'none',0,'test')`,
      [documentId, seeded.tenantId, seeded.organizationId],
    );

    const approved = await app.inject({
      method: 'POST', url: `/api/documents/${documentId}/approve`, headers, payload: { expectedVersion: 1 },
    });
    expect(approved.statusCode, approved.body).toBe(200);
    expect(approved.json().approved_snapshot.podtyp).toBe('dobropis');
    const rozhodnutie = await database.query<{ podtyp: string } & Record<string, unknown>>(
      'SELECT podtyp FROM ucto_decisions WHERE document_id=$1', [documentId]);
    expect(rozhodnutie.rows[0]?.podtyp).toBe('dobropis');
    const oprava = await database.query<{ podtyp: string } & Record<string, unknown>>(
      'SELECT podtyp FROM ucto_opravy WHERE document_id=$1', [documentId]);
    expect(oprava.rows[0]?.podtyp).toBe('dobropis');

    const xml = await buildApprovedDocumentsXml(database, {
      tenantId: seeded.tenantId, organizationId: seeded.organizationId, ico: '12345678',
      documentIds: [documentId], packId: randomUUID(),
    });
    expect(xml).toContain('receivedCreditNotice');

    await app.close();
  }, 60_000);

  it('zmena druhu doplní rad pre nový druh a AI návrh nechá tak', async () => {
    const { database, seeded, app, headers } = await pripravAplikaciu();
    const { documentId, predkontacia, clenenie, rad, radZalohovy } = await pripravDoklad(database, seeded, 'bezna');
    // AI analýza dokladu, ktorú by celá prestavba návrhu prepísala slabším
    // návrhom z pamäte — a nikto by ju už znova nepustil.
    await database.query(
      `INSERT INTO accounting_suggestions (document_id,tenant_id,organization_id,predkontacia_id,clenenie_dph_id,ciselny_rad_id,source,confidence,reason)
       VALUES ($1,$2,$3,$4,$5,$6,'ai',0.8,'AI analýza dokladu: záloha na tovar')`,
      [documentId, seeded.tenantId, seeded.organizationId, predkontacia, clenenie, rad],
    );

    // Editor pri zmene druhu starý rad (prijaté faktúry) vymaže.
    const zalohova = await app.inject({
      method: 'PATCH', url: `/api/documents/${documentId}`, headers,
      payload: {
        documentType: 'FP', podtyp: 'zalohova', expectedVersion: 1,
        accounting: { predkontaciaId: predkontacia, clenenieDphId: clenenie },
      },
    });
    expect(zalohova.statusCode, zalohova.body).toBe(200);
    // Jedna verzia — doplnenie radu nie je druhá úprava dokladu.
    expect(zalohova.json().version).toBe(2);
    expect(zalohova.json().accounting.ciselnyRadId).toBe(radZalohovy);
    const navrh = await database.query<{ ciselny_rad_id: string; source: string; predkontacia_id: string } & Record<string, unknown>>(
      'SELECT ciselny_rad_id, source, predkontacia_id FROM accounting_suggestions WHERE document_id=$1', [documentId]);
    expect(navrh.rows[0]).toMatchObject({ ciselny_rad_id: radZalohovy, source: 'ai', predkontacia_id: predkontacia });

    // Prepnutie tam a späť rad z konceptu zmazalo; druh je ako v databáze,
    // a doklad aj tak nesmie ostať bez radu.
    const spat = await app.inject({
      method: 'PATCH', url: `/api/documents/${documentId}`, headers,
      payload: {
        documentType: 'FP', podtyp: 'zalohova', expectedVersion: 2,
        accounting: { predkontaciaId: predkontacia, clenenieDphId: clenenie },
      },
    });
    expect(spat.statusCode, spat.body).toBe(200);
    expect(spat.json().accounting.ciselnyRadId).toBe(radZalohovy);

    await app.close();
  }, 60_000);
});

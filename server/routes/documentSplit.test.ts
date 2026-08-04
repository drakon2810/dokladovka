import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import { buildApp } from '../app.js';
import { createTestDatabase, seedTestUser, testConfig } from '../testHelpers.js';
import { MemoryObjectStorage } from '../storage.js';

const databases: Awaited<ReturnType<typeof createTestDatabase>>[] = [];
afterEach(async () => Promise.all(databases.splice(0).map((database) => database.close())));

function sessionHeaders(response: { headers: Record<string, unknown>; json(): any }) {
  const cookie = String(response.headers['set-cookie']).split(';')[0];
  return { cookie, 'x-csrf-token': response.json().csrfToken as string };
}

/** Rekapitulácia miezd: hrubé mzdy + odvody poisťovni v jednom doklade. */
const EXTRACTED = {
  dodavatel: { nazov: 'Zamestnávateľ s.r.o.', ico: '12345678' },
  cisloFaktury: 'MZDY-07/2026',
  datumVystavenia: '2026-07-31',
  mena: 'EUR',
  rozpisDph: [{ sadzba: 0, zaklad: 3000, dph: 0 }],
  sumaSpolu: 3000,
  polozky: [
    { id: 'p1', popis: 'Hrubé mzdy', sadzbaDph: 0, sumaBezDph: 2000, sumaDph: 0, sumaSpolu: 2000 },
    { id: 'p2', popis: 'Odvody Sociálna poisťovňa', sadzbaDph: 0, sumaBezDph: 800, sumaDph: 0, sumaSpolu: 800 },
    { id: 'p3', popis: 'Zrážková daň', sadzbaDph: 0, sumaBezDph: 200, sumaDph: 0, sumaSpolu: 200 },
  ],
};

describe('rozdelenie dokladu', () => {
  it('oddelí vybrané položky do nového dokladu a prepočíta sumy oboch', async () => {
    const database = await createTestDatabase();
    databases.push(database);
    const seeded = await seedTestUser(database);
    const app = await buildApp({ database, storage: new MemoryObjectStorage(), config: testConfig(), logger: false });
    const headers = sessionHeaders(await app.inject({
      method: 'POST', url: '/api/auth/login', payload: { email: seeded.email, password: seeded.password },
    }));

    const documentId = randomUUID();
    await database.query(
      `INSERT INTO documents (id,tenant_id,organization_id,document_type,status,processing_status,extracted,accounting,total_amount,currency)
       VALUES ($1,$2,$3,'MZDY','na_kontrole','ready_for_review',$4::jsonb,'{}'::jsonb,3000,'EUR')`,
      [documentId, seeded.tenantId, seeded.organizationId, JSON.stringify(EXTRACTED)],
    );

    // Odvody idú do samostatného ostatného záväzku.
    const split = await app.inject({
      method: 'POST', url: `/api/documents/${documentId}/split`, headers,
      payload: { polozkaIds: ['p2'], typ: 'OZ', expectedVersion: 1 },
    });
    expect(split.statusCode, split.body).toBe(201);
    const novyId = split.json().id as string;

    const novy = await database.query<Record<string, any>>(
      'SELECT document_type, status, extracted, total_amount, split_from_document_id FROM documents WHERE id=$1',
      [novyId],
    );
    expect(novy.rows[0].document_type).toBe('OZ');
    expect(novy.rows[0].split_from_document_id).toBe(documentId);
    expect(novy.rows[0].extracted.polozky).toHaveLength(1);
    expect(novy.rows[0].extracted.sumaSpolu).toBe(800);
    // Rozpis DPH sa poskladá z položiek novej časti, nezdedí sa celý.
    expect(novy.rows[0].extracted.rozpisDph).toEqual([{ sadzba: 0, zaklad: 800, dph: 0 }]);
    expect(Number(novy.rows[0].total_amount)).toBe(800);

    const povodny = await database.query<Record<string, any>>(
      'SELECT extracted, version, total_amount FROM documents WHERE id=$1', [documentId],
    );
    expect(povodny.rows[0].extracted.polozky.map((p: any) => p.id)).toEqual(['p1', 'p3']);
    expect(povodny.rows[0].extracted.sumaSpolu).toBe(2200);
    expect(povodny.rows[0].version).toBe(2);

    // Časť rozdeleného dokladu sa už ďalej deliť nedá.
    const znova = await app.inject({
      method: 'POST', url: `/api/documents/${novyId}/split`, headers,
      payload: { polozkaIds: ['p2'], typ: 'FP', expectedVersion: 1 },
    });
    expect(znova.statusCode).toBe(409);
    expect(znova.json().code).toBe('already_split');
    await app.close();
  }, 120_000);

  it('pôvodný doklad sa dá rozdeliť opakovane — rekapitulácia miezd dá tri interné doklady', async () => {
    const database = await createTestDatabase();
    databases.push(database);
    const seeded = await seedTestUser(database);
    const app = await buildApp({ database, storage: new MemoryObjectStorage(), config: testConfig(), logger: false });
    const headers = sessionHeaders(await app.inject({
      method: 'POST', url: '/api/auth/login', payload: { email: seeded.email, password: seeded.password },
    }));
    const documentId = randomUUID();
    await database.query(
      `INSERT INTO documents (id,tenant_id,organization_id,document_type,status,processing_status,extracted,accounting,total_amount,currency)
       VALUES ($1,$2,$3,'MZDY','na_kontrole','ready_for_review',$4::jsonb,'{}'::jsonb,3000,'EUR')`,
      [documentId, seeded.tenantId, seeded.organizationId, JSON.stringify(EXTRACTED)],
    );

    // 1. odčlenenie: tvorba sociálneho fondu
    const prve = await app.inject({
      method: 'POST', url: `/api/documents/${documentId}/split`, headers,
      payload: { polozkaIds: ['p2'], typ: 'MZDY', expectedVersion: 1 },
    });
    expect(prve.statusCode, prve.body).toBe(201);

    // 2. odčlenenie z toho istého (už zmenšeného) dokladu — verzia medzitým stúpla
    const druhe = await app.inject({
      method: 'POST', url: `/api/documents/${documentId}/split`, headers,
      payload: { polozkaIds: ['p3'], typ: 'MZDY', expectedVersion: 2 },
    });
    expect(druhe.statusCode, druhe.body).toBe(201);

    const casti = await database.query<Record<string, any>>(
      'SELECT id, extracted, total_amount FROM documents WHERE split_from_document_id=$1 ORDER BY created_at',
      [documentId],
    );
    expect(casti.rowCount).toBe(2);
    expect(casti.rows.map((row) => Number(row.total_amount))).toEqual([800, 200]);
    const zvysok = await database.query<Record<string, any>>('SELECT extracted FROM documents WHERE id=$1', [documentId]);
    expect(zvysok.rows[0].extracted.polozky.map((p: any) => p.id)).toEqual(['p1']);
    expect(zvysok.rows[0].extracted.sumaSpolu).toBe(2000);
    await app.close();
  }, 120_000);

  it('odmietne zastaranú verziu, prázdny výber aj odobratie všetkých položiek', async () => {
    const database = await createTestDatabase();
    databases.push(database);
    const seeded = await seedTestUser(database);
    const app = await buildApp({ database, storage: new MemoryObjectStorage(), config: testConfig(), logger: false });
    const headers = sessionHeaders(await app.inject({
      method: 'POST', url: '/api/auth/login', payload: { email: seeded.email, password: seeded.password },
    }));
    const documentId = randomUUID();
    await database.query(
      `INSERT INTO documents (id,tenant_id,organization_id,document_type,status,processing_status,extracted,accounting,total_amount,currency)
       VALUES ($1,$2,$3,'MZDY','na_kontrole','ready_for_review',$4::jsonb,'{}'::jsonb,3000,'EUR')`,
      [documentId, seeded.tenantId, seeded.organizationId, JSON.stringify(EXTRACTED)],
    );

    const zlaVerzia = await app.inject({
      method: 'POST', url: `/api/documents/${documentId}/split`, headers,
      payload: { polozkaIds: ['p2'], typ: 'OZ', expectedVersion: 9 },
    });
    expect(zlaVerzia.statusCode).toBe(409);
    expect(zlaVerzia.json().code).toBe('version_conflict');

    // Neznáme id položky = prázdny výber; doklad musí ostať nedotknutý.
    const nic = await app.inject({
      method: 'POST', url: `/api/documents/${documentId}/split`, headers,
      payload: { polozkaIds: ['neexistuje'], typ: 'OZ', expectedVersion: 1 },
    });
    expect(nic.statusCode).toBe(422);
    expect(nic.json().code).toBe('no_items');

    const vsetky = await app.inject({
      method: 'POST', url: `/api/documents/${documentId}/split`, headers,
      payload: { polozkaIds: ['p1', 'p2', 'p3'], typ: 'OZ', expectedVersion: 1 },
    });
    expect(vsetky.statusCode).toBe(422);
    expect(vsetky.json().code).toBe('all_items');

    const nedotknuty = await database.query<Record<string, any>>(
      'SELECT extracted, version FROM documents WHERE id=$1', [documentId],
    );
    expect(nedotknuty.rows[0].extracted.polozky).toHaveLength(3);
    expect(nedotknuty.rows[0].version).toBe(1);
    await app.close();
  }, 120_000);
});

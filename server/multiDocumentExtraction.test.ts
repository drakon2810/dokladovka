// Rekapitulácia miezd sa účtuje ako viac interných dokladov naraz. AI ich vráti
// v `additionalDocuments` a worker z jedného prijatého súboru založí niekoľko
// dokladov previazaných tou istou väzbou ako ručné rozdelenie.
import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import { buildApp } from './app.js';
import { createTestDatabase, seedTestUser, testConfig } from './testHelpers.js';
import { MemoryObjectStorage } from './storage.js';
import { processNextJob } from './workerService.js';
import { EXTRACTION_SCHEMA_VERSION, fromWireResult, type ExtractionInput, type ExtractionOutcome, type ServerDocumentExtractionProvider } from './extraction/contract.js';

const databases: Awaited<ReturnType<typeof createTestDatabase>>[] = [];
afterEach(async () => Promise.all(databases.splice(0).map((database) => database.close())));

function sessionHeaders(response: { headers: Record<string, unknown>; json(): any }) {
  const cookie = String(response.headers['set-cookie']).split(';')[0];
  return { cookie, 'x-csrf-token': response.json().csrfToken as string };
}

const PRAZDNA_STRANA = {
  nazov: null, ico: null, dic: null, icDph: null, adresa: null, iban: null, bic: null,
};

// Polia bankového pohybu — pri faktúrach a mzdách ich model vracia ako null.
const PRAZDNY_POHYB = {
  paymentDate: null, counterpartyName: null, counterpartyIban: null,
  variableSymbol: null, constantSymbol: null, specificSymbol: null,
};

/** Presne to, čo by model vrátil pre rozbor miezd podľa pravidla firmy. */
function rekapitulaciaWire() {
  return {
    schemaVersion: EXTRACTION_SCHEMA_VERSION,
    documentType: 'MZDY',
    supplier: { ...PRAZDNA_STRANA, nazov: 'AGS Bratislava' },
    buyer: { nazov: null, ico: null, dic: null, icDph: null, adresa: null },
    invoiceNumber: 'MZDY-04/2026', orderNumber: null, deliveryNoteNumber: null,
    variableSymbol: '202612', constantSymbol: null, specificSymbol: null,
    issueDate: '2026-04-30', taxDate: '2026-04-30', dueDate: null, currency: 'EUR',
    statementNumber: null,
    documentSummary: 'mzdy za 2026/04',
    // Mzdy idú do POHODY ako „UN" + sekcia KV „KN" — obidve naraz, každá vo svojom poli.
    accountCode: null, vatClassificationCode: 'UN', vatControlStatementCode: 'KN', numberSeriesCode: '26MZD',
    lineItems: [
      // Kód opísaný z pravidla presne; server ho spáruje s číselníkom firmy.
      { description: 'hrubá mzda', accountCode: '521100/331100 HM', vatClassificationCode: null, quantity: '1', unit: null, unitPriceWithoutVat: null, vatRate: '0', amountWithoutVat: '9201.19', vatAmount: '0', amountTotal: '9201.19', ...PRAZDNY_POHYB },
      // Kód bez chvosta — musí sa nájsť cez jednoznačný prefix.
      { description: 'náhrada za PN', accountCode: '524100/331100', vatClassificationCode: null, quantity: '1', unit: null, unitPriceWithoutVat: null, vatRate: '0', amountWithoutVat: '225.71', vatAmount: '0', amountTotal: '225.71', ...PRAZDNY_POHYB },
    ],
    vatBreakdown: [{ vatRate: '0', base: '9426.90', vat: '0', total: '9426.90' }],
    additionalDocuments: [
      {
        documentType: 'MZDY',
        documentSummary: 'mzdy-tvorba SF 04/2026',
        variableSymbol: '202510',
        accountCode: 'SF', vatClassificationCode: null, vatControlStatementCode: 'KN', numberSeriesCode: '26MZD',
        issueDate: '2026-04-30', taxDate: '2026-04-30',
        totalAmount: '51.88',
        lineItems: [],
        vatBreakdown: [{ vatRate: '0', base: '51.88', vat: '0', total: '51.88' }],
      },
      {
        documentType: 'OZ',
        documentSummary: 'zúčt.zál.na fin.prísp.-stravné 04/26',
        variableSymbol: '202507',
        // Kód s medzerami okolo lomky — musí sa spárovať s '331 / 335200'.
        accountCode: '331/335200', vatClassificationCode: null, vatControlStatementCode: null, numberSeriesCode: 'NEEXISTUJE',
        issueDate: '2026-04-30', taxDate: null,
        totalAmount: '162.00',
        lineItems: [],
        vatBreakdown: [{ vatRate: '0', base: '162.00', vat: '0', total: '162.00' }],
      },
    ],
    totalWithoutVat: '9426.90', totalVat: '0', totalAmount: '9426.90',
    fieldConfidence: [{ field: 'totalAmount', confidence: 0.95 }],
    evidence: [],
    warnings: [],
  };
}

class RekapitulaciaProvider implements ServerDocumentExtractionProvider {
  readonly name = 'mock' as const;

  async extract(_input: ExtractionInput): Promise<ExtractionOutcome> {
    return { result: fromWireResult(rekapitulaciaWire()), model: 'test', usage: undefined, requestId: undefined };
  }
}

describe('viac dokladov z jedného súboru', () => {
  it('rozbor miezd založí tri doklady previazané s pôvodným', async () => {
    const database = await createTestDatabase();
    databases.push(database);
    const seeded = await seedTestUser(database);
    const storage = new MemoryObjectStorage();
    const config = testConfig();
    const app = await buildApp({ database, storage, config, logger: false });
    const headers = sessionHeaders(await app.inject({
      method: 'POST', url: '/api/auth/login', payload: { email: seeded.email, password: seeded.password },
    }));
    // Číselník firmy — presne tie kódy, ktoré pravidlo menuje.
    const ciselnik: Array<[string, string, string]> = [
      ['predkontacie', '521100/331100 HM', 'Hrubá mzda zamestnanca'],
      ['predkontacie', '524100/331100', 'Náhrada za PN'],
      ['predkontacie', 'SF', 'Sociálny fond - zaúčtovanie prídelu'],
      ['predkontacie', '331 / 335200', 'fin.príspevok na stravu'],
      ['cleneniaDph', 'UN', 'Nezahŕňať do priznania DPH'],
      ['ciselneRady', '26MZD', 'Interné doklady-Mzdy'],
    ];
    const kody = new Map<string, string>();
    for (const [kind, code, name] of ciselnik) {
      const id = randomUUID();
      kody.set(code, id);
      await database.query(
        `INSERT INTO code_list_items (id,tenant_id,organization_id,kind,code,name,source)
         VALUES ($1,$2,$3,$4,$5,$6,'pohoda')`,
        [id, seeded.tenantId, seeded.organizationId, kind, code, name],
      );
    }

    const nahratie = await app.inject({
      method: 'POST', url: '/api/documents/upload', headers,
      payload: {
        organizationId: seeded.organizationId,
        files: [{ fileName: 'rozbor.pdf', mimeType: 'application/pdf', contentBase64: Buffer.from('%PDF-1.7 rozbor miezd').toString('base64') }],
      },
    });
    expect(nahratie.statusCode).toBe(202);

    await processNextJob(database, config, 'w1', { storage, provider: new RekapitulaciaProvider() });

    const doklady = await database.query<Record<string, any>>(
      `SELECT id, document_type, total_amount, extracted, accounting, split_from_document_id
         FROM documents WHERE organization_id=$1 ORDER BY created_at, split_from_document_id NULLS FIRST`,
      [seeded.organizationId],
    );
    expect(doklady.rowCount).toBe(3);

    const hlavny = doklady.rows.find((row) => !row.split_from_document_id);
    const casti = doklady.rows.filter((row) => row.split_from_document_id);
    expect(hlavny.document_type).toBe('MZDY');
    expect(Number(hlavny.total_amount)).toBe(9426.9);
    expect(hlavny.extracted.polozky).toHaveLength(2);
    expect(hlavny.extracted.textPolozky).toBe('mzdy za 2026/04');
    expect(hlavny.extracted.variabilnySymbol).toBe('202612');

    // Obe časti visia na hlavnom doklade — rovnaká väzba ako pri ručnom rozdelení.
    expect(casti).toHaveLength(2);
    expect(new Set(casti.map((row) => row.split_from_document_id))).toEqual(new Set([hlavny.id]));

    const sf = casti.find((row) => row.extracted.textPolozky === 'mzdy-tvorba SF 04/2026');
    expect(sf.document_type).toBe('MZDY');
    expect(Number(sf.total_amount)).toBe(51.88);
    expect(sf.extracted.variabilnySymbol).toBe('202510');
    // Dodávateľa aj číslo dokladu dedí od hlavného — ide o ten istý súbor.
    expect(sf.extracted.dodavatel.nazov).toBe('AGS Bratislava');
    expect(sf.extracted.cisloFaktury).toBe('MZDY-04/2026');

    const zaloha = casti.find((row) => row.document_type === 'OZ');
    expect(Number(zaloha.total_amount)).toBe(162);
    expect(zaloha.extracted.variabilnySymbol).toBe('202507');

    // Kódy z pravidla sú preložené na id číselníka firmy.
    // Členenie DPH aj sekcia KV naraz — mzdy idú do POHODY ako „UN" + „KN".
    expect(hlavny.accounting).toMatchObject({
      clenenieDphId: kody.get('UN'), ciselnyRadId: kody.get('26MZD'), clenenieKvKod: 'KN',
    });
    expect(hlavny.extracted.polozky[0].ucto.predkontaciaId).toBe(kody.get('521100/331100 HM'));
    // Kód bez chvosta sa našiel cez jednoznačný prefix.
    expect(hlavny.extracted.polozky[1].ucto.predkontaciaId).toBe(kody.get('524100/331100'));
    expect(sf.accounting).toMatchObject({
      predkontaciaId: kody.get('SF'), ciselnyRadId: kody.get('26MZD'), clenenieKvKod: 'KN',
    });
    // Medzery okolo lomky nevadia — „331/335200" sedí na „331 / 335200".
    expect(zaloha.accounting.predkontaciaId).toBe(kody.get('331 / 335200'));
    // Neznámy kód sa nehádže na najbližší: časť si necháva to, čo zdedila po
    // hlavnom doklade (ide o ten istý súbor), a účtovník to prípadne prepíše.
    expect(zaloha.accounting.ciselnyRadId).toBe(kody.get('26MZD'));

    // Každá časť má vlastný návrh zaúčtovania.
    const navrhy = await database.query(
      'SELECT document_id FROM accounting_suggestions WHERE document_id = ANY($1::text[])',
      [doklady.rows.map((row) => row.id)],
    );
    expect(navrhy.rowCount).toBe(3);

    // Príloha ostáva pri hlavnom doklade; časti sa k skenu dostanú cez väzbu.
    const priloha = await database.query<Record<string, any>>(
      'SELECT document_id, status FROM inbound_attachments WHERE organization_id=$1', [seeded.organizationId],
    );
    expect(priloha.rows[0]).toMatchObject({ document_id: hlavny.id, status: 'document_created' });
    await app.close();
  }, 120_000);

  it('bez additionalDocuments vznikne jediný doklad ako doteraz', async () => {
    const database = await createTestDatabase();
    databases.push(database);
    const seeded = await seedTestUser(database);
    const storage = new MemoryObjectStorage();
    const config = testConfig();
    const app = await buildApp({ database, storage, config, logger: false });
    const headers = sessionHeaders(await app.inject({
      method: 'POST', url: '/api/auth/login', payload: { email: seeded.email, password: seeded.password },
    }));
    await app.inject({
      method: 'POST', url: '/api/documents/upload', headers,
      payload: {
        organizationId: seeded.organizationId,
        files: [{ fileName: 'faktura.pdf', mimeType: 'application/pdf', contentBase64: Buffer.from('%PDF-1.7 bezna faktura').toString('base64') }],
      },
    });

    class BeznaFaktura implements ServerDocumentExtractionProvider {
      readonly name = 'mock' as const;
      async extract(): Promise<ExtractionOutcome> {
        return { result: fromWireResult({ ...rekapitulaciaWire(), documentType: 'FP', additionalDocuments: [] }), model: 'test', usage: undefined, requestId: undefined };
      }
    }
    await processNextJob(database, config, 'w1', { storage, provider: new BeznaFaktura() });

    const doklady = await database.query('SELECT id FROM documents WHERE organization_id=$1', [seeded.organizationId]);
    expect(doklady.rowCount).toBe(1);
    await app.close();
  }, 120_000);
});

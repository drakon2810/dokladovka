// Smer pokladničného dokladu sa pri vzniku neukladal: editor „Výdajový" len
// zobrazoval a AI pre doklad bez smeru brala históriu príjmov aj výdajov naraz.
import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { buildApp } from './app.js';
import { EXTRACTION_SCHEMA_VERSION, fromWireResult, type ExtractionOutcome, type ServerDocumentExtractionProvider } from './extraction/contract.js';
import { MemoryObjectStorage } from './storage.js';
import { aiOdpoved, createTestDatabase, seedTestUser, testConfig } from './testHelpers.js';
import { processNextJob } from './workerService.js';

const databases: Awaited<ReturnType<typeof createTestDatabase>>[] = [];
afterEach(async () => Promise.all(databases.splice(0).map((database) => database.close())));

const PRAZDNA_STRANA = {
  nazov: null, ico: null, dic: null, icDph: null, adresa: null, ulica: null, psc: null, obec: null, krajina: null, iban: null, bic: null,
};
const PRAZDNY_POHYB = {
  discountPercent: null, paymentDate: null, counterpartyName: null, counterpartyIban: null,
  variableSymbol: null, constantSymbol: null, specificSymbol: null,
};

/** Bloček s jedinou položkou tak, ako by ho vrátil model. */
function pokladnicnyDoklad(cislo: string, dodavatel: { nazov: string; ico: string }) {
  return {
    schemaVersion: EXTRACTION_SCHEMA_VERSION,
    documentType: 'PD',
    supplier: { ...PRAZDNA_STRANA, ...dodavatel },
    buyer: { nazov: null, ico: null, dic: null, icDph: null, adresa: null, ulica: null, psc: null, obec: null, krajina: null },
    invoiceNumber: cislo, orderNumber: null, deliveryNoteNumber: null, originalDocumentNumber: null,
    variableSymbol: null, constantSymbol: null, specificSymbol: null,
    issueDate: '2026-04-30', taxDate: '2026-04-30', servicePeriodEnd: null, originalTaxDate: null, dueDate: null, currency: 'EUR',
    statementNumber: null,
    documentSummary: 'benzin natural 95',
    accountCode: null, vatClassificationCode: null, vatControlStatementCode: null, numberSeriesCode: null,
    lineItems: [{
      description: 'benzin natural 95', accountCode: null, vatClassificationCode: null, quantity: '1', unit: null, unitPriceWithoutVat: null,
      vatRate: '23', amountWithoutVat: '50.00', vatAmount: '11.50', amountTotal: '61.50', ...PRAZDNY_POHYB,
    }],
    vatBreakdown: [{ vatRate: '23', base: '50.00', vat: '11.50', total: '61.50' }],
    additionalDocuments: [],
    totalWithoutVat: '50.00', totalVat: '11.50', totalAmount: '61.50',
    fieldConfidence: [{ field: 'totalAmount', confidence: 0.95 }],
    evidence: [],
    warnings: [],
  };
}

describe('smer pokladničného dokladu pri vzniku', () => {
  it('doklad firmy je príjem, cudzí výdaj, nastavený smer ostane a AI berie len históriu smeru', async () => {
    const database = await createTestDatabase();
    databases.push(database);
    const seeded = await seedTestUser(database);
    const storage = new MemoryObjectStorage();
    const config = testConfig();
    const app = await buildApp({ database, storage, config, logger: false });
    const login = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { email: seeded.email, password: seeded.password } });
    const headers = { cookie: String(login.headers['set-cookie']).split(';')[0], 'x-csrf-token': login.json().csrfToken as string };
    const kde = [seeded.tenantId, seeded.organizationId];

    await database.query(
      `INSERT INTO code_list_items (id,tenant_id,organization_id,kind,code,name,source)
       VALUES ($1,$2,$3,'predkontacie','501/211','Nákup PHM','pohoda'), ($4,$2,$3,'predkontacie','211/602','Tržba','pohoda')`,
      [randomUUID(), ...kde, randomUUID()],
    );
    // Ten istý text vo výdavkoch aj v príjmoch — denník smie niesť len prax smeru dokladu.
    for (const [agenda, predkontacia] of [['VPD', '501/211'], ['PPD', '211/602']]) {
      await database.query(
        `INSERT INTO ucto_historia (id,tenant_id,organization_id,agenda,line_text_normalized,predkontacia_kod,source,riadok_hash)
         VALUES ($1,$2,$3,$4,'benzin natural 95',$5,'mdb',$6)`,
        [randomUUID(), ...kde, agenda, predkontacia, randomUUID()],
      );
    }

    let wire = pokladnicnyDoklad('', { nazov: '', ico: '' });
    let pocasExtrakcie: (() => Promise<unknown>) | undefined;
    const provider: ServerDocumentExtractionProvider = {
      name: 'mock',
      async extract(): Promise<ExtractionOutcome> {
        await pocasExtrakcie?.();
        return { result: fromWireResult(wire), model: 'test', usage: undefined, requestId: undefined };
      },
    };
    const parser = {
      create: vi.fn().mockResolvedValue(aiOdpoved({
        predkontaciaId: null, clenenieDphId: null, clenenieKvKod: null, ciselnyRadId: null, confidence: 0.1, reason: 'test', riadky: null,
      })),
    };
    const spracuj = async (cislo: string, dodavatel: { nazov: string; ico: string }) => {
      wire = pokladnicnyDoklad(cislo, dodavatel);
      const nahratie = await app.inject({
        method: 'POST', url: '/api/documents/upload', headers,
        payload: {
          organizationId: seeded.organizationId,
          files: [{ fileName: `${cislo}.pdf`, mimeType: 'application/pdf', contentBase64: Buffer.from(`%PDF-1.7 ${cislo}`).toString('base64') }],
        },
      });
      expect(nahratie.statusCode, nahratie.body).toBe(202);
      parser.create.mockClear();
      await processNextJob(database, config, 'w1', { storage, provider, aiParser: parser });
      const doklad = (await database.query<Record<string, any>>(
        `SELECT accounting FROM documents WHERE organization_id=$1 AND extracted->>'cisloFaktury'=$2`,
        [seeded.organizationId, cislo],
      )).rows[0];
      const prompt = parser.create.mock.calls[0]?.[0] as any;
      return {
        smer: doklad?.accounting.pokladnaTyp,
        dennik: prompt && JSON.parse(prompt.input[0].content[0].text).dennik.map((riadok: { predkontaciaKod: string }) => riadok.predkontaciaKod),
      };
    };

    expect(await spracuj('BLOK-1', { nazov: 'Čerpacia stanica s.r.o.', ico: '87654321' }))
      .toEqual({ smer: 'expense', dennik: ['501/211'] });
    // Príjmový doklad vystavila sama firma — dodávateľom je ona.
    expect(await spracuj('PPD-1', { nazov: 'Test s.r.o.', ico: '12345678' }))
      .toEqual({ smer: 'receipt', dennik: ['211/602'] });
    // Smer, ktorý účtovník nastavil počas extrakcie, predvoľba neprepíše.
    pocasExtrakcie = () => database.query(
      `UPDATE documents SET accounting = accounting || '{"pokladnaTyp":"receipt"}'::jsonb
        WHERE organization_id=$1 AND processing_status='extracting'`,
      [seeded.organizationId],
    );
    expect((await spracuj('BLOK-2', { nazov: 'Čerpacia stanica s.r.o.', ico: '87654321' })).smer).toBe('receipt');

    await app.close();
  }, 120_000);
});

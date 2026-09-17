import { describe, expect, it, vi } from 'vitest';
import { buildApp } from './app.js';
import { MemoryObjectStorage } from './storage.js';
import { createTestDatabase, seedTestUser, testConfig } from './testHelpers.js';
import { randomUUID } from 'node:crypto';
import { cisloVPohodeZDokladu, looksLikePdfStructure, processNextJob, retryDelaySeconds, uvolniZaseknuteDoklady } from './workerService.js';

// Hodiny workera: klasifikácia trvá 30 s, extrakcia 2 s a potom padne.
const hodiny = vi.hoisted(() => ({ ms: 0 }));
vi.mock('./extraction/classifyProvider.js', async (povodny) => ({
  ...await povodny<typeof import('./extraction/classifyProvider.js')>(),
  OpenAIDocumentClassifier: class { async classify() { hodiny.ms += 30_000; return undefined; } },
}));
vi.mock('./extraction/openaiProvider.js', async (povodny) => {
  const skutocny = await povodny<typeof import('./extraction/openaiProvider.js')>();
  return {
    ...skutocny,
    OpenAIDocumentExtractionProvider: class {
      name = 'openai' as const;
      async extract(): Promise<never> {
        hodiny.ms += 2_000;
        throw new skutocny.ExtractionProviderError('openai_timeout', 'Časový limit AI', true);
      }
    },
  };
});

describe('retryDelaySeconds', () => {
  it('gives transient errors tens of seconds, not the old 2s/4s', () => {
    // rand=1 → full base: 20, 40, 80, 160, 320 s pre pokusy 1..5.
    expect(retryDelaySeconds(1, 1)).toBe(20);
    expect(retryDelaySeconds(2, 1)).toBe(40);
    expect(retryDelaySeconds(5, 1)).toBe(320);
  });

  it('applies jitter within [0.5*base, base] and caps at 600 s', () => {
    expect(retryDelaySeconds(1, 0)).toBe(10); // 20 * 0.5
    expect(retryDelaySeconds(6, 1)).toBe(600); // 20*2^5=640 → strop 600
    expect(retryDelaySeconds(6, 0)).toBe(300); // 600 * 0.5
  });

  it('grows monotonically with attempts for a fixed jitter', () => {
    const delays = [1, 2, 3, 4].map((n) => retryDelaySeconds(n, 0.7));
    expect(delays).toEqual([...delays].sort((a, b) => a - b));
  });
});

describe('looksLikePdfStructure', () => {
  it('accepts a real PDF trailer (that pdf-lib may still reject)', () => {
    expect(looksLikePdfStructure(Buffer.from('%PDF-1.4\n...\nstartxref\n1234\n%%EOF'))).toBe(true);
  });

  it('rejects data without any PDF cross-reference structure', () => {
    expect(looksLikePdfStructure(Buffer.from('%PDF-not-a-real-file'))).toBe(false);
  });
});

describe('cisloVPohodeZDokladu', () => {
  it('vydaná faktúra ide do POHODY s vlastným číslom, ostatné agendy nie', () => {
    expect(cisloVPohodeZDokladu('FV', { cisloFaktury: '260704300120' })).toBe('260704300120');
    // Prijatú faktúru čísluje POHODA — číslo dodávateľa ide do variabilného symbolu.
    expect(cisloVPohodeZDokladu('FP', { cisloFaktury: 'FA-225/2026' })).toBeUndefined();
    expect(cisloVPohodeZDokladu('FV', { cisloFaktury: '  ' })).toBeUndefined();
    expect(cisloVPohodeZDokladu('FV', undefined)).toBeUndefined();
    // POHODA berie do čísla dokladu najviac 32 znakov.
    expect(cisloVPohodeZDokladu('FV', { cisloFaktury: '9'.repeat(40) })).toHaveLength(32);
  });
});

// Doklad v 'normalizing' má extrakčný job už 'succeeded' — jeho výsledok je
// zaplatený a uložený, takže ho nič nevyzdvihne. Keby workera niekto zabil
// uprostred chvosta (kontrola DPH, návrh zaúčtovania), doklad by ostal
// neotvoriteľný navždy. Sweep po štarte workera ho uvoľní.
describe('uvolniZaseknuteDoklady', () => {
  it('uvolní len zaseknutý doklad — nie ten, na ktorom chvost ešte beží', async () => {
    const database = await createTestDatabase();
    try {
      const seeded = await seedTestUser(database);
      const config = testConfig();
      const doklad = async (processingStatus: string, staryOd: string) => {
        const id = randomUUID();
        await database.query(
          `INSERT INTO documents (id,tenant_id,organization_id,document_type,status,processing_status,
             source,extracted,accounting,total_amount,currency,updated_at)
           VALUES ($1,$2,$3,'FP','extrahovany',$4,'{"typ":"email"}'::jsonb,'{}'::jsonb,'{}'::jsonb,100,'EUR',
             now() - ($5::text)::interval)`,
          [id, seeded.tenantId, seeded.organizationId, processingStatus, staryOd],
        );
        return id;
      };
      const job = async (documentId: string, status: string) => database.query(
        `INSERT INTO processing_jobs (id,tenant_id,organization_id,document_id,kind,status,correlation_id)
         VALUES ($1,$2,$3,$4,'extract_document',$5,'test')`,
        [randomUUID(), seeded.tenantId, seeded.organizationId, documentId, status],
      );

      // Zabitý worker: chvost sa nedokončil, job je hotový, nikto nepríde.
      const zaseknuty = await doklad('normalizing', '2 hours');
      await job(zaseknuty, 'succeeded');
      // Chvost práve beží — dotknutý pred chvíľou, uvoľní ho processNextJob sám.
      const bezi = await doklad('normalizing', '5 seconds');
      await job(bezi, 'succeeded');
      // Starý doklad s čakajúcim jobom: ten ho prepíše, sweep doň nesmie siahnuť.
      const vofronte = await doklad('normalizing', '2 hours');
      await job(vofronte, 'queued');
      // Trvalá chyba je koncový verdikt a nesmie sa premeniť na „hotové".
      const zlyhany = await doklad('failed_permanent', '2 hours');
      await job(zlyhany, 'failed');

      expect(await uvolniZaseknuteDoklady(database, config)).toBe(1);
      const stav = async (id: string) => (await database.query<Record<string, any>>(
        'SELECT processing_status FROM documents WHERE id=$1', [id])).rows[0].processing_status;
      expect(await stav(zaseknuty)).toBe('ready_for_review');
      expect(await stav(bezi)).toBe('normalizing');
      expect(await stav(vofronte)).toBe('normalizing');
      expect(await stav(zlyhany)).toBe('failed_permanent');
      // Opakovaný štart workera už nemá čo uvolniť.
      expect(await uvolniZaseknuteDoklady(database, config)).toBe(0);
    } finally {
      await database.close();
    }
  }, 90_000);
});

describe('oneskorenie behu extrakcie', () => {
  it('zlyhaná extrakcia neráta čas klasifikácie, ktorá má vlastný beh', async () => {
    const database = await createTestDatabase();
    try {
      await seedTestUser(database);
      const storage = new MemoryObjectStorage();
      const config = testConfig({
        extractionProvider: 'openai',
        openai: { ...testConfig().openai, apiKey: 'test-key', timeoutMs: 5_000, maxRetries: 2 },
      });
      const app = await buildApp({ database, storage, config, logger: false });
      const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(32)]);
      const prijate = await app.inject({
        method: 'POST', url: '/api/webhooks/inbound-email/mock',
        headers: { 'x-dokladovka-webhook-secret': 'test-webhook-secret' },
        payload: {
          providerMessageId: 'oneskorenie-1', envelopeRecipients: ['test-abc234@doklady.test.sk'],
          attachments: [{ fileName: 'blok.png', mimeType: 'image/png', contentBase64: png.toString('base64') }],
        },
      });
      expect(prijate.statusCode).toBe(202);
      await app.close();
      const hodinky = vi.spyOn(performance, 'now').mockImplementation(() => hodiny.ms);
      try {
        await processNextJob(database, config, 'oneskorenie-worker', { storage });
      } finally {
        hodinky.mockRestore();
      }
      const behy = await database.query<{ prompt_version: string; status: string; latency_ms: number } & Record<string, unknown>>(
        'SELECT prompt_version, status, latency_ms FROM extraction_runs',
      );
      expect(behy.rows.map((beh) => beh.prompt_version)).toContain('klasifikacia-v1');
      expect(behy.rows.find((beh) => beh.prompt_version !== 'klasifikacia-v1'))
        .toMatchObject({ status: 'failed', latency_ms: 2_000 });
    } finally {
      await database.close();
    }
  }, 90_000);
});

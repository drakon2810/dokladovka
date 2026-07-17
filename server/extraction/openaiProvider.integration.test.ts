import { PDFDocument, StandardFonts, degrees } from 'pdf-lib';
import { describe, expect, it } from 'vitest';
import { EXTRACTION_PROMPT_VERSION, EXTRACTION_SCHEMA_VERSION } from './contract.js';
import { OpenAIDocumentExtractionProvider } from './openaiProvider.js';

const enabled = process.env.RUN_OPENAI_EXTRACTION_INTEGRATION === 'true' && Boolean(process.env.OPENAI_API_KEY);

describe.skipIf(!enabled)('OpenAI extraction – opt-in real API', () => {
  it('prečíta textovú a otočenú stranu PDF', async () => {
    const pdf = await PDFDocument.create();
    const font = await pdf.embedFont(StandardFonts.Helvetica);
    const first = pdf.addPage([595, 842]);
    first.drawText('FAKTURA 2026-TEST-001', { x: 60, y: 760, size: 18, font });
    first.drawText('Dodavatel: Test Supplier s.r.o., ICO 12345678', { x: 60, y: 720, size: 11, font });
    first.drawText('Odberatel: Test Buyer s.r.o., ICO 87654321', { x: 60, y: 700, size: 11, font });
    first.drawText('Datum vystaveni: 14.07.2026  Splatnost: 28.07.2026', { x: 60, y: 680, size: 11, font });
    first.drawText('Zaklad 100.00 EUR  DPH 23% 23.00 EUR  Celkem 123.00 EUR', { x: 60, y: 640, size: 11, font });
    const rotated = pdf.addPage([595, 842]);
    rotated.drawText('Variabilny symbol: 2026001', { x: 100, y: 100, size: 12, font, rotate: degrees(90) });

    const provider = new OpenAIDocumentExtractionProvider({
      apiKey: process.env.OPENAI_API_KEY,
      model: process.env.OPENAI_MODEL || 'gpt-5.6-terra',
      storeResponses: false,
      timeoutMs: Number(process.env.OPENAI_TIMEOUT_MS) || 120_000,
      maxRetries: 0,
    });
    const outcome = await provider.extract({
      documentId: 'integration-test', mimeType: 'application/pdf', fileName: 'integration-test.pdf',
      bytes: await pdf.save(), organizationContext: { nazov: 'Test Buyer s.r.o.', ico: '87654321' },
      promptVersion: EXTRACTION_PROMPT_VERSION, schemaVersion: EXTRACTION_SCHEMA_VERSION,
    });
    expect(outcome.result.invoiceNumber).toContain('2026-TEST-001');
    expect(outcome.result.totalAmount).toBe('123.00');
  }, 180_000);
});

import { describe, expect, it } from 'vitest';
import { OpenAIDocumentClassifier, signalyZNazvu } from './classifyProvider.js';

// Klasifikácia je samostatný krok práve preto, že v extrakčnom prompte sa
// documentType strácal medzi tridsiatimi poľami. Testy držia zmluvu tohto
// kroku: vracia typ, príznak účtovného dokladu a nikdy nepadá na odpovedi,
// ktorá sa nedá spracovať.

const config = {
  apiKey: 'test',
  model: 'gpt-test',
  accountingModel: 'gpt-test',
  ruleAnalysisModel: 'gpt-test',
  reasoningEffort: '',
  storeResponses: false,
  timeoutMs: 1000,
  maxRetries: 0,
} as unknown as Parameters<typeof OpenAIDocumentClassifier.prototype.constructor>[0];

const vstup = { bytes: new Uint8Array([1, 2, 3]), mimeType: 'application/pdf', fileName: 'kontrakt 2409.pdf' };

describe('signalyZNazvu', () => {
  it('rozpozná zmluvu, objednávku aj proformu bez ohľadu na diakritiku', () => {
    expect(signalyZNazvu('kontrakt 2409.pdf')).toEqual(['názov súboru pripomína zmluvu']);
    expect(signalyZNazvu('Objednávka_12.pdf')).toEqual(['názov súboru pripomína objednávku']);
    expect(signalyZNazvu('PROFORMA-9.pdf')).toEqual(['názov súboru pripomína proformu']);
  });

  it('bežná faktúra nedostane žiadny signál', () => {
    expect(signalyZNazvu('invoice_7553046102.pdf')).toEqual([]);
    expect(signalyZNazvu('312 Faktura.pdf')).toEqual([]);
  });

  it('rovnaký signál sa nezopakuje', () => {
    expect(signalyZNazvu('zmluva-kontrakt.pdf')).toEqual(['názov súboru pripomína zmluvu']);
  });
});

describe('OpenAIDocumentClassifier', () => {
  it('vráti typ dokladu a príznak, či ide o účtovný doklad', async () => {
    const classifier = new OpenAIDocumentClassifier(config, {
      parse: async () => ({
        output_parsed: {
          documentType: 'INY',
          jeUctovnyDoklad: false,
          dovod: 'Nadpis hovorí Contract application, nie faktúra.',
          istota: 0.94,
        },
      }),
    });
    const vysledok = await classifier.classify(vstup);
    expect(vysledok).toMatchObject({ documentType: 'INY', jeUctovnyDoklad: false });
  });

  it('signály z názvu sa modelu pribalia ako pomôcka, nie ako dôkaz', async () => {
    let odoslane = '';
    const classifier = new OpenAIDocumentClassifier(config, {
      parse: async (body: any) => {
        odoslane = JSON.stringify(body.input);
        return { output_parsed: { documentType: 'FP', jeUctovnyDoklad: true, dovod: 'x', istota: 0.5 } };
      },
    });
    await classifier.classify(vstup);
    expect(odoslane).toContain('pripomína zmluvu');
    expect(odoslane).toContain('rozhodni z obsahu');
  });

  // Prázdna odpoveď nesmie zhodiť spracovanie — extrakcia určí typ sama.
  it('odpoveď bez obsahu vráti undefined', async () => {
    const classifier = new OpenAIDocumentClassifier(config, { parse: async () => ({}) });
    expect(await classifier.classify(vstup)).toBeUndefined();
  });
});

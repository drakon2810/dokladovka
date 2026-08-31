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
          podtyp: 'bezna',
          jeUctovnyDoklad: false,
          dovod: 'Nadpis hovorí Contract application, nie faktúra.',
          obsahZvazku: '',
          pocetFakturaciiVSubore: 0,
          istota: 0.94,
        },
      }),
    });
    const vysledok = await classifier.classify(vstup);
    expect(vysledok).toMatchObject({ documentType: 'INY', podtyp: 'bezna', jeUctovnyDoklad: false });
  });

  it('signály z názvu sa modelu pribalia ako pomôcka, nie ako dôkaz', async () => {
    let odoslane = '';
    const classifier = new OpenAIDocumentClassifier(config, {
      parse: async (body: any) => {
        odoslane = JSON.stringify(body.input);
        return { output_parsed: { documentType: 'FP', podtyp: 'bezna', jeUctovnyDoklad: true, dovod: 'x', istota: 0.5, obsahZvazku: '', pocetFakturaciiVSubore: 1 } };
      },
    });
    await classifier.classify(vstup);
    expect(odoslane).toContain('pripomína zmluvu');
    expect(odoslane).toContain('rozhodni z obsahu');
  });

  // Bez klienta model nevie, ktorá strana je "naša" — vydanú faktúru potom
  // číta ako prijatú. Preto ide do každej správy, aj keď ho nemáme.
  it('účtovný klient ide modelu vždy, aj keď nie je známy', async () => {
    let odoslane = '';
    const classifier = new OpenAIDocumentClassifier(config, {
      parse: async (body: any) => {
        odoslane = JSON.stringify(body.input);
        return { output_parsed: { documentType: 'FV', podtyp: 'bezna', jeUctovnyDoklad: true, dovod: 'x', istota: 0.9, obsahZvazku: '', pocetFakturaciiVSubore: 1 } };
      },
    });
    await classifier.classify({ ...vstup, organizacia: { nazov: 'RCI REAL CARGO', ico: '57251266' } });
    expect(odoslane).toContain('RCI REAL CARGO');
    expect(odoslane).toContain('57251266');

    await classifier.classify(vstup);
    expect(odoslane).toContain('neuvedený');
  });

  // Prepravný spis chodí ako zväzok. Opis je jediné, z čoho sa účtovník
  // dozvie, že v súbore bola aj druhá faktúra, ktorú nikto nezaúčtoval.
  it('opis zväzku aj počet fakturujúcich strán prejdú nedotknuté', async () => {
    const classifier = new OpenAIDocumentClassifier(config, {
      parse: async () => ({
        output_parsed: {
          documentType: 'FP',
          podtyp: 'bezna',
          jeUctovnyDoklad: true,
          dovod: 'Strana 3 obsahuje Invoice №2409.',
          istota: 0.93,
          obsahZvazku: 'faktúra s. 3 · zmluva s. 1-2 · CMR s. 4',
          pocetFakturaciiVSubore: 2,
        },
      }),
    });
    expect(await classifier.classify(vstup)).toMatchObject({
      obsahZvazku: 'faktúra s. 3 · zmluva s. 1-2 · CMR s. 4',
      pocetFakturaciiVSubore: 2,
    });
  });

  // Prázdna odpoveď nesmie zhodiť spracovanie — extrakcia určí typ sama.
  it('odpoveď bez obsahu vráti undefined', async () => {
    const classifier = new OpenAIDocumentClassifier(config, { parse: async () => ({}) });
    expect(await classifier.classify(vstup)).toBeUndefined();
  });
});

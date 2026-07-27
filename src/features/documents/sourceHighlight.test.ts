import { describe, expect, it } from 'vitest';
import type { DocumentExtractedData, ExtractionRun } from '../../data/types';
import { buildMarks, buildSourceMap, editedFields, highlightHtml } from './sourceHighlight';

const run = {
  id: 'run-1',
  status: 'succeeded',
  result: {
    supplier: { nazov: 'Hapag-Lloyd AG', icDph: 'DE118516320', iban: 'DE68200700000056800000' },
    invoiceNumber: '2189662042',
    issueDate: '2026-06-15',
    dueDate: '2026-07-15',
    totalAmount: '6550.13',
    currency: 'EUR',
    lineItems: [],
    vatBreakdown: [],
    fieldConfidence: { invoiceNumber: 0.99, dueDate: 0.43 },
    evidence: {
      invoiceNumber: [{ page: 1, text: 'RECHNUNG NR.: 2189662042' }],
      dueDate: [{ page: 1, text: '30 TAGE NETTO' }],
      currency: [{ page: 1, text: 'WÄHRUNG: EUR' }],
    },
    warnings: [],
  },
} as unknown as ExtractionRun;

const extracted = {
  dodavatel: { nazov: 'Hapag-Lloyd AG', icDph: 'DE118516320', iban: 'DE68 2007 0000 0056 8000 00' },
  cisloFaktury: '2189662042',
  datumVystavenia: '2026-06-15',
  datumSplatnosti: '2026-07-15',
  sumaSpolu: 6550.13,
  mena: 'EUR',
  rozpisDph: [],
} as unknown as DocumentExtractedData;

describe('sourceHighlight', () => {
  const map = buildSourceMap([run]);

  it('priradí poliam sekciu a istotu', () => {
    expect(map.cisloFaktury.section).toBe(1);
    expect(map['dodavatel.icDph'].section).toBe(2);
    expect(map.mena.section).toBe(3);
    expect(map['dodavatel.iban'].section).toBe(4);
    expect(map.datumSplatnosti.confidence).toBe(0.43);
    // Hodnotu bez evidencie a bez AI výsledku nezvýrazňujeme.
    expect(map.konstantnySymbol).toBeUndefined();
  });

  it('IBAN s medzerami ani dátum v inom formáte nie je „upravené"', () => {
    expect(editedFields(map, extracted)).toEqual([]);
    expect(editedFields(map, { ...extracted, cisloFaktury: '999' })).toEqual(['cisloFaktury']);
    expect(editedFields(map, { ...extracted, sumaSpolu: 6550.1 } as DocumentExtractedData)).toEqual(['sumaSpolu']);
  });

  it('nájde hodnotu v texte rozsekanom medzerami a obalí ju značkou', () => {
    const marks = buildMarks(map, 1, new Set());
    const html = highlightHtml('R E C H N U N G  NR.:   2189662042', marks);
    expect(html).toContain('data-src="cisloFaktury"');
    expect(html).toContain('dv-src-1');

    const datum = highlightHtml('LEISTUNGSDATUM:  15.06.2026', marks);
    expect(datum).toContain('data-src="datumVystavenia"');

    const iban = highlightHtml('IBAN: DE68 2007 0000 0056 8000 00  BIC: DEUTDEHH', marks);
    expect(iban).toContain('data-src="dodavatel.iban"');
  });

  it('prepísané pole dostane neutrálnu značku a cudzia strana sa nehľadá', () => {
    const marks = buildMarks(map, 1, new Set(['cisloFaktury']));
    expect(highlightHtml('NR.: 2189662042', marks)).toContain('dv-src-edited');
    // Pole s evidenciou zo strany 1 sa na strane 2 nehľadá; pole bez strany áno.
    const strana2 = buildMarks(map, 2, new Set()).map((mark) => mark.anchor);
    expect(strana2).not.toContain('cisloFaktury');
    expect(strana2).toContain('dodavatel.iban');
  });

  it('nezvýrazní text bez zhody a ošetrí HTML', () => {
    const marks = buildMarks(map, 1, new Set());
    expect(highlightHtml('<b>SHIPMENT 14215837</b>', marks)).toBe('&lt;b&gt;SHIPMENT 14215837&lt;/b&gt;');
  });
});

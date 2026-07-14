import { describe, expect, it } from 'vitest';
import type { Organization } from '../types';
import {
  buildCodeListRequestFileName,
  buildCodeListRequestXml,
} from './requestTemplates';

const ORGANIZATION: Organization = {
  id: 'org-1',
  tenantId: 'tenant-demo',
  nazov: 'Účtovná kancelária, s.r.o.',
  ico: '35761571',
  dic: '2020000000',
  emailAlias: 'fixture@example.invalid',
  farba: '#0E7A5F',
};

describe('buildCodeListRequestXml', () => {
  it('vytvorí jeden ASCII dataPack so štyrmi oficiálnymi list requestami', () => {
    const xml = buildCodeListRequestXml(ORGANIZATION, new Date(2026, 6, 13));
    expect(xml).toContain('id="ExpCis-uctovna-kancelaria-20260713"');
    expect(xml).toContain('ico="35761571"');
    expect(xml.match(/<dat:dataPackItem /g)).toHaveLength(4);
    expect(xml).toContain('<lst:listAccountingDoubleEntryRequest version="1.1"/>');
    expect(xml).toContain(
      '<lst:listClassificationVATRequest version="2.0" classificationVATVersion="2.0">',
    );
    expect(xml).toContain(
      '<lst:listNumericalSeriesRequest version="2.0" numericalSeriesVersion="2.0">',
    );
    expect(xml).toContain(
      '<lCen:listCentreRequest version="2.0" centreVersion="2.0">',
    );
    expect(/^[\x00-\x7f]*$/.test(xml)).toBe(true);
  });
});

describe('buildCodeListRequestFileName', () => {
  it('vytvorí stabilný bezpečný názov súboru', () => {
    expect(buildCodeListRequestFileName(ORGANIZATION)).toBe(
      'pohoda-request-ciselniky-uctovna-kancelaria.xml',
    );
  });
});

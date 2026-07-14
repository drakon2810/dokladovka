import type { Organization } from '../types';
import { slugifyOrganizationName } from '../alias/aliasGenerator';
import { escapeXml } from '../xml/pohodaDataPack';

const DATA_NAMESPACE = 'http://www.stormware.cz/schema/version_2/data.xsd';
const TYPE_NAMESPACE = 'http://www.stormware.cz/schema/version_2/type.xsd';
const LIST_NAMESPACE = 'http://www.stormware.cz/schema/version_2/list.xsd';
const LIST_CENTRE_NAMESPACE =
  'http://www.stormware.cz/schema/version_2/list_centre.xsd';

function compactDate(value: Date): string {
  const pad = (part: number) => String(part).padStart(2, '0');
  return `${value.getFullYear()}${pad(value.getMonth() + 1)}${pad(value.getDate())}`;
}

/**
 * Jeden request pre štyri číselníky organizácie. Názvy elementov a verzie sú
 * prevzaté z aktuálnych oficiálnych príkladov a XSD STORMWARE (2026-06-04).
 */
export function buildCodeListRequestXml(
  organization: Organization,
  when: Date = new Date(),
): string {
  const orgCode = slugifyOrganizationName(organization.nazov, 32);
  const requestId = `ExpCis-${orgCode}-${compactDate(when)}`;
  const lines = [
    '<?xml version="1.0" encoding="Windows-1250"?>',
    `<dat:dataPack version="2.0" id="${escapeXml(requestId)}" ico="${escapeXml(organization.ico)}"`,
    '    application="Dokladovka" note="Export ciselnikov"',
    `    xmlns:dat="${DATA_NAMESPACE}"`,
    `    xmlns:typ="${TYPE_NAMESPACE}"`,
    `    xmlns:lst="${LIST_NAMESPACE}"`,
    `    xmlns:lCen="${LIST_CENTRE_NAMESPACE}">`,
    '  <dat:dataPackItem id="c01" version="2.0">',
    '    <lst:listAccountingDoubleEntryRequest version="1.1"/>',
    '  </dat:dataPackItem>',
    '  <dat:dataPackItem id="c02" version="2.0">',
    '    <lst:listClassificationVATRequest version="2.0" classificationVATVersion="2.0">',
    '      <lst:requestClassificationVAT/>',
    '    </lst:listClassificationVATRequest>',
    '  </dat:dataPackItem>',
    '  <dat:dataPackItem id="c03" version="2.0">',
    '    <lst:listNumericalSeriesRequest version="2.0" numericalSeriesVersion="2.0">',
    '      <lst:requestNumericalSeries/>',
    '    </lst:listNumericalSeriesRequest>',
    '  </dat:dataPackItem>',
    '  <dat:dataPackItem id="c04" version="2.0">',
    '    <lCen:listCentreRequest version="2.0" centreVersion="2.0">',
    '      <lCen:requestCentre/>',
    '    </lCen:listCentreRequest>',
    '  </dat:dataPackItem>',
    '</dat:dataPack>',
  ];
  return lines.join('\n');
}

export function buildCodeListRequestFileName(organization: Organization): string {
  const orgCode = slugifyOrganizationName(organization.nazov, 40);
  return `pohoda-request-ciselniky-${orgCode}.xml`;
}

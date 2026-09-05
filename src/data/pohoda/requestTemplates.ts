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
 * Jeden request pre číselníky organizácie (predkontácie, členenia DPH, číselné
 * rady, strediská, bankové účty). Názvy elementov a verzie sú prevzaté
 * z aktuálnych oficiálnych príkladov a XSD STORMWARE (2026-06-04).
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
    '  <dat:dataPackItem id="c05" version="2.0">',
    '    <lst:listBankAccountRequest version="2.0" bankAccountVersion="2.0">',
    '      <lst:requestBankAccount/>',
    '    </lst:listBankAccountRequest>',
    '  </dat:dataPackItem>',
    '</dat:dataPack>',
  ];
  return lines.join('\n');
}

export function buildCodeListRequestFileName(organization: Organization): string {
  const orgCode = slugifyOrganizationName(organization.nazov, 40);
  return `pohoda-request-ciselniky-${orgCode}.xml`;
}

const FILTER_NAMESPACE = 'http://www.stormware.cz/schema/version_2/filter.xsd';

/**
 * Request na účtovný denník za jeden rok. Denník nesie to, čo číselník ani
 * hlavičková história neukážu: každú proviozku s jej účtami MD/DAL, teda aj to,
 * že doklad bol rozdelený na niekoľko zaúčtovaní.
 *
 * Limit 10 000 je strop schémy (filter.xsd limitType). Celý rok 2026 ALPINY má
 * 7 389 proviozok, takže sa doň zmestí; väčšia firma by potrebovala stránkovanie
 * cez idFrom.
 */
export function buildDennikRequestXml(
  organization: Organization,
  rok: number = new Date().getFullYear(),
): string {
  const orgCode = slugifyOrganizationName(organization.nazov, 32);
  return [
    '<?xml version="1.0" encoding="Windows-1250"?>',
    `<dat:dataPack version="2.0" id="${escapeXml(`Dennik-${orgCode}-${rok}`)}" ico="${escapeXml(organization.ico)}"`,
    '    application="Dokladovka" note="Export uctovneho dennika"',
    `    xmlns:dat="${DATA_NAMESPACE}"`,
    `    xmlns:lst="${LIST_NAMESPACE}"`,
    `    xmlns:ftr="${FILTER_NAMESPACE}">`,
    '  <dat:dataPackItem id="dennik" version="2.0">',
    '    <lst:listAccountancyRequest version="2.0" accountancyVersion="2.0">',
    '      <lst:limit><ftr:count>10000</ftr:count></lst:limit>',
    '      <lst:requestAccountancy>',
    '        <ftr:filter>',
    `          <ftr:dateFrom>${rok}-01-01</ftr:dateFrom>`,
    `          <ftr:dateTill>${rok}-12-31</ftr:dateTill>`,
    '        </ftr:filter>',
    '      </lst:requestAccountancy>',
    '    </lst:listAccountancyRequest>',
    '  </dat:dataPackItem>',
    '</dat:dataPack>',
  ].join('\n');
}

export function buildDennikRequestFileName(organization: Organization, rok: number): string {
  return `pohoda-request-dennik-${slugifyOrganizationName(organization.nazov, 40)}-${rok}.xml`;
}

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

const HISTORIA_TYPY_FAKTUR = [
  'receivedInvoice', 'receivedCreditNotice', 'receivedDebitNote', 'receivedAdvanceInvoice',
  'issuedInvoice', 'issuedCreditNotice', 'issuedDebitNote', 'issuedAdvanceInvoice',
  // Ostatné záväzky sú tiež agenda faktúr, ale POHODA ich bez vlastnej
  // požiadavky nevráti — musia byť v zozname zvlášť.
  'commitment',
];

/**
 * Doklady s POLOŽKAMI: všetky dokladové agendy (faktúry vrátane dobropisov,
 * ťarchopisov a zálohových, ostatné záväzky, pokladňa, interné doklady).
 *
 * Rozúčtovanie dokladu je vidieť jedine tu. Hlavička faktúry Print-Office nesie
 * „repre / PD / B2" a v účtovnom denníku po nej ostanú štyri proviozky s tým
 * istým textom — že vody a káva idú mimo priznania (PN, KN), kým kancelárske
 * potreby majú odpočet, stojí až v položkách.
 *
 * Bez filtra: request je pre celý korpus, nie pre jeden prípad. Odpoveď má
 * rádovo 4,5 kB na doklad.
 */
export function buildHistoriaRequestXml(organization: Organization): string {
  const orgCode = slugifyOrganizationName(organization.nazov, 32);
  const polozky = HISTORIA_TYPY_FAKTUR.map((typ, index) =>
    `  <dat:dataPackItem id="h${String(index + 1).padStart(2, '0')}" version="2.0">`
    + `<lst:listInvoiceRequest version="2.0" invoiceType="${typ}" invoiceVersion="2.0">`
    + '<lst:requestInvoice/></lst:listInvoiceRequest></dat:dataPackItem>');
  polozky.push(
    `  <dat:dataPackItem id="h${HISTORIA_TYPY_FAKTUR.length + 1}" version="2.0">`
    + '<lst:listVoucherRequest version="2.0" voucherVersion="2.0">'
    + '<lst:requestVoucher/></lst:listVoucherRequest></dat:dataPackItem>',
    `  <dat:dataPackItem id="h${HISTORIA_TYPY_FAKTUR.length + 2}" version="2.0">`
    + '<lst:listIntDocRequest version="2.0" intDocVersion="2.0">'
    + '<lst:requestIntDoc/></lst:listIntDocRequest></dat:dataPackItem>',
  );
  return [
    '<?xml version="1.0" encoding="Windows-1250"?>',
    `<dat:dataPack version="2.0" id="${escapeXml(`Polozky-${orgCode}`)}" ico="${escapeXml(organization.ico)}"`,
    '    application="Dokladovka" note="Export dokladov s polozkami"',
    `    xmlns:dat="${DATA_NAMESPACE}"`,
    `    xmlns:lst="${LIST_NAMESPACE}">`,
    ...polozky,
    '</dat:dataPack>',
  ].join('\n');
}

export function buildHistoriaRequestFileName(organization: Organization): string {
  return `pohoda-request-polozky-${slugifyOrganizationName(organization.nazov, 40)}.xml`;
}

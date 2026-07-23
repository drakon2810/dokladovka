// Generovanie XML POHODA dataPack — SPEC §7. Produkčný agent vykoná fail-closed XSD validáciu.
import type { CodeListItem, DocumentItem, DocumentLineItem, Organization, VatBreakdownRow } from '../types';
import { slugifyOrganizationName } from '../alias/aliasGenerator';
import { lineItemEffective } from '../../lib/validate';

/**
 * Escapovanie XML špeciálnych znakov + všetky ne-ASCII znaky ako numerické
 * entity (&#x...;). Výsledný súbor je čisté ASCII, takže deklarovaná
 * Windows-1250 aj akékoľvek iné kódovanie ho prečíta bez poškodenia diakritiky.
 */
export function escapeXml(value: string): string {
  const escaped = value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
  return Array.from(escaped, (character) => {
    const codePoint = character.codePointAt(0)!;
    if (codePoint < 0x20 && codePoint !== 0x09 && codePoint !== 0x0a && codePoint !== 0x0d) {
      return '';
    }
    return codePoint > 0x7e ? `&#x${codePoint.toString(16).toUpperCase()};` : character;
  }).join('');
}

/** Sumy s bodkou a 2 desatinnými miestami (SPEC §7). */
export function formatXmlAmount(value: number): string {
  return (Math.round((value + Number.EPSILON) * 100) / 100).toFixed(2);
}

/** FP → receivedInvoice, FV → issuedInvoice (SPEC §7). */
export function mapInvoiceType(typ: DocumentItem['typ']): string {
  switch (typ) {
    case 'FP':
      return 'receivedInvoice';
    case 'FV':
      return 'issuedInvoice';
    case 'OZ':
      return 'commitment';
    default:
      // BV a MZDY sa vo Fáze 1 neexportujú (SPEC §7)
      throw new Error(`Typ dokladu ${typ} sa neexportuje cez dataPack`);
  }
}

/** Krajina z prefixu IČ DPH — POHODA číselník krajín používa ISO kódy (EL→GR, XI→GB). */
export function vatCountryIds(icDph: string | undefined): string | undefined {
  const prefix = (icDph ?? '').replace(/[^A-Za-z0-9]/g, '').toUpperCase().slice(0, 2);
  if (!/^[A-Z]{2}$/.test(prefix)) return undefined;
  if (prefix === 'EL') return 'GR';
  if (prefix === 'XI') return 'GB';
  return prefix;
}

/**
 * Heuristický rozklad voľnej adresy z extrakcie na ulicu / mesto / PSČ.
 * Musí zostať v zhode so serverovým splitPostalAddress v server/pohodaXml.ts.
 */
export function splitPostalAddress(value: string | undefined): { street?: string; city?: string; zip?: string } {
  const parts = (value ?? '')
    .split(/\r?\n|\s+[–—-]\s+|,/)
    .map((part) => part.trim())
    .filter(Boolean);
  if (parts.length === 0) return {};
  let city: string | undefined;
  let zip: string | undefined;
  const rest: string[] = [];
  for (const part of parts) {
    const match = !city && part.match(/^(\d{3}\s?\d{2}|\d{4,6})\s+(\D.*)$/);
    if (match) {
      zip = match[1];
      city = match[2].trim();
    } else {
      rest.push(part);
    }
  }
  if (!city && rest.length === 1) return { street: rest[0] };
  const street = rest.find((part) => /\d/.test(part)) ?? rest[0];
  return { street, city, zip };
}

/** Riadky typ:address partnera — prázdne prvky sa vynechávajú, krajina z IČ DPH. */
function partnerAddressLines(
  supplier: { nazov: string; ico?: string; dic?: string; icDph?: string; adresa?: string },
  indent: string,
): string[] {
  const address = splitPostalAddress(supplier.adresa);
  const country = vatCountryIds(supplier.icDph);
  const lines = [`${indent}<typ:company>${escapeXml(supplier.nazov)}</typ:company>`];
  if (address.city) lines.push(`${indent}<typ:city>${escapeXml(address.city)}</typ:city>`);
  if (address.street) lines.push(`${indent}<typ:street>${escapeXml(address.street)}</typ:street>`);
  if (address.zip) lines.push(`${indent}<typ:zip>${escapeXml(address.zip)}</typ:zip>`);
  if (supplier.ico) lines.push(`${indent}<typ:ico>${escapeXml(supplier.ico)}</typ:ico>`);
  if (supplier.dic) lines.push(`${indent}<typ:dic>${escapeXml(supplier.dic)}</typ:dic>`);
  if (supplier.icDph) lines.push(`${indent}<typ:icDph>${escapeXml(supplier.icDph.replace(/\s+/g, ''))}</typ:icDph>`);
  // Krajina sa vypĺňa vždy (aj tuzemsko SK) — POHODA ju pri importe páruje na číselník krajín.
  if (country) lines.push(`${indent}<typ:country><typ:ids>${country}</typ:ids></typ:country>`);
  return lines;
}

export function skIbanAccount(iban: string | undefined): { accountNo: string; bankCode: string } | undefined {
  const normalized = (iban ?? '').replaceAll(' ', '').toUpperCase();
  if (!/^SK\d{2}\d{4}\d{16}$/.test(normalized)) return undefined;
  const bankCode = normalized.slice(4, 8);
  const prefix = normalized.slice(8, 14).replace(/^0+/, '');
  const account = normalized.slice(14, 24).replace(/^0+/, '') || '0';
  return { accountNo: prefix ? `${prefix}-${account}` : account, bankCode };
}

interface VatTotals {
  zaklad23: number;
  dph23: number;
  zaklad19: number;
  dph19: number;
  zaklad5: number;
  dph5: number;
  zaklad0: number;
}

export function summarizeVat(rows: VatBreakdownRow[]): VatTotals {
  const t: VatTotals = { zaklad23: 0, dph23: 0, zaklad19: 0, dph19: 0, zaklad5: 0, dph5: 0, zaklad0: 0 };
  for (const row of rows) {
    if (row.sadzba === 23) {
      t.zaklad23 += row.zaklad;
      t.dph23 += row.dph;
    } else if (row.sadzba === 19) {
      t.zaklad19 += row.zaklad;
      t.dph19 += row.dph;
    } else if (row.sadzba === 5) {
      t.zaklad5 += row.zaklad;
      t.dph5 += row.dph;
    } else {
      t.zaklad0 += row.zaklad;
    }
  }
  return t;
}

export interface DataPackCodeLists {
  predkontacie: CodeListItem[];
  cleneniaDph: CodeListItem[];
  ciselneRady: CodeListItem[];
  strediska?: CodeListItem[];
}

/** Sadzba DPH → POHODA rateVAT. Zhodné s rozdelením súhrnu (23→high, 19→low, 5→third). */
function vatRateName(sadzba: number | undefined): 'high' | 'low' | 'third' | 'none' {
  if (sadzba === 23) return 'high';
  if (sadzba === 19) return 'low';
  if (sadzba === 5) return 'third';
  return 'none';
}

/**
 * Riadky <inv:invoiceDetail> z položiek dokladu. Zaúčtovanie/členenie položky
 * s návratom na hlavičku; členenie KV DPH z hlavičky. Prázdne pole = bez rozpisu.
 */
function invoiceDetailLines(
  polozky: DocumentLineItem[] | undefined,
  kodOf: (list: CodeListItem[], id: string | undefined) => string | undefined,
  codeLists: DataPackCodeLists,
  header: { accounting?: string; clenenie?: string; kv?: string },
): string[] {
  if (!polozky || polozky.length === 0) return [];
  const lines = ['      <inv:invoiceDetail>'];
  for (const item of polozky) {
    const eff = lineItemEffective(item);
    const bezDph = eff.bezDph ?? 0;
    const unitPrice = item.jednotkovaCenaBezDph ?? bezDph;
    const accounting = kodOf(codeLists.predkontacie, item.ucto?.predkontaciaId) ?? header.accounting;
    const clenenie = kodOf(codeLists.cleneniaDph, item.ucto?.clenenieDphId) ?? header.clenenie;
    const centre = kodOf(codeLists.strediska ?? [], item.ucto?.strediskoId);
    lines.push('        <inv:invoiceItem>');
    lines.push(`          <inv:text>${escapeXml(item.popis ?? '')}</inv:text>`);
    lines.push(`          <inv:quantity>${escapeXml(String(item.mnozstvo ?? 1))}</inv:quantity>`);
    if (item.jednotka) lines.push(`          <inv:unit>${escapeXml(item.jednotka)}</inv:unit>`);
    lines.push('          <inv:coefficient>1.0</inv:coefficient>');
    lines.push('          <inv:payVAT>false</inv:payVAT>');
    lines.push(`          <inv:rateVAT>${vatRateName(item.sadzbaDph)}</inv:rateVAT>`);
    lines.push('          <inv:discountPercentage>0.0</inv:discountPercentage>');
    lines.push('          <inv:homeCurrency>');
    lines.push(`            <typ:unitPrice>${formatXmlAmount(unitPrice)}</typ:unitPrice>`);
    lines.push(`            <typ:price>${formatXmlAmount(bezDph)}</typ:price>`);
    lines.push(`            <typ:priceVAT>${formatXmlAmount(eff.dph ?? 0)}</typ:priceVAT>`);
    lines.push(`            <typ:priceSum>${formatXmlAmount(eff.spolu ?? bezDph)}</typ:priceSum>`);
    lines.push('          </inv:homeCurrency>');
    if (accounting) lines.push(`          <inv:accounting><typ:ids>${escapeXml(accounting)}</typ:ids></inv:accounting>`);
    if (clenenie) lines.push(`          <inv:classificationVAT><typ:ids>${escapeXml(clenenie)}</typ:ids></inv:classificationVAT>`);
    if (header.kv) lines.push(`          <inv:classificationKVDPH><typ:ids>${escapeXml(header.kv)}</typ:ids></inv:classificationKVDPH>`);
    if (centre) lines.push(`          <inv:centre><typ:ids>${escapeXml(centre)}</typ:ids></inv:centre>`);
    lines.push('        </inv:invoiceItem>');
  }
  lines.push('      </inv:invoiceDetail>');
  return lines;
}

/**
 * Čistá funkcia: dataPack pre JEDNU organizáciu (export nikdy nemieša
 * organizácie — SPEC §6.5, §11.24).
 */
export function buildDataPack(
  org: Organization,
  docs: DocumentItem[],
  codeLists: DataPackCodeLists,
  batchId = 'Export001',
): string {
  const unsupported = docs.find((d) => d.typ === 'BV' || d.typ === 'MZDY');
  if (unsupported) {
    throw new Error(
      `Doklad typu ${unsupported.typ} nepatrí do XML exportu (bankové výpisy sa importujú cez camt.053)`,
    );
  }
  const foreign = docs.find((d) => d.orgId !== org.id);
  if (foreign) {
    throw new Error('Export nesmie miešať doklady rôznych organizácií');
  }

  const items = docs
    .map((doc, index) => {
      const kodOf = (list: CodeListItem[], id: string | undefined): string | undefined =>
        id
          ? list.find(
              (c) =>
                c.id === id &&
                c.tenantId === doc.tenantId &&
                c.orgId === doc.orgId &&
                c.active,
            )?.kod
          : undefined;
      const vat = summarizeVat(doc.extracted.rozpisDph);
      const predkontacia = kodOf(codeLists.predkontacie, doc.ucto.predkontaciaId);
      const clenenie = kodOf(codeLists.cleneniaDph, doc.ucto.clenenieDphId);
      const rad = kodOf(codeLists.ciselneRady, doc.ucto.ciselnyRadId);
      if (!rad) {
        throw new Error(
          `Doklad ${doc.id} nemá vybraný aktívny číselný rad pre export do POHODY`,
        );
      }
      // Mock číslovanie v rade — POHODA pri importe pridelí reálne číslo z radu
      const numberRequested = `${rad}${String(index + 1).padStart(4, '0')}`;
      const d = doc.extracted;
      const currencyLines = [
        `          <typ:priceHigh>${formatXmlAmount(vat.zaklad23)}</typ:priceHigh>`,
        `          <typ:priceHighVAT>${formatXmlAmount(vat.dph23)}</typ:priceHighVAT>`,
        `          <typ:priceLow>${formatXmlAmount(vat.zaklad19)}</typ:priceLow>`,
        `          <typ:priceLowVAT>${formatXmlAmount(vat.dph19)}</typ:priceLowVAT>`,
        `          <typ:price3>${formatXmlAmount(vat.zaklad5)}</typ:price3>`,
        `          <typ:price3VAT>${formatXmlAmount(vat.dph5)}</typ:price3VAT>`,
        `          <typ:priceNone>${formatXmlAmount(vat.zaklad0)}</typ:priceNone>`,
      ];
      if (doc.typ === 'PD') {
        if (!doc.ucto.pokladnaKod?.trim() || !doc.ucto.pokladnaTyp) {
          throw new Error(`Pokladničný doklad ${doc.id} nemá nastavený kód a typ pokladničného dokladu POHODA`);
        }
        return [
          `  <dat:dataPackItem id="${escapeXml(doc.id)}" version="2.0">`,
          '    <vch:voucher version="2.0">',
          '      <vch:voucherHeader>',
          `        <vch:voucherType>${doc.ucto.pokladnaTyp}</vch:voucherType>`,
          `        <vch:cashAccount><typ:ids>${escapeXml(doc.ucto.pokladnaKod)}</typ:ids></vch:cashAccount>`,
          `        <vch:number><typ:numberRequested>${escapeXml(numberRequested)}</typ:numberRequested></vch:number>`,
          `        <vch:originalDocument>${escapeXml(d.cisloFaktury)}</vch:originalDocument>`,
          `        <vch:date>${escapeXml(d.datumVystavenia)}</vch:date>`,
          `        <vch:dateTax>${escapeXml(d.datumDodania ?? d.datumVystavenia)}</vch:dateTax>`,
          ...(predkontacia ? [`        <vch:accounting><typ:ids>${escapeXml(predkontacia)}</typ:ids></vch:accounting>`] : []),
          ...(clenenie ? [`        <vch:classificationVAT><typ:ids>${escapeXml(clenenie)}</typ:ids></vch:classificationVAT>`] : []),
          `        <vch:text>${escapeXml(d.textPolozky ?? `Pokladničný doklad ${d.cisloFaktury}`)}</vch:text>`,
          '        <vch:partnerIdentity><typ:address>',
          ...partnerAddressLines(d.dodavatel, '          '),
          '        </typ:address></vch:partnerIdentity>',
          '      </vch:voucherHeader>',
          '      <vch:voucherSummary><vch:homeCurrency>',
          ...currencyLines,
          '      </vch:homeCurrency></vch:voucherSummary>',
          '    </vch:voucher>',
          '  </dat:dataPackItem>',
        ].join('\n');
      }
      const invoiceType = mapInvoiceType(doc.typ);
      const lines: string[] = [];
      lines.push(`  <dat:dataPackItem id="${escapeXml(doc.id)}" version="2.0">`);
      lines.push('    <inv:invoice version="2.0">');
      lines.push('      <inv:invoiceHeader>');
      lines.push(`        <inv:invoiceType>${invoiceType}</inv:invoiceType>`);
      lines.push(
        `        <inv:number><typ:numberRequested>${escapeXml(numberRequested)}</typ:numberRequested></inv:number>`,
      );
      // AI môže vrátiť prázdny reťazec (nie undefined) — VS musí mať fallback
      // na číslice z čísla faktúry, inak sa v POHODE nespáruje úhrada.
      lines.push(`        <inv:symVar>${escapeXml((d.variabilnySymbol ?? '').trim() || d.cisloFaktury.replace(/\D/g, ''))}</inv:symVar>`);
      // „Doklad" v POHODE = dodávateľské číslo faktúry; pri vydaných faktúrach pole neexistuje.
      if (doc.typ !== 'FV' && d.cisloFaktury) {
        lines.push(`        <inv:originalDocument>${escapeXml(d.cisloFaktury)}</inv:originalDocument>`);
      }
      lines.push(`        <inv:date>${escapeXml(d.datumVystavenia)}</inv:date>`);
      lines.push(`        <inv:dateTax>${escapeXml(d.datumDodania ?? d.datumVystavenia)}</inv:dateTax>`);
      if (d.datumSplatnosti) {
        lines.push(`        <inv:dateDue>${escapeXml(d.datumSplatnosti)}</inv:dateDue>`);
      }
      if (d.datumDodania) {
        lines.push(`        <inv:dateDelivery>${escapeXml(d.datumDodania)}</inv:dateDelivery>`);
      }
      if (predkontacia) {
        lines.push(`        <inv:accounting><typ:ids>${escapeXml(predkontacia)}</typ:ids></inv:accounting>`);
      }
      if (clenenie) {
        lines.push(
          `        <inv:classificationVAT><typ:ids>${escapeXml(clenenie)}</typ:ids></inv:classificationVAT>`,
        );
      }
      lines.push(`        <inv:text>${escapeXml(d.textPolozky ?? `Faktúra ${d.cisloFaktury}`)}</inv:text>`);
      lines.push('        <inv:partnerIdentity>');
      lines.push('          <typ:address>');
      lines.push(...partnerAddressLines(d.dodavatel, '            '));
      lines.push('          </typ:address>');
      lines.push('        </inv:partnerIdentity>');
      if (d.dodavatel.iban) {
        const account = skIbanAccount(d.dodavatel.iban);
        if (account) lines.push(`        <inv:paymentAccount><typ:accountNo>${escapeXml(account.accountNo)}</typ:accountNo><typ:bankCode>${escapeXml(account.bankCode)}</typ:bankCode></inv:paymentAccount>`);
      }
      lines.push('      </inv:invoiceHeader>');
      lines.push(...invoiceDetailLines(
        d.polozky,
        kodOf,
        codeLists,
        { accounting: predkontacia, clenenie, kv: doc.ucto.clenenieKvKod },
      ));
      lines.push('      <inv:invoiceSummary>');
      lines.push('        <inv:homeCurrency>');
      lines.push(...currencyLines);
      lines.push('        </inv:homeCurrency>');
      lines.push('      </inv:invoiceSummary>');
      lines.push('    </inv:invoice>');
      lines.push('  </dat:dataPackItem>');
      return lines.join('\n');
    })
    .join('\n');

  return [
    '<?xml version="1.0" encoding="Windows-1250"?>',
    `<dat:dataPack version="2.0" id="${escapeXml(batchId)}" ico="${escapeXml(org.ico)}"`,
    '    application="Dokladovka" note="Import faktur"',
    '    xmlns:dat="http://www.stormware.cz/schema/version_2/data.xsd"',
    '    xmlns:inv="http://www.stormware.cz/schema/version_2/invoice.xsd"',
    '    xmlns:vch="http://www.stormware.cz/schema/version_2/voucher.xsd"',
    '    xmlns:typ="http://www.stormware.cz/schema/version_2/type.xsd">',
    items,
    '</dat:dataPack>',
  ].join('\n');
}

/** Názov súboru: pohoda-{orgKod}-{YYYYMMDD-HHmm}.xml (SPEC §6.5). */
export function buildExportFileName(org: Organization, when: Date = new Date()): string {
  const orgKod = slugifyOrganizationName(org.nazov, 40);
  const pad = (n: number) => String(n).padStart(2, '0');
  const stamp = `${when.getFullYear()}${pad(when.getMonth() + 1)}${pad(when.getDate())}-${pad(when.getHours())}${pad(when.getMinutes())}`;
  return `pohoda-${orgKod}-${stamp}.xml`;
}

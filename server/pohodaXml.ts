export function escapeXml(value: unknown): string {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&apos;')
    .replace(/[^\x09\x0A\x0D\x20-\x7E]/g, (character) => `&#${character.codePointAt(0)};`);
}

interface Snapshot {
  version: number;
  typ: string;
  extracted: Record<string, any>;
  ucto: Record<string, string | undefined>;
}

export interface PohodaXmlDocument {
  id: string;
  snapshot: Snapshot;
}

export interface PohodaCodeLookup {
  predkontacie: Map<string, string>;
  cleneniaDph: Map<string, string>;
  ciselneRady: Map<string, string>;
  strediska: Map<string, string>;
}

function invoiceType(type: string): string {
  if (type === 'FP') return 'receivedInvoice';
  if (type === 'FV') return 'issuedInvoice';
  if (type === 'OZ') return 'commitment';
  throw new Error(`Nepodporovaný typ dokladu pre POHODA: ${type}`);
}

function skIbanAccount(iban: unknown): { accountNo: string; bankCode: string } | undefined {
  const normalized = String(iban ?? '').replaceAll(' ', '').toUpperCase();
  if (!/^SK\d{2}\d{4}\d{16}$/.test(normalized)) return undefined;
  const bankCode = normalized.slice(4, 8);
  const prefix = normalized.slice(8, 14).replace(/^0+/, '');
  const account = normalized.slice(14, 24).replace(/^0+/, '') || '0';
  return { accountNo: prefix ? `${prefix}-${account}` : account, bankCode };
}

function amount(value: unknown): string {
  const numeric = Number(value ?? 0);
  if (!Number.isFinite(numeric)) throw new Error('Neplatná suma v schválenom snapshote');
  return numeric.toFixed(2);
}

/** Krajina z prefixu IČ DPH — POHODA číselník krajín používa ISO kódy (EL→GR, XI→GB). */
export function vatCountryIds(icDph: unknown): string | undefined {
  const prefix = String(icDph ?? '').replace(/[^A-Za-z0-9]/g, '').toUpperCase().slice(0, 2);
  if (!/^[A-Z]{2}$/.test(prefix)) return undefined;
  if (prefix === 'EL') return 'GR';
  if (prefix === 'XI') return 'GB';
  return prefix;
}

/**
 * Heuristický rozklad voľnej adresy z extrakcie na ulicu / mesto / PSČ.
 * Podporuje viacriadkové adresy aj jeden riadok oddelený „ – “ alebo čiarkou.
 * Časť v tvare „PSČ Mesto“ určuje mesto; ulica je časť s číslom domu.
 */
export function splitPostalAddress(value: unknown): { street?: string; city?: string; zip?: string } {
  const parts = String(value ?? '')
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

/** typ:address partnera — prázdne prvky sa vynechávajú, krajina sa odvodí z IČ DPH. */
function partnerAddressXml(supplier: Record<string, any>): string {
  const address = splitPostalAddress(supplier.adresa);
  const country = vatCountryIds(supplier.icDph);
  const lines = [`<typ:company>${escapeXml(supplier.nazov)}</typ:company>`];
  if (address.city) lines.push(`<typ:city>${escapeXml(address.city)}</typ:city>`);
  if (address.street) lines.push(`<typ:street>${escapeXml(address.street)}</typ:street>`);
  if (address.zip) lines.push(`<typ:zip>${escapeXml(address.zip)}</typ:zip>`);
  if (supplier.ico) lines.push(`<typ:ico>${escapeXml(supplier.ico)}</typ:ico>`);
  if (supplier.dic) lines.push(`<typ:dic>${escapeXml(supplier.dic)}</typ:dic>`);
  if (supplier.icDph) lines.push(`<typ:icDph>${escapeXml(String(supplier.icDph).replace(/\s+/g, ''))}</typ:icDph>`);
  // Krajina sa vypĺňa vždy (aj tuzemsko SK) — POHODA ju pri importe páruje na číselník krajín.
  if (country) lines.push(`<typ:country><typ:ids>${country}</typ:ids></typ:country>`);
  return `<typ:address>
          ${lines.join('\n          ')}
        </typ:address>`;
}

export function buildServerDataPack(input: {
  id: string;
  ico: string;
  documents: PohodaXmlDocument[];
  codeLists: PohodaCodeLookup;
}): string {
  if (!/^\d{8}$/.test(input.ico)) throw new Error('IČO účtovnej jednotky je neplatné');
  const items = input.documents.map(({ id, snapshot }) => {
    const extracted = snapshot.extracted;
    const supplier = extracted.dodavatel ?? {};
    const accounting = input.codeLists.predkontacie.get(snapshot.ucto.predkontaciaId ?? '');
    const classificationVat = input.codeLists.cleneniaDph.get(snapshot.ucto.clenenieDphId ?? '');
    const numberSeries = input.codeLists.ciselneRady.get(snapshot.ucto.ciselnyRadId ?? '');
    if (!accounting || !classificationVat || !numberSeries) {
      throw new Error(`Doklad ${id} nemá platné aktívne číselníky organizácie`);
    }
    const rows = Array.isArray(extracted.rozpisDph) ? extracted.rozpisDph : [];
    const base23 = rows.filter((row: any) => Number(row.sadzba) === 23).reduce((sum: number, row: any) => sum + Number(row.zaklad || 0), 0);
    const vat23 = rows.filter((row: any) => Number(row.sadzba) === 23).reduce((sum: number, row: any) => sum + Number(row.dph || 0), 0);
    const base19 = rows.filter((row: any) => Number(row.sadzba) === 19).reduce((sum: number, row: any) => sum + Number(row.zaklad || 0), 0);
    const vat19 = rows.filter((row: any) => Number(row.sadzba) === 19).reduce((sum: number, row: any) => sum + Number(row.dph || 0), 0);
    const base5 = rows.filter((row: any) => Number(row.sadzba) === 5).reduce((sum: number, row: any) => sum + Number(row.zaklad || 0), 0);
    const vat5 = rows.filter((row: any) => Number(row.sadzba) === 5).reduce((sum: number, row: any) => sum + Number(row.dph || 0), 0);
    const base0 = rows.filter((row: any) => Number(row.sadzba) === 0).reduce((sum: number, row: any) => sum + Number(row.zaklad || 0), 0);
    const currency = `<typ:priceHigh>${amount(base23)}</typ:priceHigh>
        <typ:priceHighVAT>${amount(vat23)}</typ:priceHighVAT>
        <typ:priceLow>${amount(base19)}</typ:priceLow>
        <typ:priceLowVAT>${amount(vat19)}</typ:priceLowVAT>
        <typ:price3>${amount(base5)}</typ:price3>
        <typ:price3VAT>${amount(vat5)}</typ:price3VAT>
        <typ:priceNone>${amount(base0)}</typ:priceNone>`;
    const partner = partnerAddressXml(supplier);
    if (snapshot.typ === 'PD') {
      const cashAccount = snapshot.ucto.pokladnaKod;
      const voucherType = snapshot.ucto.pokladnaTyp;
      if (!cashAccount || !['receipt', 'expense'].includes(voucherType ?? '')) throw new Error(`Pokladničný doklad ${id} nemá nastavený kód a typ pokladničného dokladu POHODA`);
      return `  <dat:dataPackItem id="${escapeXml(id)}" version="2.0">
    <vch:voucher version="2.0">
      <vch:voucherHeader>
        <vch:voucherType>${escapeXml(voucherType)}</vch:voucherType>
        <vch:cashAccount><typ:ids>${escapeXml(cashAccount)}</typ:ids></vch:cashAccount>
        <vch:number><typ:numberRequested>${escapeXml(numberSeries)}</typ:numberRequested></vch:number>
        <vch:originalDocument>${escapeXml(extracted.cisloFaktury ?? '')}</vch:originalDocument>
        <vch:date>${escapeXml(extracted.datumVystavenia)}</vch:date>
        <vch:dateTax>${escapeXml(extracted.datumDodania ?? extracted.datumVystavenia)}</vch:dateTax>
        <vch:accounting><typ:ids>${escapeXml(accounting)}</typ:ids></vch:accounting>
        <vch:classificationVAT><typ:ids>${escapeXml(classificationVat)}</typ:ids></vch:classificationVAT>
        ${snapshot.ucto.clenenieKvKod ? `<vch:classificationKVDPH><typ:ids>${escapeXml(snapshot.ucto.clenenieKvKod)}</typ:ids></vch:classificationKVDPH>` : ''}
        <vch:text>${escapeXml(extracted.textPolozky ?? extracted.cisloFaktury ?? 'Pokladničný doklad')}</vch:text>
        <vch:partnerIdentity>${partner}</vch:partnerIdentity>
      </vch:voucherHeader>
      <vch:voucherSummary><vch:homeCurrency>
        ${currency}
      </vch:homeCurrency></vch:voucherSummary>
    </vch:voucher>
  </dat:dataPackItem>`;
    }
    if (snapshot.typ === 'MZDY') {
      // Mzdová páska sa účtuje ako interný doklad (agenda Interné doklady).
      // Mzdy nemajú DPH — celková suma ide do priceNone, ak rozpis chýba.
      const priceNone = rows.length > 0 ? base0 : Number(extracted.sumaSpolu || 0);
      const mzdyCurrency = rows.length > 0 ? currency : `<typ:priceHigh>0.00</typ:priceHigh>
        <typ:priceHighVAT>0.00</typ:priceHighVAT>
        <typ:priceLow>0.00</typ:priceLow>
        <typ:priceLowVAT>0.00</typ:priceLowVAT>
        <typ:price3>0.00</typ:price3>
        <typ:price3VAT>0.00</typ:price3VAT>
        <typ:priceNone>${amount(priceNone)}</typ:priceNone>`;
      return `  <dat:dataPackItem id="${escapeXml(id)}" version="2.0">
    <int:intDoc version="2.0">
      <int:intDocHeader>
        <int:number><typ:numberRequested>${escapeXml(numberSeries)}</typ:numberRequested></int:number>
        <int:date>${escapeXml(extracted.datumVystavenia)}</int:date>
        <int:accounting><typ:ids>${escapeXml(accounting)}</typ:ids></int:accounting>
        <int:classificationVAT><typ:ids>${escapeXml(classificationVat)}</typ:ids></int:classificationVAT>
        <int:text>${escapeXml(extracted.textPolozky ?? `Mzdová páska ${extracted.cisloFaktury || extracted.datumVystavenia}`)}</int:text>
        <int:partnerIdentity>${partner}</int:partnerIdentity>
      </int:intDocHeader>
      <int:intDocSummary><int:homeCurrency>
        ${mzdyCurrency}
      </int:homeCurrency></int:intDocSummary>
    </int:intDoc>
  </dat:dataPackItem>`;
    }
    const paymentAccount = skIbanAccount(supplier.iban);
    return `  <dat:dataPackItem id="${escapeXml(id)}" version="2.0">
    <inv:invoice version="2.0">
      <inv:invoiceHeader>
        <inv:invoiceType>${invoiceType(snapshot.typ)}</inv:invoiceType>
        <inv:number><typ:numberRequested>${escapeXml(numberSeries)}</typ:numberRequested></inv:number>
        <inv:symVar>${escapeXml((extracted.variabilnySymbol ?? '').trim() || (extracted.cisloFaktury ?? '').replace(/\D/g, ''))}</inv:symVar>
        ${snapshot.typ !== 'FV' && extracted.cisloFaktury ? `<inv:originalDocument>${escapeXml(extracted.cisloFaktury)}</inv:originalDocument>` : ''}
        <inv:date>${escapeXml(extracted.datumVystavenia)}</inv:date>
        <inv:dateTax>${escapeXml(extracted.datumDodania ?? extracted.datumVystavenia)}</inv:dateTax>
        <inv:dateDue>${escapeXml(extracted.datumSplatnosti ?? extracted.datumVystavenia)}</inv:dateDue>
        ${extracted.datumDodania ? `<inv:dateDelivery>${escapeXml(extracted.datumDodania)}</inv:dateDelivery>` : ''}
        <inv:accounting><typ:ids>${escapeXml(accounting)}</typ:ids></inv:accounting>
        <inv:classificationVAT><typ:ids>${escapeXml(classificationVat)}</typ:ids></inv:classificationVAT>
        ${snapshot.ucto.clenenieKvKod ? `<inv:classificationKVDPH><typ:ids>${escapeXml(snapshot.ucto.clenenieKvKod)}</typ:ids></inv:classificationKVDPH>` : ''}
        ${extracted.cisloObjednavky ? `<inv:numberOrder>${escapeXml(extracted.cisloObjednavky)}</inv:numberOrder>` : ''}
        <inv:partnerIdentity>${partner}</inv:partnerIdentity>
        ${paymentAccount ? `<inv:paymentAccount><typ:accountNo>${escapeXml(paymentAccount.accountNo)}</typ:accountNo><typ:bankCode>${escapeXml(paymentAccount.bankCode)}</typ:bankCode></inv:paymentAccount>` : ''}
        ${snapshot.ucto.poznamka ? `<inv:note>${escapeXml(snapshot.ucto.poznamka)}</inv:note>` : ''}
      </inv:invoiceHeader>
      <inv:invoiceSummary><inv:homeCurrency>
        ${currency}
      </inv:homeCurrency></inv:invoiceSummary>
    </inv:invoice>
  </dat:dataPackItem>`;
  }).join('\n');
  return `<?xml version="1.0" encoding="Windows-1250"?>
<dat:dataPack version="2.0" id="${escapeXml(input.id)}" ico="${input.ico}"
  application="Dokladovka" note="Import faktur"
  xmlns:dat="http://www.stormware.cz/schema/version_2/data.xsd"
  xmlns:inv="http://www.stormware.cz/schema/version_2/invoice.xsd"
  xmlns:vch="http://www.stormware.cz/schema/version_2/voucher.xsd"
  xmlns:int="http://www.stormware.cz/schema/version_2/intDoc.xsd"
  xmlns:typ="http://www.stormware.cz/schema/version_2/type.xsd">
${items}
</dat:dataPack>`;
}

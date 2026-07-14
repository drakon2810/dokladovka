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
    const partner = `<typ:address>
          <typ:company>${escapeXml(supplier.nazov)}</typ:company>
          <typ:ico>${escapeXml(supplier.ico)}</typ:ico>
          <typ:dic>${escapeXml(supplier.dic)}</typ:dic>
        </typ:address>`;
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
        <vch:text>${escapeXml(extracted.textPolozky ?? extracted.cisloFaktury ?? 'Pokladničný doklad')}</vch:text>
        <vch:partnerIdentity>${partner}</vch:partnerIdentity>
      </vch:voucherHeader>
      <vch:voucherSummary><vch:homeCurrency>
        ${currency}
      </vch:homeCurrency></vch:voucherSummary>
    </vch:voucher>
  </dat:dataPackItem>`;
    }
    const paymentAccount = skIbanAccount(supplier.iban);
    return `  <dat:dataPackItem id="${escapeXml(id)}" version="2.0">
    <inv:invoice version="2.0">
      <inv:invoiceHeader>
        <inv:invoiceType>${invoiceType(snapshot.typ)}</inv:invoiceType>
        <inv:number><typ:numberRequested>${escapeXml(numberSeries)}</typ:numberRequested></inv:number>
        <inv:symVar>${escapeXml(extracted.variabilnySymbol ?? '')}</inv:symVar>
        <inv:date>${escapeXml(extracted.datumVystavenia)}</inv:date>
        <inv:dateTax>${escapeXml(extracted.datumDodania ?? extracted.datumVystavenia)}</inv:dateTax>
        <inv:dateDue>${escapeXml(extracted.datumSplatnosti ?? extracted.datumVystavenia)}</inv:dateDue>
        <inv:accounting><typ:ids>${escapeXml(accounting)}</typ:ids></inv:accounting>
        <inv:classificationVAT><typ:ids>${escapeXml(classificationVat)}</typ:ids></inv:classificationVAT>
        <inv:partnerIdentity><typ:address>
          <typ:company>${escapeXml(supplier.nazov)}</typ:company>
          <typ:ico>${escapeXml(supplier.ico)}</typ:ico>
          <typ:dic>${escapeXml(supplier.dic)}</typ:dic>
        </typ:address></inv:partnerIdentity>
        ${paymentAccount ? `<inv:paymentAccount><typ:accountNo>${escapeXml(paymentAccount.accountNo)}</typ:accountNo><typ:bankCode>${escapeXml(paymentAccount.bankCode)}</typ:bankCode></inv:paymentAccount>` : ''}
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
  xmlns:typ="http://www.stormware.cz/schema/version_2/type.xsd">
${items}
</dat:dataPack>`;
}

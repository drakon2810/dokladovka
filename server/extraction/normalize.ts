import {
  SUPPORTED_VAT_RATES,
  extractionResultSchema,
  type ExtractionResult,
} from './contract.js';
import { splitPostalAddress } from '../pohodaXml.js';
import { jeCudziDodavatel } from '../services/dphAdvisor.js';

export type DocumentType = 'FP' | 'FV' | 'BV' | 'MZDY' | 'OZ' | 'PD';

export interface NormalizedExtraction {
  documentType: DocumentType;
  extracted: Record<string, unknown>;
  fieldConfidence: Record<string, number>;
  confidence: number;
  totalAmount: number;
  currency: string;
}

const FIELD_PATHS: Record<string, string> = {
  'supplier.nazov': 'dodavatel.nazov',
  'supplier.ico': 'dodavatel.ico',
  'supplier.dic': 'dodavatel.dic',
  'supplier.icDph': 'dodavatel.icDph',
  'supplier.adresa': 'dodavatel.adresa',
  'supplier.iban': 'dodavatel.iban',
  'supplier.bic': 'dodavatel.bic',
  'buyer.nazov': 'odberatel.nazov',
  'buyer.ico': 'odberatel.ico',
  invoiceNumber: 'cisloFaktury',
  orderNumber: 'cisloObjednavky',
  deliveryNoteNumber: 'cisloDodaciehoListu',
  variableSymbol: 'variabilnySymbol',
  constantSymbol: 'konstantnySymbol',
  specificSymbol: 'specifickySymbol',
  issueDate: 'datumVystavenia',
  taxDate: 'datumDodania',
  dueDate: 'datumSplatnosti',
  totalAmount: 'sumaSpolu',
};

export function parseDecimal(value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  const parsed = Number(value.replace(',', '.'));
  return Number.isFinite(parsed) ? parsed : undefined;
}

// AI vracia menu v rôznych podobách (EURO, €, Kč, $). Kanonizujeme na ISO kód,
// inak doklad spadne na 'unsupported_currency', hoci mena je reálne EUR.
const CURRENCY_ALIASES: Record<string, string> = {
  EUR: 'EUR', EURO: 'EUR', EUROS: 'EUR', '€': 'EUR',
  CZK: 'CZK', 'KČ': 'CZK', KC: 'CZK',
  USD: 'USD', 'US$': 'USD', '$': 'USD',
};

export function canonicalCurrency(raw: string | undefined): string {
  const key = (raw ?? '').trim().toUpperCase();
  if (!key) return 'EUR';
  return CURRENCY_ALIASES[key] ?? key;
}

/**
 * ISO kód krajiny od modelu. Berieme len dve písmená — čokoľvek iné („Israel",
 * „SLOVAK REPUBLIC") by v POHODE nesadlo na číselník krajín, tam sa krajina
 * dohľadá starým rozkladom adresy.
 */
function isoKrajina(value: unknown): string | undefined {
  const kod = String(value ?? '').replace(/[^A-Za-z]/g, '').toUpperCase();
  return /^[A-Z]{2}$/.test(kod) ? kod : undefined;
}

/** Krajina strany: kód od modelu, inak dohľadanie názvu v texte adresy. */
function krajinaStrany(entity: { krajina?: string; adresa?: string } | undefined): string | undefined {
  return isoKrajina(entity?.krajina) ?? splitPostalAddress(entity?.adresa).country;
}

/**
 * Slovo pred samotným číslom („TVA FR30300823390", „VAT DE811907980") extrakcia
 * občas zoberie ako súčasť hodnoty. Predponu odstránime len vtedy, keď je zvyšok
 * platné IČ DPH — inak by sme z čísla ukrojili kus.
 */
function bezSlovnejPredpony(value: string | undefined): string | undefined {
  if (!value) return value;
  const cisty = value.replace(/[^A-Za-z0-9]/g, '').toUpperCase();
  if (checkVatId(cisty) === 'valid') return value;
  for (const predpona of ['TVA', 'VAT', 'MWST', 'USTIDNR', 'UST', 'IVA', 'BTW', 'DPH', 'NO']) {
    if (cisty.startsWith(predpona) && checkVatId(cisty.slice(predpona.length)) === 'valid') {
      return cisty.slice(predpona.length);
    }
  }
  return value;
}

function bezMedzier(value?: string): string | undefined {
  const clean = value?.replace(/\s+/g, '').trim();
  return clean ? clean : undefined;
}

/**
 * Identifikátory strany do správnych polí a bez medzier.
 * - „Client VAT No.: CH E101237456" extrakcia uloží do DIČ, hoci je to IČ DPH.
 *   V DIČ ho slovenský formát hlási ako chybu a do POHODY neodíde ako IČ DPH.
 * - Tá istá hodnota v oboch poliach je duplikát z extrakcie (ATU… u rakúskeho
 *   dodávateľa, SK… u odberateľa) — DIČ sa zahodí.
 * - Medzery sa odstraňujú vždy: POHODA ani kontroly formátu ich nečakajú.
 */
function opravIdentifikatory<T extends {
  ico?: string; dic?: string; icDph?: string;
  adresa?: string; ulica?: string; psc?: string; obec?: string; krajina?: string;
}>(entity: T): T {
  const ico = bezMedzier(entity.ico);
  let dic = bezMedzier(entity.dic);
  let icDph = bezSlovnejPredpony(bezMedzier(entity.icDph));
  if (dic && icDph && dic.toUpperCase() === icDph.toUpperCase()) dic = undefined;
  // Zahraničná strana slovenské DIČ nemá — čo z faktúry prišlo ako jej daňové
  // číslo (izraelské „Client VAT No.: 511149775"), je jej IČ DPH.
  // Krajinu určuje model z adresy (pozná aj samotné mesto: Ashdod → IL);
  // rozklad názvov v texte je len záloha pre doklady spracované predtým.
  const krajina = krajinaStrany(entity);
  const zahranicna = Boolean(krajina && krajina !== 'SK');
  if (!icDph && dic && (checkVatId(dic) === 'valid' || zahranicna)) {
    icDph = dic.toUpperCase();
    dic = undefined;
  }
  // Anglická faktúra píše slovenskej strane daňové číslo bez predpony („VAT:
  // 2020270780"). Samotných 10 číslic je DIČ; IČ DPH je to isté číslo s kódom
  // krajiny. Bez doplnenia formát blokuje schválenie a do POHODY by odišlo
  // neplatné IČ DPH. Podmienkou je PREUKÁZANÁ slovenská krajina, nie „nie je
  // zahraničná": 10 číslic bez kódu krajiny má aj poľské NIP či turecké VKN a
  // strane, ktorej krajinu nepoznáme, by sme vyrobili neexistujúce SK číslo —
  // to by prešlo kontrolou aj do kontrolného výkazu ako tuzemské plnenie.
  if (krajina === 'SK' && icDph && /^\d{10}$/.test(icDph)) {
    dic ??= icDph;
    icDph = `SK${icDph}`;
  }
  // Časti adresy od modelu majú prednosť pred rozkladom voľného textu; keď
  // niektorú nevráti, doplní ju rozklad (a účtovník ju vie prepísať).
  const zRozkladu = splitPostalAddress(entity.adresa);
  return {
    ...entity,
    ico,
    dic,
    icDph,
    krajina,
    ulica: entity.ulica?.trim() || zRozkladu.street,
    psc: entity.psc?.trim() || zRozkladu.zip,
    obec: entity.obec?.trim() || zRozkladu.city,
  };
}

function round2(value: number): number {
  return Math.round((value + Number.EPSILON) * 100) / 100;
}

function isValidVatRate(value: number): boolean {
  return Number.isFinite(value) && value >= 0 && value <= 100;
}

function isCurrentSupportedVatRate(value: number): boolean {
  return (SUPPORTED_VAT_RATES as readonly number[]).includes(value);
}

function confidence(fieldConfidence: Record<string, number>): number {
  const values = Object.values(fieldConfidence).filter(Number.isFinite);
  if (values.length === 0) return 0;
  return Math.round((values.reduce((sum, value) => sum + value, 0) / values.length) * 10_000) / 10_000;
}

/**
 * Rozpis DPH dopočítaný z položiek: sadzby sa zoskupia a sumy sčítajú. Základ a
 * daň sa berú z položky, a keď chýbajú, dopočítajú sa zo sumy s DPH a sadzby —
 * rovnako ako to robí editor pri prepnutí „počíta sa z položiek".
 */
function rozpisZPoloziek(
  polozky: Array<{ sadzbaDph?: number; sumaBezDph?: number; sumaDph?: number; sumaSpolu?: number }>,
): Array<{ sadzba: number; zaklad: number; dph: number }> {
  const podlaSadzby = new Map<number, { sadzba: number; zaklad: number; dph: number }>();
  for (const polozka of polozky) {
    // Oslobodené plnenie (rakúske „Mwst.-frei", prenesenie daňovej povinnosti)
    // nemá vytlačenú sadzbu, len sumu a nulovú daň. Preskočiť taký riadok
    // znamená prázdny rozpis DPH — a ten blokuje schválenie dokladu, hoci
    // doklad je v poriadku. Bez dane je sadzba nulová, nie neznáma.
    const bezDane = (polozka.sumaDph ?? 0) === 0;
    const sadzba = polozka.sadzbaDph ?? (bezDane ? 0 : undefined);
    if (sadzba === undefined || !isValidVatRate(sadzba)) continue;
    const spolu = polozka.sumaSpolu;
    const zaklad = polozka.sumaBezDph
      ?? (spolu === undefined ? undefined : round2(spolu / (1 + sadzba / 100)));
    if (zaklad === undefined) continue;
    const dph = polozka.sumaDph
      ?? (spolu === undefined ? round2(zaklad * sadzba / 100) : round2(spolu - zaklad));
    const riadok = podlaSadzby.get(sadzba) ?? { sadzba, zaklad: 0, dph: 0 };
    riadok.zaklad = round2(riadok.zaklad + zaklad);
    riadok.dph = round2(riadok.dph + dph);
    podlaSadzby.set(sadzba, riadok);
  }
  return [...podlaSadzby.values()].sort((left, right) => right.sadzba - left.sadzba);
}

/**
 * Doklad s cudzou daňou ide do účtovníctva ako JEDNA nezdaniteľná suma.
 * Rakúskych 20 % nie je DPH, ktorú by šlo odpočítať alebo vykázať — rozpis na
 * základ a daň nemá čo znamenať, POHODA preň nemá sadzbu a celá suma jej aj tak
 * ide do priceNone. Rozdeľovať taký doklad je len mätúce: účtovník vidí „20 %,
 * DPH 17,80" pri doklade, ktorý sa zaúčtuje ako 106,80 bez dane.
 *
 * Koľko cudzej dane v sume sedí, ostáva v `cudziaDan`. Bez toho údaja by doklad
 * vyzeral ako plnenie BEZ dane, čiže ako kandidát na samozdanenie — a DPH
 * poradca by stratil aj varovanie, aj blokáciu odpočtu cudzej dane.
 */
function bezCudzejDane(
  polozky: Array<Record<string, unknown>>,
  rozpisDph: Array<{ sadzba: number; zaklad: number; dph: number }>,
): {
  polozky: Array<Record<string, unknown>>;
  rozpisDph: Array<{ sadzba: number; zaklad: number; dph: number }>;
  cudziaDan?: number;
} {
  const cudziaDan = round2(rozpisDph.reduce((sum, row) => sum + row.dph, 0));
  // Zahraničná faktúra bez dane (prenesenie daňovej povinnosti, oslobodené
  // plnenie) sa nemení — tam je nulová sadzba pravda dokladu, nie náhrada.
  if (cudziaDan === 0) return { polozky, rozpisDph };
  return {
    polozky: polozky.map((polozka) => {
      const spolu = (polozka.sumaSpolu as number | undefined)
        ?? round2(((polozka.sumaBezDph as number | undefined) ?? 0) + ((polozka.sumaDph as number | undefined) ?? 0));
      const mnozstvo = polozka.mnozstvo as number | undefined;
      return {
        ...polozka,
        sadzbaDph: 0,
        sumaBezDph: spolu,
        sumaDph: 0,
        sumaSpolu: spolu,
        jednotkovaCenaBezDph: mnozstvo ? round2(spolu / mnozstvo) : spolu,
      };
    }),
    rozpisDph: [{
      sadzba: 0,
      zaklad: round2(rozpisDph.reduce((sum, row) => sum + row.zaklad + row.dph, 0)),
      dph: 0,
    }],
    cudziaDan,
  };
}

export function normalizeExtractionResult(
  raw: unknown,
  documentId: string,
  fallbackDate: string,
): NormalizedExtraction {
  const result = extractionResultSchema.parse(raw);
  const totalAmount = round2(parseDecimal(result.totalAmount) ?? 0);
  const currency = canonicalCurrency(result.currency);
  const mappedConfidence = Object.fromEntries(Object.entries(result.fieldConfidence).map(([path, value]) => [
    FIELD_PATHS[path] ?? path
      .replace(/^supplier\./, 'dodavatel.')
      .replace(/^buyer\./, 'odberatel.')
      .replace(/^vatBreakdown/, 'rozpisDph')
      .replace(/^lineItems/, 'polozky'),
    value,
  ]));

  const polozky = result.lineItems.map((item, index) => {
    const rate = Number(item.vatRate?.replace(',', '.'));
    return {
      id: `${documentId}-li-${index}`,
      popis: item.description ?? '',
      mnozstvo: parseDecimal(item.quantity),
      jednotka: item.unit,
      jednotkovaCenaBezDph: parseDecimal(item.unitPriceWithoutVat),
      sadzbaDph: isValidVatRate(rate) ? rate : undefined,
      sumaBezDph: parseDecimal(item.amountWithoutVat),
      sumaDph: parseDecimal(item.vatAmount),
      sumaSpolu: parseDecimal(item.amountTotal),
      // Bankový pohyb (BV): dátum platby, protistrana a symboly.
      datumPlatby: item.paymentDate,
      protistrana: item.counterpartyName,
      protiucetIban: item.counterpartyIban,
      vs: item.variableSymbol,
      ks: item.constantSymbol,
      ss: item.specificSymbol,
    };
  });

  const rozpisSDuplicitami = result.vatBreakdown.flatMap((row) => {
    let sadzba = Number(row.vatRate.replace(',', '.'));
    const zaklad = parseDecimal(row.base);
    const dph = parseDecimal(row.vat);
    // Prenesenie daňovej povinnosti nesie nulovú daň, ale model k nej občas
    // priradí sadzbu z hlavy — 10 % pri dani 0,00 je matematicky nemožný riadok
    // a blokuje schválenie. Nulová daň pri nenulovom základe = nulová sadzba.
    if (dph !== undefined && round2(dph) === 0 && zaklad !== undefined && round2(zaklad) !== 0) sadzba = 0;
    return isValidVatRate(sadzba) && zaklad !== undefined && dph !== undefined
      ? [{ sadzba, zaklad: round2(zaklad), dph: round2(dph) }]
      : [];
  });
  // Úplne zhodný riadok rozpisu je vždy prepis tej istej sumy, nikdy nie dva
  // rôzne plnenia: rozpis DPH má z definície jeden riadok na sadzbu. Talianska
  // faktúra tlačí celkovú sumu vo štyroch rámčekoch (Imponibile, Totale merce,
  // TOTALE A PAGARE, TOTALE DOCUMENTO) a model z každého spravil riadok —
  // základ potom vyšiel štvornásobne a „zaokrúhlenie" ukázalo −4006,50.
  //
  // Zhodné riadky sa zahodia, rôzne (tá istá sadzba, iný základ) sa nechajú:
  // tie sa legitímne sčítajú a kontrola súčtu ich overí.
  const rozpisZOdpovede = rozpisSDuplicitami.filter((row, index) => index === rozpisSDuplicitami
    .findIndex((iny) => iny.sadzba === row.sadzba && iny.zaklad === row.zaklad && iny.dph === row.dph));
  // Model občas rozpis DPH vôbec nevráti, hoci položky sadzbu aj daň nesú.
  // Prázdny rozpis blokuje schválenie a do POHODY by odišli nulové základy —
  // preto sa dopočíta z položiek. Vlastný rozpis z dokladu má vždy prednosť.
  const rozpisPrepocitany = rozpisZOdpovede.length > 0 ? rozpisZOdpovede : rozpisZPoloziek(polozky);
  const dodavatel = { ...opravIdentifikatory(result.supplier), nazov: result.supplier.nazov ?? '' };
  // Cudzia daň sa nerozpisuje na základ a DPH — celá suma je nezdaniteľná.
  const sumy = jeCudziDodavatel(dodavatel)
    ? bezCudzejDane(polozky, rozpisPrepocitany)
    : { polozky, rozpisDph: rozpisPrepocitany, cudziaDan: undefined };

  return {
    // INY sem dorazí len pri opakovanej extrakcii už existujúceho dokladu —
    // vtedy sa doklad neruší, len ostane pri predvolenom type ako pri UNKNOWN.
    documentType: result.documentType === 'UNKNOWN' || result.documentType === 'INY'
      ? 'FP'
      : result.documentType,
    extracted: {
      dodavatel,
      odberatel: opravIdentifikatory({ ...result.buyer }),
      cisloFaktury: result.invoiceNumber ?? '',
      cisloVypisu: result.statementNumber,
      // Počiatočný zostatok výpisu (BV nesie v totalWithoutVat) sa uloží,
      // aby ho videl editor a rovnica výpisu prežila aj neskoršie úpravy.
      pociatocnyZostatok: result.documentType === 'BV' ? parseDecimal(result.totalWithoutVat) : undefined,
      cisloObjednavky: result.orderNumber,
      cisloDodaciehoListu: result.deliveryNoteNumber,
      variabilnySymbol: result.variableSymbol,
      konstantnySymbol: result.constantSymbol,
      specifickySymbol: result.specificSymbol,
      datumVystavenia: result.issueDate ?? fallbackDate,
      // Splatnosť: keď ju doklad neuvádza, platí dňom vystavenia — presne ten
      // fallback už používa export do POHODY (pohodaXml.ts), takže uložená
      // hodnota konečne sedí s vyexportovanou. Že nepochádza z dokladu, vidno
      // vo zvýraznení zdroja — pole ostane bez farby (rovnako ako datumDodania).
      datumSplatnosti: result.dueDate ?? result.issueDate ?? fallbackDate,
      // DUZP: keď ho faktúra neuvádza (bežné pri zahraničných službách), odvodí
      // sa z dátumu vystavenia — rovnako ako to robí dphAdvisor. Inak by správny
      // návrh zaúčtovania blokovala validácia „chýba dátum dodania".
      datumDodania: result.taxDate ?? result.issueDate ?? fallbackDate,
      mena: currency,
      // AI zhrnutie plnenia — predvyplní „Text dokladu", ktorý ide do POHODY
      // ako text účtovného zápisu; účtovník ho môže prepísať.
      textPolozky: result.documentSummary,
      rozpisDph: sumy.rozpisDph,
      // Daň, ktorú si zahraničný dodávateľ účtoval pod vlastným IČ DPH. Nie je
      // súčasťou rozpisu (do priznania nevstupuje), ale doklad ju obsahuje.
      cudziaDan: sumy.cudziaDan,
      sumaSpolu: totalAmount,
      polozky: sumy.polozky,
    },
    fieldConfidence: mappedConfidence,
    confidence: confidence(result.fieldConfidence),
    totalAmount,
    currency,
  };
}

export interface ValidationIssue {
  code: string;
  field?: string;
  severity: 'warning' | 'error';
  message: string;
}

function isIsoDate(value: unknown): value is string {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(`${value}T00:00:00.000Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

function normalizedIdentifier(value: unknown): string {
  return typeof value === 'string' ? value.replace(/[^A-Za-z0-9]/g, '').toUpperCase() : '';
}

function validDic(value: unknown): boolean {
  if (/^(?:\d{8,10}|CZ[A-Z0-9]{8,12})$/.test(normalizedIdentifier(value))) return true;
  // AI často skopíruje IČ DPH (SK2020254170, ATU12345678) do poľa DIČ — je to
  // platný daňový identifikátor, len iného typu; blokovať schválenie netreba.
  const vat = checkVatId(value);
  return vat === 'valid' || vat === 'unknown_country';
}

// IČ DPH podľa krajín: EÚ formáty podľa VIES + XI/GB/CH/NO, ktoré sa na
// faktúrach zahraničných dodávateľov bežne vyskytujú. CZ zostáva zámerne
// voľnejšie než oficiálny formát (spätná kompatibilita s existujúcimi dokladmi).
const VAT_ID_FORMATS: Record<string, RegExp> = {
  AT: /^ATU\d{8}$/,
  BE: /^BE[01]\d{9}$/,
  BG: /^BG\d{9,10}$/,
  CH: /^CHE\d{9}(?:MWST|TVA|IVA)?$/,
  CY: /^CY\d{8}[A-Z]$/,
  CZ: /^CZ[A-Z0-9]{8,12}$/,
  DE: /^DE\d{9}$/,
  DK: /^DK\d{8}$/,
  EE: /^EE\d{9}$/,
  EL: /^EL\d{9}$/,
  ES: /^ES[A-Z0-9]\d{7}[A-Z0-9]$/,
  FI: /^FI\d{8}$/,
  FR: /^FR[A-Z0-9]{2}\d{9}$/,
  GB: /^GB(?:\d{9}|\d{12}|(?:GD|HA)\d{3})$/,
  GR: /^GR\d{9}$/,
  HR: /^HR\d{11}$/,
  HU: /^HU\d{8}$/,
  IE: /^IE(?:\d{7}[A-Z]{1,2}|\d[A-Z0-9]\d{5}[A-Z])$/,
  IT: /^IT\d{11}$/,
  LT: /^LT(?:\d{9}|\d{12})$/,
  LU: /^LU\d{8}$/,
  LV: /^LV\d{11}$/,
  MT: /^MT\d{8}$/,
  NL: /^NL[A-Z0-9]{9}B\d{2}$/,
  NO: /^NO\d{9}(?:MVA)?$/,
  PL: /^PL\d{10}$/,
  PT: /^PT\d{9}$/,
  RO: /^RO\d{2,10}$/,
  SE: /^SE\d{12}$/,
  SI: /^SI\d{8}$/,
  SK: /^SK\d{10}$/,
  XI: /^XI(?:\d{9}|\d{12}|(?:GD|HA)\d{3})$/,
};

/**
 * Efektívne sumy položky: prázdna DPH pri vyplnenej sadzbe znamená
 * „dopočítaj zo základu“. Ak extrahované „spolu“ zodpovedá základu (faktúry
 * uvádzajú riadky bez DPH a daň pridávajú až v súčte), efektívne spolu je
 * základ + dopočítaná DPH. Musí zostať v zhode s klientom (src/lib/validate.ts).
 */
function lineItemEffective(item: {
  sadzbaDph?: number;
  sumaBezDph?: number;
  sumaDph?: number;
  sumaSpolu?: number;
}): { bezDph?: number; dph?: number; spolu?: number } {
  const bezDph = item.sumaBezDph;
  let dph = item.sumaDph;
  let spolu = item.sumaSpolu;
  if (dph === undefined && item.sadzbaDph !== undefined && bezDph !== undefined) {
    dph = round2((bezDph * item.sadzbaDph) / 100);
    if (spolu === undefined || Math.abs(spolu - bezDph) <= 0.02) {
      spolu = round2(bezDph + dph);
    }
  }
  if (spolu === undefined && bezDph !== undefined && dph !== undefined) {
    spolu = round2(bezDph + dph);
  }
  return { bezDph, dph, spolu };
}

type VatIdCheck = 'valid' | 'invalid' | 'unknown_country';

function checkVatId(value: unknown): VatIdCheck {
  const normalized = normalizedIdentifier(value);
  const format = VAT_ID_FORMATS[normalized.slice(0, 2)];
  if (format) return format.test(normalized) ? 'valid' : 'invalid';
  // Neznámy kód krajiny nesmie blokovať schválenie — o zahraničnom doklade
  // rozhoduje človek; error je len pre hodnoty, ktoré nie sú IČ DPH vôbec.
  return /^[A-Z]{2}[A-Z0-9]{2,13}$/.test(normalized) ? 'unknown_country' : 'invalid';
}

/**
 * Formát IČ DPH blokuje schválenie LEN slovenskej strane — zahraničné daňové
 * čísla sú príliš rôznorodé („511149775" bez kódu krajiny, „TVAFR30300823390"
 * so slovom TVA navyše). Zahraničnej strane ostáva len upozornenie.
 */
function chybneIcDph(icDph: unknown, zahranicna: boolean): boolean {
  if (zahranicna) return false;
  return checkVatId(icDph) === 'invalid';
}

function validIban(value: string): boolean {
  const iban = value.replace(/\s/g, '').toUpperCase();
  if (!/^[A-Z]{2}\d{2}[A-Z0-9]{11,30}$/.test(iban)) return false;
  const lengths: Record<string, number> = { SK: 24, CZ: 24 };
  if (lengths[iban.slice(0, 2)] && iban.length !== lengths[iban.slice(0, 2)]) return false;
  const rearranged = iban.slice(4) + iban.slice(0, 4);
  let remainder = 0;
  for (const char of rearranged) {
    const digits = /[A-Z]/.test(char) ? String(char.charCodeAt(0) - 55) : char;
    for (const digit of digits) remainder = (remainder * 10 + Number(digit)) % 97;
  }
  return remainder === 1;
}

export function validateNormalizedExtraction(
  normalized: NormalizedExtraction,
  organization: { ico: string; dic?: string; icDph?: string },
): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const extracted = normalized.extracted as any;
  const supplier = extracted.dodavatel ?? {};
  const buyer = extracted.odberatel ?? {};
  const invoiceType = normalized.documentType === 'FP' || normalized.documentType === 'FV';
  if (!String(supplier.nazov ?? '').trim()) issues.push({ code: 'supplier_name_required', field: 'dodavatel.nazov', severity: 'error', message: 'Chýba názov dodávateľa' });
  if (invoiceType && !String(extracted.cisloFaktury ?? '').trim()) issues.push({ code: 'invoice_number_required', field: 'cisloFaktury', severity: 'error', message: 'Chýba číslo faktúry' });
  if (!isIsoDate(extracted.datumVystavenia)) issues.push({ code: 'invalid_issue_date', field: 'datumVystavenia', severity: 'error', message: 'Dátum vystavenia nie je platný' });
  if (invoiceType && !isIsoDate(extracted.datumDodania)) issues.push({ code: 'tax_date_required', field: 'datumDodania', severity: 'error', message: 'Chýba platný dátum dodania' });
  // Dátum splatnosti nie je účtovný údaj (slúži na sledovanie úhrad) — keď chýba,
  // stačí varovanie, aby neblokoval schválenie správne zaúčtovaného dokladu.
  if (invoiceType && !isIsoDate(extracted.datumSplatnosti)) issues.push({ code: 'due_date_required', field: 'datumSplatnosti', severity: 'warning', message: 'Chýba platný dátum splatnosti' });
  // Splatnosť pred vystavením je nezvyčajná, ale legitímna (napr. zálohové
  // faktúry) — varovanie, o schválení rozhoduje človek.
  if (isIsoDate(extracted.datumSplatnosti) && isIsoDate(extracted.datumVystavenia) && extracted.datumSplatnosti < extracted.datumVystavenia) {
    issues.push({ code: 'due_before_issue', field: 'datumSplatnosti', severity: 'warning', message: 'Dátum splatnosti je pred dátumom vystavenia' });
  }
  if (supplier.icDph) {
    const supplierVat = checkVatId(supplier.icDph);
    if (chybneIcDph(supplier.icDph, (krajinaStrany(supplier) ?? 'SK') !== 'SK')) {
      issues.push({ code: 'invalid_supplier_vat_id', field: 'dodavatel.icDph', severity: 'error', message: 'IČ DPH dodávateľa nemá platný formát' });
    } else if (supplierVat !== 'valid') {
      // Zahraničné číslo, ktoré formát nepozná: neblokuje, ale účtovník ho má vidieť.
      issues.push({ code: 'unverified_supplier_vat_id', field: 'dodavatel.icDph', severity: 'warning', message: 'IČ DPH dodávateľa sa nedá overiť formátom — skontrolujte podľa originálu' });
    }
  }
  // Zahraničný dodávateľ nemá slovenské 8-miestne IČO ani SK/CZ DIČ — formálne
  // odchýlky sú len varovanie, o doklade rozhoduje človek. Slovenský dodávateľ
  // ostáva blokujúca chyba. „Zahraničný" = zahraničný daňový identifikátor v poli
  // icDph ALEBO dic (AI ho často dá do dic, napr. ATU… u rakúskeho dodávateľa).
  const foreignVatLike = (value: unknown): boolean => {
    const n = normalizedIdentifier(value);
    return /^[A-Z]{2}/.test(n) && n.slice(0, 2) !== 'SK';
  };
  const supplierForeign = foreignVatLike(supplier.icDph) || foreignVatLike(supplier.dic)
    || (krajinaStrany(supplier) ?? 'SK') !== 'SK';
  if (supplier.ico && !/^\d{8}$/.test(normalizedIdentifier(supplier.ico))) issues.push({ code: 'invalid_supplier_ico', field: 'dodavatel.ico', severity: supplierForeign ? 'warning' : 'error', message: 'IČO dodávateľa nemá 8 číslic' });
  if (supplier.dic && !validDic(supplier.dic)) issues.push({ code: 'invalid_supplier_dic', field: 'dodavatel.dic', severity: supplierForeign ? 'warning' : 'error', message: 'DIČ dodávateľa nemá platný formát' });
  // Chybný IBAN je UPOZORNENIE, nie prekážka — na žiadnom type dokladu.
  // Zaúčtovanie ani daňové priznanie od neho nezávisia; nesprávny IBAN znamená
  // nanajvýš zle vyplnený príkaz na úhradu, ktorý účtovník aj tak prepisuje
  // z výpisu. Klient to tak vyhodnocuje už dlhšie (UPOZORNENIA v
  // src/data/validation/documentValidation.ts), server nie — doklad sa preto
  // tváril schvaľovateľný, oranžovo upozornil a Schváliť spadlo na 409.
  // Ten istý nález nesmie byť v jednej vrstve varovanie a v druhej chyba.
  if (supplier.iban && !validIban(supplier.iban)) issues.push({ code: 'invalid_iban', field: 'dodavatel.iban', severity: 'warning', message: 'IBAN dodávateľa nie je platný' });
  const buyerIco = normalizedIdentifier(buyer.ico);
  const orgIco = normalizedIdentifier(organization.ico);
  // Na VYDANEJ faktúre je odberateľom zákazník — iné IČO je normálny stav, nie
  // nesúlad. Obrátene platí, že dodávateľom má byť naša firma; keď ňou nie je,
  // ide pravdepodobne o prijatú faktúru zaradenú do zlej agendy.
  const vydana = normalized.documentType === 'FV';
  if (!vydana && buyerIco && buyerIco !== orgIco) issues.push({ code: 'buyer_ico_mismatch', field: 'odberatel.ico', severity: 'warning', message: 'IČO odberateľa sa nezhoduje s organizáciou' });
  if (vydana && !String(buyer.nazov ?? '').trim()) issues.push({ code: 'buyer_name_required', field: 'odberatel.nazov', severity: 'error', message: 'Chýba názov odberateľa' });
  if (vydana && normalizedIdentifier(supplier.ico) && normalizedIdentifier(supplier.ico) !== orgIco) {
    issues.push({ code: 'issued_supplier_not_own_company', field: 'dodavatel.ico', severity: 'warning', message: 'Vydanú faktúru nevystavila vaša firma — skontrolujte, či nejde o prijatú faktúru' });
  }
  // Na prijatej faktúre (FP) je odberateľom naša organizácia, ktorej reálne
  // identifikátory poznáme — chybne prečítané IČO/DIČ/IČ DPH odberateľa z faktúry
  // je len šum, nemá blokovať schválenie (varovanie). Na vydanej faktúre (FV) je
  // odberateľ zákazník a jeho identifikátory sú podstatné → blokujúca chyba.
  // Zahraničný zákazník (americký, ázijský) nemá slovenské IČO/DIČ — krajinu
  // poznáme z adresy, takže formátové kontroly naň neuplatňujeme rovnako, ako
  // to už platí pre zahraničného dodávateľa.
  const buyerForeign = foreignVatLike(buyer.icDph) || foreignVatLike(buyer.dic)
    || (krajinaStrany(buyer) ?? 'SK') !== 'SK';
  const buyerSeverity: 'warning' | 'error' = normalized.documentType === 'FV' ? 'error' : 'warning';
  // Slovenské formáty IČO/DIČ na zahraničného zákazníka neplatia. IČ DPH sa
  // kontroluje formátom jeho vlastnej krajiny (checkVatId), takže tam blokujúca
  // chyba ostáva aj zahraničnému odberateľovi.
  const buyerSkSeverity: 'warning' | 'error' = buyerForeign ? 'warning' : buyerSeverity;
  if (buyerIco && !/^\d{8}$/.test(buyerIco)) issues.push({ code: 'invalid_buyer_ico', field: 'odberatel.ico', severity: buyerSkSeverity, message: 'IČO odberateľa nemá 8 číslic' });
  if (buyer.dic && !validDic(buyer.dic)) issues.push({ code: 'invalid_buyer_dic', field: 'odberatel.dic', severity: buyerSkSeverity, message: 'DIČ odberateľa nemá platný formát' });
  if (buyer.icDph) {
    const buyerVat = checkVatId(buyer.icDph);
    if (chybneIcDph(buyer.icDph, buyerForeign)) {
      issues.push({ code: 'invalid_buyer_vat_id', field: 'odberatel.icDph', severity: buyerSeverity, message: 'IČ DPH odberateľa nemá platný formát' });
    } else if (buyerVat !== 'valid') {
      issues.push({ code: 'unverified_buyer_vat_id', field: 'odberatel.icDph', severity: 'warning', message: 'IČ DPH odberateľa má neznámy kód krajiny — skontrolujte podľa originálu' });
    }
  }
  // Len pri prijatých dokladoch: „dodávateľ sme my a odberateľ niekto iný" je
  // podozrenie na zámenu strán. Na vydanej faktúre je to presne správny stav.
  if (!vydana && normalizedIdentifier(supplier.ico) === orgIco && buyerIco && buyerIco !== orgIco) {
    issues.push({ code: 'supplier_buyer_may_be_inverted', severity: 'warning', message: 'Dodávateľ a odberateľ môžu byť zamenení' });
  }
  // BV: „celková suma" je konečný zostatok výpisu — záporný zostatok je legálny.
  if (!Number.isFinite(normalized.totalAmount) || (normalized.totalAmount < 0 && normalized.documentType !== 'BV')) issues.push({ code: 'invalid_total', field: 'sumaSpolu', severity: 'error', message: 'Celková suma nie je platná' });
  const rows = extracted.rozpisDph as Array<{ sadzba: number; zaklad: number; dph: number }>;
  for (const [index, row] of rows.entries()) {
    if (!isValidVatRate(row.sadzba) || Math.abs(round2(row.zaklad * row.sadzba / 100) - row.dph) > 0.02) {
      issues.push({ code: 'invalid_vat_row', field: `rozpisDph.${index}`, severity: 'error', message: 'Rozpis DPH matematicky nesedí' });
    }
    if (isValidVatRate(row.sadzba) && !isCurrentSupportedVatRate(row.sadzba)) {
      issues.push({ code: 'historical_or_unknown_vat_rate', field: `rozpisDph.${index}.sadzba`, severity: 'warning', message: 'Sadzba DPH nie je v aktuálnom zozname; skontrolujte historickú sadzbu' });
    }
  }
  // BV: „celková suma" je konečný zostatok — prípadné zvyšné riadky rozpisu
  // DPH sa naň nemajú čo rovnať (editor výpisu rozpis nezobrazuje).
  if (rows.length > 0 && normalized.documentType !== 'BV') {
    const rowsTotal = round2(rows.reduce((sum, row) => sum + row.zaklad + row.dph, 0));
    if (Math.abs(rowsTotal - normalized.totalAmount) > 0.02) issues.push({ code: 'total_mismatch', field: 'sumaSpolu', severity: 'error', message: 'Celková suma nesedí s rozpisom DPH' });
  }
  const items = extracted.polozky as Array<any>;
  for (const [index, item] of items.entries()) {
    // Jednotková cena je na doklade zaokrúhlená na centy, takže pri väčšom
    // množstve sa rozdiel legálne nasčíta: 10 ks × 0,38 € vyjde 3,80, no riadok
    // je 3,82 (skutočná cena za kus je 0,382). Tolerancia preto rastie o pol
    // centa na kus — inak správna faktúra hlási chybu a nedá sa schváliť.
    if (item.mnozstvo !== undefined && item.jednotkovaCenaBezDph !== undefined && item.sumaBezDph !== undefined
      && Math.abs(round2(item.mnozstvo * item.jednotkovaCenaBezDph) - item.sumaBezDph)
        > 0.02 + Math.abs(item.mnozstvo) * 0.005 + 1e-9) {
      issues.push({ code: 'invalid_line_item', field: `polozky.${index}.sumaBezDph`, severity: 'error', message: 'Množstvo a jednotková cena nesedia so sumou položky' });
    }
    if (item.sumaBezDph !== undefined && item.sumaDph !== undefined && item.sumaSpolu !== undefined
      && Math.abs(round2(item.sumaBezDph + item.sumaDph) - item.sumaSpolu) > 0.02) {
      issues.push({ code: 'invalid_line_item_total', field: `polozky.${index}.sumaSpolu`, severity: 'error', message: 'Súčet základu a DPH nesedí so sumou položky' });
    }
  }
  // Súčet položiek pracuje s efektívnymi sumami — prázdna DPH pri vyplnenej
  // sadzbe sa dopočíta, aby faktúry s riadkami bez DPH neblokovali schválenie.
  // BV sa nekontroluje: položky sú pohyby výpisu a „celková suma" je konečný
  // zostatok — súčet pohybov sa mu rovnať nemá.
  const effectiveItems = items.map(lineItemEffective);
  if (normalized.documentType !== 'BV' && effectiveItems.length > 0 && effectiveItems.every((item) => item.spolu !== undefined)) {
    const itemTotal = round2(effectiveItems.reduce((sum, item) => sum + (item.spolu ?? 0), 0));
    if (Math.abs(itemTotal - normalized.totalAmount) > 0.02) issues.push({ code: 'line_items_total_mismatch', field: 'polozky', severity: 'error', message: 'Súčet položiek nesedí s celkovou sumou' });
  }
  return issues;
}

/** Kontroly hodnôt, ktoré zostávajú v presných decimal strings pred normalizáciou. */
export function validateExtractionResult(
  result: ExtractionResult,
  normalized: NormalizedExtraction,
  organization: { ico: string; dic?: string; icDph?: string },
): ValidationIssue[] {
  const issues = validateNormalizedExtraction(normalized, organization);
  if (!result.totalAmount || parseDecimal(result.totalAmount) === undefined) {
    issues.push({ code: 'total_required', field: 'sumaSpolu', severity: 'error', message: 'Chýba platná celková suma' });
  }
  if (!result.currency || !['EUR', 'CZK', 'USD'].includes(result.currency.trim().toUpperCase())) {
    issues.push({ code: 'unsupported_currency', field: 'mena', severity: 'error', message: 'Mena dokladu nie je podporovaná' });
  }
  const totalWithoutVat = parseDecimal(result.totalWithoutVat);
  const totalVat = parseDecimal(result.totalVat);
  const totalAmount = parseDecimal(result.totalAmount);
  // BV: totalWithoutVat nesie POČIATOČNÝ zostatok výpisu (nie základ DPH).
  // Kontrola účtovnej rovnice výpisu: počiatočný + súčet pohybov = konečný.
  // Nesúlad je varovanie — AI mohla na fotke prehliadnuť riadok, rozhodne človek.
  if (normalized.documentType === 'BV') {
    const pohyby = ((normalized.extracted as any).polozky ?? []) as Array<{ sumaSpolu?: number }>;
    if (totalWithoutVat !== undefined && totalAmount !== undefined && pohyby.length > 0
      && pohyby.every((pohyb) => pohyb.sumaSpolu !== undefined)) {
      const sucetPohybov = round2(pohyby.reduce((sum, pohyb) => sum + (pohyb.sumaSpolu ?? 0), 0));
      if (Math.abs(round2(totalWithoutVat + sucetPohybov) - totalAmount) > 0.02) {
        issues.push({
          code: 'bank_balance_mismatch', field: 'polozky', severity: 'warning',
          message: `Počiatočný zostatok + pohyby (${round2(totalWithoutVat + sucetPohybov).toFixed(2)}) nesedí s konečným zostatkom (${totalAmount.toFixed(2)}) — skontrolujte, či sa načítali všetky pohyby`,
        });
      }
    }
    return issues;
  }
  if (totalWithoutVat !== undefined && totalVat !== undefined && totalAmount !== undefined
    && Math.abs(round2(totalWithoutVat + totalVat) - totalAmount) > 0.02) {
    issues.push({ code: 'declared_totals_mismatch', field: 'sumaSpolu', severity: 'error', message: 'Deklarovaný základ a DPH nesedia s celkovou sumou' });
  }
  const rawBase = result.vatBreakdown.reduce((sum, row) => sum + (parseDecimal(row.base) ?? 0), 0);
  const rawVat = result.vatBreakdown.reduce((sum, row) => sum + (parseDecimal(row.vat) ?? 0), 0);
  if (totalWithoutVat !== undefined && Math.abs(round2(rawBase) - totalWithoutVat) > 0.02) {
    issues.push({ code: 'vat_base_total_mismatch', field: 'rozpisDph', severity: 'error', message: 'Súčet základov DPH nesedí s deklarovaným základom' });
  }
  if (totalVat !== undefined && Math.abs(round2(rawVat) - totalVat) > 0.02) {
    issues.push({ code: 'vat_total_mismatch', field: 'rozpisDph', severity: 'error', message: 'Súčet DPH nesedí s deklarovanou DPH' });
  }
  return issues;
}

export function escapeXml(value: unknown): string {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&apos;')
    .replace(/[^\x09\x0A\x0D\x20-\x7E]/g, (character) => `&#${character.codePointAt(0)};`);
}

/**
 * Skráti hodnotu na limit oficiálnej XSD schémy POHODY. Hodnoty pochádzajú z AI
 * extrakcie, takže pridlhý názov firmy či zahraničné daňové číslo v poli IČO
 * (napr. francúzske SIRET „340 256 791 00054") inak zhodí XSD validáciu — a s ňou
 * CELÝ dataPack vrátane bezchybných dokladov v tej istej dávke.
 */
function clamp(value: unknown, maxLength: number): string {
  // Zlomy riadkov a viacnásobné medzery sa zlučujú do jednej: polia POHODY sú
  // jednoriadkové a XSD počíta každý znak vrátane konca riadka. Text so zlomom
  // prejde orezaním na presný limit a validáciu aj tak zhodí — a POHODA odmietne
  // CELÝ dataPack, nielen tento doklad.
  return String(value ?? '').replace(/\s+/g, ' ').trim().slice(0, maxLength);
}

/** Identifikátory (IČO, DIČ, IČ DPH) POHODA očakáva bez medzier. */
function identifier(value: unknown, maxLength: number): string {
  return String(value ?? '').replace(/\s+/g, '').slice(0, maxLength);
}

// Priečinok agendy v strome „Dokumenty firmy". POHODA cestu ukladá na doklad
// a agent do nej odloží sken — bez nej doklad hlási „Priečinok nie je
// definovaný" a PDF nemá kam ísť. Bankový výpis chýba zámerne: jeden výpis sa
// do POHODY rozpadne na jeden doklad za KAŽDÝ pohyb, takže priečinok dokladu
// pre celý sken neexistuje.
//
// ponytail: segment agendy píšeme aj do podzložky, rovnako ako doteraz vydaná
// faktúra. Ak POHODA vracia agendu už v companyDocumentsFolder, cesta na disku
// má agendu dvakrát — na funkciu to nemá vplyv (POHODA aj agent skladajú tú
// istú dvojicu), len je škaredá. Overiť na pilotnom stroji, kam reálne
// pristál sken jednej vydanej faktúry, a segment prípadne vypustiť.
const AGENDA_PRIECINOK: Record<string, string> = {
  FP: 'Fakturácia\\Prijaté faktúry',
  FV: 'Fakturácia\\Vydané faktúry',
  OZ: 'Fakturácia\\Ostatné záväzky',
  PD: 'Podvojné účtovníctvo\\Pokladňa',
  MZDY: 'Podvojné účtovníctvo\\Interné doklady',
};

/**
 * Meno podpriečinka jedného dokladu. Musí byť jedinečné a bezpečné ako cesta:
 * POHODA hodnotu iba uloží a vráti a agent ju vloží do Path.Combine, takže „/"
 * z čísla faktúry by pridal úroveň a „.." by zapísal mimo stromu Dokumenty.
 */
function bezpecnaCast(value: unknown): string {
  return String(value ?? '')
    .replace(/[^\p{L}\p{N}._-]/gu, '-')
    .replace(/^[.\-]+|[.\-]+$/g, '')
    .slice(0, 32);
}

/**
 * Dátumy sú v schéme xsd:date (RRRR-MM-DD). Prázdna hodnota (chýbajúca splatnosť
 * je pri schvaľovaní len upozornenie) alebo formát „30.06.2026" zhodí XSD validáciu
 * celého dataPacku — preto sa nevalidný dátum radšej nahradí alebo vynechá.
 */
function isoDate(value: unknown): string | undefined {
  const text = String(value ?? '').trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text) || Number.isNaN(Date.parse(text))) return undefined;
  return text;
}

interface Snapshot {
  version: number;
  typ: string;
  /** Dobropis, ťarchopis, zálohová. Chýba pri dokladoch spred zavedenia. */
  podtyp?: string;
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
  /** Analytické dimenzie POHODY: zákazka (contract) a činnosť (activity). */
  zakazky?: Map<string, string>;
  cinnosti?: Map<string, string>;
  /** Názvy predkontácií (id → názov) pre <inv:text>; kódy sú v `predkontacie`. */
  predkontacieNazvy?: Map<string, string>;
}

/**
 * Typ faktúry pre POHODA. Rozhoduje DVOJICA: dobropis a ťarchopis sú v POHODE
 * samostatné hodnoty invoiceType, nie iné agendy — presne ako v jej XSD
 * (issuedCreditNotice = Dobropis, issuedDebitNote = Vrubopis/ťarchopis).
 */
function invoiceType(type: string, podtyp?: string): string {
  if (type === 'OZ') return 'commitment';
  const strana = type === 'FP' ? 'received' : type === 'FV' ? 'issued' : undefined;
  if (!strana) throw new Error(`Nepodporovaný typ dokladu pre POHODA: ${type}`);
  if (podtyp === 'dobropis') return `${strana}CreditNotice`;
  if (podtyp === 'tarchopis') return `${strana}DebitNote`;
  if (podtyp === 'zalohova') return `${strana}AdvanceInvoice`;
  return `${strana}Invoice`;
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

const round2 = (value: number): number => Math.round((value + Number.EPSILON) * 100) / 100;

/** Sadzba DPH → POHODA rateVAT. Zhodné s rozdelením súhrnu (23→high, 19→low, 5→third). */
function vatRateName(sadzba: unknown): 'high' | 'low' | 'third' | 'none' {
  const rate = Number(sadzba);
  if (rate === 23) return 'high';
  if (rate === 19) return 'low';
  if (rate === 5) return 'third';
  return 'none';
}

/** Efektívne sumy položky — prázdna DPH pri vyplnenej sadzbe sa dopočíta zo základu (zhoda s normalize.ts). */
function lineItemAmounts(item: any): { bezDph: number; dph: number; spolu: number; unitPrice: number } {
  const bezDph = Number(item.sumaBezDph ?? 0);
  let dph = item.sumaDph !== undefined ? Number(item.sumaDph) : undefined;
  let spolu = item.sumaSpolu !== undefined ? Number(item.sumaSpolu) : undefined;
  if (dph === undefined && item.sadzbaDph !== undefined && item.sumaBezDph !== undefined) {
    dph = round2((bezDph * Number(item.sadzbaDph)) / 100);
    if (spolu === undefined || Math.abs(spolu - bezDph) <= 0.02) spolu = round2(bezDph + dph);
  }
  dph = dph ?? 0;
  spolu = spolu ?? round2(bezDph + dph);
  const unitPrice = item.jednotkovaCenaBezDph !== undefined ? Number(item.jednotkovaCenaBezDph) : bezDph;
  return { bezDph, dph, spolu, unitPrice };
}

/** Elementy položkového rozpisu podľa agendy — obsah položky je vo všetkých
 *  troch schémach zhodný (líši sa len namespace a názov obálky). */
const DETAIL_TAGS = {
  invoice: { ns: 'inv', detail: 'invoiceDetail', item: 'invoiceItem' },
  voucher: { ns: 'vch', detail: 'voucherDetail', item: 'voucherItem' },
  intDoc: { ns: 'int', detail: 'intDocDetail', item: 'intDocItem' },
} as const;

/**
 * Položkový rozpis dokladu (SPEC — rozpis na položky) pre invoice/voucher/intDoc.
 * Každá dimenzia položky (zaúčtovanie, členenia, stredisko, činnosť, zákazka) sa
 * pri prázdnej hodnote vracia na hlavičku — prázdne pole v editore znamená
 * „ako doklad", nie „bez hodnoty".
 * Vráti prázdny reťazec, ak doklad nemá položky (vtedy sa importuje len súhrn).
 */
function documentDetailXml(
  polozky: unknown,
  header: { accounting: string; classificationVat: string; kv?: string; centre?: string; activity?: string; contract?: string },
  codeLists: PohodaCodeLookup,
  tag: (typeof DETAIL_TAGS)[keyof typeof DETAIL_TAGS],
): string {
  if (!Array.isArray(polozky) || polozky.length === 0) return '';
  const { ns } = tag;
  const items = polozky.map((item: any) => {
    const { bezDph, dph, spolu, unitPrice } = lineItemAmounts(item);
    // Cudzia daň (sadzba mimo slovenských) sa do POHODY nedá poslať ako DPH —
    // rateVAT je „none". Poslať k nej priceVAT by znamenalo doklad nižší o daň,
    // preto ide celá suma do ceny bez dane, rovnako ako v súhrne dokladu.
    const cudziaDan = vatRateName(item.sadzbaDph) === 'none' && dph !== 0;
    const mnozstvo = Number.isFinite(Number(item.mnozstvo)) && Number(item.mnozstvo) !== 0 ? Number(item.mnozstvo) : 1;
    const cena = cudziaDan ? spolu : bezDph;
    const cenaDph = cudziaDan ? 0 : dph;
    const cenaZaJednotku = cudziaDan ? round2(spolu / mnozstvo) : unitPrice;
    const accounting = codeLists.predkontacie.get(item.ucto?.predkontaciaId ?? '') ?? header.accounting;
    const classificationVat = codeLists.cleneniaDph.get(item.ucto?.clenenieDphId ?? '') ?? header.classificationVat;
    const kv = item.ucto?.clenenieKvKod || header.kv;
    const centre = codeLists.strediska.get(item.ucto?.strediskoId ?? '') ?? header.centre;
    const activity = codeLists.cinnosti?.get(item.ucto?.cinnostId ?? '') ?? header.activity;
    const contract = codeLists.zakazky?.get(item.ucto?.zakazkaId ?? '') ?? header.contract;
    const lines = [
      // Text položky má v schéme 90 znakov, merná jednotka 10.
      `        <${ns}:text>${escapeXml(clamp(item.popis, 90))}</${ns}:text>`,
      // quantity je xsd:float — „2 ks" alebo prázdna hodnota by zhodila celý dataPack.
      `        <${ns}:quantity>${Number.isFinite(Number(item.mnozstvo)) ? Number(item.mnozstvo) : 1}</${ns}:quantity>`,
      ...(item.jednotka ? [`        <${ns}:unit>${escapeXml(clamp(item.jednotka, 10))}</${ns}:unit>`] : []),
      `        <${ns}:coefficient>1.0</${ns}:coefficient>`,
      `        <${ns}:payVAT>false</${ns}:payVAT>`,
      `        <${ns}:rateVAT>${vatRateName(item.sadzbaDph)}</${ns}:rateVAT>`,
      `        <${ns}:discountPercentage>0.0</${ns}:discountPercentage>`,
      `        <${ns}:homeCurrency>`,
      `          <typ:unitPrice>${amount(cenaZaJednotku)}</typ:unitPrice>`,
      `          <typ:price>${amount(cena)}</typ:price>`,
      `          <typ:priceVAT>${amount(cenaDph)}</typ:priceVAT>`,
      `          <typ:priceSum>${amount(spolu)}</typ:priceSum>`,
      `        </${ns}:homeCurrency>`,
      ...(accounting ? [`        <${ns}:accounting><typ:ids>${escapeXml(accounting)}</typ:ids></${ns}:accounting>`] : []),
      ...(classificationVat ? [`        <${ns}:classificationVAT><typ:ids>${escapeXml(classificationVat)}</typ:ids></${ns}:classificationVAT>`] : []),
      ...(kv ? [`        <${ns}:classificationKVDPH><typ:ids>${escapeXml(kv)}</typ:ids></${ns}:classificationKVDPH>`] : []),
      // Poradie centre → activity → contract je dané sekvenciou v XSD.
      ...(centre ? [`        <${ns}:centre><typ:ids>${escapeXml(centre)}</typ:ids></${ns}:centre>`] : []),
      ...(activity ? [`        <${ns}:activity><typ:ids>${escapeXml(activity)}</typ:ids></${ns}:activity>`] : []),
      ...(contract ? [`        <${ns}:contract><typ:ids>${escapeXml(contract)}</typ:ids></${ns}:contract>`] : []),
    ];
    return `      <${ns}:${tag.item}>\n${lines.join('\n')}\n      </${ns}:${tag.item}>`;
  });
  return `\n      <${ns}:${tag.detail}>\n${items.join('\n')}\n      </${ns}:${tag.detail}>`;
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
/**
 * Krajiny, ktoré na dokladoch reálne chodia: názov v texte adresy → ISO kód pre
 * číselník krajín POHODY. Neznámy názov ostáva nerozpoznaný — prázdna krajina
 * je lepšia než vymyslená.
 */
const KRAJINA_PODLA_MENA = new Map<string, string>([
  ['sk', 'SK'], ['slovakia', 'SK'], ['slovak republic', 'SK'], ['slovensko', 'SK'],
  ['slovenska republika', 'SK'], ['slowakei', 'SK'], ['slovakei', 'SK'],
  ['cz', 'CZ'], ['czech republic', 'CZ'], ['czechia', 'CZ'], ['cesko', 'CZ'],
  ['ceska republika', 'CZ'], ['tschechien', 'CZ'],
  ['at', 'AT'], ['austria', 'AT'], ['rakusko', 'AT'], ['osterreich', 'AT'],
  ['de', 'DE'], ['germany', 'DE'], ['nemecko', 'DE'], ['deutschland', 'DE'],
  ['hu', 'HU'], ['hungary', 'HU'], ['madarsko', 'HU'], ['ungarn', 'HU'],
  ['pl', 'PL'], ['poland', 'PL'], ['polsko', 'PL'], ['polen', 'PL'],
  ['ie', 'IE'], ['ireland', 'IE'], ['irsko', 'IE'],
  ['gb', 'GB'], ['uk', 'GB'], ['united kingdom', 'GB'], ['great britain', 'GB'],
  ['fr', 'FR'], ['france', 'FR'], ['francuzsko', 'FR'],
  ['it', 'IT'], ['italy', 'IT'], ['taliansko', 'IT'], ['italia', 'IT'],
  ['es', 'ES'], ['spain', 'ES'], ['spanielsko', 'ES'], ['espana', 'ES'],
  ['nl', 'NL'], ['netherlands', 'NL'], ['holandsko', 'NL'], ['nederland', 'NL'],
  ['be', 'BE'], ['belgium', 'BE'], ['belgicko', 'BE'],
  ['ch', 'CH'], ['switzerland', 'CH'], ['svajciarsko', 'CH'], ['schweiz', 'CH'],
  ['us', 'US'], ['usa', 'US'], ['united states', 'US'],
  ['il', 'IL'], ['israel', 'IL'], ['izrael', 'IL'],
  ['jp', 'JP'], ['japan', 'JP'], ['japonsko', 'JP'],
  ['ca', 'CA'], ['canada', 'CA'], ['kanada', 'CA'],
  ['au', 'AU'], ['australia', 'AU'], ['australia commonwealth', 'AU'],
  ['nz', 'NZ'], ['new zealand', 'NZ'], ['novy zeland', 'NZ'],
  ['ae', 'AE'], ['united arab emirates', 'AE'], ['spojene arabske emiraty', 'AE'],
  ['tr', 'TR'], ['turkey', 'TR'], ['turkiye', 'TR'], ['turecko', 'TR'],
  ['ua', 'UA'], ['ukraine', 'UA'], ['ukrajina', 'UA'],
  ['rs', 'RS'], ['serbia', 'RS'], ['srbsko', 'RS'],
  ['no', 'NO'], ['norway', 'NO'], ['norsko', 'NO'],
  ['se', 'SE'], ['sweden', 'SE'], ['svedsko', 'SE'],
  ['dk', 'DK'], ['denmark', 'DK'], ['dansko', 'DK'],
  ['fi', 'FI'], ['finland', 'FI'], ['finsko', 'FI'],
  ['pt', 'PT'], ['portugal', 'PT'], ['portugalsko', 'PT'],
  ['gr', 'GR'], ['greece', 'GR'], ['grecko', 'GR'],
  ['ro', 'RO'], ['romania', 'RO'], ['rumunsko', 'RO'],
  ['bg', 'BG'], ['bulgaria', 'BG'], ['bulharsko', 'BG'],
  ['hr', 'HR'], ['croatia', 'HR'], ['chorvatsko', 'HR'],
  ['si', 'SI'], ['slovenia', 'SI'], ['slovinsko', 'SI'],
  ['lt', 'LT'], ['lithuania', 'LT'], ['litva', 'LT'],
  ['lv', 'LV'], ['latvia', 'LV'], ['lotyssko', 'LV'],
  ['ee', 'EE'], ['estonia', 'EE'], ['estonsko', 'EE'],
  ['lu', 'LU'], ['luxembourg', 'LU'], ['luxembursko', 'LU'],
  ['cy', 'CY'], ['cyprus', 'CY'],
  ['mt', 'MT'], ['malta', 'MT'],
  ['sg', 'SG'], ['singapore', 'SG'], ['singapur', 'SG'],
  ['za', 'ZA'], ['south africa', 'ZA'], ['juzna afrika', 'ZA'],
  ['cn', 'CN'], ['china', 'CN'], ['cina', 'CN'],
  ['in', 'IN'], ['india', 'IN'],
  ['br', 'BR'], ['brazil', 'BR'], ['brazilia', 'BR'],
  ['mx', 'MX'], ['mexico', 'MX'], ['mexiko', 'MX'],
]);

const PSC_SAMOTNE = /^(\d{3}\s?\d{2}|\d{4,6})$/;
const PSC_S_MESTOM = /^(\d{3}\s?\d{2}|\d{4,6})\s+(\D.*)$/;
/** Kraj/okres/región — ani mesto, ani ulica; do POHODY nepatrí. */
const OBLAST = /(^|\s)(kraj|okres|region|county|province|oblast)(\s|$)/;

function bezDiakritikyMalymi(text: string): string {
  return text.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
}

function jeOblast(cast: string): boolean {
  return OBLAST.test(bezDiakritikyMalymi(cast).replace(/[.,]/g, ' '));
}

/**
 * ISO kód krajiny z jej názvu v adrese. Skúša aj tvar so zátvorkou — extrakcia
 * píše raz „Slovakia", inokedy „Slovakia (Slovak Republic)"; oba znamenajú SK.
 */
function krajinaZMena(cast: string | undefined): string | undefined {
  const zaklad = bezDiakritikyMalymi(cast ?? '');
  const vZatvorke = /\(([^)]*)\)/.exec(zaklad)?.[1] ?? '';
  for (const kandidat of [zaklad.replace(/\([^)]*\)/g, ' '), vZatvorke, zaklad]) {
    const kluc = kandidat.replace(/[.,()]/g, ' ').replace(/\s+/g, ' ').trim();
    const kod = kluc ? KRAJINA_PODLA_MENA.get(kluc) : undefined;
    if (kod) return kod;
  }
  return undefined;
}

export function splitPostalAddress(value: unknown): { street?: string; city?: string; zip?: string; country?: string } {
  const parts = String(value ?? '')
    .split(/\r?\n|\s+[–—-]\s+|,/)
    .map((part) => part.trim())
    .filter(Boolean);
  if (parts.length === 0) return {};
  // Krajina býva na konci adresy, ale nie vždy („…, Ashdod, Israel, South
  // District"), preto sa hľadá od konca cez všetky časti. Rozpoznaná časť
  // z ďalšieho rozkladu vypadne, nech neskončí ako mesto alebo ulica.
  let country: string | undefined;
  for (let index = parts.length - 1; index >= 0; index -= 1) {
    const kod = krajinaZMena(parts[index]);
    if (kod) {
      country = kod;
      parts.splice(index, 1);
      break;
    }
  }
  const zvysne = parts.filter((part) => !jeOblast(part));

  let city: string | undefined;
  let zip: string | undefined;
  const rest: string[] = [];
  for (let index = 0; index < zvysne.length; index += 1) {
    const part = zvysne[index];
    const sMestom = !city ? PSC_S_MESTOM.exec(part) : null;
    if (sMestom) {
      zip = sMestom[1];
      city = sMestom[2].trim();
      continue;
    }
    // PSČ ako samostatná časť („…, BRATISLAVA, 811 07") — mesto stojí vedľa
    // neho, raz pred ním, inokedy zaň. Bez tohto ostalo mesto aj PSČ prázdne.
    if (!zip && PSC_SAMOTNE.test(part)) {
      zip = part;
      if (!city) {
        const zaNim = zvysne[index + 1];
        const predNim = rest[rest.length - 1];
        if (zaNim && !/\d/.test(zaNim)) {
          city = zaNim;
          index += 1;
        } else if (predNim && !/\d/.test(predNim)) {
          city = predNim;
          rest.pop();
        }
      }
      continue;
    }
    rest.push(part);
  }
  // Mesto zopakované v adrese („…, Bratislava, Bratislava, 811 07") netreba mať
  // ešte raz v ulici.
  while (rest.length > 1 && city && rest[rest.length - 1].toLowerCase() === city.toLowerCase()) rest.pop();
  if (!city && rest.length === 1) return { street: rest[0], country };
  // Ulica = všetko od prvej časti s číslom domu ďalej („46A, Mýtna"); názov
  // firmy, ak ho extrakcia vložila pred ulicu, tak do ulice nespadne.
  const odkial = rest.findIndex((part) => /\d/.test(part));
  const street = odkial >= 0 ? rest.slice(odkial).join(', ') : rest[0];
  return { street, city, zip, country };
}

/**
 * Adresa dodávateľa po častiach. Ručne vyplnené polia (ulica/psc/obec/krajina)
 * majú prednosť; kým sú undefined, odvodí sa ulica/PSČ/obec z voľnej `adresa`
 * a krajina z IČ DPH — a keď je prázdne, z DIČ, lebo extrakcia zahraničný daňový
 * identifikátor (DE813960018, ATU61252600) často uloží do poľa DIČ. Bez toho
 * fallbacku POHODA importovala dodávateľa bez krajiny. Prázdny reťazec je vedomé
 * vymazanie, preto `??` a nie `||`. Zhoda so src/data/xml/pohodaDataPack.ts.
 */
export function supplierAddressParts(supplier: Record<string, any>): {
  ulica?: string; psc?: string; obec?: string; krajina?: string;
} {
  const split = splitPostalAddress(supplier.adresa);
  return {
    ulica: supplier.ulica ?? split.street,
    psc: supplier.psc ?? split.zip,
    obec: supplier.obec ?? split.city,
    // Krajina: ručné pole > IČ DPH/DIČ (najspoľahlivejšie) > názov krajiny
    // v texte adresy — pri súkromnej osobe bez IČ DPH je to jediný zdroj.
    krajina: supplier.krajina ?? vatCountryIds(supplier.icDph) ?? vatCountryIds(supplier.dic) ?? split.country,
  };
}

/** typ:address partnera — prázdne prvky sa vynechávajú. */
function partnerAddressXml(supplier: Record<string, any>): string {
  const address = supplierAddressParts(supplier);
  // Limity podľa oficiálnej type.xsd: company 255, city 45, street 64, zip 15,
  // ico 15, dic 18, icDph 18, country ids 32.
  const lines = [`<typ:company>${escapeXml(clamp(supplier.nazov, 255))}</typ:company>`];
  if (address.obec) lines.push(`<typ:city>${escapeXml(clamp(address.obec, 45))}</typ:city>`);
  if (address.ulica) lines.push(`<typ:street>${escapeXml(clamp(address.ulica, 64))}</typ:street>`);
  if (address.psc) lines.push(`<typ:zip>${escapeXml(clamp(address.psc, 15))}</typ:zip>`);
  if (supplier.ico) lines.push(`<typ:ico>${escapeXml(identifier(supplier.ico, 15))}</typ:ico>`);
  if (supplier.dic) lines.push(`<typ:dic>${escapeXml(identifier(supplier.dic, 18))}</typ:dic>`);
  if (supplier.icDph) lines.push(`<typ:icDph>${escapeXml(identifier(supplier.icDph, 18))}</typ:icDph>`);
  // Krajina sa vypĺňa vždy (aj tuzemsko SK) — POHODA ju pri importe páruje na číselník krajín.
  if (address.krajina) lines.push(`<typ:country><typ:ids>${escapeXml(clamp(address.krajina, 32))}</typ:ids></typ:country>`);
  return `<typ:address>
          ${lines.join('\n          ')}
        </typ:address>`;
}

/**
 * Bankový výpis → jeden <bnk:bank> na KAŽDÝ pohyb. POHODA vedie agendu Banka
 * po pohyboch, nie po výpisoch; smer (príjem/výdaj) určuje znamienko sumy.
 * Poradie elementov drží poradie v bank.xsd (bankHeader je xsd:all, ale test
 * poradia aj čitateľnosť profitujú z poradia podľa schémy).
 */
function bankDataPackItems(
  id: string,
  snapshot: Snapshot,
  codeLists: PohodaCodeLookup,
): string {
  const extracted = snapshot.extracted;
  const ucet = String(snapshot.ucto.bankUcetKod ?? '').trim();
  if (!ucet) throw new Error(`Bankový výpis ${id} nemá nastavený účet POHODY`);
  // ponytail: len domáca mena — devízový účet potrebuje foreignCurrency + kurz,
  // doplniť pri prvom reálnom USD/CZK výpise.
  if ((extracted.mena ?? 'EUR') !== 'EUR') {
    throw new Error(`Bankový výpis ${id} je v mene ${extracted.mena} — export devízových výpisov zatiaľ nie je podporovaný`);
  }
  const polozky = Array.isArray(extracted.polozky) ? extracted.polozky : [];
  if (polozky.length === 0) throw new Error(`Bankový výpis ${id} nemá žiadne pohyby`);
  const dateStatement = isoDate(extracted.datumVystavenia);
  if (!dateStatement) throw new Error(`Bankový výpis ${id} nemá platný dátum výpisu (očakáva sa RRRR-MM-DD)`);
  const cisloVypisu = clamp(extracted.cisloVypisu, 10);
  const headerAccounting = codeLists.predkontacie.get(snapshot.ucto.predkontaciaId ?? '');
  const centre = codeLists.strediska.get(snapshot.ucto.strediskoId ?? '');

  return polozky.map((pohyb: any, index: number) => {
    // Bez `?? 0`: pohyb bez sumy by sa v POHODE objavil ako príjem 0,00 —
    // chýbajúca suma musí export zastaviť, nie prekĺznuť.
    const suma = Number(pohyb.sumaSpolu);
    if (!Number.isFinite(suma)) throw new Error(`Pohyb ${index + 1} výpisu ${id} nemá platnú sumu`);
    // Nastavená, ale nerozpoznaná predkontácia pohybu je chyba — tichý pád na
    // hlavičkovú by zaúčtoval pohyb inam, než účtovník schválil (napr. po
    // resynchronizácii číselníka, ktorá predkontáciu deaktivovala).
    const vlastnaId = pohyb.ucto?.predkontaciaId;
    const vlastna = vlastnaId ? codeLists.predkontacie.get(vlastnaId) : undefined;
    if (vlastnaId && !vlastna) throw new Error(`Pohyb ${index + 1} výpisu ${id} má predkontáciu mimo aktívneho číselníka organizácie`);
    const accounting = vlastna ?? headerAccounting;
    if (!accounting) throw new Error(`Pohyb ${index + 1} výpisu ${id} nemá predkontáciu`);
    const itemCentre = codeLists.strediska.get(pohyb.ucto?.strediskoId ?? '') ?? centre;
    const datePayment = isoDate(pohyb.datumPlatby) ?? dateStatement;
    const paymentAccount = skIbanAccount(pohyb.protiucetIban);
    const text = clamp(pohyb.popis || pohyb.protistrana || 'Bankový pohyb', 96);
    const vs = clamp(pohyb.vs, 20).replace(/\D/g, '');
    const lines = [
      `        <bnk:bankType>${suma < 0 ? 'expense' : 'receipt'}</bnk:bankType>`,
      `        <bnk:account><typ:ids>${escapeXml(ucet)}</typ:ids></bnk:account>`,
      // Číslo výpisu + poradie pohybu — POHODA z nich skladá evidenčné číslo.
      ...(cisloVypisu ? [`        <bnk:statementNumber><bnk:statementNumber>${escapeXml(cisloVypisu)}</bnk:statementNumber><bnk:numberMovement>${index + 1}</bnk:numberMovement></bnk:statementNumber>`] : []),
      ...(vs ? [`        <bnk:symVar>${escapeXml(vs)}</bnk:symVar>`] : []),
      `        <bnk:dateStatement>${dateStatement}</bnk:dateStatement>`,
      `        <bnk:datePayment>${datePayment}</bnk:datePayment>`,
      `        <bnk:accounting><typ:ids>${escapeXml(accounting)}</typ:ids></bnk:accounting>`,
      `        <bnk:text>${escapeXml(text)}</bnk:text>`,
      ...(pohyb.protistrana ? [`        <bnk:partnerIdentity><typ:address><typ:company>${escapeXml(clamp(pohyb.protistrana, 255))}</typ:company></typ:address></bnk:partnerIdentity>`] : []),
      ...(paymentAccount ? [`        <bnk:paymentAccount><typ:accountNo>${escapeXml(paymentAccount.accountNo)}</typ:accountNo><typ:bankCode>${escapeXml(paymentAccount.bankCode)}</typ:bankCode></bnk:paymentAccount>`] : []),
      ...(pohyb.ks ? [`        <bnk:symConst>${escapeXml(clamp(pohyb.ks, 4))}</bnk:symConst>`] : []),
      ...(pohyb.ss ? [`        <bnk:symSpec>${escapeXml(clamp(pohyb.ss, 16))}</bnk:symSpec>`] : []),
      ...(itemCentre ? [`        <bnk:centre><typ:ids>${escapeXml(itemCentre)}</typ:ids></bnk:centre>`] : []),
      ...(snapshot.ucto.poznamka ? [`        <bnk:note>${escapeXml(clamp(snapshot.ucto.poznamka, 240))}</bnk:note>`] : []),
    ];
    return `  <dat:dataPackItem id="${escapeXml(`${id}-p${index + 1}`)}" version="2.0">
    <bnk:bank version="2.0">
      <bnk:bankHeader>
${lines.join('\n')}
      </bnk:bankHeader>
      <bnk:bankSummary><bnk:homeCurrency>
        <typ:priceNone>${amount(Math.abs(suma))}</typ:priceNone>
      </bnk:homeCurrency></bnk:bankSummary>
    </bnk:bank>
  </dat:dataPackItem>`;
  }).join('\n');
}

export function buildServerDataPack(input: {
  id: string;
  ico: string;
  documents: PohodaXmlDocument[];
  codeLists: PohodaCodeLookup;
}): string {
  if (!/^\d{8}$/.test(input.ico)) throw new Error('IČO účtovnej jednotky je neplatné');
  const items = input.documents.map(({ id, snapshot }) => {
    // Bankový výpis nemá číselný rad ani členenie DPH — vetví sa pred spoločnou
    // kontrolou číselníkov nižšie.
    if (snapshot.typ === 'BV') return bankDataPackItems(id, snapshot, input.codeLists);
    const extracted = snapshot.extracted;
    const supplier = extracted.dodavatel ?? {};
    const accounting = input.codeLists.predkontacie.get(snapshot.ucto.predkontaciaId ?? '');
    const classificationVat = input.codeLists.cleneniaDph.get(snapshot.ucto.clenenieDphId ?? '');
    // typ:ids = prefix číselnej rady, z ktorej POHODA pridelí ďalšie voľné číslo.
    // typ:numberRequested je naopak konkrétne ČÍSLO dokladu „bez väzby na číselnú
    // radu" — posielať doň prefix znamenalo žiadať pre každý doklad to isté číslo,
    // takže druhý a každý ďalší export skončil hláškou „Doklad so zadaným číslom
    // už existuje" a doklad sa v POHODE vôbec nezaložil.
    const numberSeries = input.codeLists.ciselneRady.get(snapshot.ucto.ciselnyRadId ?? '');
    // Účtovník smie číslo dokladu prepísať (pole v páse „Doklad bude zaúčtovaný…").
    // Prázdne = číslo pridelí POHODA z radu.
    //
    // POZOR na poradie priorít POHODY: numberRequested je podľa type.xsd „číslo
    // dokladu BEZ väzby na číselnú radu" a rada (ids) ho prebíja. Keď sme
    // posielali oboje, POHODA odpovedala „Hodnota prvku musela byť upravená" a
    // doklad dostal číslo zo svojho počítadla (2607000001) namiesto čísla
    // faktúry. Vlastné číslo preto posielame SAMOSTATNE, bez rady.
    //
    // checkDuplicity ostáva na predvolenom true: obsadené číslo znamená, že ten
    // istý doklad už v POHODE je, a to má účtovník vidieť — nie dostať potichu
    // druhý doklad s posunutým číslom.
    const cisloVPohode = clamp(snapshot.ucto.cisloVPohode, 32);
    const numberXml = cisloVPohode
      ? `<typ:numberRequested>${escapeXml(cisloVPohode)}</typ:numberRequested>`
      : `<typ:ids>${escapeXml(numberSeries ?? '')}</typ:ids>`;
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
    // Sadzba, ktorú slovenská POHODA nepozná (rakúskych 20 %, českých 21 %), je
    // cudzia daň: nie je čo odpočítať, do priznania nevstúpi a rozdeliť ju na
    // základ a DPH nemá kam. Ide preto CELÁ do priceNone — bez toho by z
    // rakúskej faktúry vypadla úplne a doklad by prišiel do POHODY nulový.
    const cudziaDan = rows.filter((row: any) => ![23, 19, 5, 0].includes(Number(row.sadzba)));
    const base0 = rows.filter((row: any) => Number(row.sadzba) === 0).reduce((sum: number, row: any) => sum + Number(row.zaklad || 0), 0)
      + cudziaDan.reduce((sum: number, row: any) => sum + Number(row.zaklad || 0) + Number(row.dph || 0), 0);
    const currency = `<typ:priceHigh>${amount(base23)}</typ:priceHigh>
        <typ:priceHighVAT>${amount(vat23)}</typ:priceHighVAT>
        <typ:priceLow>${amount(base19)}</typ:priceLow>
        <typ:priceLowVAT>${amount(vat19)}</typ:priceLowVAT>
        <typ:price3>${amount(base5)}</typ:price3>
        <typ:price3VAT>${amount(vat5)}</typ:price3VAT>
        <typ:priceNone>${amount(base0)}</typ:priceNone>`;
    // POHODA má na doklade JEDNU stranu partnera a je to vždy protistrana:
    // na prijatých dokladoch dodávateľ, na VYDANEJ faktúre odberateľ (zákazník).
    // Bez tohto rozlíšenia by vydaná faktúra prišla do POHODY vystavená na
    // vlastnú firmu — partnerIdentity je v invoice.xsd „adresa zákazníka".
    const vydana = snapshot.typ === 'FV';
    const protistrana = vydana ? (extracted.odberatel ?? {}) : supplier;
    const partner = partnerAddressXml(protistrana);
    // Dátum vystavenia je povinný — bez neho sa doklad odmietne hneď pri vytvorení
    // prenosu s jasnou hláškou, nie až XSD chybou agenta o hodinu neskôr.
    const issueDate = isoDate(extracted.datumVystavenia);
    if (!issueDate) throw new Error(`Doklad ${id} nemá platný dátum vystavenia (očakáva sa RRRR-MM-DD)`);
    const deliveryDate = isoDate(extracted.datumDodania);
    const taxDate = deliveryDate ?? issueDate;
    const dueDate = isoDate(extracted.datumSplatnosti) ?? issueDate;
    // Analytické dimenzie hlavičky. Editor ich ponúka pri každom doklade, do
    // POHODY sa však doteraz posielali len z položiek — hlavičkové sa zahadzovali.
    const centre = input.codeLists.strediska.get(snapshot.ucto.strediskoId ?? '');
    const activity = input.codeLists.cinnosti?.get(snapshot.ucto.cinnostId ?? '');
    const contract = input.codeLists.zakazky?.get(snapshot.ucto.zakazkaId ?? '');
    const headerDims = { centre, activity, contract };
    // Poradie centre → activity → contract je dané sekvenciou v XSD.
    const dimensionsXml = (ns: string) => [
      centre ? `<${ns}:centre><typ:ids>${escapeXml(centre)}</typ:ids></${ns}:centre>` : '',
      activity ? `<${ns}:activity><typ:ids>${escapeXml(activity)}</typ:ids></${ns}:activity>` : '',
      contract ? `<${ns}:contract><typ:ids>${escapeXml(contract)}</typ:ids></${ns}:contract>` : '',
    ].filter(Boolean).join('\n        ');
    // Text zápisu si píše účtovník v karte „Text dokladu"; keď ho nechá prázdny,
    // POHODA dostane názov predkontácie a až potom číslo dokladu.
    const documentText = String(extracted.textPolozky ?? '').trim();
    // Záložka „Dokumenty": kým doklad nemá určenú podzložku, POHODA píše
    // „Priečinok nie je definovaný" a Mostík nemá kam sken uložiť. Cestu preto
    // určíme sami — <Dokumenty firmy>\<agenda>\<rada>\<doklad> — a to pre KAŽDÚ
    // agendu, nielen pre faktúry. Predtým sa skladala len z vlastného čísla
    // dokladu, a to má z celého importu jedine vydaná faktúra: prijaté faktúry,
    // ostatné záväzky, pokladňa aj interné doklady tak ostali bez PDF.
    //
    // Číslo od POHODY v tejto chvíli ešte neexistuje (prideľuje ho až pri
    // importe z číselného radu), takže meno priečinka nesie začiatok id dokladu.
    // Číslo od dodávateľa by sa nedalo použiť: nie je jedinečné — dvaja
    // dodávatelia pokojne pošlú faktúru „1" a druhý sken by sa do spoločného
    // priečinka už nezapísal (agent rovnaké meno súboru preskočí).
    const podzlozka = AGENDA_PRIECINOK[snapshot.typ]
      ? `${AGENDA_PRIECINOK[snapshot.typ]}\\${numberSeries}\\${bezpecnaCast(cisloVPohode) || id.slice(0, 12)}`
      : '';
    const dokumentyXml = (ns: string) => (podzlozka
      ? `
      <${ns}:attachments><typ:files><typ:subFolder>${escapeXml(clamp(podzlozka, 255))}</typ:subFolder></typ:files></${ns}:attachments>`
      : '');
    if (snapshot.typ === 'PD') {
      const cashAccount = snapshot.ucto.pokladnaKod;
      const voucherType = snapshot.ucto.pokladnaTyp;
      if (!cashAccount || !['receipt', 'expense'].includes(voucherType ?? '')) throw new Error(`Pokladničný doklad ${id} nemá nastavený kód a typ pokladničného dokladu POHODA`);
      return `  <dat:dataPackItem id="${escapeXml(id)}" version="2.0">
    <vch:voucher version="2.0">
      <vch:voucherHeader>
        <vch:voucherType>${escapeXml(voucherType)}</vch:voucherType>
        <vch:cashAccount><typ:ids>${escapeXml(cashAccount)}</typ:ids></vch:cashAccount>
        <vch:number>${numberXml}</vch:number>
        <vch:originalDocument>${escapeXml(clamp(extracted.cisloFaktury, 32))}</vch:originalDocument>
        <vch:date>${issueDate}</vch:date>
        <vch:dateTax>${taxDate}</vch:dateTax>
        <vch:accounting><typ:ids>${escapeXml(accounting)}</typ:ids></vch:accounting>
        <vch:classificationVAT><typ:ids>${escapeXml(classificationVat)}</typ:ids></vch:classificationVAT>
        ${snapshot.ucto.clenenieKvKod ? `<vch:classificationKVDPH><typ:ids>${escapeXml(snapshot.ucto.clenenieKvKod)}</typ:ids></vch:classificationKVDPH>` : ''}
        <vch:text>${escapeXml(clamp(documentText || extracted.cisloFaktury || 'Pokladničný doklad', 240))}</vch:text>
        <vch:partnerIdentity>${partner}</vch:partnerIdentity>
        ${extracted.variabilnySymbol ? `<vch:symPar>${escapeXml(clamp(extracted.variabilnySymbol, 20))}</vch:symPar>` : ''}
        ${dimensionsXml('vch')}
        ${snapshot.ucto.poznamka ? `<vch:note>${escapeXml(clamp(snapshot.ucto.poznamka, 240))}</vch:note>` : ''}
      </vch:voucherHeader>${documentDetailXml(extracted.polozky, { accounting, classificationVat, kv: snapshot.ucto.clenenieKvKod, ...headerDims }, input.codeLists, DETAIL_TAGS.voucher)}
      <vch:voucherSummary><vch:homeCurrency>
        ${currency}
      </vch:homeCurrency></vch:voucherSummary>${dokumentyXml('vch')}
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
        <int:number>${numberXml}</int:number>
        <int:date>${issueDate}</int:date>
        <int:accounting><typ:ids>${escapeXml(accounting)}</typ:ids></int:accounting>
        <int:classificationVAT><typ:ids>${escapeXml(classificationVat)}</typ:ids></int:classificationVAT>
        ${snapshot.ucto.clenenieKvKod ? `<int:classificationKVDPH><typ:ids>${escapeXml(snapshot.ucto.clenenieKvKod)}</typ:ids></int:classificationKVDPH>` : ''}
        <int:text>${escapeXml(clamp(documentText || `Mzdová páska ${extracted.cisloFaktury || extracted.datumVystavenia}`, 240))}</int:text>
        <int:partnerIdentity>${partner}</int:partnerIdentity>
        ${dimensionsXml('int')}
        ${snapshot.ucto.poznamka ? `<int:note>${escapeXml(clamp(snapshot.ucto.poznamka, 240))}</int:note>` : ''}
      </int:intDocHeader>${documentDetailXml(extracted.polozky, { accounting, classificationVat, kv: snapshot.ucto.clenenieKvKod, ...headerDims }, input.codeLists, DETAIL_TAGS.intDoc)}
      <int:intDocSummary><int:homeCurrency>
        ${mzdyCurrency}
      </int:homeCurrency></int:intDocSummary>${dokumentyXml('int')}
    </int:intDoc>
  </dat:dataPackItem>`;
    }
    // Záväzok (FP/OZ) nesie <inv:paymentAccount> = účet, na ktorý zaplatíme
    // dodávateľovi. Pohľadávka (FV) má vlastné pole <inv:account> = účet, na
    // ktorý má zaplatiť zákazník — berie sa zo skratky číselníka bankových účtov.
    const paymentAccount = vydana ? undefined : skIbanAccount(supplier.iban);
    const vlastnyUcet = vydana ? clamp(snapshot.ucto.bankUcetKod, 19) : '';
    const formaUhrady = vydana ? clamp(snapshot.ucto.formaUhrady, 20) : '';
    // Text dokladu = názov vybranej predkontácie (účtovník ho vidí v POHODE
    // namiesto predvoleného „Import FA z XML"); fallback na číslo faktúry.
    const headerText = documentText
      || input.codeLists.predkontacieNazvy?.get(snapshot.ucto.predkontaciaId ?? '')
      || extracted.cisloFaktury
      || '';
    return `  <dat:dataPackItem id="${escapeXml(id)}" version="2.0">
    <inv:invoice version="2.0">
      <inv:invoiceHeader>
        <inv:invoiceType>${invoiceType(snapshot.typ, snapshot.podtyp)}</inv:invoiceType>
        <inv:number>${numberXml}</inv:number>
        <inv:symVar>${escapeXml(clamp((extracted.variabilnySymbol ?? '').trim() || (extracted.cisloFaktury ?? '').replace(/\D/g, ''), 20))}</inv:symVar>
        ${snapshot.typ !== 'FV' && extracted.cisloFaktury ? `<inv:originalDocument>${escapeXml(clamp(extracted.cisloFaktury, 32))}</inv:originalDocument>` : ''}
        <inv:date>${issueDate}</inv:date>
        <inv:dateTax>${taxDate}</inv:dateTax>
        <inv:dateDue>${dueDate}</inv:dateDue>
        ${deliveryDate && !vydana ? `<inv:dateDelivery>${deliveryDate}</inv:dateDelivery>` : ''}
        <inv:accounting><typ:ids>${escapeXml(accounting)}</typ:ids></inv:accounting>
        <inv:classificationVAT><typ:ids>${escapeXml(classificationVat)}</typ:ids></inv:classificationVAT>
        ${snapshot.ucto.clenenieKvKod ? `<inv:classificationKVDPH><typ:ids>${escapeXml(snapshot.ucto.clenenieKvKod)}</typ:ids></inv:classificationKVDPH>` : ''}
        ${headerText ? `<inv:text>${escapeXml(clamp(headerText, 240))}</inv:text>` : ''}
        <inv:partnerIdentity>${partner}</inv:partnerIdentity>
        ${extracted.cisloObjednavky ? `<inv:numberOrder>${escapeXml(clamp(extracted.cisloObjednavky, 32))}</inv:numberOrder>` : ''}
        ${formaUhrady ? `<inv:paymentType><typ:paymentType>${escapeXml(formaUhrady)}</typ:paymentType></inv:paymentType>` : ''}
        ${vlastnyUcet ? `<inv:account><typ:ids>${escapeXml(vlastnyUcet)}</typ:ids></inv:account>` : ''}
        ${extracted.konstantnySymbol ? `<inv:symConst>${escapeXml(clamp(extracted.konstantnySymbol, 4))}</inv:symConst>` : ''}
        ${extracted.specifickySymbol && !vydana ? `<inv:symSpec>${escapeXml(clamp(extracted.specifickySymbol, 16))}</inv:symSpec>` : ''}
        ${paymentAccount ? `<inv:paymentAccount><typ:accountNo>${escapeXml(paymentAccount.accountNo)}</typ:accountNo><typ:bankCode>${escapeXml(paymentAccount.bankCode)}</typ:bankCode></inv:paymentAccount>` : ''}
        ${dimensionsXml('inv')}
        ${snapshot.ucto.poznamka ? `<inv:note>${escapeXml(clamp(snapshot.ucto.poznamka, 240))}</inv:note>` : ''}
      </inv:invoiceHeader>${documentDetailXml(extracted.polozky, { accounting, classificationVat, kv: snapshot.ucto.clenenieKvKod, ...headerDims }, input.codeLists, DETAIL_TAGS.invoice)}
      <inv:invoiceSummary><inv:homeCurrency>
        ${currency}
      </inv:homeCurrency></inv:invoiceSummary>${dokumentyXml('inv')}
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
  xmlns:bnk="http://www.stormware.cz/schema/version_2/bank.xsd"
  xmlns:typ="http://www.stormware.cz/schema/version_2/type.xsd">
${items}
</dat:dataPack>`;
}

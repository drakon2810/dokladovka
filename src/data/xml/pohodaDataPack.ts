// Generovanie XML POHODA dataPack — SPEC §7. Produkčný agent vykoná fail-closed XSD validáciu.
import type { CodeListItem, DocumentItem, DocumentLineItem, Organization, VatBreakdownRow } from '../types';
import { slugifyOrganizationName } from '../alias/aliasGenerator';
import { lineItemEffective, round2 } from '../../lib/validate';

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

/**
 * Skráti hodnotu na limit oficiálnej XSD schémy POHODY a zlúči biele znaky.
 * Text položky z faktúry býva viacriadkový a dlhší než 90 znakov — bez orezania
 * XSD validácia zhodí CELÝ dataPack vrátane bezchybných dokladov v dávke.
 * Musí zostať v zhode s clamp v server/pohodaXml.ts.
 */
function clamp(value: unknown, maxLength: number): string {
  return String(value ?? '').replace(/\s+/g, ' ').trim().slice(0, maxLength);
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

export function splitPostalAddress(value: string | undefined): { street?: string; city?: string; zip?: string; country?: string } {
  const parts = (value ?? '')
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

export interface SupplierAddress {
  ulica?: string;
  psc?: string;
  obec?: string;
  krajina?: string;
}

/**
 * Adresa dodávateľa po častiach. Ručne vyplnené polia majú prednosť; kým sú
 * undefined, odvodí sa ulica/PSČ/obec z voľnej `adresa` a krajina z IČ DPH
 * (a keď je prázdne, z DIČ — extrakcia zahraničný daňový identifikátor
 * DE813960018 často uloží do DIČ). Prázdny reťazec je vedomé vymazanie, preto
 * `??` a nie `||`. Musí zostať v zhode so server/pohodaXml.ts.
 */
export function supplierAddressParts(
  supplier: SupplierAddress & { dic?: string; icDph?: string; adresa?: string },
): SupplierAddress {
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

/** Riadky typ:address partnera — prázdne prvky sa vynechávajú. */
function partnerAddressLines(
  supplier: SupplierAddress & { nazov: string; ico?: string; dic?: string; icDph?: string; adresa?: string },
  indent: string,
): string[] {
  const address = supplierAddressParts(supplier);
  const lines = [`${indent}<typ:company>${escapeXml(clamp(supplier.nazov, 255))}</typ:company>`];
  if (address.obec) lines.push(`${indent}<typ:city>${escapeXml(address.obec)}</typ:city>`);
  if (address.ulica) lines.push(`${indent}<typ:street>${escapeXml(address.ulica)}</typ:street>`);
  if (address.psc) lines.push(`${indent}<typ:zip>${escapeXml(address.psc)}</typ:zip>`);
  if (supplier.ico) lines.push(`${indent}<typ:ico>${escapeXml(supplier.ico)}</typ:ico>`);
  if (supplier.dic) lines.push(`${indent}<typ:dic>${escapeXml(supplier.dic)}</typ:dic>`);
  if (supplier.icDph) lines.push(`${indent}<typ:icDph>${escapeXml(supplier.icDph.replace(/\s+/g, ''))}</typ:icDph>`);
  // Krajina sa vypĺňa vždy (aj tuzemsko SK) — POHODA ju pri importe páruje na číselník krajín.
  if (address.krajina) lines.push(`${indent}<typ:country><typ:ids>${escapeXml(address.krajina)}</typ:ids></typ:country>`);
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
  zakladHigh: number;
  dphHigh: number;
  zakladLow: number;
  dphLow: number;
  zakladThird: number;
  dphThird: number;
  zakladNone: number;
}

/**
 * Slovenské sadzby DPH podľa dátumu zdaniteľného plnenia. Zhoda so
 * SK_SADZBY_DPH v server/pohodaXml.ts — tam je zdôvodnenie aj to, prečo sa
 * neposiela percentVAT.
 */
const SK_SADZBY_DPH: ReadonlyArray<{ od: string; high: number; low: number; third?: number }> = [
  { od: '2025-01-01', high: 23, low: 19, third: 5 },
  { od: '2023-01-01', high: 20, low: 10, third: 5 },
  { od: '2011-01-01', high: 20, low: 10 },
];

/**
 * Dodávateľ účtujúci VLASTNÚ, nie slovenskú daň. Zhoda s jeCudziDodavatel
 * v server/services/dphAdvisor.ts, podľa ktorého sa rozhoduje aj na serveri.
 */
function jeCudziDodavatel(dodavatel: { icDph?: string; krajina?: string }): boolean {
  const krajina = (dodavatel.krajina ?? '').trim().toUpperCase();
  const prefix = (dodavatel.icDph ?? '').replace(/\s+/g, '').toUpperCase().slice(0, 2);
  return krajina !== '' && krajina !== 'SK' && prefix !== 'SK';
}

/**
 * Sadzba DPH → POHODA rateVAT pre deň plnenia; bez dátumu platia súčasné
 * sadzby. „none" je nulová sadzba, cudzia daň aj sadzba, ktorú Slovensko v ten
 * deň nemalo. Zhoda so server/pohodaXml.ts.
 */
function vatRateName(sadzba: number | undefined, datum?: string, cudzia = false): 'high' | 'low' | 'third' | 'none' {
  const obdobie = SK_SADZBY_DPH.find((riadok) => !datum || riadok.od <= datum);
  if (cudzia || !obdobie || !sadzba) return 'none';
  if (sadzba === obdobie.high) return 'high';
  if (sadzba === obdobie.low) return 'low';
  if (sadzba === obdobie.third) return 'third';
  return 'none';
}

export function summarizeVat(rows: VatBreakdownRow[], datum?: string, cudzia = false): VatTotals {
  const t: VatTotals = { zakladHigh: 0, dphHigh: 0, zakladLow: 0, dphLow: 0, zakladThird: 0, dphThird: 0, zakladNone: 0 };
  for (const row of rows) {
    const sadzba = vatRateName(row.sadzba, datum, cudzia);
    if (sadzba === 'high') {
      t.zakladHigh += row.zaklad;
      t.dphHigh += row.dph;
    } else if (sadzba === 'low') {
      t.zakladLow += row.zaklad;
      t.dphLow += row.dph;
    } else if (sadzba === 'third') {
      t.zakladThird += row.zaklad;
      t.dphThird += row.dph;
    } else {
      // Cudzia daň (rakúskych 20 %, českých 21 %) a sadzba, ktorú Slovensko
      // v deň plnenia nemalo — POHODA ju nemá kam zaradiť a odpočítať sa nedá,
      // preto ide do nezdaniteľnej sumy CELÁ. Pri sadzbe 0 je dph nula.
      t.zakladNone += row.zaklad + row.dph;
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

/**
 * Riadky <inv:invoiceDetail> z položiek dokladu. Zaúčtovanie, členenie DPH aj
 * členenie KV položky s návratom na hlavičku — rovnako ako server
 * (server/pohodaXml.ts). Prázdne pole = bez rozpisu.
 */
function invoiceDetailLines(
  polozky: DocumentLineItem[] | undefined,
  kodOf: (list: CodeListItem[], id: string | undefined) => string | undefined,
  codeLists: DataPackCodeLists,
  header: { docId: string; accounting?: string; clenenie?: string; kv?: string; datum?: string; cudzia: boolean },
): string[] {
  if (!polozky || polozky.length === 0) return [];
  const lines = ['      <inv:invoiceDetail>'];
  for (const [index, item] of polozky.entries()) {
    const eff = lineItemEffective(item);
    const sadzba = vatRateName(item.sadzbaDph, header.datum, header.cudzia);
    // Cudzia daň sa do POHODY ako DPH poslať nedá (rateVAT „none") — celá suma
    // preto ide do ceny bez dane, rovnako ako v súhrne dokladu a na serveri.
    const cudziaDan = sadzba === 'none' && (eff.dph ?? 0) !== 0;
    // Vyplnené ID mimo aktívneho číselníka nie je „ako doklad" — tichý návrat na
    // hlavičku by zaúčtoval položku inak, než ju účtovník schválil. Zhoda so
    // server/pohodaXml.ts.
    const kodPolozky = (list: CodeListItem[], id: string | undefined, nazov: string): string | undefined => {
      if (!id) return undefined;
      const kod = kodOf(list, id);
      if (!kod) throw new Error(`Položka ${index + 1} dokladu ${header.docId} má ${nazov} mimo aktívneho číselníka organizácie`);
      return kod;
    };
    const mnozstvo = Number(item.mnozstvo) || 1;
    // Položka, ktorá nesie LEN celkovú sumu (pokuta — ani sadzba, ani základ),
    // mala základ 0 a do POHODY odišla za 0,00 €: POHODA počíta cenu položky
    // z price + priceVAT, priceSum je len kontrolný súčet. Rovnaký dopočet
    // robí server (lineItemAmounts v server/pohodaXml.ts) — tento export nesmie
    // poslať iné čísla ako ten.
    const zaklad = eff.bezDph ?? round2((eff.spolu ?? 0) - (eff.dph ?? 0));
    const bezDph = cudziaDan ? (eff.spolu ?? 0) : zaklad;
    const unitPrice = cudziaDan
      ? Math.round(((eff.spolu ?? 0) / mnozstvo) * 100) / 100
      : item.jednotkovaCenaBezDph ?? bezDph;
    const accounting = kodPolozky(codeLists.predkontacie, item.ucto?.predkontaciaId, 'predkontáciu') ?? header.accounting;
    const clenenie = kodPolozky(codeLists.cleneniaDph, item.ucto?.clenenieDphId, 'členenie DPH') ?? header.clenenie;
    const centre = kodPolozky(codeLists.strediska ?? [], item.ucto?.strediskoId, 'stredisko');
    lines.push('        <inv:invoiceItem>');
    lines.push(`          <inv:text>${escapeXml(clamp(item.popis, 90))}</inv:text>`);
    lines.push(`          <inv:quantity>${escapeXml(String(item.mnozstvo ?? 1))}</inv:quantity>`);
    if (item.jednotka) lines.push(`          <inv:unit>${escapeXml(clamp(item.jednotka, 10))}</inv:unit>`);
    lines.push('          <inv:coefficient>1.0</inv:coefficient>');
    lines.push('          <inv:payVAT>false</inv:payVAT>');
    lines.push(`          <inv:rateVAT>${sadzba}</inv:rateVAT>`);
    // Rovnako ako server (pohodaXml.ts): zľava ide s cenou pred zľavou, pri cudzej dani nie.
    const zlava = !cudziaDan && (item.zlavaPercent ?? 0) > 0 ? item.zlavaPercent : 0;
    lines.push(`          <inv:discountPercentage>${zlava ? String(zlava) : '0.0'}</inv:discountPercentage>`);
    lines.push('          <inv:homeCurrency>');
    lines.push(`            <typ:unitPrice>${formatXmlAmount(unitPrice)}</typ:unitPrice>`);
    lines.push(`            <typ:price>${formatXmlAmount(bezDph)}</typ:price>`);
    lines.push(`            <typ:priceVAT>${formatXmlAmount(cudziaDan ? 0 : eff.dph ?? 0)}</typ:priceVAT>`);
    lines.push(`            <typ:priceSum>${formatXmlAmount(eff.spolu ?? bezDph)}</typ:priceSum>`);
    lines.push('          </inv:homeCurrency>');
    if (accounting) lines.push(`          <inv:accounting><typ:ids>${escapeXml(accounting)}</typ:ids></inv:accounting>`);
    if (clenenie) lines.push(`          <inv:classificationVAT><typ:ids>${escapeXml(clenenie)}</typ:ids></inv:classificationVAT>`);
    const kv = item.ucto?.clenenieKvKod || header.kv;
    if (kv) lines.push(`          <inv:classificationKVDPH><typ:ids>${escapeXml(kv)}</typ:ids></inv:classificationKVDPH>`);
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
      // Kôš DPH podľa dátumu plnenia; cudzia daň podľa dodávateľa (vydaná faktúra
      // nesie vždy našu, slovenskú daň). Zhoda so server/pohodaXml.ts.
      const datumPlnenia = doc.extracted.datumDodania ?? doc.extracted.datumVystavenia;
      const cudzia = doc.typ !== 'FV' && jeCudziDodavatel(doc.extracted.dodavatel);
      const vat = summarizeVat(doc.extracted.rozpisDph, datumPlnenia, cudzia);
      const predkontacia = kodOf(codeLists.predkontacie, doc.ucto.predkontaciaId);
      // Text dokladu = názov vybranej predkontácie (zhoda so server/pohodaXml.ts).
      const predkontaciaNazov = codeLists.predkontacie.find(
        (c) =>
          c.id === doc.ucto.predkontaciaId &&
          c.tenantId === doc.tenantId &&
          c.orgId === doc.orgId &&
          c.active,
      )?.nazov;
      const clenenie = kodOf(codeLists.cleneniaDph, doc.ucto.clenenieDphId);
      const rad = kodOf(codeLists.ciselneRady, doc.ucto.ciselnyRadId);
      if (!rad) {
        throw new Error(
          `Doklad ${doc.id} nemá vybraný aktívny číselný rad pre export do POHODY`,
        );
      }
      // Číslo, s ktorým doklad vznikne v POHODE: čo prepísal účtovník, inak mock
      // číslovanie v rade (v ostrom exporte prideľuje číslo POHODA z radu).
      const numberRequested = doc.ucto.cisloVPohode?.trim() || `${rad}${String(index + 1).padStart(4, '0')}`;
      const d = doc.extracted;
      const currencyLines = [
        `          <typ:priceHigh>${formatXmlAmount(vat.zakladHigh)}</typ:priceHigh>`,
        `          <typ:priceHighVAT>${formatXmlAmount(vat.dphHigh)}</typ:priceHighVAT>`,
        `          <typ:priceLow>${formatXmlAmount(vat.zakladLow)}</typ:priceLow>`,
        `          <typ:priceLowVAT>${formatXmlAmount(vat.dphLow)}</typ:priceLowVAT>`,
        `          <typ:price3>${formatXmlAmount(vat.zakladThird)}</typ:price3>`,
        `          <typ:price3VAT>${formatXmlAmount(vat.dphThird)}</typ:price3VAT>`,
        `          <typ:priceNone>${formatXmlAmount(vat.zakladNone)}</typ:priceNone>`,
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
          `        <vch:text>${escapeXml(clamp(d.textPolozky ?? `Pokladničný doklad ${d.cisloFaktury}`, 240))}</vch:text>`,
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
      lines.push(`        <inv:text>${escapeXml(clamp(predkontaciaNazov ?? d.textPolozky ?? `Faktúra ${d.cisloFaktury}`, 240))}</inv:text>`);
      // Partner dokladu je vždy PROTISTRANA: na prijatých dokladoch dodávateľ,
      // na vydanej faktúre odberateľ. Zhoda so server/pohodaXml.ts.
      const vydana = doc.typ === 'FV';
      lines.push('        <inv:partnerIdentity>');
      lines.push('          <typ:address>');
      lines.push(...partnerAddressLines(vydana ? { ...d.odberatel, nazov: d.odberatel?.nazov ?? '' } : d.dodavatel, '            '));
      lines.push('          </typ:address>');
      lines.push('        </inv:partnerIdentity>');
      // paymentAccount je pole záväzku (kam zaplatíme dodávateľovi) — na
      // pohľadávke sa neposiela; tam ide účet zo skratky číselníka.
      if (!vydana && d.dodavatel.iban) {
        const account = skIbanAccount(d.dodavatel.iban);
        if (account) lines.push(`        <inv:paymentAccount><typ:accountNo>${escapeXml(account.accountNo)}</typ:accountNo><typ:bankCode>${escapeXml(account.bankCode)}</typ:bankCode></inv:paymentAccount>`);
      }
      lines.push('      </inv:invoiceHeader>');
      lines.push(...invoiceDetailLines(
        d.polozky,
        kodOf,
        codeLists,
        { docId: doc.id, accounting: predkontacia, clenenie, kv: doc.ucto.clenenieKvKod, datum: datumPlnenia, cudzia },
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

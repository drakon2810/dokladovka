import { XMLParser } from 'fast-xml-parser';
import { HttpError } from '../http.js';
import { platnyKvKod } from './accountingSuggestionService.js';
import type { HistoryRow } from './uctoHistoryService.js';

/**
 * Doklady s POLOŽKAMI z POHODY (listInvoice / listVoucher / listIntDoc) do
 * korpusu histórie.
 *
 * Načo to je: rozúčtovanie dokladu nie je vidieť nikde inde. Hlavička faktúry
 * Print-Office nesie „repre / PD / B2", v účtovnom denníku po nej ostanú štyri
 * proviozky s tým istým textom — a to, že vody a káva idú mimo priznania
 * (PN, KN), kým kancelárske potreby majú odpočet, je zapísané jedine
 * v položkách.
 *
 * Agent to sťahuje sám, tento parser je pre ručnú cestu: účtovník bez
 * nainštalovaného agenta si stiahne request, prežene ho v POHODE a odpoveď
 * nahrá. Riadky musia vyjsť ROVNAKÉ ako z agenta (PohodaXml.ParseHistoryRows)
 * — preto sa nedopĺňa suma ani sadzba, hoci ich položka nesie: tie dva parsery
 * by sa tým rozišli a korpus by mal dva rôzne tvary toho istého dokladu.
 * ponytail: keď agent raz začne posielať surové XML, tento parser ostane
 *   jediný a ten v C# sa zmaže.
 */

/** invoiceType → agenda korpusu. Zvyšok agendy FA sú ostatné záväzky. */
const AGENDA_FAKTURY: Record<string, string> = {
  receivedInvoice: 'FP', receivedCreditNotice: 'FP-D',
  receivedDebitNote: 'FP-T', receivedAdvanceInvoice: 'FP-Z',
  issuedInvoice: 'FV', issuedCreditNotice: 'FV-D',
  issuedDebitNote: 'FV-T', issuedAdvanceInvoice: 'FV-Z',
};

/** Doklad → (hlavička, detail, položka, agenda). Mená sú tie isté, aké export do POHODY zapisuje. */
const DOKLADY = {
  invoice: { header: 'invoiceHeader', detail: 'invoiceDetail', item: 'invoiceItem' },
  voucher: { header: 'voucherHeader', detail: 'voucherDetail', item: 'voucherItem' },
  intDoc: { header: 'intDocHeader', detail: 'intDocDetail', item: 'intDocItem' },
} as const;

type DruhDokladu = keyof typeof DOKLADY;

function asArray<T>(value: T | T[] | undefined): T[] {
  if (value === undefined || value === null) return [];
  return Array.isArray(value) ? value : [value];
}

function text(value: unknown): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value === 'object') {
    const inner = (value as Record<string, unknown>)['#text'];
    return inner === undefined ? undefined : String(inner).trim() || undefined;
  }
  return String(value).trim() || undefined;
}

/** typ:refType — kód je v „ids". */
function refIds(node: unknown): string | undefined {
  return node && typeof node === 'object' ? text((node as Record<string, unknown>).ids) : undefined;
}

function isoDate(value: unknown): string | undefined {
  const raw = text(value);
  return raw && /^\d{4}-\d{2}-\d{2}/.test(raw) ? raw.slice(0, 10) : undefined;
}

/**
 * Doklady kdekoľvek v odpovedi. POHODA ich balí do listInvoice / listVoucher /
 * listIntDoc, ale hĺbka sa medzi verziami líšila — hľadá sa preto podľa mena
 * uzla, nie podľa cesty.
 */
function najdiDoklady(node: unknown, found: Array<{ druh: DruhDokladu; doklad: Record<string, any> }> = []) {
  if (!node || typeof node !== 'object') return found;
  for (const [kluc, hodnota] of Object.entries(node as Record<string, unknown>)) {
    if (kluc in DOKLADY) {
      for (const doklad of asArray(hodnota as any)) {
        if (doklad && typeof doklad === 'object') found.push({ druh: kluc as DruhDokladu, doklad });
      }
      continue;
    }
    for (const dieta of asArray(hodnota as any)) najdiDoklady(dieta, found);
  }
  return found;
}

function agendaDokladu(druh: DruhDokladu, header: Record<string, any>): string {
  if (druh === 'voucher') return text(header.voucherType) === 'receipt' ? 'PPD' : 'VPD';
  if (druh === 'intDoc') return 'INT';
  return AGENDA_FAKTURY[text(header.invoiceType) ?? ''] ?? 'OZ';
}

export function parseHistoriaXml(xml: string): { rows: HistoryRow[]; warnings: string[] } {
  let root: Record<string, any>;
  try {
    root = new XMLParser({
      ignoreAttributes: false, attributeNamePrefix: '@_', removeNSPrefix: true, parseTagValue: false,
    }).parse(xml);
  } catch {
    throw new HttpError(400, 'historia_necitatelna', 'Súbor sa nedá prečítať ako XML.');
  }
  const pack = root.responsePack;
  if (!pack) throw new HttpError(400, 'historia_nie_je_odpoved', 'Súbor nie je odpoveďou z POHODY — chýba responsePack.');
  if (pack['@_state'] === 'error') {
    throw new HttpError(400, 'historia_chyba', `POHODA vrátila chybu: ${pack['@_note'] ?? 'bez popisu'}`);
  }

  const rows: HistoryRow[] = [];
  for (const { druh, doklad } of najdiDoklady(pack)) {
    const mena = DOKLADY[druh];
    const header = doklad[mena.header];
    if (!header || typeof header !== 'object') continue;
    const lineText = text(header.text);
    const predkontacia = refIds(header.accounting);
    const clenenieDph = refIds(header.classificationVAT);
    // Doklad bez textu alebo bez zaúčtovania korpusu nič nepovie.
    if (!lineText || (!predkontacia && !clenenieDph)) continue;
    const adresa = header.partnerIdentity?.address;
    const spolocne = {
      agenda: agendaDokladu(druh, header) as HistoryRow['agenda'],
      dokladCislo: text(header.number?.numberRequested) ?? text(header.number?.ids),
      datum: isoDate(header.date),
      supplierIco: text(adresa?.ico)?.replace(/\D/g, '') || undefined,
      supplierName: text(adresa?.company),
    };
    const kvHlavicky = platnyKvKod(refIds(header.classificationKVDPH));
    rows.push({
      ...spolocne, lineText, riadokIndex: 0,
      predkontaciaKod: predkontacia, clenenieDphKod: clenenieDph, clenenieKvKod: kvHlavicky,
    });

    // Položky s VLASTNÝM zaúčtovaním — tie, kde sa účtovník rozhodol inak než
    // na hlavičke. Text smie chýbať: na reálnom exporte ALPINY je bez textu 18
    // zo 68 rozúčtovaných položiek a je medzi nimi práve riadok „repre / PN /
    // KN". Vtedy sa berie text hlavičky, ktorý účtovník pri položke aj tak vidí.
    // Keď je doklad rozúčtovaný, berú sa VŠETKY jeho položky — aj tie, ktoré
    // zaúčtovanie dedia. Rozúčtovanie sa totiž číta z DVOJICE: „Natural 95
    // (daňová časť 80 %)" za 52,68 drží hlavičkové zaúčtovanie a do korpusu by
    // nepadla, takže by v ňom ostala len nedaňová časť za 13,17 a pomer by
    // z nej nikto nevyčítal. Pri nerozúčtovanom doklade sa nič nepridáva.
    const polozky = asArray(doklad[mena.detail]?.[mena.item])
      .filter((polozka: unknown): polozka is Record<string, unknown> => Boolean(polozka) && typeof polozka === 'object');
    const rozuctovany = polozky.some((polozka) => {
      const itemPredkontacia = refIds(polozka.accounting);
      const itemClenenie = refIds(polozka.classificationVAT);
      return (itemPredkontacia || itemClenenie)
        && !(itemPredkontacia === predkontacia && itemClenenie === clenenieDph);
    });
    let poradie = 0;
    for (const polozka of polozky) {
      poradie += 1;
      const itemPredkontacia = refIds(polozka.accounting);
      const itemClenenie = refIds(polozka.classificationVAT);
      // Položka, ktorá zaúčtovanie hlavičky iba zopakuje, sa berie vtedy, keď
      // má VLASTNÝ text. O zaúčtovaní síce nepovie nič nové, ale povie, ČO sa
      // kupovalo — a práve to hlavička zahmlieva: „Importné colné služby a
      // administratívne poplatky" v hlavičke proti „1 x Importabfertigung im
      // HZA-Wien" na položke. AGS účtuje prijaté faktúry na jeden účet, takže
      // rozúčtovaná je iba každá siedma — a text položiek sa doteraz stratil
      // pri zvyšných šiestich. Rozlíšiť pritom treba práve súrodenecké účty
      // služieb (preprava/colné/destinácia, tuzemsko/zahraničie, s § 69 aj bez)
      // a hlavička na to slová nemá.
      //
      // Bez vlastného textu by šlo o čistý duplikát hlavičky, ten sa preskočí.
      const vlastnyText = Boolean(text(polozka.text));
      if (!rozuctovany && !vlastnyText && !itemPredkontacia && !itemClenenie) continue;
      if (!rozuctovany && !vlastnyText
        && itemPredkontacia === predkontacia && itemClenenie === clenenieDph) continue;
      const ceny = polozka.homeCurrency as Record<string, unknown> | undefined;
      const suma = Number(text(ceny?.price) ?? Number.NaN);
      const sumaDph = Number(text(ceny?.priceVAT) ?? Number.NaN);
      rows.push({
        ...spolocne,
        lineText: text(polozka.text) ?? lineText,
        riadokIndex: poradie,
        // Bez súm sa pomer rozúčtovania nedá prečítať a krátenie dane (PHM 50 %)
        // z podielu základu vôbec nevyplýva.
        ...(Number.isFinite(suma) ? { suma } : {}),
        ...(Number.isFinite(sumaDph) ? { sumaDph } : {}),
        predkontaciaKod: itemPredkontacia ?? predkontacia,
        clenenieDphKod: itemClenenie ?? clenenieDph,
        clenenieKvKod: platnyKvKod(refIds(polozka.classificationKVDPH)) ?? kvHlavicky,
      });
    }
  }
  if (rows.length === 0) {
    throw new HttpError(400, 'historia_bez_dokladov', 'V súbore nie je ani jeden doklad so zaúčtovaním.');
  }
  const warnings = asArray(pack.responsePackItem)
    .filter((item: any) => item?.['@_state'] && item['@_state'] !== 'ok')
    .map((item: any) => String(item['@_note'] ?? 'POHODA nevrátila časť dokladov.'));
  return { rows, warnings };
}

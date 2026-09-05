import { randomUUID } from 'node:crypto';
import { XMLParser } from 'fast-xml-parser';
import type { Database, Queryable } from '../db/database.js';
import { HttpError } from '../http.js';

/**
 * Účtovný denník z POHODY. Na rozdiel od číselníka predkontácií nesie to, čo
 * účtovník naozaj urobil: každú proviozku s jej účtami MD/DAL a sumou.
 * Je to jediný zdroj, z ktorého sa dá zistiť, že doklad bol rozdelený —
 * v hlavičkovom korpuse po rozdelení nezostane ani stopa.
 */
export interface DennikRiadok {
  externalnyId: string;
  agenda: string;
  dokladCislo?: string;
  datum?: string;
  text?: string;
  suma?: number;
  ucetMd: string;
  ucetDal: string;
  partnerIco?: string;
  partnerNazov?: string;
  strediskoKod?: string;
  cinnostKod?: string;
  zakazkaKod?: string;
}

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

/** Referencia typu typ:refType — kód strediska, činnosti či zákazky je v „ids". */
function refIds(node: unknown): string | undefined {
  return node && typeof node === 'object' ? text((node as Record<string, unknown>).ids) : undefined;
}

function isoDate(value: string | undefined): string | undefined {
  return value && /^\d{4}-\d{2}-\d{2}/.test(value) ? value.slice(0, 10) : undefined;
}

/**
 * Rozloží odpoveď na listAccountancyRequest. Proviozka bez oboch účtov sa
 * preskočí — bez nich nenesie zaúčtovanie a v analýze by len šumela.
 */
export function parseDennik(xml: string): { riadky: DennikRiadok[]; preskocene: number } {
  let root: Record<string, any>;
  try {
    root = new XMLParser({
      ignoreAttributes: false,
      attributeNamePrefix: '@_',
      removeNSPrefix: true,
      parseTagValue: false,
      parseAttributeValue: false,
    }).parse(xml);
  } catch {
    throw new HttpError(400, 'dennik_necitatelny', 'Súbor sa nedá prečítať ako XML.');
  }
  const pack = root.responsePack;
  if (!pack) throw new HttpError(400, 'dennik_nie_je_odpoved', 'Súbor nie je odpoveďou z POHODY — chýba responsePack.');
  if (pack['@_state'] === 'error') {
    throw new HttpError(400, 'dennik_chyba', `POHODA vrátila chybu: ${pack['@_note'] ?? 'bez popisu'}`);
  }
  const polozky: any[] = [];
  for (const item of asArray(pack.responsePackItem)) {
    for (const zoznam of asArray(item.listAccountancy)) {
      for (const zaznam of asArray(zoznam.accountancy)) {
        polozky.push(...asArray(zaznam.accountingItem));
      }
    }
  }
  if (polozky.length === 0) {
    throw new HttpError(400, 'dennik_bez_proviozok', 'V súbore nie je ani jedna proviozka účtovného denníka.');
  }
  const riadky: DennikRiadok[] = [];
  let preskocene = 0;
  for (const item of polozky) {
    // POHODA má v accountancy.xsd credit = MD a debit = DAL — pomenovanie je
    // oproti angličtine prehodené, berie sa podľa dokumentácie schémy.
    const ucetMd = text(item.accounting?.credit);
    const ucetDal = text(item.accounting?.debit);
    const externalnyId = text(item.id);
    if (!externalnyId || !ucetMd || !ucetDal) { preskocene += 1; continue; }
    const adresa = item.address?.address;
    const suma = Number(text(item.homeCurrency?.priceSum) ?? Number.NaN);
    riadky.push({
      externalnyId,
      agenda: text(item.source) ?? 'neznáma',
      dokladCislo: text(item.number?.numberRequested) ?? text(item.number?.ids),
      datum: isoDate(text(item.date)),
      text: text(item.text),
      suma: Number.isFinite(suma) ? suma : undefined,
      ucetMd,
      ucetDal,
      partnerIco: text(adresa?.ico)?.replace(/\D/g, '') || undefined,
      partnerNazov: text(adresa?.company),
      strediskoKod: refIds(item.centre),
      cinnostKod: refIds(item.activity),
      zakazkaKod: refIds(item.contract),
    });
  }
  return { riadky, preskocene };
}

/**
 * Uloží denník a ku každej proviozke doplní kandidátov na predkontáciu podľa
 * dvojice účtov. Kandidáti sa NEVYNUCUJÚ na jedného: na reálnych dátach sadne
 * dvojica na práve jednu predkontáciu iba v 55 % proviozok.
 */
export async function ulozDennik(
  database: Database,
  input: { tenantId: string; organizationId: string; riadky: readonly DennikRiadok[] },
): Promise<{ ulozenych: number; sJednouPredkontaciou: number; sViacerymi: number; bezPredkontacie: number }> {
  const predkontacie = await database.query<{ code: string; ucet_md: string; ucet_dal: string } & Record<string, unknown>>(
    `SELECT code, ucet_md, ucet_dal FROM code_list_items
      WHERE tenant_id=$1 AND organization_id=$2 AND kind='predkontacie' AND active=true
        AND ucet_md IS NOT NULL AND ucet_dal IS NOT NULL`,
    [input.tenantId, input.organizationId],
  );
  const podlaUctov = new Map<string, string[]>();
  for (const row of predkontacie.rows) {
    const kluc = `${row.ucet_md.trim()}/${row.ucet_dal.trim()}`;
    if (!podlaUctov.has(kluc)) podlaUctov.set(kluc, []);
    podlaUctov.get(kluc)!.push(row.code);
  }
  let sJednou = 0;
  let sViacerymi = 0;
  let bez = 0;
  await database.transaction(async (tx: Queryable) => {
    for (const riadok of input.riadky) {
      const kandidati = podlaUctov.get(`${riadok.ucetMd}/${riadok.ucetDal}`) ?? [];
      if (kandidati.length === 1) sJednou += 1;
      else if (kandidati.length > 1) sViacerymi += 1;
      else bez += 1;
      await tx.query(
        `INSERT INTO ucto_dennik
          (id,tenant_id,organization_id,externalny_id,agenda,doklad_cislo,datum,text,suma,
           ucet_md,ucet_dal,partner_ico,partner_nazov,stredisko_kod,cinnost_kod,zakazka_kod,predkontacia_kody)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17::text[])
         ON CONFLICT (organization_id, externalny_id) DO UPDATE SET
           agenda=excluded.agenda, doklad_cislo=excluded.doklad_cislo, datum=excluded.datum,
           text=excluded.text, suma=excluded.suma, ucet_md=excluded.ucet_md, ucet_dal=excluded.ucet_dal,
           partner_ico=excluded.partner_ico, partner_nazov=excluded.partner_nazov,
           stredisko_kod=excluded.stredisko_kod, cinnost_kod=excluded.cinnost_kod,
           zakazka_kod=excluded.zakazka_kod, predkontacia_kody=excluded.predkontacia_kody`,
        [randomUUID(), input.tenantId, input.organizationId, riadok.externalnyId, riadok.agenda,
          riadok.dokladCislo ?? null, riadok.datum ?? null, riadok.text ?? null, riadok.suma ?? null,
          riadok.ucetMd, riadok.ucetDal, riadok.partnerIco ?? null, riadok.partnerNazov ?? null,
          riadok.strediskoKod ?? null, riadok.cinnostKod ?? null, riadok.zakazkaKod ?? null, kandidati],
      );
    }
  });
  return { ulozenych: input.riadky.length, sJednouPredkontaciou: sJednou, sViacerymi, bezPredkontacie: bez };
}

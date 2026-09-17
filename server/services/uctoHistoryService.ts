import { createHash, randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { Database, Queryable } from '../db/database.js';
import { jeBezPredkontacia, normalizeName, platnyKvKod } from './accountingSuggestionService.js';

// Korpus histórie zaúčtovaní (ucto_historia): úplná POHODA po riadkoch a cez
// všetky agendy. Zdroj pravdy pre jednorazovú analýzu kategórií plnení.
// Zámerne NIE je v ceste návrhu na doklade — tá beží nad ucto_decisions.

/**
 * Účtovné agendy korpusu — jedna za každú agendu POHODY, ktorú účtovník vidí
 * v type dokladu. Pokladňa je rozdelená na príjem a výdaj, lebo tie isté slová
 * („PHM", „poštovné") sa v nich účtujú opačne a v jednej hromade by si kategórie
 * protirečili.
 *
 * `PD`, `MZDY` a `INE` sú staré hodnoty z importov spred rozdelenia; nové riadky
 * ich už nepoužívajú, ale v databáze zostávajú, tak musia prejsť validáciou.
 */
export const AGENDY = [
  'FP', 'FV', 'PPD', 'VPD', 'OZ', 'OP', 'INT', 'BV', 'PD', 'MZDY', 'INE',
  // Dobropis, ťarchopis a zálohová faktúra. V POHODE zdieľajú okno s faktúrou,
  // v korpuse musia stáť samostatne: dobropis je oprava základu dane a ide do
  // opačnej sekcie KV (C1/C2), zálohová do výkazu nevstupuje vôbec. V jednej
  // hromade s FP/FV by si prevažujúce zaúčtovania protirečili — presne tak, ako
  // sa to stalo s DDsl§69, ktoré firma používa len na interných dokladoch.
  'FP-D', 'FP-T', 'FP-Z', 'FV-D', 'FV-T', 'FV-Z',
] as const;

/** Agendy, ktoré sa účtovníkovi ponúkajú ako filter — v poradí ako v type dokladu. */
export const AGENDY_ZOBRAZENE = [
  'VPD', 'PPD', 'FP', 'FP-D', 'FP-T', 'FP-Z', 'FV', 'FV-D', 'FV-T', 'FV-Z', 'OZ', 'OP', 'INT',
] as const;

/** Riadok histórie tak, ako ho posiela prehliadač (.mdb) aj agent (POHODA XML). */
export const historyRowSchema = z.object({
  agenda: z.enum(AGENDY),
  dokladCislo: z.string().trim().max(60).optional(),
  /** Poradie položky v doklade — dva rovnaké riadky jednej faktúry sú dva riadky. */
  riadokIndex: z.number().int().min(0).max(10_000).optional(),
  datum: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  supplierIco: z.string().trim().max(20).optional(),
  supplierName: z.string().trim().max(300).optional(),
  lineText: z.string().trim().max(2000),
  suma: z.number().finite().optional(),
  /** DPH položky. Krátenie odpočtu (PHM 50 %) sa z podielu základu nedá odvodiť. */
  sumaDph: z.number().finite().optional(),
  sadzbaDph: z.number().finite().optional(),
  predkontaciaKod: z.string().trim().max(100).optional(),
  clenenieDphKod: z.string().trim().max(100).optional(),
  clenenieKvKod: z.string().trim().max(20).optional(),
  strediskoKod: z.string().trim().max(100).optional(),
  /**
   * Číselný rad dokladu presne podľa POHODY: identifikátor (typ:id) a predpona
   * (typ:ids). Z predpony čísla dokladu sa rad nedá určiť — rovnakú predponu
   * nesie viac radov. Nesie ho hlavička aj každá položka dokladu.
   */
  radExternalId: z.string().trim().max(50).optional(),
  radKod: z.string().trim().max(50).optional(),
  /** Krajina protistrany (ISO) — firmy delia rady na tuzemské a zahraničné. */
  krajina: z.string().trim().max(10).optional(),
  /**
   * Natívne id dokladu a položky v POHODE (inv:id, „jen pro export"). Číslo,
   * dátum aj poradie položky sa v POHODE dajú zmeniť, id nie — spolu s
   * databázou je to identita riadka. Posiela ich len Mostík so stagingom.
   */
  dokladId: z.number().int().positive().optional(),
  polozkaId: z.number().int().positive().optional(),
}).strict();

export type HistoryRow = z.infer<typeof historyRowSchema>;

const datum = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const suma = z.number().finite();
const cislo = z.string().trim().max(100);

/**
 * Hlavička dokladu z Mostíka (protokol 3): to, čo riadok korpusu nenesie —
 * dátum dane, účtovania, dodania a KV zvlášť, číslo dodávateľa oddelene od
 * opravovaného dokladu, symboly, mena s kurzom a súhrn podľa sadzieb. Väzby
 * a likvidácie POHODA dáva len exportom (linkedDocuments, liquidations).
 */
export const historyDokladSchema = z.object({
  agenda: z.enum(AGENDY),
  dokladId: z.number().int().positive(),
  dokladCislo: cislo.optional(),
  datum: datum.optional(),
  datumDane: datum.optional(),
  datumUctovania: datum.optional(),
  datumDodania: datum.optional(),
  datumKvDph: datum.optional(),
  datumUplatneniaDph: datum.optional(),
  externeCislo: cislo.optional(),
  opravovanyDoklad: cislo.optional(),
  varSymbol: cislo.optional(),
  parSymbol: cislo.optional(),
  mena: z.string().trim().max(10).optional(),
  kurz: suma.optional(),
  kurzMnozstvo: z.number().int().optional(),
  sumaMena: suma.optional(),
  zakladNulova: suma.optional(),
  zakladZnizena: suma.optional(),
  dphZnizena: suma.optional(),
  sadzbaZnizena: suma.optional(),
  zakladZakladna: suma.optional(),
  dphZakladna: suma.optional(),
  sadzbaZakladna: suma.optional(),
  zaklad3: suma.optional(),
  dph3: suma.optional(),
  sadzba3: suma.optional(),
  zaokruhlenie: suma.optional(),
  vazby: z.array(z.object({
    typ: z.enum(['link', 'manualLink', 'liquidation']),
    druhaAgenda: z.string().trim().max(50).optional(),
    druhyDokladId: z.number().int().positive().optional(),
    druhyDokladCislo: cislo.optional(),
    likvidaciaId: z.number().int().positive().optional(),
    datum: datum.optional(),
    suma: suma.optional(),
    sumaMena: suma.optional(),
  }).strict()).max(1_000),
}).strict();

export type HistoryDoklad = z.infer<typeof historyDokladSchema>;

/** Tabuľka POHODY, v ktorej je natívne id jedinečné — FP aj FP-D sú faktúry. */
function tabulkaAgendy(agenda: string): 'invoice' | 'voucher' | 'intDoc' {
  return agenda === 'PPD' || agenda === 'VPD' ? 'voucher' : agenda === 'INT' ? 'intDoc' : 'invoice';
}

/** camelCase polia → stĺpce tabuľky (zaklad3 → zaklad_3); jsonb_populate_recordset iné kľúče ignoruje. */
function naStlpce(objekt: object): Record<string, unknown> {
  return Object.fromEntries(Object.entries(objekt).map(([kluc, hodnota]) => [kluc.replace(/[A-Z]|\d+/g, (znak) => `_${znak.toLowerCase()}`), hodnota]));
}

/**
 * Hlavičky a väzby dokladov jednej databázy POHODY. Vymenia sa celé ako korpus
 * pri publikácii — opakovaný prenos nič nezdvojí a doklad zmazaný v POHODE
 * zmizne. Transakciu drží volajúci.
 */
export async function ulozDokladyHistorie(
  db: Queryable,
  input: { tenantId: string; organizationId: string; databaza: string; rok: number; doklady: HistoryDoklad[] },
): Promise<{ dokladov: number; vazieb: number }> {
  // Väzby zmaže kaskáda. Meno databázy bez ohľadu na veľkosť písmen (mServer a CLI ho píšu rôzne).
  await db.query(
    'DELETE FROM ucto_historia_doklady WHERE tenant_id=$1 AND organization_id=$2 AND lower(zdroj_databaza)=lower($3)',
    [input.tenantId, input.organizationId, input.databaza],
  );
  const kluc = { tenant_id: input.tenantId, organization_id: input.organizationId, zdroj_databaza: input.databaza, rok: input.rok };
  // Doklad dvakrát v prenose (zopakovaná dávka) sa uloží raz — vyhráva posledný.
  const doklady = [...new Map(input.doklady.map((doklad) => [`${tabulkaAgendy(doklad.agenda)}:${doklad.dokladId}`, doklad])).values()]
    .map((doklad) => ({ ...doklad, ...kluc, tabulka: tabulkaAgendy(doklad.agenda), pohoda_doklad_id: doklad.dokladId }));
  const vazby = doklady.flatMap((doklad) => doklad.vazby.map((vazba, poradie) => ({
    ...naStlpce(vazba), ...kluc, tabulka: doklad.tabulka, pohoda_doklad_id: doklad.pohoda_doklad_id, poradie,
  })));
  await db.query(
    'INSERT INTO ucto_historia_doklady SELECT * FROM jsonb_populate_recordset(null::ucto_historia_doklady, $1::jsonb)',
    [JSON.stringify(doklady.map(naStlpce))],
  );
  await db.query(
    'INSERT INTO ucto_historia_vazby SELECT * FROM jsonb_populate_recordset(null::ucto_historia_vazby, $1::jsonb)',
    [JSON.stringify(vazby)],
  );
  return { dokladov: doklady.length, vazieb: vazby.length };
}

/** Dávka: 20 000 krátkych riadkov sa pod bodyLimit (30 MB) pohodlne zmestí. */
export const historyImportSchema = z.object({
  rows: z.array(historyRowSchema).max(20_000),
  /**
   * Prvá dávka úplného prenosu z POHODY. Korpus sa vtedy zahodí a postaví
   * nanovo, lebo agent posiela CELÚ históriu — bez toho by v ňom navždy
   * ostávali riadky zmazané v POHODE a pri zmene agendy (dobropis z FP na FP-D)
   * by sa zmenil hash a doklady by sa zdvojili.
   *
   * Podľa zdroja mazať nejde: riadky agenta majú source 'mdb' rovnako ako ručný
   * import, aby sa navzájom neduplikovali.
   */
  reset: z.boolean().optional(),
  /**
   * Číselné rady prečítané z dokladov. POHODA rad bez vyplneného Obdobia do
   * číselníka nedá — v jej schéme je element „period" povinný, takže taký
   * záznam nevie zapísať a ticho ho vynechá. Doklad ten istý rad nesie bez
   * problémov, tak sa berie odtiaľ; inak by účtovník rad v ponuke nikdy nemal.
   */
  series: z.array(z.object({
    externalId: z.string().min(1).max(50),
    kod: z.string().min(1).max(50),
    agenda: z.string().min(1).max(50),
    posledneCislo: z.string().max(50).nullish(),
  })).max(2_000).optional(),
}).strict();

interface ResolvedRow {
  agenda: string;
  dokladCislo: string | null;
  datum: string | null;
  supplierIco: string | null;
  supplierName: string | null;
  lineText: string;
  suma: number | null;
  sumaDph: number | null;
  riadokIndex: number | null;
  sadzbaDph: number | null;
  predkontaciaKod: string | null;
  predkontaciaId: string | null;
  clenenieDphKod: string | null;
  clenenieDphId: string | null;
  clenenieKvKod: string | null;
  strediskoKod: string | null;
  strediskoId: string | null;
  radExternalId?: string | null;
  radKod?: string | null;
  krajina?: string | null;
  dokladId?: number | null;
  polozkaId?: number | null;
  hash: string;
}

/** Kľúč idempotencie importu — pozri komentár v tele. */
function riadokHash(row: ResolvedRow, poradie: number, zdrojDatabaza: string | undefined): string {
  // Natívne id POHODY je pevná identita: presun dobropisu z FP do FP-D ani
  // prehodené položky ho nezmenia. Platí len v jednej databáze (ročníku),
  // preto je databáza v odtlačku. Položka bez vlastného id by s id dokladu
  // kolidovala so svojou hlavičkou — tá ide po starom.
  // Id je jedinečné len v tabuľke agendy POHODY: faktúra, pokladničný a interný
  // doklad môžu mať to isté id. Tabuľka sa berie z agendy — FP aj FP-D sú faktúry.
  // Meno databázy bez ohľadu na veľkosť písmen: mServer a POHODA CLI ho píšu rôzne.
  if (row.dokladId && (row.riadokIndex ? row.polozkaId : true)) {
    return createHash('sha256')
      .update(['pohoda', (zdrojDatabaza ?? '').toLowerCase(), tabulkaAgendy(row.agenda), row.dokladId, row.polozkaId ?? 0].join('|'))
      .digest('hex').slice(0, 32);
  }
  // Odtlačok PÔVODU riadka, nie obsahu: opakovaný import tej istej histórie nič
  // nezduplikuje, ale dve rovnaké položky dvoch rôznych faktúr ostanú dve. Pre
  // analýzu je početnosť hlavný signál — zlučovanie podľa obsahu by z „1240×
  // preprava" spravilo jeden riadok. Bez čísla dokladu sa padá späť na obsah.
  if (row.dokladCislo) {
    return createHash('sha256')
      .update([row.agenda, row.dokladCislo, row.datum ?? '', String(poradie)].join(''))
      .digest('hex').slice(0, 32);
  }
  return createHash('sha256').update([
    row.agenda, row.dokladCislo ?? '', row.datum ?? '', row.supplierIco ?? '', row.supplierName ?? '',
    row.lineText, row.suma ?? '', row.sadzbaDph ?? '',
    row.predkontaciaKod ?? '', row.clenenieDphKod ?? '', row.clenenieKvKod ?? '', row.strediskoKod ?? '',
  ].join('')).digest('hex').slice(0, 32);
}

async function kodyNaId(
  db: Queryable,
  tenantId: string,
  organizationId: string,
): Promise<Map<string, string>> {
  const result = await db.query<{ id: string; kind: string; code: string } & Record<string, unknown>>(
    `SELECT id, kind, code FROM code_list_items
      WHERE tenant_id=$1 AND organization_id=$2 AND active=true
        AND kind IN ('predkontacie','cleneniaDph','strediska')`,
    [tenantId, organizationId],
  );
  return new Map(result.rows.map((row) => [`${row.kind}:${row.code.trim()}`, row.id]));
}

/**
 * Uloží dávku histórie. Na rozdiel od tréningového importu riadok s neznámym
 * kódom NEODMIETA — kód sa uloží ako text a id ostane prázdne, takže analýza
 * vidí aj prax, ktorá už v aktívnych číselníkoch nie je.
 */
export async function importUctoHistory(
  database: Queryable,
  input: {
    tenantId: string;
    organizationId: string;
    rows: HistoryRow[];
    source: 'mdb' | 'agent';
    /** Databáza POHODY, z ktorej prenos prišiel (publikácia prenosu Mostíka). */
    zdrojDatabaza?: string;
  },
): Promise<{ imported: number; duplicates: number; bezKodu: number }> {
  const { tenantId, organizationId } = input;
  const idPreKod = await kodyNaId(database, tenantId, organizationId);
  const id = (kind: string, kod: string | undefined) =>
    (kod ? idPreKod.get(`${kind}:${kod.trim()}`) ?? null : null);

  // Ručné XML a .mdb natívne id nepoznajú a odtlačok skladajú z agendy, čísla,
  // dátumu a poradia. Riadok, ktorý už prišiel z publikácie Mostíka, sa preto
  // prepíše pod svojím odtlačkom — inak by ručné nahratie tej istej histórie
  // zdvojilo korpus až do ďalšieho prenosu.
  const nativne = new Map<string, string>();
  const cisla = input.zdrojDatabaza ? [] : [...new Set(input.rows.flatMap((row) => (row.dokladCislo ? [row.dokladCislo] : [])))];
  if (cisla.length > 0) {
    const result = await database.query<{ riadok_hash: string; kluc: string } & Record<string, unknown>>(
      `SELECT riadok_hash, agenda || '|' || doklad_cislo || '|' || coalesce(datum::text, '') || '|' || coalesce(riadok_index::text, '') AS kluc
         FROM ucto_historia
        WHERE tenant_id=$1 AND organization_id=$2 AND pohoda_doklad_id IS NOT NULL AND doklad_cislo = ANY($3::text[])`,
      [tenantId, organizationId, cisla],
    );
    for (const row of result.rows) nativne.set(row.kluc, row.riadok_hash);
  }

  const resolved: ResolvedRow[] = [];
  let bezKodu = 0;
  for (const row of input.rows) {
    const lineText = normalizeName(row.lineText).slice(0, 1000);
    if (!lineText) continue; // riadok bez textu nenesie pre analýzu žiadny signál
    const base: ResolvedRow = {
      agenda: row.agenda,
      dokladCislo: row.dokladCislo ?? null,
      datum: row.datum ?? null,
      supplierIco: row.supplierIco?.replace(/\D/g, '') || null,
      supplierName: normalizeName(row.supplierName) || null,
      lineText,
      suma: row.suma ?? null,
      sumaDph: row.sumaDph ?? null,
      riadokIndex: row.riadokIndex ?? null,
      sadzbaDph: row.sadzbaDph ?? null,
      // „BEZ…" nie je účet, ale doklad bez zaúčtovania — do korpusu sa nedostane
      // ani ako kód, inak by z neho analýza spravila kategóriu s účtom BEZ321100.
      predkontaciaKod: jeBezPredkontacia(row.predkontaciaKod) ? null : row.predkontaciaKod?.trim() || null,
      predkontaciaId: jeBezPredkontacia(row.predkontaciaKod) ? null : id('predkontacie', row.predkontaciaKod),
      clenenieDphKod: row.clenenieDphKod?.trim() || null,
      clenenieDphId: id('cleneniaDph', row.clenenieDphKod),
      clenenieKvKod: platnyKvKod(row.clenenieKvKod) ?? null,
      strediskoKod: row.strediskoKod?.trim() || null,
      strediskoId: id('strediska', row.strediskoKod),
      radExternalId: row.radExternalId || null,
      radKod: row.radKod || null,
      krajina: row.krajina?.toUpperCase() || null,
      dokladId: row.dokladId ?? null,
      polozkaId: row.polozkaId ?? null,
      hash: '',
    };
    if (!base.predkontaciaKod && !base.clenenieDphKod) {
      bezKodu += 1;
      continue; // riadok bez zaúčtovania sa nemá čo učiť
    }
    base.hash = nativne.get(`${base.agenda}|${base.dokladCislo}|${base.datum ?? ''}|${base.riadokIndex ?? ''}`)
      ?? riadokHash(base, row.riadokIndex ?? resolved.length, input.zdrojDatabaza);
    resolved.push(base);
  }

  // Po 1000 riadkov v jednom INSERT-e: 25 000 samostatných príkazov trvalo pri
  // publikácii prenosu desiatky sekúnd a agent čaká na odpoveď najviac 120 s.
  // Jeden príkaz nesmie zasiahnuť ten istý riadok dvakrát — pri rovnakom
  // odtlačku vyhráva posledný, ako pri postupnom prepise.
  const naVlozenie = [...new Map(resolved.map((row) => [row.hash, row])).values()];
  const STLPCOV = 28;
  let imported = 0;
  for (let od = 0; od < naVlozenie.length; od += 1000) {
    const cast = naVlozenie.slice(od, od + 1000);
    const result = await database.query<{ vlozeny: boolean } & Record<string, unknown>>(
      `INSERT INTO ucto_historia
        (id,tenant_id,organization_id,agenda,doklad_cislo,datum,supplier_ico,supplier_name_normalized,
         line_text_normalized,suma,suma_dph,sadzba_dph,predkontacia_kod,predkontacia_id,clenenie_dph_kod,
         clenenie_dph_id,clenenie_kv_kod,stredisko_kod,stredisko_id,source,riadok_hash,riadok_index,
         rad_external_id,rad_kod,krajina,zdroj_databaza,pohoda_doklad_id,pohoda_polozka_id)
       VALUES ${cast.map((_, r) => `(${Array.from({ length: STLPCOV }, (__, s) => `$${r * STLPCOV + s + 1}`).join(',')})`).join(',')}
       -- Prepis, nie DO NOTHING: korpus je zrkadlo POHODY a import, ktorý
       -- prinesie viac (sumy pribudli neskôr), musí riadok doplniť. xmax=0
       -- rozlíši skutočný vklad od prepisu, inak by boli duplicity vždy nula.
       -- Text, partner a stredisko sa prepisujú: účtovník ich v POHODE opravil
       -- a odtlačok sa tým nemení. Rad, krajinu, sadzbu, DPH a pôvod doplní,
       -- ale nezmaže: import .mdb, ručné XML ani starší Mostík ich nepoznajú
       -- a prepis by zahodil to, čo priniesol novší prenos. Stredisko je
       -- dvojica kód+id — id Bratislavy pri kóde KE by klamalo.
       ON CONFLICT (organization_id, riadok_hash) DO UPDATE SET
         agenda=excluded.agenda, doklad_cislo=excluded.doklad_cislo, datum=excluded.datum,
         supplier_ico=excluded.supplier_ico, supplier_name_normalized=excluded.supplier_name_normalized,
         line_text_normalized=excluded.line_text_normalized,
         suma=excluded.suma,
         suma_dph=coalesce(excluded.suma_dph, ucto_historia.suma_dph),
         sadzba_dph=coalesce(excluded.sadzba_dph, ucto_historia.sadzba_dph),
         predkontacia_kod=excluded.predkontacia_kod, predkontacia_id=excluded.predkontacia_id,
         clenenie_dph_kod=excluded.clenenie_dph_kod, clenenie_dph_id=excluded.clenenie_dph_id,
         clenenie_kv_kod=excluded.clenenie_kv_kod, riadok_index=excluded.riadok_index,
         stredisko_kod=CASE WHEN excluded.stredisko_kod IS NULL THEN ucto_historia.stredisko_kod ELSE excluded.stredisko_kod END,
         stredisko_id=CASE WHEN excluded.stredisko_kod IS NULL THEN ucto_historia.stredisko_id ELSE excluded.stredisko_id END,
         rad_external_id=coalesce(excluded.rad_external_id, ucto_historia.rad_external_id),
         rad_kod=coalesce(excluded.rad_kod, ucto_historia.rad_kod),
         krajina=coalesce(excluded.krajina, ucto_historia.krajina),
         zdroj_databaza=coalesce(excluded.zdroj_databaza, ucto_historia.zdroj_databaza),
         pohoda_doklad_id=coalesce(excluded.pohoda_doklad_id, ucto_historia.pohoda_doklad_id),
         pohoda_polozka_id=coalesce(excluded.pohoda_polozka_id, ucto_historia.pohoda_polozka_id)
       RETURNING (xmax = 0) AS vlozeny`,
      cast.flatMap((row) => [randomUUID(), tenantId, organizationId, row.agenda, row.dokladCislo, row.datum,
        row.supplierIco, row.supplierName, row.lineText, row.suma, row.sumaDph, row.sadzbaDph,
        row.predkontaciaKod, row.predkontaciaId, row.clenenieDphKod, row.clenenieDphId,
        row.clenenieKvKod, row.strediskoKod, row.strediskoId, input.source, row.hash, row.riadokIndex,
        row.radExternalId, row.radKod, row.krajina, input.zdrojDatabaza ?? null, row.dokladId, row.polozkaId]),
    );
    imported += result.rows.filter((row) => row.vlozeny).length;
  }
  await doplnRokRadovZDokladov(database, tenantId, organizationId);
  return { imported, duplicates: resolved.length - imported, bezKodu };
}

/**
 * Agenda korpusu podľa typu dokladu, z ktorého rozhodnutie vzniklo. Pokladňa
 * nesie smer v zaúčtovaní dokladu, nie v type — bez neho by príjem a výdaj
 * skončili v jednej hromade.
 */
export function agendaZTypuDokladu(documentType: unknown, pokladnaTyp: unknown): string {
  switch (String(documentType ?? '')) {
    case 'FP': return 'FP';
    case 'FV': return 'FV';
    case 'OZ': return 'OZ';
    case 'MZDY': return 'INT';
    case 'BV': return 'BV';
    case 'PD': return String(pokladnaTyp ?? '') === 'receipt' ? 'PPD' : 'VPD';
    // Rozhodnutia bez dokladu pochádzajú z importu .mdb prijatých faktúr.
    default: return 'FP';
  }
}

/**
 * Preklopí už existujúcu pamäť rozhodnutí do korpusu, aby analýza mala z čoho
 * vychádzať ešte pred prvým plným exportom z POHODY. Agenda sa berie z dokladu,
 * ku ktorému rozhodnutie patrí — kým sa písalo natvrdo 'FP', celý korpus vyzeral
 * ako samé prijaté faktúry a rozdelenie profilu podľa agend nemalo čo ukázať.
 * Opakované preklopenie agendu opraví aj riadkom, ktoré tu už sú.
 *
 * POZOR na očakávania: pamäť rozhodnutí pozná len prijaté faktúry (import .mdb
 * do pamäte berie RelTpFak 11/12/15) a doklady schválené v Dokladovke. Pokladňu,
 * vydané faktúry ani ostatné záväzky odtiaľto NEČAKAJ — tie prináša až import
 * .mdb do korpusu (extractPohodaHistory).
 */
export async function backfillHistoryFromDecisions(
  database: Database,
  tenantId: string,
  organizationId: string,
): Promise<{ imported: number }> {
  const rows = await database.query<Record<string, any>>(
    `SELECT d.id, d.supplier_ico, d.supplier_name_normalized, d.line_text_normalized,
            d.clenenie_kv_kod,
            p.code AS predkontacia_kod, d.predkontacia_id,
            c.code AS clenenie_dph_kod, d.clenenie_dph_id,
            s.code AS stredisko_kod, d.stredisko_id,
            dok.document_type, dok.accounting->>'pokladnaTyp' AS pokladna_typ
       FROM ucto_decisions d
       LEFT JOIN code_list_items p ON p.id=d.predkontacia_id
       LEFT JOIN code_list_items c ON c.id=d.clenenie_dph_id
       LEFT JOIN code_list_items s ON s.id=d.stredisko_id
       LEFT JOIN documents dok ON dok.id=d.document_id
      WHERE d.tenant_id=$1 AND d.organization_id=$2 AND d.excluded=false
        AND coalesce(d.line_text_normalized,'') <> ''`,
    [tenantId, organizationId],
  );
  let imported = 0;
  for (const row of rows.rows) {
    const resolved: ResolvedRow = {
      agenda: agendaZTypuDokladu(row.document_type, row.pokladna_typ),
      dokladCislo: null,
      datum: null,
      supplierIco: row.supplier_ico ?? null,
      supplierName: row.supplier_name_normalized ?? null,
      lineText: row.line_text_normalized,
      suma: null,
      sumaDph: null,
      riadokIndex: 0,
      sadzbaDph: null,
      predkontaciaKod: jeBezPredkontacia(row.predkontacia_kod) ? null : row.predkontacia_kod ?? null,
      predkontaciaId: jeBezPredkontacia(row.predkontacia_kod) ? null : row.predkontacia_id ?? null,
      clenenieDphKod: row.clenenie_dph_kod ?? null,
      clenenieDphId: row.clenenie_dph_id ?? null,
      clenenieKvKod: row.clenenie_kv_kod ?? null,
      strediskoKod: row.stredisko_kod ?? null,
      strediskoId: row.stredisko_id ?? null,
      hash: '',
    };
    if (!resolved.predkontaciaKod && !resolved.clenenieDphKod) continue;
    // Kľúčom je id rozhodnutia — každý riadok pamäte je samostatný výskyt,
    // inak by sa opakované rovnaké zaúčtovania zlúčili a analýza by stratila
    // početnosť, ktorá je pre ňu hlavným signálom.
    resolved.hash = createHash('sha256').update(`decision:${row.id}`).digest('hex').slice(0, 32);
    const result = await database.query(
      `INSERT INTO ucto_historia
        (id,tenant_id,organization_id,agenda,line_text_normalized,supplier_ico,supplier_name_normalized,
         predkontacia_kod,predkontacia_id,clenenie_dph_kod,clenenie_dph_id,clenenie_kv_kod,
         stredisko_kod,stredisko_id,source,riadok_hash)
       VALUES ($1,$2,$3,$15,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,'decisions',$14)
       -- Agenda sa pri opakovanom preklopení DOPLNÍ. S DO NOTHING ostali riadky
       -- preklopené starším kódom navždy pri 'FP' a oprava agendy sa k nim
       -- nikdy nedostala — tlačidlo len hlásilo „(0)". Podmienka drží rowCount
       -- pravdivý: keď sa nič nemení, riadok sa nepočíta ako preklopený.
       ON CONFLICT (organization_id, riadok_hash) DO UPDATE
         SET agenda=EXCLUDED.agenda
         WHERE ucto_historia.agenda IS DISTINCT FROM EXCLUDED.agenda`,
      [randomUUID(), tenantId, organizationId, resolved.lineText, resolved.supplierIco,
        resolved.supplierName, resolved.predkontaciaKod, resolved.predkontaciaId,
        resolved.clenenieDphKod, resolved.clenenieDphId, resolved.clenenieKvKod,
        resolved.strediskoKod, resolved.strediskoId, resolved.hash, resolved.agenda],
    );
    if (result.rowCount > 0) imported += 1;
  }
  return { imported };
}

export async function historyStats(
  database: Database,
  tenantId: string,
  organizationId: string,
): Promise<{ spolu: number; podlaAgendy: Array<{ agenda: string; pocet: number }>; dodavatelov: number; roznychTextov: number }> {
  const spolu = await database.query<{ pocet: string } & Record<string, unknown>>(
    'SELECT count(*) AS pocet FROM ucto_historia WHERE tenant_id=$1 AND organization_id=$2',
    [tenantId, organizationId],
  );
  const agendy = await database.query<{ agenda: string; pocet: string } & Record<string, unknown>>(
    `SELECT agenda, count(*) AS pocet FROM ucto_historia
      WHERE tenant_id=$1 AND organization_id=$2 GROUP BY agenda ORDER BY 2 DESC`,
    [tenantId, organizationId],
  );
  const ostatne = await database.query<{ dodavatelov: string; textov: string } & Record<string, unknown>>(
    `SELECT count(DISTINCT coalesce(supplier_ico, supplier_name_normalized)) AS dodavatelov,
            count(DISTINCT line_text_normalized) AS textov
       FROM ucto_historia WHERE tenant_id=$1 AND organization_id=$2`,
    [tenantId, organizationId],
  );
  return {
    spolu: Number(spolu.rows[0]?.pocet ?? 0),
    podlaAgendy: agendy.rows.map((row) => ({ agenda: row.agenda, pocet: Number(row.pocet) })),
    dodavatelov: Number(ostatne.rows[0]?.dodavatelov ?? 0),
    roznychTextov: Number(ostatne.rows[0]?.textov ?? 0),
  };
}

/**
 * Číselné rady prečítané z dokladov. Doplní iba tie, ktoré v číselníku nie sú —
 * rad z číselníka je vždy presnejší (má názov aj vlastné posledné číslo), takže
 * sa neprepisuje. Vlastný zdroj 'pohoda_doklad' ich chráni pred hodinovou
 * deaktiváciou, ktorá čistí len rady so source='pohoda'.
 */
export async function ulozRadyZDokladov(
  database: Queryable,
  input: { tenantId: string; organizationId: string; series: readonly {
    externalId: string; kod: string; agenda: string; posledneCislo?: string | null;
  }[] },
): Promise<{ nove: number; aktualizovane: number }> {
  if (input.series.length === 0) return { nove: 0, aktualizovane: 0 };
  // Kľúčom je identifikátor radu, nie kód: ten istý kód môže niesť viac radov
  // (rad „26" je v pokladni aj v ostatných záväzkoch) a oba sú skutočné.
  const podlaId = new Map<string, typeof input.series[number]>();
  for (const rad of input.series) if (!podlaId.has(rad.externalId)) podlaId.set(rad.externalId, rad);
  let nove = 0;
  let aktualizovane = 0;
  // Transakciu drží volajúci — publikácia prenosu potrebuje rady v tej istej
  // transakcii ako korpus, z ktorého sa im dopĺňa rok.
  for (const rad of podlaId.values()) {
    // Názov z dokladu nezistíme — POHODA v ňom posiela len identifikátor
    // a prefix. V ponuke sa tak rad ukáže pod vlastným kódom.
    const result = await database.query(
      `INSERT INTO code_list_items
         (id, tenant_id, organization_id, kind, code, name, source, active, external_id, agenda, last_number, synced_at)
       VALUES ($1,$2,$3,'ciselneRady',$4,$4,'pohoda_doklad',true,$5,$6,$7,now())
       ON CONFLICT (tenant_id, organization_id, external_id) WHERE kind = 'ciselneRady' AND external_id IS NOT NULL
       DO UPDATE
          SET last_number=coalesce(excluded.last_number, code_list_items.last_number),
              code=excluded.code, name=excluded.name, agenda=excluded.agenda,
              active=true, synced_at=now(), updated_at=now()
        WHERE code_list_items.source='pohoda_doklad'
       RETURNING (xmax = 0) AS vlozeny`,
      [randomUUID(), input.tenantId, input.organizationId, rad.kod,
        rad.externalId, rad.agenda, rad.posledneCislo ?? null],
    );
    // Rad, ktorý už v číselníku je, WHERE odfiltruje — nevráti sa nič a je to
    // v poriadku: číselník má prednosť.
    if (result.rowCount === 0) continue;
    if (result.rows[0]?.vlozeny) nove += 1; else aktualizovane += 1;
  }
  await doplnRokRadovZDokladov(database, input.tenantId, input.organizationId);
  return { nove, aktualizovane };
}

/**
 * Rok radu z dokladov = rok dokladu s jeho posledným číslom (ako migrácia 0061).
 * Bez roka sa ponúkal aj rad minulého roka, ktorý ostal na neuhradených
 * dokladoch v novej databáze (ROFA „FP20"). Beží po každej dávke: rady prídu
 * s prvou, ale doklad s posledným číslom môže prísť až v ďalšej.
 */
async function doplnRokRadovZDokladov(db: Queryable, tenantId: string, organizationId: string): Promise<void> {
  await db.query(
    `UPDATE code_list_items c
        SET accounting_year = h.rok, updated_at = now()
       FROM (
         SELECT doklad_cislo, max(extract(year FROM datum))::int::text AS rok
           FROM ucto_historia
          WHERE tenant_id=$1 AND organization_id=$2 AND datum IS NOT NULL AND doklad_cislo IS NOT NULL
          GROUP BY doklad_cislo
       ) h
      WHERE c.tenant_id=$1 AND c.organization_id=$2 AND c.kind='ciselneRady' AND c.source='pohoda_doklad'
        AND c.accounting_year IS NULL AND h.doklad_cislo = c.last_number`,
    [tenantId, organizationId],
  );
}

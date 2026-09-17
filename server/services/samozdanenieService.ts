import type { Queryable } from '../db/database.js';
import { normalizeName } from './accountingSuggestionService.js';
import { EU_DPH_PREFIXY, extrakt, jeCudziDodavatel, NAZVY_DRUHOV, sadzbyDphPre } from './dphAdvisor.js';
import { popisKodu } from './pohodaDphKody.js';
import { DD_REFY_SLUZBY, DD_REFY_TOVAR } from './profilKatalog.js';
import { loadDphProfil, predvolenyDphProfil, type DphProfil, type SamozdanenieDruh } from './dphProfileService.js';

/**
 * Samozdanenie na prijatej faktúre bez DPH. Obchod (služba z EÚ, tovar z EÚ,
 * tuzemské prenesenie) určuje, či a kedy daň vzniká — profil klienta dodáva len
 * kódy firmy. Účtovník volí: vytvoriť interné doklady (vymeranie a odpočet),
 * už zaúčtované v POHODE, alebo nevzniká povinnosť s dôvodom.
 */

export const VOLBY_SAMOZDANENIA = ['vytvorit', 'v_pohode', 'nevznika'] as const;
export type VolbaSamozdanenia = typeof VOLBY_SAMOZDANENIA[number];
export const DOVODY_NEVZNIKA = ['slovenska_dph', 'miesto_dodania', 'nie_plnenie', 'iny'] as const;
export type DovodNevznika = typeof DOVODY_NEVZNIKA[number];
/** Prijaté druhy, na ktoré sa blok pýta. Dovoz (§84a) sa len označí na ručné spracovanie. */
export const DRUHY_PRIJATEHO = ['sluzby_eu', 'tovar_eu', 'sluzby_mimo_eu', 'prenesenie_prijate', 'dovoz'] as const;
export type DruhPrijateho = typeof DRUHY_PRIJATEHO[number];
export type ZdrojVolby = 'predvolene' | 'dodavatel' | 'firma' | 'uctovnik';
export type RolaPrenosu = 'faktura' | 'dd' | 'p';

export interface RucneParametre { druh?: DruhPrijateho; datumDanovejPovinnosti?: string; sadzba?: number; kurz?: number }

/** Čo firma s dodávateľom samozdaňovala doteraz — len os „tovar alebo služba". */
export type PraxDodavatela = 'tovar' | 'sluzby';
/** Koľko dokladov musí prax niesť, aby druh určila sama (pravidlo vlastníka: päť rovnakých). */
const MIN_DOKLADOV_PRAXE = 5;

/** Voľba účtovníka — to, čo posiela editor. */
export interface RozhodnutieSamozdanenia {
  volba: VolbaSamozdanenia;
  dovod?: DovodNevznika;
  dovodText?: string;
  cislaInternych?: string;
  /** Hodnoty, ktoré účtovník prepísal; ostatné sa počítajú z dokladu. */
  rucne?: RucneParametre;
}

/** documents.samozdanenie a approved_snapshot.samozdanenie. */
export interface Samozdanenie extends RozhodnutieSamozdanenia {
  druh: DruhPrijateho;
  zdroj: ZdrojVolby;
  datumDanovejPovinnosti?: string;
  sadzba?: number;
  kurz?: number;
  zaklad?: number;
  dan?: number;
  odpocet?: number;
  /** Kódy firmy pre interné doklady v okamihu výpočtu — export ich berie zo snapshotu. */
  interny?: SamozdanenieDruh['interny'];
  export?: Partial<Record<RolaPrenosu, { stav: 'ok' | 'warning' | 'chyba'; cislo?: string; sprava?: string; at: string }>>;
}

export type ChybaSamozdanenia = 'dovoz' | 'kody' | 'datum' | 'kurz' | 'dovod';

export interface StavSamozdanenia {
  uzemie: 'eu' | 'mimo_eu' | 'sk';
  predvolene: { volba: VolbaSamozdanenia; zdroj: ZdrojVolby; dovod?: DovodNevznika; dovodText?: string };
  hodnota: Samozdanenie;
  /** Sadzby na výber — znížené len pri tovare z EÚ. */
  sadzby: number[];
  mena: string;
  /** Bránia schváleniu zvolenej voľby. */
  chyby: ChybaSamozdanenia[];
  statusNepotvrdeny: boolean;
}

export interface PamatDodavatela { dovod: DovodNevznika; dovodText?: string }

const iso = (hodnota: unknown) => {
  const text = String(hodnota ?? '').slice(0, 10);
  return /^\d{4}-\d{2}-\d{2}$/.test(text) && !Number.isNaN(Date.parse(text)) ? text : undefined;
};
const kladne = (hodnota: unknown) => (Number(hodnota) > 0 ? Number(hodnota) : undefined);

/** Časti faktúry so samozdanením, ktoré POHODA už prijala — znova sa neposielajú a voľba sa už nemení. */
export const prijateCasti = (samozdanenie: Partial<Samozdanenie> | null | undefined): RolaPrenosu[] =>
  Object.entries(samozdanenie?.export ?? {}).filter(([, vysledok]) => vysledok?.stav === 'ok').map(([rola]) => rola as RolaPrenosu);

/** 15. deň mesiaca po dodaní (§20 ods. 1 písm. a). */
function patnastyNasledujuceho(datum: string): string {
  const [rok, mesiac] = datum.split('-').map(Number);
  return mesiac === 12 ? `${rok + 1}-01-15` : `${rok}-${String(mesiac + 1).padStart(2, '0')}-15`;
}

/** Daň na centy podľa §26 ods. 3: od 0,005 nahor. V celých centoch je polovica presná. */
export function danZoZakladu(zaklad: number, sadzba: number): number {
  return Math.round((Math.round(zaklad * 100) * sadzba) / 100) / 100;
}

/**
 * Stav bloku samozdanenia, alebo undefined, keď sa doklad netýka: prijatá bežná
 * faktúra bez DPH od cudzieho dodávateľa, alebo od slovenského platiteľa vo
 * firme s potvrdeným prijatým prenesením. Uložené rozhodnutie má prednosť;
 * predvolená voľba je pamäť dodávateľa > nastavenie firmy > vytvoriť doklady.
 */
export function zostavSamozdanenie(vstup: {
  documentType: string;
  podtyp?: string | null;
  extracted: Record<string, unknown> | null | undefined;
  profil: DphProfil;
  pamat?: PamatDodavatela;
  /** Prax firmy s týmto dodávateľom z POHODY — určuje tovar proti službe. */
  praxDodavatela?: PraxDodavatela;
  ulozene?: Partial<Samozdanenie> | null;
}): StavSamozdanenia | undefined {
  const { profil } = vstup;
  if (vstup.documentType !== 'FP' || (vstup.podtyp ?? 'bezna') !== 'bezna') return undefined;
  // Firma, ktorá samozdanenie na prijatých faktúrach nerieši (potvrdené v profile
  // klienta), blok nedostane a faktúra ide do POHODY bez interných dokladov.
  if (profil.samozdaneniePostup === 'neriesime') return undefined;
  const doklad = extrakt({ documentType: vstup.documentType, extracted: vstup.extracted });
  if (doklad.dphSpolu !== 0 || !(doklad.sumaSpolu > 0)) return undefined;
  const prefix = doklad.dodavatelIcDph.slice(0, 2);
  const cudzi = jeCudziDodavatel({ icDph: doklad.dodavatelIcDph, krajina: doklad.dodavatelKrajina }) || EU_DPH_PREFIXY.includes(prefix);
  const krajina = doklad.dodavatelKrajina && doklad.dodavatelKrajina !== 'SK' ? doklad.dodavatelKrajina : prefix;
  const uzemie = cudzi ? (EU_DPH_PREFIXY.includes(krajina) ? 'eu' : 'mimo_eu')
    : prefix === 'SK' && profil.samozdanenie.prenesenie_prijate ? 'sk' : undefined;
  if (!uzemie) return undefined;

  const predvolene: StavSamozdanenia['predvolene'] = vstup.pamat
    ? { volba: 'nevznika', zdroj: 'dodavatel', dovod: vstup.pamat.dovod, ...(vstup.pamat.dovodText ? { dovodText: vstup.pamat.dovodText } : {}) }
    : profil.samozdaneniePostup === 'v_pohode' ? { volba: 'v_pohode', zdroj: 'firma' } : { volba: 'vytvorit', zdroj: 'predvolene' };
  // Uložená hodnota je rozhodnutie, keď ju zvolil účtovník. Zápis schválenia
  // z predvolieb sa prepočíta (oprava dodávateľa, nové nastavenie firmy) — okrem
  // dokladu, ktorého časť už prijala POHODA: ten ostáva, ako odišiel.
  const prijate = prijateCasti(vstup.ulozene).length > 0;
  const ulozene = vstup.ulozene?.volba && ((vstup.ulozene.zdroj ?? 'uctovnik') === 'uctovnik' || prijate) ? vstup.ulozene : undefined;
  const volba = ulozene?.volba ?? predvolene.volba;
  // Druh pripína výslovná zmena účtovníka (rucne.druh) a doklad, ktorý už raz
  // odišiel do POHODY: opakovaný prenos musí poslať ten istý interný doklad, aký
  // POHODA prijala (aj s varovaním), nie doklad inej rodiny.
  const odoslane = prijate || Boolean(vstup.ulozene?.export);
  const pripnuty = odoslane ? vstup.ulozene?.druh : ulozene?.rucne?.druh;
  // Územie rozhoduje o EÚ/tretej krajine/tuzemsku, prax dodávateľa o tom, či ide
  // o tovar alebo službu — z dokladu sa to spoľahlivo prečítať nedá. ROFA tak
  // dostávala „Služby z EÚ" na 113 zo 118 dokladov, hoci firma ich 108× zaúčtovala
  // ako nadobudnutie tovaru (DDnadEU/PDnadEU). Prax mimo EÚ sa nepoužíva: tovar
  // z tretej krajiny je dovoz (§21), ten sa samozdanením nevymeriava a v histórii
  // preto nemá jediný doklad, z ktorého by sa dal odvodiť.
  const druh = pripnuty && (DRUHY_PRIJATEHO as readonly string[]).includes(pripnuty) ? pripnuty
    : uzemie === 'eu' ? (vstup.praxDodavatela === 'tovar' ? 'tovar_eu' : 'sluzby_eu')
      : uzemie === 'mimo_eu' ? 'sluzby_mimo_eu' : 'prenesenie_prijate';
  const rucne = ulozene?.rucne ?? {};
  const extracted = (vstup.extracted ?? {}) as Record<string, unknown>;

  const vystavenie = iso(extracted.datumVystavenia);
  const dodanie = iso(extracted.datumDodania) ?? vystavenie;
  // Tovar z EÚ: skorší z dátumu vystavenia faktúry a 15. dňa mesiaca po dodaní.
  const vypocitany = druh === 'tovar_eu' && dodanie
    ? [vystavenie, patnastyNasledujuceho(dodanie)].filter((datum): datum is string => Boolean(datum)).sort()[0]
    : dodanie;
  const datum = iso(rucne.datumDanovejPovinnosti) ?? vypocitany;
  // Dátum pred tabuľkou sadzieb (pred 2011, aj rozpísaný rok „0002") sadzbu nemá — chyba dátumu.
  const obdobie = sadzbyDphPre(datum);
  const sadzby = !obdobie ? [] : druh === 'tovar_eu'
    ? [obdobie.high, obdobie.low, obdobie.third].filter((sadzba): sadzba is number => Boolean(sadzba))
    : [obdobie.high];
  const sadzba = rucne.sadzba !== undefined && sadzby.includes(rucne.sadzba) ? rucne.sadzba : obdobie?.high;
  const mena = doklad.mena.trim().toUpperCase() || 'EUR';
  const kurz = mena === 'EUR' ? undefined : kladne(rucne.kurz) ?? kladne(extracted.kurz);
  // Kurz = jednotiek cudzej meny za 1 EUR, ako v kurzovom lístku ECB/NBS.
  const zaklad = mena === 'EUR' ? Math.round(doklad.sumaSpolu * 100) / 100
    : kurz ? Math.round((doklad.sumaSpolu / kurz + Number.EPSILON) * 100) / 100 : undefined;
  const dan = zaklad === undefined || sadzba === undefined ? undefined : danZoZakladu(zaklad, sadzba);
  // Neplatiteľ, §7 a §7a daň priznáva, ale neodpočítava. Nepotvrdený status: oba doklady a upozornenie.
  const sOdpoctom = profil.platitelDph === 'platitel' || profil.platitelDph === 'nezname';
  const interny = profil.samozdanenie[druh]?.interny;
  const dovod = volba !== 'nevznika' ? undefined : ulozene ? ulozene.dovod : predvolene.dovod;
  const dovodText = dovod !== 'iny' ? undefined : (ulozene ? ulozene.dovodText : predvolene.dovodText)?.trim() || undefined;
  const cislaInternych = volba === 'v_pohode' ? ulozene?.cislaInternych?.trim() || undefined : undefined;

  const chyby: ChybaSamozdanenia[] = [];
  if (volba === 'vytvorit') {
    if (druh === 'dovoz') chyby.push('dovoz');
    else if (!interny?.ddKod || !interny.ddPredkontaciaKod || (sOdpoctom && (!interny.pKod || !interny.pPredkontaciaKod))) chyby.push('kody');
    if (!obdobie || !datum) chyby.push('datum');
    if (zaklad === undefined) chyby.push('kurz');
  }
  if (volba === 'nevznika' && (!dovod || (dovod === 'iny' && !dovodText))) chyby.push('dovod');

  return {
    uzemie,
    predvolene,
    sadzby,
    mena,
    chyby,
    statusNepotvrdeny: profil.platitelDph === 'nezname',
    hodnota: {
      volba,
      druh,
      zdroj: ulozene ? ulozene.zdroj ?? 'uctovnik' : predvolene.zdroj,
      ...(dovod ? { dovod } : {}),
      ...(dovodText ? { dovodText } : {}),
      ...(cislaInternych ? { cislaInternych } : {}),
      ...(datum ? { datumDanovejPovinnosti: datum } : {}),
      sadzba,
      ...(kurz ? { kurz } : {}),
      ...(zaklad !== undefined && dan !== undefined ? { zaklad, dan, odpocet: sOdpoctom ? dan : 0 } : {}),
      ...(interny ? { interny } : {}),
      ...(Object.values(rucne).some((hodnota) => hodnota !== undefined) ? { rucne } : {}),
    },
  };
}

/** Hláška pre 409 pri schválení. */
export function spravaChyby(chyba: ChybaSamozdanenia, hodnota: Pick<Samozdanenie, 'druh'>, mena: string): string {
  switch (chyba) {
    case 'dovoz': return 'Dovoz spracujte v POHODE — interné doklady pre dovoz sa tu nevytvárajú. Zvoľte „Už zaúčtované v POHODE".';
    case 'kody': return `Doplňte samozdanenie „${NAZVY_DRUHOV[hodnota.druh]}" v profile klienta — chýbajú kódy interných dokladov.`;
    case 'datum': return 'Doplňte platný dátum daňovej povinnosti samozdanenia.';
    case 'kurz': return `Faktúra je v mene ${mena} — doplňte kurz pre samozdanenie.`;
    case 'dovod': return 'Vyberte dôvod, prečo nevzniká povinnosť samozdanenia.';
  }
}

/** Kľúč pamäte dodávateľa: IČO, bez neho normalizované meno. */
export function klucDodavatela(extracted: unknown): string | undefined {
  const dodavatel = ((extracted as Record<string, any> | null)?.dodavatel ?? {}) as { ico?: string; nazov?: string };
  const ico = String(dodavatel.ico ?? '').replace(/\D/g, '');
  const nazov = normalizeName(dodavatel.nazov);
  return ico ? `ico:${ico}` : nazov ? `nazov:${nazov}` : undefined;
}

export async function nacitajPamatDodavatela(
  db: Queryable, firma: { tenantId: string; organizationId: string }, extracted: unknown,
): Promise<PamatDodavatela | undefined> {
  const kluc = klucDodavatela(extracted);
  if (!kluc) return undefined;
  const riadok = (await db.query<{ dovod: DovodNevznika; dovod_text: string | null } & Record<string, unknown>>(
    `SELECT dovod, dovod_text FROM samozdanenie_dodavatelia
      WHERE tenant_id=$1 AND organization_id=$2 AND dodavatel_kluc=$3`,
    [firma.tenantId, firma.organizationId, kluc],
  )).rows[0];
  return riadok ? { dovod: riadok.dovod, ...(riadok.dovod_text ? { dovodText: riadok.dovod_text } : {}) } : undefined;
}

/**
 * Tovar alebo služba podľa toho, čo firma s týmto dodávateľom samozdaňovala
 * doteraz. Rodinu nesie interný doklad (DD kód), nie faktúra — na faktúre je
 * „nezahrňovať do priznania".
 *
 * Prax platí len jednomyseľná a len od piatich dokladov (pravidlo vlastníka):
 * najčastejšia rodina nestačí. parr instrument dodáva ROFE prístroje aj servis
 * (3 doklady tovar, 1 služba) a väčšinové pravidlo by servisnej faktúre s istotou
 * priradilo nadobudnutie tovaru.
 *
 * `doDatumu` drží poctivé meranie aj dodatočné priznanie: doklad vidí len prax,
 * ktorá v jeho čase existovala.
 */
export async function praxSamozdaneniaDodavatela(
  db: Queryable,
  firma: { tenantId: string; organizationId: string },
  extracted: unknown,
  doDatumu?: string,
): Promise<PraxDodavatela | undefined> {
  const dodavatel = ((extracted as Record<string, any> | null)?.dodavatel ?? {}) as { ico?: string; icDph?: string; nazov?: string };
  // Zahraničný dodávateľ má v POHODE v poli IČO daňové číslo bez predpony
  // (ATU74777039 → 74777039) alebo nič. Krátke číslo sa nepoužije: „FN 520079 y"
  // z rakúskej faktúry nie je identifikátor, ale zle prečítané registračné číslo.
  const cisla = [dodavatel.ico, dodavatel.icDph]
    .map((hodnota) => String(hodnota ?? '').replace(/\D/g, ''))
    .filter((hodnota) => hodnota.length >= 8);
  // Meno sa porovnáva bez interpunkcie: POHODA má „ROFA Laboratory & Process
  // Analyzers GmbH", faktúra „ROFA - Laboratory & Process Analyzers, GmbH" —
  // presná zhoda na takom páre zlyhá a prax dodávateľa sa nenájde.
  const nazov = normalizeName(dodavatel.nazov).replace(/[^a-z0-9]/g, '');
  if (cisla.length === 0 && !nazov) return undefined;
  const riadky = (await db.query<{ kod: string; dokladov: string } & Record<string, unknown>>(
    `SELECT clenenie_dph_kod AS kod, count(DISTINCT (agenda, doklad_cislo)) AS dokladov
       FROM ucto_historia
      WHERE tenant_id=$1 AND organization_id=$2 AND clenenie_dph_kod IS NOT NULL
        AND ((cardinality($3::text[]) > 0
              AND regexp_replace(coalesce(supplier_ico, ''), '\\D', '', 'g') = ANY($3::text[]))
          OR ($4::text <> ''
              AND regexp_replace(lower(coalesce(supplier_name_normalized, '')), '[^a-z0-9]', '', 'g') = $4))
        AND ($5::date IS NULL OR datum < $5::date)
      GROUP BY 1`,
    [firma.tenantId, firma.organizationId, cisla, nazov, doDatumu ?? null],
  )).rows;
  let tovar = 0;
  let sluzby = 0;
  for (const riadok of riadky) {
    const ref = popisKodu(riadok.kod)?.ref ?? '';
    if (DD_REFY_TOVAR.includes(ref)) tovar += Number(riadok.dokladov);
    else if (DD_REFY_SLUZBY.includes(ref)) sluzby += Number(riadok.dokladov);
  }
  if (tovar >= MIN_DOKLADOV_PRAXE && sluzby === 0) return 'tovar';
  if (sluzby >= MIN_DOKLADOV_PRAXE && tovar === 0) return 'sluzby';
  return undefined;
}

/** „Pamätať pre dodávateľa": zapne uloží dôvod, vypne ho zabudne. */
export async function ulozPamatDodavatela(
  db: Queryable,
  vstup: { tenantId: string; organizationId: string; userId: string; extracted: unknown; pamat?: PamatDodavatela },
): Promise<void> {
  const kluc = klucDodavatela(vstup.extracted);
  if (!kluc) return;
  if (!vstup.pamat) {
    await db.query('DELETE FROM samozdanenie_dodavatelia WHERE tenant_id=$1 AND organization_id=$2 AND dodavatel_kluc=$3',
      [vstup.tenantId, vstup.organizationId, kluc]);
    return;
  }
  await db.query(
    `INSERT INTO samozdanenie_dodavatelia (organization_id, tenant_id, dodavatel_kluc, dodavatel_nazov, volba, dovod, dovod_text, zapisal)
     VALUES ($1,$2,$3,$4,'nevznika',$5,$6,$7)
     ON CONFLICT (organization_id, dodavatel_kluc) DO UPDATE SET dodavatel_nazov=excluded.dodavatel_nazov,
       dovod=excluded.dovod, dovod_text=excluded.dovod_text, zapisal=excluded.zapisal, updated_at=now()`,
    [vstup.organizationId, vstup.tenantId, kluc, (vstup.extracted as any)?.dodavatel?.nazov ?? null,
      vstup.pamat.dovod, vstup.pamat.dovodText ?? null, vstup.userId],
  );
}

/** Stav bloku pre uložený doklad — profil klienta a pamäť dodávateľa z databázy. */
export async function stavSamozdaneniaDokladu(
  db: Queryable,
  tenantId: string,
  document: { organization_id: string; document_type: string; podtyp?: string | null; extracted: unknown; samozdanenie?: Partial<Samozdanenie> | null },
  profilDokladu?: DphProfil,
): Promise<(StavSamozdanenia & { profil: DphProfil; pamat?: PamatDodavatela }) | undefined> {
  const firma = { tenantId, organizationId: document.organization_id };
  const profil = profilDokladu ?? await loadDphProfil(db, tenantId, firma.organizationId) ?? predvolenyDphProfil(tenantId, firma.organizationId);
  const extracted = (document.extracted ?? {}) as Record<string, unknown>;
  const datumPraxe = typeof extracted.datumDodania === 'string' ? extracted.datumDodania
    : typeof extracted.datumVystavenia === 'string' ? extracted.datumVystavenia : undefined;
  const [pamat, praxDodavatela] = await Promise.all([
    nacitajPamatDodavatela(db, firma, document.extracted),
    praxSamozdaneniaDodavatela(db, firma, document.extracted, datumPraxe),
  ]);
  const stav = zostavSamozdanenie({
    documentType: document.document_type, podtyp: document.podtyp, extracted,
    profil, pamat, praxDodavatela, ulozene: document.samozdanenie,
  });
  return stav && { ...stav, profil, ...(pamat ? { pamat } : {}) };
}

/** Položka dataPacku interného dokladu: `<id dokladu>-sz-dd` (vymeranie) a `-sz-p` (odpočet). */
export const ID_INTERNEHO = /^(.+)-sz-(dd|p)$/;

/**
 * Položky prenosu, za ktoré Mostík hlási výsledok — tak, ako sú v dataPacku:
 * faktúra už prijatá v POHODE sa pri opakovaní neposiela, interné doklady áno.
 */
export function polozkyPrenosu(documentIds: readonly string[], requestXml: string): Set<string> {
  const vBaliku = [...requestXml.matchAll(/<dat:dataPackItem id="([^"]+)"/g)].map((zhoda) => zhoda[1]);
  return new Set(vBaliku.filter((id) => documentIds.includes(id) || documentIds.includes(ID_INTERNEHO.exec(id)?.[1] ?? '')));
}

/**
 * Výsledok prenosu faktúry so samozdanením po dokladoch do samozdanenie.export.
 * Nepotvrdený interný doklad vráti faktúru do stavu „chyba", aby sa dal prenos
 * zopakovať; keď sú potvrdené všetky časti, doklad je exportovaný.
 */
export async function zapisPrenosSamozdanenia(
  tx: Queryable,
  vstup: {
    tenantId: string; organizationId: string;
    perDocument: Array<{ documentId: string; state: 'ok' | 'warning' | 'error'; pohodaNumber?: string; message?: string }>;
  },
): Promise<void> {
  const at = new Date().toISOString();
  const dotknute = new Set<string>();
  for (const item of vstup.perDocument) {
    const interny = ID_INTERNEHO.exec(item.documentId);
    const documentId = interny?.[1] ?? item.documentId;
    const stav = {
      stav: item.state === 'error' ? 'chyba' : item.state, at,
      ...(item.pohodaNumber ? { cislo: item.pohodaNumber } : {}), ...(item.message ? { sprava: item.message } : {}),
    };
    const nazov = interny?.[2] === 'p' ? 'odpočet' : 'vymeranie';
    const zapis = await tx.query(
      `UPDATE documents SET samozdanenie = jsonb_set(samozdanenie, '{export}',
                coalesce(samozdanenie->'export', '{}'::jsonb) || jsonb_build_object($1::text, $2::jsonb)),
              history = CASE WHEN $6::boolean THEN history || $7::jsonb ELSE history END, updated_at=now()
        WHERE id=$3 AND tenant_id=$4 AND organization_id=$5 AND samozdanenie->>'volba'='vytvorit'`,
      [interny?.[2] ?? 'faktura', JSON.stringify(stav), documentId, vstup.tenantId, vstup.organizationId, Boolean(interny),
        JSON.stringify([{ ts: at, user: 'POHODA', akcia: item.state === 'ok'
          ? `Interný doklad samozdanenia (${nazov}) potvrdený${item.pohodaNumber ? ` č. ${item.pohodaNumber}` : ''}`
          : `Interný doklad samozdanenia (${nazov}) nebol prenesený: ${item.message ?? 'Neznáma chyba'}` }])],
    );
    if (zapis.rowCount > 0) dotknute.add(documentId);
  }
  for (const documentId of dotknute) {
    const riadok = (await tx.query<{ status: string; samozdanenie: Samozdanenie } & Record<string, unknown>>(
      'SELECT status, samozdanenie FROM documents WHERE id=$1 AND tenant_id=$2', [documentId, vstup.tenantId],
    )).rows[0];
    const vysledky = riadok.samozdanenie.export ?? {};
    const casti: RolaPrenosu[] = ['faktura', 'dd', ...((riadok.samozdanenie.odpocet ?? 0) > 0 ? ['p' as const] : [])];
    const status = casti.every((cast) => vysledky[cast]?.stav === 'ok') ? 'exportovany'
      : (['dd', 'p'] as const).some((cast) => vysledky[cast] && vysledky[cast]!.stav !== 'ok') ? 'chyba' : riadok.status;
    if (status !== riadok.status) {
      await tx.query('UPDATE documents SET status=$1, updated_at=now() WHERE id=$2 AND tenant_id=$3', [status, documentId, vstup.tenantId]);
    }
  }
}

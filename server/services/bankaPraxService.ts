import { randomUUID } from 'node:crypto';
import type { Queryable } from '../db/database.js';
import { HttpError } from '../http.js';
import { normalizeName } from './accountingSuggestionService.js';

/**
 * Prax banky z účtovného denníka POHODY (agenda Banka): na aký protiúčet firma
 * účtuje pohyby partnera, alebo pohyby bez partnera s rovnakým textom (poplatky,
 * daň, úroky). Denník nenesie IBAN ani VS — kľúčom je partner (IČO, inak meno)
 * alebo opakované slová textu, vždy so smerom. Bez modelu; výpis z nej dostane
 * návrh predkontácie a AI rieši len zvyšok.
 */

type Firma = { tenantId: string; organizationId: string };
export type SmerBanky = 'prijem' | 'vydaj';
export type StavPraxeBanky = 'navrhnute' | 'potvrdene' | 'zamietnute';

// Prah z analýzy etapy 4 (Q04/Q05): aspoň 5 riadkov a vedúci protiúčet ≥ 90 %.
export const BANKA_MIN_RIADKOV = 5;
export const BANKA_MIN_PODIEL = 0.9;
const AGENDA_BANKA = 'Banka';
const AGENDA_SMERU: Record<SmerBanky, string> = { prijem: 'bankReceived', vydaj: 'bankIssued' };

export interface RiadokBanky {
  datum?: string;
  text?: string;
  suma?: number;
  ucetMd: string;
  ucetDal: string;
  partnerIco?: string;
  partnerNazov?: string;
}

export interface BankovaPredkontacia { kod: string; agenda: string; ucetMd?: string; ucetDal?: string }

export interface DokazBanky {
  riadkov: number;
  /** Podiel vedúceho protiúčtu. */
  podiel: number;
  od?: string;
  do?: string;
  protiucet: string;
  /** Kódy bankových predkontácií so smerom a protiúčtom praxe. */
  kandidati: string[];
}

export interface PraxBanky {
  kluc: string;
  smer: SmerBanky;
  partnerIco?: string;
  /** Normalizované mená partnera, najčastejšie prvé. */
  partnerMena: string[];
  slova: string[];
  protiucet: string;
  /** Len jediný kandidát — z viacerých sa automaticky nevyberá. */
  predkontaciaKod?: string;
  dokaz: DokazBanky;
}

export interface UlozenaPraxBanky extends Omit<PraxBanky, 'dokaz'> {
  id: string;
  stav: StavPraxeBanky;
  /** Chýba, keď história prax už nedrží. */
  dokaz?: DokazBanky;
  /** Meno používateľa, nie id. */
  potvrdil?: string;
  potvrdeneAt?: string;
}

const jeBanka = (ucet: string | undefined) => (ucet ?? '').trim().startsWith('221');

/** Slová textu bez diakritiky, čísel a skratiek pod 3 znaky — kľúč pohybu bez partnera. */
export function slovaTextu(text: string | undefined): string[] {
  return [...new Set((text ?? '').normalize('NFD').replace(/\p{M}/gu, '').toLocaleLowerCase('sk')
    .split(/[^\p{L}\p{N}]+/u).filter((slovo) => slovo.length >= 3 && !/\d/.test(slovo)))].sort();
}

/**
 * Bankové predkontácie pre smer a protiúčet: agenda podľa smeru, nebanková
 * strana presne, banková strana 221 len ako rola (šablóna 221000, denník 221100).
 */
export function kandidatiBanky(predkontacie: readonly BankovaPredkontacia[], smer: SmerBanky, protiucet: string): string[] {
  return [...new Set(predkontacie
    .filter((p) => p.agenda === AGENDA_SMERU[smer] && (smer === 'prijem'
      ? jeBanka(p.ucetMd) && p.ucetDal?.trim() === protiucet
      : jeBanka(p.ucetDal) && p.ucetMd?.trim() === protiucet))
    .map((p) => p.kod.trim()))].sort();
}

/** Pohyb banky z riadku denníka: práve jedna strana 221 a kladná suma, inak nič. */
function pohybRiadka(riadok: RiadokBanky) {
  const md = jeBanka(riadok.ucetMd);
  if (md === jeBanka(riadok.ucetDal) || !(Number(riadok.suma) > 0)) return undefined;
  const smer: SmerBanky = md ? 'prijem' : 'vydaj';
  const protiucet = (md ? riadok.ucetDal : riadok.ucetMd).trim();
  const ico = (riadok.partnerIco ?? '').replace(/\D/g, '');
  const meno = normalizeName(riadok.partnerNazov);
  const slova = ico || meno ? [] : slovaTextu(riadok.text);
  const kluc = ico ? `ico:${ico}` : meno ? `meno:${meno}` : slova.length > 0 ? `text:${slova.join(' ')}` : undefined;
  return kluc ? { kluc: `${kluc}:${smer}`, smer, protiucet, ico, meno, slova } : undefined;
}

interface Skupina {
  smer: SmerBanky;
  ico: string;
  slova: string[];
  mena: Map<string, number>;
  protiucty: Map<string, number>;
  riadkov: number;
  od?: string;
  do?: string;
}
type Skupiny = Map<string, Skupina>;

const podlaPoctu = (mapa: Map<string, number>) =>
  [...mapa].sort(([a, x], [b, y]) => y - x || (a < b ? -1 : a > b ? 1 : 0));

function pridajRiadok(skupiny: Skupiny, riadok: RiadokBanky) {
  const pohyb = pohybRiadka(riadok);
  if (!pohyb) return;
  let skupina = skupiny.get(pohyb.kluc);
  if (!skupina) {
    skupiny.set(pohyb.kluc, skupina = { smer: pohyb.smer, ico: pohyb.ico, slova: pohyb.slova, mena: new Map(), protiucty: new Map(), riadkov: 0 });
  }
  skupina.riadkov += 1;
  skupina.protiucty.set(pohyb.protiucet, (skupina.protiucty.get(pohyb.protiucet) ?? 0) + 1);
  if (pohyb.meno) skupina.mena.set(pohyb.meno, (skupina.mena.get(pohyb.meno) ?? 0) + 1);
  if (riadok.datum && (!skupina.od || riadok.datum < skupina.od)) skupina.od = riadok.datum;
  if (riadok.datum && (!skupina.do || riadok.datum > skupina.do)) skupina.do = riadok.datum;
}

/**
 * Textová prax sa použije na každý text, ktorý obsahuje jej slová — dôkaz preto
 * ráta všetky riadky smeru bez partnera aj so slovami navyše. Iný protiúčet
 * dlhšieho textu tak širšiu prax zhodí, aj keď sám prah nedosiahne.
 */
function sNadmnozinami(skupiny: Skupiny, skupina: Skupina): Skupina {
  if (skupina.slova.length === 0) return skupina;
  const spolu: Skupina = { ...skupina, protiucty: new Map(), riadkov: 0 };
  // ponytail: O(k²) cez texty bez partnera (v produkcii do ~100 na firmu), index slov až keď to spomalí meranie.
  for (const ina of skupiny.values()) {
    if (ina.smer !== skupina.smer || ina.slova.length === 0 || !skupina.slova.every((slovo) => ina.slova.includes(slovo))) continue;
    spolu.riadkov += ina.riadkov;
    for (const [protiucet, pocet] of ina.protiucty) spolu.protiucty.set(protiucet, (spolu.protiucty.get(protiucet) ?? 0) + pocet);
    if (ina.od && (!spolu.od || ina.od < spolu.od)) spolu.od = ina.od;
    if (ina.do && (!spolu.do || ina.do > spolu.do)) spolu.do = ina.do;
  }
  return spolu;
}

function praxZoSkupin(skupiny: Skupiny, predkontacie: readonly BankovaPredkontacia[]): PraxBanky[] {
  const praxe: PraxBanky[] = [];
  for (const [kluc, vlastna] of skupiny) {
    const skupina = sNadmnozinami(skupiny, vlastna);
    if (skupina.riadkov < BANKA_MIN_RIADKOV) continue;
    const [protiucet, pocet] = podlaPoctu(skupina.protiucty)[0];
    const podiel = pocet / skupina.riadkov;
    if (podiel < BANKA_MIN_PODIEL) continue;
    const kandidati = kandidatiBanky(predkontacie, skupina.smer, protiucet);
    praxe.push({
      kluc, smer: skupina.smer, ...(skupina.ico ? { partnerIco: skupina.ico } : {}),
      partnerMena: podlaPoctu(skupina.mena).map(([meno]) => meno), slova: skupina.slova, protiucet,
      ...(kandidati.length === 1 ? { predkontaciaKod: kandidati[0] } : {}),
      dokaz: { riadkov: skupina.riadkov, podiel, ...(skupina.od ? { od: skupina.od, do: skupina.do } : {}), protiucet, kandidati },
    });
  }
  return praxe.sort((a, b) => b.dokaz.riadkov - a.dokaz.riadkov || (a.kluc < b.kluc ? -1 : 1));
}

/** Ustálená prax banky z riadkov denníka (≥ 5 riadkov, vedúci protiúčet ≥ 90 %). */
export function odvodPraxBanky(riadky: readonly RiadokBanky[], predkontacie: readonly BankovaPredkontacia[]): PraxBanky[] {
  const skupiny: Skupiny = new Map();
  for (const riadok of riadky) pridajRiadok(skupiny, riadok);
  return praxZoSkupin(skupiny, predkontacie);
}

type PraxNaZhodu = Pick<UlozenaPraxBanky, 'smer' | 'partnerIco' | 'partnerMena' | 'slova' | 'predkontaciaKod'> & { stav?: StavPraxeBanky };

/**
 * Kód predkontácie pohybu z praxe. Pohyb s protistranou sa páruje menom alebo
 * IČO, pohyb bez nej slovami textu (všetky slová praxe v texte). Užšia textová
 * prax prebije širšiu, aj zamietnutá či bez kódu. Zamietnutá prax sa nepoužije,
 * potvrdená má prednosť; rôzne kódy = žiadny návrh.
 */
export function predkontaciaZPraxe(
  praxe: readonly PraxNaZhodu[],
  pohyb: { suma: number; protistrana?: string; ico?: string; text?: string },
): string | undefined {
  const smer: SmerBanky | undefined = pohyb.suma > 0 ? 'prijem' : pohyb.suma < 0 ? 'vydaj' : undefined;
  if (!smer) return undefined;
  const ico = (pohyb.ico ?? '').replace(/\D/g, '');
  const meno = normalizeName(pohyb.protistrana);
  const slova = new Set(ico || meno ? [] : slovaTextu(pohyb.text));
  const zhody = praxe.filter((prax) => prax.smer === smer && (ico || meno
    ? (ico !== '' && prax.partnerIco === ico) || (meno !== '' && prax.partnerMena.includes(meno))
    : prax.slova.length > 0 && prax.slova.every((slovo) => slova.has(slovo))));
  const platne = zhody.filter((prax) => prax.stav !== 'zamietnute' && prax.predkontaciaKod
    && !zhody.some((uzsia) => uzsia.slova.length > prax.slova.length && prax.slova.every((slovo) => uzsia.slova.includes(slovo))));
  const potvrdene = platne.filter((prax) => prax.stav === 'potvrdene');
  const kody = new Set((potvrdene.length > 0 ? potvrdene : platne).map((prax) => prax.predkontaciaKod));
  return kody.size === 1 ? [...kody][0] : undefined;
}

async function nacitajPodklady(db: Queryable, firma: Firma) {
  const riadky = (await db.query<Record<string, any>>(
    `SELECT datum::text AS datum, text, suma, ucet_md, ucet_dal, partner_ico, partner_nazov FROM ucto_dennik
      WHERE tenant_id=$1 AND organization_id=$2 AND agenda=$3 ORDER BY datum NULLS LAST, externalny_id`,
    [firma.tenantId, firma.organizationId, AGENDA_BANKA],
  )).rows.map((row): RiadokBanky => ({
    datum: row.datum ?? undefined, text: row.text ?? undefined, suma: row.suma === null ? undefined : Number(row.suma),
    ucetMd: row.ucet_md, ucetDal: row.ucet_dal, partnerIco: row.partner_ico ?? undefined, partnerNazov: row.partner_nazov ?? undefined,
  }));
  const predkontacie = (await db.query<Record<string, any>>(
    `SELECT btrim(code) AS kod, agenda, ucet_md, ucet_dal FROM code_list_items
      WHERE tenant_id=$1 AND organization_id=$2 AND kind='predkontacie' AND active=true AND agenda IN ('bankReceived','bankIssued')`,
    [firma.tenantId, firma.organizationId],
  )).rows.map((row): BankovaPredkontacia => ({ kod: row.kod, agenda: row.agenda, ucetMd: row.ucet_md ?? undefined, ucetDal: row.ucet_dal ?? undefined }));
  return { riadky, predkontacie };
}

/**
 * Prepočet praxe banky pod zámkom praxe firmy (transakciu drží volajúci).
 * Navrhnutú prax prepíše; potvrdenej a zamietnutej dá len čerstvý dôkaz.
 */
export async function prepocitajPraxBanky(tx: Queryable, firma: Firma): Promise<{ praxi: number }> {
  const { riadky, predkontacie } = await nacitajPodklady(tx, firma);
  const praxe = odvodPraxBanky(riadky, predkontacie);
  for (const prax of praxe) {
    await tx.query(
      `INSERT INTO banka_prax (id, organization_id, tenant_id, kluc, smer, partner_ico, partner_mena, slova, stav, protiucet, predkontacia_kod, dokaz)
       VALUES ($1,$2,$3,$4,$5,$6,$7::text[],$8::text[],'navrhnute',$9,$10,$11::jsonb)
       ON CONFLICT (organization_id, kluc) DO UPDATE SET partner_mena=excluded.partner_mena, dokaz=excluded.dokaz, updated_at=now(),
         protiucet=CASE WHEN banka_prax.stav='navrhnute' THEN excluded.protiucet ELSE banka_prax.protiucet END,
         predkontacia_kod=CASE WHEN banka_prax.stav='navrhnute' THEN excluded.predkontacia_kod ELSE banka_prax.predkontacia_kod END`,
      [randomUUID(), firma.organizationId, firma.tenantId, prax.kluc, prax.smer, prax.partnerIco ?? null, prax.partnerMena, prax.slova,
        prax.protiucet, prax.predkontaciaKod ?? null, JSON.stringify(prax.dokaz)],
    );
  }
  const kluce = praxe.map((prax) => prax.kluc);
  await tx.query(
    `DELETE FROM banka_prax WHERE tenant_id=$1 AND organization_id=$2 AND stav='navrhnute' AND kluc <> ALL($3::text[])`,
    [firma.tenantId, firma.organizationId, kluce],
  );
  await tx.query(
    `UPDATE banka_prax SET dokaz=NULL, updated_at=now()
      WHERE tenant_id=$1 AND organization_id=$2 AND stav <> 'navrhnute' AND dokaz IS NOT NULL AND kluc <> ALL($3::text[])`,
    [firma.tenantId, firma.organizationId, kluce],
  );
  return { praxi: praxe.length };
}

export async function nacitajPraxBanky(db: Queryable, firma: Firma): Promise<UlozenaPraxBanky[]> {
  return (await db.query<Record<string, any>>(
    `SELECT b.id, b.kluc, b.smer, b.partner_ico, b.partner_mena, b.slova, b.stav, b.protiucet, b.predkontacia_kod, b.dokaz,
            u.name AS potvrdil, b.potvrdene_at
       FROM banka_prax b LEFT JOIN users u ON u.id = b.potvrdil
      WHERE b.tenant_id=$1 AND b.organization_id=$2
      ORDER BY coalesce((b.dokaz->>'riadkov')::int, 0) DESC, b.kluc`,
    [firma.tenantId, firma.organizationId],
  )).rows.map((row): UlozenaPraxBanky => ({
    id: row.id, kluc: row.kluc, smer: row.smer, stav: row.stav, protiucet: row.protiucet,
    partnerMena: row.partner_mena ?? [], slova: row.slova ?? [],
    ...(row.partner_ico ? { partnerIco: row.partner_ico } : {}),
    ...(row.predkontacia_kod ? { predkontaciaKod: row.predkontacia_kod } : {}),
    ...(row.dokaz ? { dokaz: row.dokaz } : {}),
    ...(row.potvrdil ? { potvrdil: row.potvrdil } : {}),
    ...(row.potvrdene_at ? { potvrdeneAt: new Date(row.potvrdene_at).toISOString() } : {}),
  }));
}

/**
 * Rozhodnutie účtovníka o praxi banky. Potvrdiť sa dá len kandidátom z posledného
 * prepočtu, ktorý je stále aktívny v agende smeru — zlý smer ani cudzí protiúčet nikdy.
 */
export async function rozhodniPraxBanky(
  tx: Queryable,
  firma: Firma & { userId: string },
  id: string,
  telo: { stav: 'potvrdene'; predkontaciaKod: string } | { stav: 'zamietnute' },
): Promise<Record<string, unknown>> {
  const prax = (await tx.query<Record<string, any>>(
    'SELECT kluc, smer, dokaz FROM banka_prax WHERE id=$1 AND tenant_id=$2 AND organization_id=$3 FOR UPDATE',
    [id, firma.tenantId, firma.organizationId],
  )).rows[0];
  if (!prax) throw new HttpError(404, 'banka_prax_neznama', 'Taká prax banky neexistuje');
  const kod = telo.stav === 'potvrdene' ? telo.predkontaciaKod.trim() : null;
  if (kod !== null) {
    const platny = (prax.dokaz?.kandidati ?? []).includes(kod) && (await tx.query(
      `SELECT 1 FROM code_list_items WHERE tenant_id=$1 AND organization_id=$2 AND kind='predkontacie' AND active=true
          AND agenda=$3 AND btrim(code)=$4`,
      [firma.tenantId, firma.organizationId, AGENDA_SMERU[prax.smer as SmerBanky], kod],
    )).rows.length > 0;
    if (!platny) throw new HttpError(400, 'banka_prax_kod_neplatny', 'Predkontácia nie je bankovou predkontáciou tejto praxe v číselníku firmy');
  }
  await tx.query(
    `UPDATE banka_prax SET stav=$4::text, potvrdil=$6, potvrdene_at=now(), updated_at=now(),
       predkontacia_kod=CASE WHEN $5::text IS NULL THEN predkontacia_kod ELSE $5::text END,
       protiucet=CASE WHEN $5::text IS NULL THEN protiucet ELSE dokaz->>'protiucet' END
      WHERE id=$1 AND tenant_id=$2 AND organization_id=$3`,
    [id, firma.tenantId, firma.organizationId, telo.stav, kod, firma.userId],
  );
  return { id, kluc: prax.kluc, stav: telo.stav, ...(kod ? { predkontaciaKod: kod } : {}) };
}

export interface MeranieBanky {
  /** Riadky denníka s jednou stranou 221, kladnou sumou a dátumom. */
  riadkov: number;
  navrhnutych: number;
  spravnych: number;
  /** Z toho pohyby bez partnera, párované slovami textu. */
  navrhnutychZTextu: number;
  spravnychZTextu: number;
}

/**
 * Replay praxe banky po riadkoch denníka (ako Q05): riadok vidí len prax
 * z dátumov PRED svojím dňom. Návrh je predkontácia z praxe, správny keď je
 * kandidátom pre skutočný smer a protiúčet riadku. Nič nezapisuje.
 */
export async function zmerajPraxBanky(db: Queryable, firma: Firma): Promise<MeranieBanky> {
  const { riadky, predkontacie } = await nacitajPodklady(db, firma);
  const vysledok: MeranieBanky = { riadkov: 0, navrhnutych: 0, spravnych: 0, navrhnutychZTextu: 0, spravnychZTextu: 0 };
  const skupiny: Skupiny = new Map();
  let praxe: PraxBanky[] = [];
  let den: string | undefined;
  let dnesne: RiadokBanky[] = [];
  // Riadky idú zoradené podľa dátumu; deň sa do praxe pridá až po vyhodnotení celého dňa.
  for (const riadok of riadky) {
    const pohyb = pohybRiadka(riadok);
    if (!riadok.datum || !pohyb) continue;
    if (riadok.datum !== den) {
      for (const predosly of dnesne) pridajRiadok(skupiny, predosly);
      dnesne = [];
      praxe = praxZoSkupin(skupiny, predkontacie);
      den = riadok.datum;
    }
    dnesne.push(riadok);
    vysledok.riadkov += 1;
    const kod = predkontaciaZPraxe(praxe, {
      suma: pohyb.smer === 'prijem' ? 1 : -1, protistrana: riadok.partnerNazov, ico: riadok.partnerIco, text: riadok.text,
    });
    if (!kod) continue;
    const spravny = kandidatiBanky(predkontacie, pohyb.smer, pohyb.protiucet).includes(kod);
    const zTextu = pohyb.slova.length > 0;
    vysledok.navrhnutych += 1;
    if (spravny) vysledok.spravnych += 1;
    if (zTextu) vysledok.navrhnutychZTextu += 1;
    if (zTextu && spravny) vysledok.spravnychZTextu += 1;
  }
  return vysledok;
}

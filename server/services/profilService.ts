import { randomUUID } from 'node:crypto';
import type { Queryable } from '../db/database.js';
import { HttpError } from '../http.js';
import { normalizeName, otazkaPraxe, platnyKvKod, uctyBezOdpoctu } from './accountingSuggestionService.js';
import { clenenieVyzeraNaOdpocet, EU_DPH_PREFIXY } from './dphAdvisor.js';
import { jeDovozTovaru, popisKodu } from './pohodaDphKody.js';
import { ulozPravidloProtistrany } from './pravidloProtistrany.js';
import {
  DD_REFY_SLUZBY, DD_REFY_TOVAR, kodyHodnoty, P_REFY_SAMOZDANENIA, polozkaKatalogu, REFY_VYDANYCH_DRUHOV,
  type DruhSamozdanenia,
} from './profilKatalog.js';
import { DOKLAD_KLUC_SQL, navrhyPravidielDelenia, sporPraxe, type NavrhDelenia, type PraxVariant } from './uctoPravidlaService.js';

/**
 * Profil klienta: fakty firmy (potvrdené účtovníkom alebo navrhnuté z histórie
 * POHODY) a otázky, bez ktorých sa prax firmy nedá zistiť. Odvodenie je
 * deterministické, bez modelu — rovnako ako prax protistrán.
 */

/** Od koľkých dokladov je prax firmy návrhom (rozhodnutie vlastníka o predvypĺňaní). */
export const MIN_DOKLADOV_NAVRHU = 5;

type Firma = { tenantId: string; organizationId: string };

export interface ProfilDokaz {
  dokladov: number;
  od?: string;
  do?: string;
  navrh?: unknown;
  varianty?: Array<{ hodnota: unknown; dokladov: number }>;
  priklady?: Array<{ agenda: string; cislo: string; datum: string }>;
}

export interface ProfilFakt {
  kluc: string;
  stav: 'potvrdene' | 'navrhnute' | 'nepouziva_sa';
  hodnota: unknown;
  zdroj: 'historia' | 'uctovnik' | 'migracia';
  dokaz?: ProfilDokaz;
  /** Meno používateľa, nie id. */
  potvrdil?: string;
  potvrdeneAt?: string;
  updatedAt: string;
}

export interface ProfilOtazka {
  id: string;
  kluc: string;
  druh: 'fakt' | 'spor_protistrany';
  stav: 'otvorena' | 'odlozena';
  blokuje: boolean;
  dokladov: number;
  data: unknown;
  createdAt: string;
}

export interface ProfilPayload {
  fakty: ProfilFakt[];
  otazky: ProfilOtazka[];
  navrhyDelenia: NavrhDelenia[];
  prepocitaneAt?: string;
}

const iso = (hodnota: unknown) => (hodnota ? new Date(hodnota as string | Date).toISOString() : undefined);
const porovnaj = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

export async function nacitajProfil(db: Queryable, firma: Firma): Promise<ProfilPayload> {
  const kde = [firma.tenantId, firma.organizationId];
  const fakty = (await db.query<Record<string, any>>(
    `SELECT f.kluc, f.stav, f.hodnota, f.zdroj, f.dokaz, u.name AS potvrdil, f.potvrdene_at, f.updated_at
       FROM profil_fakty f LEFT JOIN users u ON u.id = f.potvrdil
      WHERE f.tenant_id=$1 AND f.organization_id=$2 ORDER BY f.kluc`, kde,
  )).rows.map((row): ProfilFakt => ({
    kluc: row.kluc, stav: row.stav, hodnota: row.hodnota, zdroj: row.zdroj,
    ...(row.dokaz ? { dokaz: row.dokaz } : {}),
    ...(row.potvrdil ? { potvrdil: row.potvrdil } : {}),
    ...(row.potvrdene_at ? { potvrdeneAt: iso(row.potvrdene_at) } : {}),
    updatedAt: iso(row.updated_at)!,
  }));
  const otazky = (await db.query<Record<string, any>>(
    `SELECT id, kluc, druh, stav, blokuje, dokladov, data, created_at FROM profil_otazky
      WHERE tenant_id=$1 AND organization_id=$2 AND stav IN ('otvorena','odlozena')
      ORDER BY blokuje DESC, dokladov DESC, created_at, kluc`, kde,
  )).rows.map((row): ProfilOtazka => ({
    id: row.id, kluc: row.kluc, druh: row.druh, stav: row.stav, blokuje: row.blokuje === true,
    dokladov: Number(row.dokladov), data: row.data, createdAt: iso(row.created_at)!,
  }));
  // ponytail: čas prepočtu sa neukladá zvlášť — generátor pri každom behu
  // prepíše navrhnuté fakty a nezodpovedané otázky; odloženie otázky ho posunie tiež.
  const prepocitane = (await db.query<Record<string, any>>(
    `SELECT greatest(
       (SELECT max(updated_at) FROM profil_fakty WHERE tenant_id=$1 AND organization_id=$2 AND zdroj='historia'),
       (SELECT max(updated_at) FROM profil_otazky WHERE tenant_id=$1 AND organization_id=$2 AND odpovedal IS NULL)) AS at`, kde,
  )).rows[0]?.at;

  // Delenie, ktoré už je potvrdeným pravidlom vozidiel, navrhyPravidielDelenia vynechá sama.
  const navrhyDelenia = await navrhyPravidielDelenia(db, firma);
  return { fakty, otazky, navrhyDelenia, ...(prepocitane ? { prepocitaneAt: iso(prepocitane) } : {}) };
}

/**
 * Zápis faktu účtovníkom. Kód, ktorý firma v číselníku nemá (alebo už nie je
 * aktívny), engine aj tak ignoruje — preto ho server odmietne hneď, nie potichu.
 */
export async function ulozFakt(
  tx: Queryable,
  firma: Firma & { userId: string },
  kluc: string,
  telo: { stav: 'potvrdene' | 'nepouziva_sa'; hodnota?: unknown },
): Promise<unknown> {
  const polozka = polozkaKatalogu(kluc);
  if (!polozka) throw new HttpError(404, 'profil_fakt_neznamy', 'Taký fakt profil klienta nepozná');
  let hodnota: unknown = null;
  if (telo.stav === 'potvrdene') {
    const overena = polozka.schema.safeParse(telo.hodnota);
    if (!overena.success) {
      throw new HttpError(400, 'profil_hodnota_neplatna', 'Hodnota faktu nemá správny tvar', overena.error.issues);
    }
    hodnota = overena.data;
    const kody = kodyHodnoty(hodnota);
    const aktivne = new Set((await tx.query<{ kind: string; code: string } & Record<string, unknown>>(
      `SELECT kind, btrim(code) AS code FROM code_list_items
        WHERE tenant_id=$1 AND organization_id=$2 AND active=true AND kind IN ('predkontacie','cleneniaDph')
          AND btrim(code) = ANY($3::text[])`,
      [firma.tenantId, firma.organizationId, [...kody.predkontacie, ...kody.cleneniaDph]],
    )).rows.map((row) => `${row.kind}:${row.code}`));
    const neplatne = [...new Set([
      ...kody.predkontacie.filter((kod) => !aktivne.has(`predkontacie:${kod}`)),
      ...kody.cleneniaDph.filter((kod) => !aktivne.has(`cleneniaDph:${kod}`)),
      ...kody.kv.filter((kod) => platnyKvKod(kod) !== kod),
    ])];
    if (neplatne.length > 0) {
      throw new HttpError(400, 'profil_kod_neplatny', `Kódy nie sú aktívne v číselníku firmy: ${neplatne.join(', ')}`, { kody: neplatne });
    }
  }
  // Dôkaz z histórie ostáva — z neho sa pozná, či potvrdená hodnota s praxou nesedí.
  await tx.query(
    `INSERT INTO profil_fakty (organization_id, tenant_id, kluc, stav, hodnota, zdroj, potvrdil, potvrdene_at, updated_at)
     VALUES ($1,$2,$3,$4,$5::jsonb,'uctovnik',$6,now(),now())
     ON CONFLICT (organization_id, kluc) DO UPDATE SET stav=excluded.stav, hodnota=excluded.hodnota, zdroj='uctovnik',
       potvrdil=excluded.potvrdil, potvrdene_at=now(), updated_at=now()`,
    [firma.organizationId, firma.tenantId, kluc, telo.stav, hodnota === null ? null : JSON.stringify(hodnota), firma.userId],
  );
  await tx.query(
    `UPDATE profil_otazky SET stav='zodpovedana', odpoved=$4::jsonb, odpovedal=$5, odpovedane_at=now(), updated_at=now()
      WHERE tenant_id=$1 AND organization_id=$2 AND kluc=$3`,
    [firma.tenantId, firma.organizationId, `fakt:${kluc}`, JSON.stringify({ stav: telo.stav, hodnota }), firma.userId],
  );
  return hodnota;
}

export type OdpovedOtazky = { akcia: 'variant'; index: number } | { akcia: 'ine'; text: string } | { akcia: 'neskor' };

/**
 * Odpoveď na otázku z profilu. Vráti metadáta auditu, alebo undefined pri
 * odložení (to nemení nič, podľa čoho sa účtuje).
 */
export async function odpovedzOtazke(
  tx: Queryable,
  firma: Firma & { userId: string; correlationId: string },
  otazkaId: string,
  odpoved: OdpovedOtazky,
): Promise<Record<string, unknown> | undefined> {
  const otazka = (await tx.query<Record<string, any>>(
    'SELECT id, kluc, druh, stav, data FROM profil_otazky WHERE id=$1 AND tenant_id=$2 AND organization_id=$3 FOR UPDATE',
    [otazkaId, firma.tenantId, firma.organizationId],
  )).rows[0];
  if (!otazka) throw new HttpError(404, 'profil_otazka_neznama', 'Otázka neexistuje');
  if (otazka.stav !== 'otvorena' && otazka.stav !== 'odlozena') {
    throw new HttpError(409, 'profil_otazka_zastarana', 'Otázka už nie je otvorená');
  }
  const data = (otazka.data ?? {}) as Record<string, any>;
  const zodpovedaj = (obsah: Record<string, unknown>) => tx.query(
    `UPDATE profil_otazky SET stav='zodpovedana', odpoved=$2::jsonb, odpovedal=$3, odpovedane_at=now(), updated_at=now()
      WHERE id=$1`,
    [otazkaId, JSON.stringify(obsah), firma.userId],
  );

  if (odpoved.akcia === 'neskor') {
    await tx.query(`UPDATE profil_otazky SET stav='odlozena', updated_at=now() WHERE id=$1`, [otazkaId]);
    return undefined;
  }
  if (odpoved.akcia === 'variant') {
    // Fakt má vlastný tvar hodnoty — ten ide cez zápis faktu, nie cez výber podoby.
    const variant = otazka.druh === 'spor_protistrany' && Array.isArray(data.varianty) ? data.varianty[odpoved.index] : undefined;
    if (!variant) throw new HttpError(400, 'profil_akcia_neplatna', 'Otázka takú možnosť nemá');
    const pravidlo = await ulozPravidloProtistrany(tx, {
      tenantId: firma.tenantId, organizationId: firma.organizationId, userId: firma.userId, correlationId: firma.correlationId,
      ico: String(data.protistranaIco ?? '').replace(/\D/g, ''), nazov: normalizeName(data.protistrana),
      predkontaciaId: variant.predkontaciaId, clenenieDphId: variant.clenenieDphId, clenenieKvKod: variant.clenenieKvKod,
      zdroj: 'otázka v profile klienta',
    });
    // Číselník sa medzičasom zmenil — podoby treba spočítať znova, nie hádať.
    if (!pravidlo) throw new HttpError(409, 'profil_otazka_zastarana', 'Predkontácia alebo členenie možnosti už nie je aktívne v číselníku firmy');
    await zodpovedaj({ index: odpoved.index, ruleId: pravidlo.ruleId });
    return { otazkaId, kluc: otazka.kluc, akcia: odpoved.akcia, ...pravidlo };
  }
  const nazov = otazka.druh === 'spor_protistrany'
    ? `Prax protistrany ${data.protistrana} (${data.agenda})`
    : `Profil klienta: ${String(otazka.kluc).replace(/^fakt:/, '')}`;
  const instructionId = randomUUID();
  await tx.query(
    `INSERT INTO ai_instructions (id, scope, tenant_id, organization_id, nazov, text, faza, updated_by)
     VALUES ($1,'organization',$2,$3,$4,$5,'accounting',$6)`,
    [instructionId, firma.tenantId, firma.organizationId, nazov.slice(0, 120), odpoved.text, firma.userId],
  );
  await zodpovedaj({ text: odpoved.text, instructionId });
  return { otazkaId, kluc: otazka.kluc, akcia: odpoved.akcia, instructionId };
}

interface RiadokKorpusu {
  idx: number;
  dph?: string;
  kv?: string;
  sadzba?: number;
}

interface Doklad {
  kluc: string;
  agenda: string;
  cislo: string;
  datum: string;
  protistrana?: string;
  hlavicka?: RiadokKorpusu;
  riadky: RiadokKorpusu[];
}

type Navrh = { hodnota: unknown; dokaz: ProfilDokaz };

/** Hodnoty podľa počtu dokladov, najčastejšia prvá. Doklad sa v jednej hodnote ráta raz. */
function podlaDokladov<T>(vyskyty: Array<{ hodnota: T; doklad: Doklad }>) {
  const skupiny = new Map<string, { hodnota: T; doklady: Set<Doklad> }>();
  for (const { hodnota, doklad } of vyskyty) {
    const kluc = JSON.stringify(hodnota);
    const skupina = skupiny.get(kluc) ?? { hodnota, doklady: new Set<Doklad>() };
    skupina.doklady.add(doklad);
    skupiny.set(kluc, skupina);
  }
  return [...skupiny.entries()]
    .sort(([klucA, a], [klucB, b]) => b.doklady.size - a.doklady.size || porovnaj(klucA, klucB))
    .map(([, skupina]) => skupina);
}

function dokaz(
  doklady: Iterable<Doklad>,
  navrh: unknown,
  varianty: Array<{ hodnota: unknown; doklady: Set<Doklad> }> = [],
): ProfilDokaz {
  const zoznam = [...new Set(doklady)].sort((a, b) => porovnaj(b.datum, a.datum) || porovnaj(a.kluc, b.kluc));
  const datumy = zoznam.map((doklad) => doklad.datum).filter(Boolean);
  return {
    dokladov: zoznam.length,
    ...(datumy.length > 0 ? { od: datumy[datumy.length - 1], do: datumy[0] } : {}),
    navrh,
    ...(varianty.length > 1 ? { varianty: varianty.map((variant) => ({ hodnota: variant.hodnota, dokladov: variant.doklady.size })) } : {}),
    priklady: zoznam.slice(0, 3).map((doklad) => ({ agenda: doklad.agenda, cislo: doklad.cislo, datum: doklad.datum })),
  };
}

/**
 * Sedí návrh z histórie s potvrdenou hodnotou? Polia sa porovnávajú ako množiny;
 * pri objekte rozhodujú polia návrhu — potvrdená hodnota smie niesť viac
 * (koeficient, KV, ktoré história nepozná), ale nie niečo iné.
 */
function zhodne(navrh: unknown, hodnota: unknown): boolean {
  if (Array.isArray(navrh)) {
    return Array.isArray(hodnota)
      && navrh.every((a) => hodnota.some((b) => zhodne(a, b))) && hodnota.every((b) => navrh.some((a) => zhodne(a, b)));
  }
  if (navrh && typeof navrh === 'object') {
    return Boolean(hodnota) && typeof hodnota === 'object' && !Array.isArray(hodnota)
      && Object.entries(navrh).every(([pole, cast]) => zhodne(cast, (hodnota as Record<string, unknown>)[pole]));
  }
  return navrh === hodnota;
}

/** Faktúra dodávateľa (aj jej podtypy) a ostatný záväzok. */
const naFakture = (agenda: string) => agenda === 'OZ' || agenda === 'FP' || agenda.startsWith('FP-');
/** Oslobodené plnenia na vydanej strane mimo prefixu UK. */
const OSLOBODENE_U = ['UNodpBez', 'UNodpS', 'UNoslob', 'UNodpBez-OsU'];
/** Slovenské sadzby DPH naprieč rokmi — iná sadzba na položke je cudzia daň. */
const SK_SADZBY = [0, 5, 10, 19, 20, 23];
/** Od koľkých dokladov s cudzou daňou sa pýtame na jej vrátenie (§55a). */
const VRATENIE_DPH_OD = 3;
/** Koľko dokladov s odpočtom bez jediného krátenia stačí na návrh „nemá oslobodené plnenia". */
const BEZ_OSLOBODENYCH_OD = 20;
/** Od koľkých riadkov denníka na účte 139 firma tovar na ceste účtuje. */
const TOVAR_NA_CESTE_OD = 3;

/**
 * Návrhy faktov z histórie a otázky účtovníkovi. Beží na konci prepocitajPrax
 * a z tlačidla „Prepočítať" — vždy pod zámkom praxe firmy, transakciu drží
 * volajúci. Potvrdenú hodnotu nikdy neprepíše, len jej dá čerstvý dôkaz.
 */
export async function aktualizujProfil(tx: Queryable, firma: Firma): Promise<{ navrhnutych: number; otazok: number }> {
  const kde = [firma.tenantId, firma.organizationId];
  const doklady = new Map<string, Doklad>();
  /** Krajina protistrany zo všetkých jej riadkov — interný doklad adresu nemá. */
  const krajiny = new Map<string, string>();
  for (const row of (await tx.query<Record<string, any>>(
    `SELECT ${DOKLAD_KLUC_SQL} AS doklad_kluc, agenda, coalesce(doklad_cislo, '') AS cislo, coalesce(datum::text, '') AS datum,
            coalesce(riadok_index, 0) AS idx, coalesce(nullif(supplier_ico, ''), supplier_name_normalized) AS protistrana,
            nullif(upper(btrim(krajina)), '') AS krajina, nullif(btrim(clenenie_dph_kod), '') AS dph,
            nullif(btrim(clenenie_kv_kod), '') AS kv, sadzba_dph
       FROM ucto_historia
      WHERE tenant_id=$1 AND organization_id=$2 AND source <> 'decisions'`, kde,
  )).rows) {
    let doklad = doklady.get(row.doklad_kluc);
    if (!doklad) {
      doklady.set(row.doklad_kluc, doklad = { kluc: row.doklad_kluc, agenda: row.agenda, cislo: row.cislo, datum: row.datum, riadky: [] });
    }
    doklad.protistrana ||= row.protistrana ?? undefined;
    const riadok: RiadokKorpusu = {
      idx: Number(row.idx), dph: row.dph ?? undefined, kv: row.kv ?? undefined,
      sadzba: row.sadzba_dph === null ? undefined : Number(row.sadzba_dph),
    };
    doklad.riadky.push(riadok);
    if (riadok.idx === 0) doklad.hlavicka = riadok;
    if (row.protistrana && row.krajina && (krajiny.get(row.protistrana) ?? '') < row.krajina) krajiny.set(row.protistrana, row.krajina);
  }
  const vsetky = [...doklady.values()];
  const kodyFirmy = (await tx.query<{ id: string; kind: string; code: string; name: string } & Record<string, unknown>>(
    `SELECT id, kind, btrim(code) AS code, name FROM code_list_items
      WHERE tenant_id=$1 AND organization_id=$2 AND active=true AND kind IN ('predkontacie','cleneniaDph')`, kde,
  )).rows;
  const fakty = new Map((await tx.query<Record<string, any>>(
    'SELECT kluc, stav, hodnota, zdroj FROM profil_fakty WHERE tenant_id=$1 AND organization_id=$2', kde,
  )).rows.map((row) => [row.kluc as string, row]));
  const rozhodnuty = (kluc: string) => ['potvrdene', 'nepouziva_sa'].includes(fakty.get(kluc)?.stav);
  const navrhy = new Map<string, Navrh>();
  const popisHlavicky = (doklad: Doklad) => popisKodu(doklad.hlavicka?.dph);

  // Registrácia DPH: daň na výstupe alebo odpočet na hlavičke. Neprítomnosť
  // kódu nie je dôkaz neplatiteľa — tam sa len pýtame.
  const sVystupom = vsetky.filter((doklad) => {
    const popis = popisHlavicky(doklad);
    return popis?.strana === 'U' && popis.riadky.some((riadok) => /^0[1-4]/.test(riadok));
  });
  const sOdpoctom = vsetky.filter((doklad) => {
    const popis = popisHlavicky(doklad);
    return popis?.strana === 'P' && popis.riadky.length > 0;
  });
  const platitel = new Set([...sVystupom, ...sOdpoctom]);
  if (platitel.size >= MIN_DOKLADOV_NAVRHU) navrhy.set('dph.status', { hodnota: { status: 'platitel' }, dokaz: dokaz(platitel, { status: 'platitel' }) });
  const statusFaktu = fakty.get('dph.status');
  // Navrhnutý z histórie, ktorý tento beh nepotvrdil, zmizne; z migrácie ostáva.
  const status = (statusFaktu?.stav === 'potvrdene' ? statusFaktu.hodnota
    : navrhy.get('dph.status')?.hodnota
      ?? (statusFaktu?.stav === 'navrhnute' && statusFaktu.zdroj !== 'historia' ? statusFaktu.hodnota : undefined)) as { status?: string } | undefined;

  if (status?.status !== 'platitel') {
    const varianty = podlaDokladov(vsetky.filter((doklad) => naFakture(doklad.agenda)).flatMap((doklad) => {
      const popis = popisHlavicky(doklad);
      return popis?.strana === 'P' && popis.riadky.length === 0 ? [{ hodnota: { clenenieKod: popis.kod }, doklad }] : [];
    }));
    if (varianty[0] && varianty[0].doklady.size >= MIN_DOKLADOV_NAVRHU) {
      navrhy.set('dph.clenenie_bez_odpoctu', { hodnota: varianty[0].hodnota, dokaz: dokaz(varianty[0].doklady, varianty[0].hodnota, varianty) });
    }
  }

  const oslobodene = vsetky.filter((doklad) => doklad.riadky.some((riadok) => {
    const popis = popisKodu(riadok.dph);
    return (popis?.strana === 'U' && (popis.kod.startsWith('UK') || OSLOBODENE_U.includes(popis.kod)))
      || (popis?.strana === 'P' && popis.kod.startsWith('PK'));
  }));
  if (oslobodene.length > 0) {
    navrhy.set('dph.oslobodene_plnenia', { hodnota: { ano: true }, dokaz: dokaz(oslobodene, { ano: true }) });
  } else if (sOdpoctom.length >= BEZ_OSLOBODENYCH_OD) {
    navrhy.set('dph.oslobodene_plnenia', { hodnota: { ano: false }, dokaz: dokaz(sOdpoctom, { ano: false }) });
  }

  // Samozdanenie prijaté: druh podľa DD kódu (služby podľa krajiny dodávateľa),
  // k nemu odpočet na internom doklade a faktúra tých istých protistrán.
  const samozdanenieMale = new Map<string, Navrh>();
  const ddVyskyty = new Map<DruhSamozdanenia, Array<{ hodnota: { ddKod: string; kv?: string }; doklad: Doklad }>>();
  for (const doklad of vsetky) {
    for (const riadok of doklad.riadky) {
      const popis = popisKodu(riadok.dph);
      if (popis?.strana !== 'DD') continue;
      const krajina = doklad.protistrana ? krajiny.get(doklad.protistrana) : undefined;
      // DD2odb a DRozdiel druh nemajú; služby bez známej krajiny sa nezaradia.
      const druh: DruhSamozdanenia | undefined = DD_REFY_TOVAR.includes(popis.ref) ? 'tovar_eu'
        : !DD_REFY_SLUZBY.includes(popis.ref) || !krajina ? undefined
          : krajina === 'SK' ? 'prenesenie_prijate' : EU_DPH_PREFIXY.includes(krajina) ? 'sluzby_eu' : 'sluzby_mimo_eu';
      if (druh) ddVyskyty.set(druh, [...(ddVyskyty.get(druh) ?? []), { hodnota: { ddKod: popis.kod, ...(riadok.kv ? { kv: riadok.kv } : {}) }, doklad }]);
    }
  }
  for (const [druh, vyskyty] of ddVyskyty) {
    const dd = podlaDokladov(vyskyty);
    const ddDoklady = new Set(vyskyty.map((vyskyt) => vyskyt.doklad));
    const protistrany = new Set([...ddDoklady].map((doklad) => doklad.protistrana).filter(Boolean));
    const ich = vsetky.filter((doklad) => doklad.protistrana && protistrany.has(doklad.protistrana));
    // Odpočet samozdanenia patrí na interný doklad, nie na faktúru — PD na
    // faktúre tej istej protistrany je bežný tuzemský nákup.
    const p = podlaDokladov(ich.filter((doklad) => !naFakture(doklad.agenda)).flatMap((doklad) => doklad.riadky
      .filter((riadok) => P_REFY_SAMOZDANENIA.includes(popisKodu(riadok.dph)?.ref ?? ''))
      .map((riadok) => ({ hodnota: { pKod: riadok.dph!, kv: riadok.kv }, doklad }))))[0]?.hodnota;
    const faktura = podlaDokladov(ich.filter((doklad) => (naFakture(doklad.agenda) || doklad.agenda === 'VPD') && doklad.hlavicka?.dph)
      .flatMap((doklad) => {
        const strana = popisHlavicky(doklad)?.strana;
        return strana === 'DD' || strana === 'U' ? []
          : [{ hodnota: { clenenieKod: doklad.hlavicka!.dph!, ...(doklad.hlavicka!.kv ? { kv: doklad.hlavicka!.kv } : {}) }, doklad }];
      }))[0]?.hodnota;
    const kv = dd[0].hodnota.kv ?? p?.kv;
    const hodnota = {
      ...(faktura ? { faktura } : {}),
      interny: { ddKod: dd[0].hodnota.ddKod, ...(p ? { pKod: p.pKod } : {}), ...(kv ? { kv } : {}) },
    };
    // Varianty dôkazu sú podľa DD kódu — ten druh určuje.
    const navrh = { hodnota, dokaz: dokaz(ddDoklady, hodnota, dd) };
    if (ddDoklady.size >= MIN_DOKLADOV_NAVRHU) navrhy.set(`samozdanenie.${druh}`, navrh);
    else samozdanenieMale.set(`samozdanenie.${druh}`, navrh);
  }

  // Druhy len s faktúrou: dovoz podľa riadku priznania, vydané podľa RefTpDph hlavičky.
  const fakturaVyskyty = new Map<string, Array<{ hodnota: { clenenieKod: string; kv?: string }; doklad: Doklad }>>();
  for (const doklad of vsetky) {
    const popis = popisHlavicky(doklad);
    if (!popis) continue;
    const druh = jeDovozTovaru(popis.kod) ? 'dovoz'
      : Object.entries(REFY_VYDANYCH_DRUHOV).find(([, refy]) => refy.includes(popis.ref))?.[0];
    if (!druh) continue;
    const kluc = `samozdanenie.${druh}`;
    fakturaVyskyty.set(kluc, [...(fakturaVyskyty.get(kluc) ?? []),
      { hodnota: { clenenieKod: popis.kod, ...(doklad.hlavicka!.kv ? { kv: doklad.hlavicka!.kv } : {}) }, doklad }]);
  }
  for (const [kluc, vyskyty] of fakturaVyskyty) {
    const varianty = podlaDokladov(vyskyty);
    const hodnota = { faktura: varianty[0].hodnota };
    const navrh = { hodnota, dokaz: dokaz(vyskyty.map((vyskyt) => vyskyt.doklad), hodnota, varianty) };
    if (navrh.dokaz.dokladov >= MIN_DOKLADOV_NAVRHU) navrhy.set(kluc, navrh);
    else samozdanenieMale.set(kluc, navrh);
  }

  // Cudzia daň na položkách zahraničného dodávateľa — vrátiť ju vie len žiadosť,
  // a či ju firma podáva, z histórie nevyčítame. Len otázka.
  const sCudzouDanou = vsetky.filter((doklad) => {
    const krajina = doklad.protistrana ? krajiny.get(doklad.protistrana) : undefined;
    return (naFakture(doklad.agenda) || doklad.agenda === 'VPD') && krajina && krajina !== 'SK'
      && doklad.riadky.some((riadok) => riadok.idx > 0 && riadok.sadzba !== undefined && !SK_SADZBY.includes(riadok.sadzba));
  });

  // Účty bez nároku: ten istý výber ako pri návrhu zaúčtovania, s prahom návrhu.
  // Vydaná strana (UN…) do výberu nepatrí — o odpočte nehovorí.
  const cleneniaBezOdpoctu = new Map(kodyFirmy
    .filter((kod) => kod.kind === 'cleneniaDph' && popisKodu(kod.code)?.strana !== 'U'
      && !clenenieVyzeraNaOdpocet({ kod: kod.code, nazov: kod.name ?? '' }))
    .map((kod) => [kod.code, kod.code] as const));
  const predkontacieFirmy = new Set(kodyFirmy.filter((kod) => kod.kind === 'predkontacie').map((kod) => kod.code));
  const bezNaroku = [...await uctyBezOdpoctu(tx, firma, [...new Set(vsetky.map((doklad) => doklad.agenda))],
    cleneniaBezOdpoctu, undefined, MIN_DOKLADOV_NAVRHU)]
    .filter(([ucet]) => predkontacieFirmy.has(ucet))
    .sort(([a], [b]) => porovnaj(a, b));
  if (bezNaroku.length > 0) {
    const hodnota = bezNaroku.map(([ucet, { id }]) => ({ predkontaciaKod: ucet, clenenieKod: id }));
    navrhy.set('naklady.bez_naroku', {
      hodnota, dokaz: { dokladov: bezNaroku.reduce((sucet, [, { dokladov }]) => sucet + dokladov, 0), navrh: hodnota },
    });
  }

  const na139 = (await tx.query<Record<string, any>>(
    `SELECT agenda, coalesce(doklad_cislo, '') AS cislo, coalesce(datum::text, '') AS datum FROM ucto_dennik
      WHERE tenant_id=$1 AND organization_id=$2 AND (ucet_md LIKE '139%' OR ucet_dal LIKE '139%')`, kde,
  )).rows.map((row, index): Doklad => ({ kluc: String(index), agenda: row.agenda, cislo: row.cislo, datum: row.datum, riadky: [] }));
  if (na139.length >= TOVAR_NA_CESTE_OD) {
    navrhy.set('zasady.tovar_na_ceste', { hodnota: { pouziva: true }, dokaz: dokaz(na139, { pouziva: true }) });
  }

  // Zápis faktov: potvrdenú hodnotu nikdy neprepísať, dostane len čerstvý dôkaz.
  let navrhnutych = 0;
  for (const [kluc, navrh] of navrhy) {
    if (rozhodnuty(kluc)) {
      await tx.query('UPDATE profil_fakty SET dokaz=$4::jsonb WHERE tenant_id=$1 AND organization_id=$2 AND kluc=$3',
        [...kde, kluc, JSON.stringify(navrh.dokaz)]);
      continue;
    }
    navrhnutych += 1;
    await tx.query(
      `INSERT INTO profil_fakty (organization_id, tenant_id, kluc, stav, hodnota, zdroj, dokaz, updated_at)
       VALUES ($1,$2,$3,'navrhnute',$4::jsonb,'historia',$5::jsonb,now())
       ON CONFLICT (organization_id, kluc) DO UPDATE SET stav='navrhnute', hodnota=excluded.hodnota, zdroj='historia',
         dokaz=excluded.dokaz, potvrdil=NULL, potvrdene_at=NULL, updated_at=now()`,
      [firma.organizationId, firma.tenantId, kluc, JSON.stringify(navrh.hodnota), JSON.stringify(navrh.dokaz)],
    );
  }
  await tx.query(
    `DELETE FROM profil_fakty WHERE tenant_id=$1 AND organization_id=$2 AND stav='navrhnute' AND zdroj='historia'
       AND kluc <> ALL($3::text[])`, [...kde, [...navrhy.keys()]],
  );
  // Dôkaz, ktorý história už nepotvrdzuje, by držal rozpor, ktorý nie je.
  await tx.query(
    `UPDATE profil_fakty SET dokaz=NULL WHERE tenant_id=$1 AND organization_id=$2 AND stav <> 'navrhnute'
       AND dokaz IS NOT NULL AND kluc <> ALL($3::text[])`, [...kde, [...navrhy.keys()]],
  );

  // Požadované otázky.
  const pozadovane = new Map<string, { druh: 'fakt' | 'spor_protistrany'; blokuje: boolean; dokladov: number; data: Record<string, unknown> }>();
  if (!status && !rozhodnuty('dph.status')) {
    // Samozdanenie bez jediného odpočtu je typická firma registrovaná len podľa §7a.
    const lenSamozdanenie = ddVyskyty.size > 0 && sOdpoctom.length === 0;
    pozadovane.set('fakt:dph.status', {
      druh: 'fakt', blokuje: true, dokladov: 0,
      data: { kluc: 'dph.status', ...(lenSamozdanenie ? { napoveda: 'registracia_7a' } : {}) },
    });
  }
  for (const [kluc, navrh] of samozdanenieMale) {
    if (rozhodnuty(kluc)) continue;
    pozadovane.set(`fakt:${kluc}`, { druh: 'fakt', blokuje: false, dokladov: navrh.dokaz.dokladov, data: { kluc, navrh: navrh.hodnota, dokaz: navrh.dokaz } });
  }
  if (sCudzouDanou.length >= VRATENIE_DPH_OD && !rozhodnuty('zahranicie.vratenie_dph')) {
    pozadovane.set('fakt:zahranicie.vratenie_dph', {
      druh: 'fakt', blokuje: false, dokladov: sCudzouDanou.length,
      data: { kluc: 'zahranicie.vratenie_dph', dokaz: dokaz(sCudzouDanou, undefined) },
    });
  }
  if (!rozhodnuty('zasady.drobny_majetok')) {
    pozadovane.set('fakt:zasady.drobny_majetok', { druh: 'fakt', blokuje: false, dokladov: 0, data: { kluc: 'zasady.drobny_majetok' } });
  }
  for (const [kluc, navrh] of navrhy) {
    const fakt = fakty.get(kluc);
    if (!rozhodnuty(kluc) || navrh.dokaz.dokladov < MIN_DOKLADOV_NAVRHU) continue;
    if (fakt?.stav === 'potvrdene' && zhodne(navrh.hodnota, fakt.hodnota)) continue;
    pozadovane.set(`fakt:${kluc}`, {
      druh: 'fakt', blokuje: false, dokladov: navrh.dokaz.dokladov, data: { kluc, rozpor: true, navrh: navrh.hodnota, dokaz: navrh.dokaz },
    });
  }

  // Spor praxí protistrany (R09) na úrovni firmy: kým o DPH protistrany
  // nerozhodlo pravidlo účtovníka. Vydané faktúry pravidlo protistrany nemajú.
  const pravidlaUctovnika = (await tx.query<{ ico: string; nazov: string } & Record<string, unknown>>(
    `SELECT regexp_replace(coalesce(supplier_ico, ''), '[^0-9]', '', 'g') AS ico, coalesce(supplier_name_normalized, '') AS nazov
       FROM accounting_rules
      WHERE tenant_id=$1 AND organization_id=$2 AND active AND clenenie_dph_id IS NOT NULL
        AND coalesce(keywords, '[]'::jsonb) = '[]'::jsonb`, kde,
  )).rows;
  const predkontacie = kodyFirmy.filter((kod) => kod.kind === 'predkontacie').map((kod) => ({ id: kod.id, kod: kod.code }));
  const clenenia = kodyFirmy.filter((kod) => kod.kind === 'cleneniaDph').map((kod) => ({ id: kod.id, kod: kod.code }));
  for (const row of (await tx.query<Record<string, any>>(
    `SELECT agenda, protistrana, protistrana_ico, dokladov, varianty FROM ucto_pravidla
      WHERE tenant_id=$1 AND organization_id=$2 AND konflikt ORDER BY agenda, protistrana`, kde,
  )).rows) {
    if (row.agenda === 'FV' || String(row.agenda).startsWith('FV-')) continue;
    const pravidlo = { konflikt: true, varianty: (row.varianty ?? []) as PraxVariant[] };
    if (sporPraxe(pravidlo) !== 'dph') continue;
    const ico = String(row.protistrana_ico ?? '').replace(/\D/g, '');
    if (pravidlaUctovnika.some((ine) => (ico && ine.ico === ico) || ine.nazov === row.protistrana)) continue;
    const otazka = otazkaPraxe(pravidlo, predkontacie, clenenia);
    if (!otazka) continue;
    pozadovane.set(`spor:${row.agenda}:${row.protistrana}`, {
      druh: 'spor_protistrany', blokuje: false, dokladov: Number(row.dokladov),
      data: { agenda: row.agenda, protistrana: row.protistrana, ...(ico ? { protistranaIco: ico } : {}), varianty: otazka.varianty },
    });
  }

  // Synchronizácia otázok. Zodpovedaná sa nezakladá znova — okrem rozporu:
  // odpoveď bez dôkazu z histórie nie je odpoveďou na to, že história teraz hovorí inak.
  const existujuce = new Map((await tx.query<Record<string, any>>(
    'SELECT kluc, stav, data FROM profil_otazky WHERE tenant_id=$1 AND organization_id=$2', kde,
  )).rows.map((row) => [row.kluc as string, row]));
  let otazok = 0;
  for (const [kluc, otazka] of pozadovane) {
    const row = existujuce.get(kluc);
    if (row?.stav === 'zodpovedana' && !(otazka.data.rozpor && !row.data?.rozpor)) continue;
    otazok += 1;
    await tx.query(
      `INSERT INTO profil_otazky (id, tenant_id, organization_id, kluc, druh, stav, blokuje, dokladov, data)
       VALUES ($1,$2,$3,$4,$5,'otvorena',$6,$7,$8::jsonb)
       ON CONFLICT (organization_id, kluc) DO UPDATE SET druh=excluded.druh, blokuje=excluded.blokuje,
         dokladov=excluded.dokladov, data=excluded.data, updated_at=now(),
         stav=CASE WHEN profil_otazky.stav IN ('otvorena','odlozena') THEN profil_otazky.stav ELSE 'otvorena' END`,
      [randomUUID(), firma.tenantId, firma.organizationId, kluc, otazka.druh, otazka.blokuje, otazka.dokladov, JSON.stringify(otazka.data)],
    );
  }
  await tx.query(
    `UPDATE profil_otazky SET stav='zastarana', updated_at=now()
      WHERE tenant_id=$1 AND organization_id=$2 AND stav IN ('otvorena','odlozena') AND kluc <> ALL($3::text[])`,
    [...kde, [...pozadovane.keys()]],
  );
  return { navrhnutych, otazok };
}

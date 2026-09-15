import { randomUUID } from 'node:crypto';
import type { ServerConfig } from '../config.js';
import type { Database } from '../db/database.js';
import { HttpError } from '../http.js';
import { maybeAiAccountingSuggestion, resolveSeriesDefault, type AiSuggestionDocumentContext } from './accountingSuggestionService.js';

/**
 * Koľko z toho, čo účtovník naozaj urobil, by AI navrhla sama.
 *
 * Doklad sa poskladá späť z korpusu (dodávateľ, texty položiek, sumy, sadzby),
 * pustí sa naň bežná AI analýza a odpoveď sa porovná so skutočným zaúčtovaním.
 *
 * DELENIE ČASOM. Merajú sa doklady od deliaceho dátumu, história sa drží spred
 * neho. Bez toho by doklad našiel v korpuse sám seba a odpísal si odpoveď —
 * meranie by ukázalo takmer 100 % a nezískali by sme ani jednu informáciu.
 * Zároveň je to realistické: doklad sa aj v praxi spracúva s tým, čo firma
 * vedela predtým.
 *
 * ČO SA NEMERIA. Extrakcia z PDF — pôvodné súbory nemáme, doklad sa skladá
 * z korpusu. Číslo je teda strop pre rozhodovaciu časť; skutočnosť bude nižšia
 * o chyby čítania. Kategórie účtovného profilu sú počítané z CELEJ histórie
 * vrátane meraných dokladov, takže výsledok mierne nadhodnocujú — prepočítať
 * ich pre každý doklad zvlášť by stálo viac než celé meranie.
 * ponytail: keď bude číslo podozrivo vysoké, prvé podozrenie sú kategórie.
 */

/** Agenda korpusu → druh dokladu, ako ho pozná spracovanie. */
const DRUH_PODLA_AGENDY: Record<string, { typ: string; podtyp?: string; pokladnaTyp?: 'receipt' | 'expense' }> = {
  FP: { typ: 'FP' },
  'FP-D': { typ: 'FP', podtyp: 'dobropis' },
  'FP-T': { typ: 'FP', podtyp: 'tarchopis' },
  'FP-Z': { typ: 'FP', podtyp: 'zalohova' },
  FV: { typ: 'FV' },
  'FV-D': { typ: 'FV', podtyp: 'dobropis' },
  'FV-T': { typ: 'FV', podtyp: 'tarchopis' },
  'FV-Z': { typ: 'FV', podtyp: 'zalohova' },
  OZ: { typ: 'OZ' },
  INT: { typ: 'MZDY' },
  VPD: { typ: 'PD', pokladnaTyp: 'expense' },
  PPD: { typ: 'PD', pokladnaTyp: 'receipt' },
};

interface Skutocnost {
  agenda: string;
  dokladCislo: string;
  datum: string;
  supplierIco?: string;
  supplierName?: string;
  predkontaciaId?: string;
  clenenieDphId?: string;
  clenenieKvKod?: string;
  /** Rad dokladu v POHODE (typ:id) a jeho predpona — staršie importy ho nenesú. */
  radExternalId?: string;
  radKod?: string;
  /** Krajina protistrany — rozhoduje o tuzemskom či zahraničnom rade. */
  krajina?: string;
  /** Text dokladu z hlavičky — pri doklade bez položiek je to jediné, čo model dostane. */
  hlavickaText?: string;
  polozky: Array<{ popis: string; suma?: number; sumaDph?: number; predkontaciaId?: string }>;
  /** Doklad, ktorý účtovník rozpísal na viac predkontácií. */
  rozpisany: boolean;
}

export interface PresnostVysledok {
  id: string;
  deliciDatum: string;
  vzorka: number;
  vysledok: Record<string, AgendaSkore>;
  rozdiely: Array<Record<string, unknown>>;
  trvanieMs: number;
}

export interface AgendaSkore {
  dokladov: number;
  predkontacia: number;
  clenenieDph: number;
  kv: number;
  rad: number;
  /** Len doklady, ktorých rad z histórie poznáme — bez neho nie je proti čomu merať. */
  radov: number;
  /** Len doklady, ktoré účtovník rozpísal — inde nie je čo merať. */
  rozpisanych: number;
  rozpis: number;
}

/** Doklady na meranie: hlavička so zaúčtovaním a jej položky. */
async function nacitajDoklady(
  database: Database,
  input: { tenantId: string; organizationId: string },
  deliciDatum: string,
): Promise<Skutocnost[]> {
  const rows = (await database.query<Record<string, any>>(
    `SELECT agenda, doklad_cislo, datum, riadok_index, line_text_normalized, suma, suma_dph,
            supplier_ico, supplier_name_normalized, predkontacia_id, clenenie_dph_id, clenenie_kv_kod,
            rad_external_id, rad_kod, krajina
       FROM ucto_historia
      WHERE tenant_id=$1 AND organization_id=$2 AND doklad_cislo IS NOT NULL AND datum >= $3::date
      -- NULLS FIRST je nutnosť, nie kozmetika: staršie importy niesli len
      -- hlavičku a riadok_index majú prázdny. Pri predvolenom NULLS LAST prišla
      -- taká hlavička AŽ ZA položkami toho istého dokladu a prepísala ich —
      -- doklad potom vyzeral ako nerozpísaný a model dostal len text hlavičky.
      ORDER BY datum, doklad_cislo, riadok_index NULLS FIRST`,
    [input.tenantId, input.organizationId, deliciDatum],
  )).rows;

  const podlaDokladu = new Map<string, Skutocnost>();
  for (const row of rows) {
    const kluc = `${row.agenda}|${row.doklad_cislo}`;
    const index = Number(row.riadok_index ?? 0);
    if (index === 0) {
      // Hlavička bez predkontácie sa nedá porovnať — nie je proti čomu.
      if (!row.predkontacia_id) continue;
      podlaDokladu.set(kluc, {
        agenda: row.agenda,
        dokladCislo: row.doklad_cislo,
        datum: String(row.datum).slice(0, 10),
        supplierIco: row.supplier_ico ?? undefined,
        supplierName: row.supplier_name_normalized ?? undefined,
        predkontaciaId: row.predkontacia_id ?? undefined,
        clenenieDphId: row.clenenie_dph_id ?? undefined,
        clenenieKvKod: row.clenenie_kv_kod ?? undefined,
        radExternalId: row.rad_external_id ?? undefined,
        radKod: row.rad_kod ?? undefined,
        krajina: row.krajina ?? undefined,
        hlavickaText: row.line_text_normalized ?? undefined,
        polozky: [],
        rozpisany: false,
      });
      continue;
    }
    const doklad = podlaDokladu.get(kluc);
    if (!doklad) continue;
    doklad.polozky.push({
      popis: row.line_text_normalized,
      suma: row.suma === null ? undefined : Number(row.suma),
      sumaDph: row.suma_dph === null ? undefined : Number(row.suma_dph),
      predkontaciaId: row.predkontacia_id ?? undefined,
    });
    if (row.predkontacia_id && row.predkontacia_id !== doklad.predkontaciaId) doklad.rozpisany = true;
  }
  // Doklad bez položiek (staršie importy niesli len hlavičku) dostane text
  // hlavičky ako jedinú položku. Inak by model dostal doklad BEZ AKÉHOKOĽVEK
  // popisu a nemal by sa z čoho rozhodnúť — meranie by netrestalo jeho úsudok,
  // ale prázdny vstup. Presne to sa aj stalo: leasingové splátky ČSOB prišli
  // bez textu a model na ne nevrátil predkontáciu vôbec.
  for (const doklad of podlaDokladu.values()) {
    if (doklad.polozky.length === 0 && doklad.hlavickaText) {
      doklad.polozky.push({ popis: doklad.hlavickaText });
    }
  }
  return [...podlaDokladu.values()]
    .filter((doklad) => DRUH_PODLA_AGENDY[doklad.agenda] && doklad.polozky.length > 0);
}

/** Vzorka podľa agend v pomere, v akom firma doklady naozaj má. */
function vyber(doklady: Skutocnost[], vzorka: number): Skutocnost[] {
  const podlaAgendy = new Map<string, Skutocnost[]>();
  for (const doklad of doklady) {
    if (!podlaAgendy.has(doklad.agenda)) podlaAgendy.set(doklad.agenda, []);
    podlaAgendy.get(doklad.agenda)!.push(doklad);
  }
  const vybrane: Skutocnost[] = [];
  for (const [, skupina] of podlaAgendy) {
    const kolko = Math.max(1, Math.round((skupina.length / doklady.length) * vzorka));
    // Rovnomerne po celom rozsahu, nie prvých N — inak by vzorka bola jeden týždeň.
    const krok = Math.max(1, Math.floor(skupina.length / kolko));
    for (let index = 0; index < skupina.length && vybrane.length < vzorka * 2; index += krok) {
      vybrane.push(skupina[index]);
    }
  }
  return vybrane.slice(0, vzorka);
}

/**
 * Doklad sa musí na chvíľu objaviť v tabuľke dokladov: analýza si ho číta
 * a zapisuje k nemu návrh. Maže sa hneď po vyhodnotení.
 * ponytail: keby beh spadol uprostred, ostanú v dokladoch — vtedy zmazať
 *   podľa source->>'meranie'.
 */
async function sNahradnymDokladom<T>(
  database: Database,
  input: { tenantId: string; organizationId: string },
  doklad: Skutocnost,
  praca: (documentId: string) => Promise<T>,
): Promise<T> {
  const documentId = randomUUID();
  const druh = DRUH_PODLA_AGENDY[doklad.agenda];
  await database.query(
    `INSERT INTO documents (id,tenant_id,organization_id,document_type,podtyp,status,processing_status,
       source,extracted,accounting,total_amount,currency)
     VALUES ($1,$2,$3,$4,$5,'na_kontrole','ready_for_review','{"meranie":true}'::jsonb,$6::jsonb,'{}'::jsonb,$7,'EUR')`,
    [documentId, input.tenantId, input.organizationId, druh.typ, druh.podtyp ?? 'bezna',
      JSON.stringify({
        dodavatel: { nazov: doklad.supplierName, ico: doklad.supplierIco },
        polozky: doklad.polozky.map((polozka) => ({ popis: polozka.popis, sumaBezDph: polozka.suma })),
        datumVystavenia: doklad.datum,
      }),
      doklad.polozky.reduce((spolu, polozka) => spolu + (polozka.suma ?? 0), 0)],
  );
  try {
    return await praca(documentId);
  } finally {
    await database.query('DELETE FROM documents WHERE id=$1', [documentId]);
  }
}

function prazdneSkore(): AgendaSkore {
  return { dokladov: 0, predkontacia: 0, clenenieDph: 0, kv: 0, rad: 0, radov: 0, rozpisanych: 0, rozpis: 0 };
}

export async function zmerajPresnost(
  database: Database,
  config: ServerConfig,
  input: { tenantId: string; organizationId: string },
  moznosti: { deliciDatum?: string; vzorka?: number } = {},
  injectedParser?: Parameters<typeof maybeAiAccountingSuggestion>[4],
): Promise<PresnostVysledok> {
  if (!injectedParser && (config.extractionProvider !== 'openai' || !config.openai.apiKey)) {
    throw new HttpError(409, 'ai_unavailable', 'AI analýza nie je nakonfigurovaná (chýba OpenAI kľúč)');
  }
  const zaciatok = Date.now();
  const vzorka = Math.min(Math.max(moznosti.vzorka ?? 100, 1), 500);
  // Deliaci dátum je 80. percentil dátumov DOKLADOV: posledná pätina sa meria,
  // predošlé štyri sa učia. Nie „max mínus tri mesiace" — leasingové splátky
  // a rezervy sú zaúčtované dopredu, takže max bol 31. 12., delítko spadlo na
  // 30. 9. a za ním ostalo 42 dokladov, medzi nimi ani jedna prijatá faktúra.
  // Percentil sa o pár dokladov v budúcnosti neopiera.
  const deliciDatum = moznosti.deliciDatum ?? (await database.query<{ d: string } & Record<string, unknown>>(
    `SELECT percentile_disc(0.80) WITHIN GROUP (ORDER BY datum)::text AS d
       FROM (SELECT DISTINCT agenda, doklad_cislo, datum FROM ucto_historia
              WHERE tenant_id=$1 AND organization_id=$2
                AND doklad_cislo IS NOT NULL AND datum IS NOT NULL) t`,
    [input.tenantId, input.organizationId],
  )).rows[0]?.d;
  if (!deliciDatum) throw new HttpError(409, 'not_enough_data', 'V korpuse nie sú doklady s dátumom.');

  // Kódy pre čitateľný zoznam rozdielov — účtovník číta kódy, nie id.
  const polozky = (await database.query<{ id: string; code: string; external_id: string | null } & Record<string, unknown>>(
    'SELECT id, code, external_id FROM code_list_items WHERE tenant_id=$1 AND organization_id=$2',
    [input.tenantId, input.organizationId],
  )).rows;
  const kod = new Map(polozky.map((row) => [row.id, row.code.trim()]));
  // Rad sa porovnáva identifikátorom z POHODY, nie id riadku ani kódom: ten istý
  // rad môže mať v číselníku iné id a dva rady rovnakú predponu.
  const externeId = new Map(polozky.map((row) => [row.id, row.external_id]));

  const vsetky = await nacitajDoklady(database, input, deliciDatum);
  if (vsetky.length === 0) {
    throw new HttpError(409, 'not_enough_data', 'Za meraným obdobím nie sú doklady so zaúčtovaním.');
  }
  const merane = vyber(vsetky, vzorka);

  const vysledok: Record<string, AgendaSkore> = {};
  const rozdiely: Array<Record<string, unknown>> = [];
  for (const doklad of merane) {
    const skore = vysledok[doklad.agenda] ?? (vysledok[doklad.agenda] = prazdneSkore());
    skore.dokladov += 1;
    if (doklad.rozpisany) skore.rozpisanych += 1;
    if (doklad.radExternalId) skore.radov += 1;

    const context: AiSuggestionDocumentContext = {
      documentType: DRUH_PODLA_AGENDY[doklad.agenda].typ,
      podtyp: DRUH_PODLA_AGENDY[doklad.agenda].podtyp,
      pokladnaTyp: DRUH_PODLA_AGENDY[doklad.agenda].pokladnaTyp,
      supplierName: doklad.supplierName,
      supplierIco: doklad.supplierIco,
      // Krajina rozhoduje o tuzemskom či zahraničnom rade (aj o cudzej dani) —
      // v ostrej prevádzke ju doklad nesie, meranie bez nej meralo naslepo.
      supplierKrajina: doklad.krajina,
      // Na vydanej faktúre je protistranou ODBERATEĽ a číta sa z iného poľa
      // (accountingSuggestionService.ts:1462). Korpus drží protistranu vždy v
      // supplier_name_normalized — aj pri FV, kde je to zákazník —, takže bez
      // tohto riadku išla každá vydaná faktúra do merania bez protistrany: bez
      // pravidla, bez denníka tej protistrany, bez rozúčtovania aj bez radu.
      // Model potom odpovedal najčastejším vzorom firmy a meranie to rátalo
      // ako jeho chybu. V ostrej prevádzke odberateľ nechýba, prišiel by
      // z dokladu — merali sme teda niečo, čo sa v produkte nedeje.
      ...(DRUH_PODLA_AGENDY[doklad.agenda].typ === 'FV'
        ? { odberatel: { nazov: doklad.supplierName, ico: doklad.supplierIco, krajina: doklad.krajina } }
        : {}),
      datumVystavenia: doklad.datum,
      lineDescriptions: doklad.polozky.map((polozka) => polozka.popis),
      polozky: doklad.polozky.map((polozka) => ({ popis: polozka.popis, suma: polozka.suma })),
      historiaDoDatumu: deliciDatum,
    };
    let navrh: Record<string, any> | undefined;
    try {
      await sNahradnymDokladom(database, input, doklad, async (documentId) => {
        await maybeAiAccountingSuggestion(database, config, {
          tenantId: input.tenantId, organizationId: input.organizationId, documentId,
          supplierIco: doklad.supplierIco, supplierName: doklad.supplierName,
        }, context, injectedParser);
        navrh = (await database.query<Record<string, any>>(
          'SELECT predkontacia_id, clenenie_dph_id, clenenie_kv_kod, ciselny_rad_id, riadky, reason FROM accounting_suggestions WHERE document_id=$1',
          [documentId],
        )).rows[0];
      });
    } catch (chyba) {
      rozdiely.push({
        doklad: doklad.dokladCislo, agenda: doklad.agenda,
        chyba: chyba instanceof Error ? chyba.message : String(chyba),
      });
      continue;
    }

    const sedi = {
      predkontacia: Boolean(navrh?.predkontacia_id) && navrh!.predkontacia_id === doklad.predkontaciaId,
      clenenieDph: !doklad.clenenieDphId || navrh?.clenenie_dph_id === doklad.clenenieDphId,
      kv: !doklad.clenenieKvKod || navrh?.clenenie_kv_kod === doklad.clenenieKvKod,
      // Rad sa porovnáva s radom, do ktorého doklad v POHODE naozaj padol. Kým
      // sa porovnávalo len „nejaký rad je", bol rad 100 % v každej firme o ničom.
      rad: Boolean(doklad.radExternalId) && externeId.get(navrh?.ciselny_rad_id ?? '') === doklad.radExternalId,
      // Rozpis: navrhol ho tam, kde ho účtovník naozaj urobil?
      rozpis: doklad.rozpisany === Array.isArray(navrh?.riadky) && (navrh?.riadky?.length ?? 0) > 0,
    };
    if (sedi.predkontacia) skore.predkontacia += 1;
    if (sedi.clenenieDph) skore.clenenieDph += 1;
    if (sedi.kv) skore.kv += 1;
    if (sedi.rad) skore.rad += 1;
    if (doklad.rozpisany && sedi.rozpis) skore.rozpis += 1;

    // Doklad, ktorý účtovník rozpísal a model nie, ide do rozdielov aj vtedy,
    // keď hlavička sedí — aj s odôvodnením modelu. Bez neho zostáva len holé
    // „rozpis 0 zo 16" a príčinu treba hádať; model ju pritom povie sám.
    if (doklad.rozpisany && !sedi.rozpis) {
      rozdiely.push({
        doklad: doklad.dokladCislo, agenda: doklad.agenda, datum: doklad.datum,
        dodavatel: doklad.supplierName, chybaRozpis: true,
        polozky: doklad.polozky.map((polozka) => polozka.popis).slice(0, 8),
        dovod: navrh?.reason ?? null,
      });
    }
    if (!sedi.predkontacia || !sedi.clenenieDph || !sedi.kv || (doklad.radExternalId && !sedi.rad)) {
      rozdiely.push({
        doklad: doklad.dokladCislo, agenda: doklad.agenda, datum: doklad.datum,
        dodavatel: doklad.supplierName,
        // Kódy, nie id — rozdiely má čítať účtovník, nie databáza.
        skutocne: {
          predkontacia: kod.get(doklad.predkontaciaId ?? '') ?? null,
          clenenieDph: kod.get(doklad.clenenieDphId ?? '') ?? null,
          kv: doklad.clenenieKvKod ?? null,
          rad: doklad.radKod ?? null,
        },
        navrh: {
          predkontacia: kod.get(navrh?.predkontacia_id ?? '') ?? null,
          clenenieDph: kod.get(navrh?.clenenie_dph_id ?? '') ?? null,
          kv: navrh?.clenenie_kv_kod ?? null,
          rad: kod.get(navrh?.ciselny_rad_id ?? '') ?? null,
        },
        rozpisany: doklad.rozpisany,
      });
    }
  }

  const id = randomUUID();
  const trvanieMs = Date.now() - zaciatok;
  await database.query(
    `INSERT INTO ucto_presnost (id,tenant_id,organization_id,delici_datum,vzorka,vysledok,rozdiely,trvanie_ms)
     VALUES ($1,$2,$3,$4::date,$5,$6::jsonb,$7::jsonb,$8)`,
    [id, input.tenantId, input.organizationId, deliciDatum, merane.length,
      JSON.stringify(vysledok), JSON.stringify(rozdiely.slice(0, 200)), trvanieMs],
  );
  return { id, deliciDatum, vzorka: merane.length, vysledok, rozdiely, trvanieMs };
}

export interface RadyVysledok {
  /** Od akého dátumu sa meralo; null = história rad dokladu nenesie vôbec. */
  od: string | null;
  podlaAgendy: Record<string, { dokladov: number; spravne: number; prazdne: number }>;
  rozdiely: Array<{
    doklad: string; agenda: string; datum: string; protistrana: string | null;
    skutocne: string | null; navrh: string | null;
  }>;
}

/**
 * Presnosť výberu číselného radu — bez AI. Rad je výpočet z histórie, nie
 * úsudok modelu, takže sa dá premerať na KAŽDOM doklade zadarmo, nie na vzorke
 * zo zmerajPresnost. Doklad dostane rad len z toho, čo firma vedela pred jeho
 * dátumom, a porovná sa s radom, do ktorého ho účtovník v POHODE naozaj dal.
 * ponytail: história roka sa číta pre každý doklad znova (n²) — pri firmách
 * s desaťtisícmi dokladov ročne načítať rok raz a filtrovať v pamäti.
 */
export async function zmerajRady(
  database: Database,
  input: { tenantId: string; organizationId: string },
  moznosti: { od?: string } = {},
): Promise<RadyVysledok> {
  // Predvolene od 1. januára posledného roka, ktorý rad dokladu nesie: staršie
  // roky majú v POHODE iné rady a výber by sa meral na tom, čo firma nerobí.
  const od = moznosti.od ?? (await database.query<{ od: string | null } & Record<string, unknown>>(
    `SELECT make_date(max(extract(year FROM datum))::int, 1, 1)::text AS od
       FROM ucto_historia
      WHERE tenant_id=$1 AND organization_id=$2 AND rad_external_id IS NOT NULL`,
    [input.tenantId, input.organizationId],
  )).rows[0]?.od ?? null;
  const vysledok: RadyVysledok = { od, podlaAgendy: {}, rozdiely: [] };
  if (!od) return vysledok;

  const doklady = (await database.query<Record<string, any>>(
    `SELECT DISTINCT ON (agenda, doklad_cislo)
            agenda, doklad_cislo, datum::text AS datum, supplier_ico, supplier_name_normalized,
            krajina, rad_external_id, rad_kod
       FROM ucto_historia
      WHERE tenant_id=$1 AND organization_id=$2 AND rad_external_id IS NOT NULL
        AND doklad_cislo IS NOT NULL AND datum >= $3::date AND agenda=ANY($4::text[])
      ORDER BY agenda, doklad_cislo, coalesce(riadok_index, 0)`,
    [input.tenantId, input.organizationId, od, Object.keys(DRUH_PODLA_AGENDY)],
  )).rows.sort((prvy, druhy) => prvy.datum.localeCompare(druhy.datum));
  const rady = new Map((await database.query<{ id: string; code: string; external_id: string | null } & Record<string, unknown>>(
    `SELECT id, code, external_id FROM code_list_items
      WHERE tenant_id=$1 AND organization_id=$2 AND kind='ciselneRady'`,
    [input.tenantId, input.organizationId],
  )).rows.map((row) => [row.id, row]));

  for (const doklad of doklady) {
    const druh = DRUH_PODLA_AGENDY[doklad.agenda];
    const navrh = await resolveSeriesDefault(
      database, input, druh.typ, doklad.datum, druh.podtyp,
      { ico: doklad.supplier_ico ?? undefined, nazov: doklad.supplier_name_normalized ?? undefined, krajina: doklad.krajina ?? undefined },
      doklad.datum, druh.pokladnaTyp,
    );
    const skore = vysledok.podlaAgendy[doklad.agenda] ??= { dokladov: 0, spravne: 0, prazdne: 0 };
    skore.dokladov += 1;
    const rad = navrh ? rady.get(navrh) : undefined;
    if (!rad) skore.prazdne += 1;
    if (rad && rad.external_id === doklad.rad_external_id) {
      skore.spravne += 1;
    } else if (vysledok.rozdiely.length < 50) {
      vysledok.rozdiely.push({
        doklad: doklad.doklad_cislo, agenda: doklad.agenda, datum: doklad.datum,
        protistrana: doklad.supplier_name_normalized ?? doklad.supplier_ico ?? null,
        skutocne: doklad.rad_kod ?? null, navrh: rad?.code.trim() ?? null,
      });
    }
  }
  return vysledok;
}

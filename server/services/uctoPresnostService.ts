import { randomUUID } from 'node:crypto';
import type { ServerConfig } from '../config.js';
import type { Database } from '../db/database.js';
import { HttpError } from '../http.js';
import { maybeAiAccountingSuggestion, type AiSuggestionDocumentContext } from './accountingSuggestionService.js';

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
const DRUH_PODLA_AGENDY: Record<string, { typ: string; podtyp?: string }> = {
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
  VPD: { typ: 'PD' },
  PPD: { typ: 'PD' },
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
            supplier_ico, supplier_name_normalized, predkontacia_id, clenenie_dph_id, clenenie_kv_kod
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
  return { dokladov: 0, predkontacia: 0, clenenieDph: 0, kv: 0, rad: 0, rozpisanych: 0, rozpis: 0 };
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
  const kod = new Map((await database.query<{ id: string; code: string } & Record<string, unknown>>(
    'SELECT id, code FROM code_list_items WHERE tenant_id=$1 AND organization_id=$2',
    [input.tenantId, input.organizationId],
  )).rows.map((row) => [row.id, row.code.trim()]));

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

    const context: AiSuggestionDocumentContext = {
      documentType: DRUH_PODLA_AGENDY[doklad.agenda].typ,
      podtyp: DRUH_PODLA_AGENDY[doklad.agenda].podtyp,
      supplierName: doklad.supplierName,
      supplierIco: doklad.supplierIco,
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
          'SELECT predkontacia_id, clenenie_dph_id, clenenie_kv_kod, ciselny_rad_id, riadky FROM accounting_suggestions WHERE document_id=$1',
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
      // Rad sa neporovnáva proti korpusu — ten ho nedrží ako id. Berie sa, či
      // ho návrh vôbec určil; presnosť radu meria vlastný test.
      rad: Boolean(navrh?.ciselny_rad_id),
      // Rozpis: navrhol ho tam, kde ho účtovník naozaj urobil?
      rozpis: doklad.rozpisany === Array.isArray(navrh?.riadky) && (navrh?.riadky?.length ?? 0) > 0,
    };
    if (sedi.predkontacia) skore.predkontacia += 1;
    if (sedi.clenenieDph) skore.clenenieDph += 1;
    if (sedi.kv) skore.kv += 1;
    if (sedi.rad) skore.rad += 1;
    if (doklad.rozpisany && sedi.rozpis) skore.rozpis += 1;

    if (!sedi.predkontacia || !sedi.clenenieDph || !sedi.kv) {
      rozdiely.push({
        doklad: doklad.dokladCislo, agenda: doklad.agenda, datum: doklad.datum,
        dodavatel: doklad.supplierName,
        // Kódy, nie id — rozdiely má čítať účtovník, nie databáza.
        skutocne: {
          predkontacia: kod.get(doklad.predkontaciaId ?? '') ?? null,
          clenenieDph: kod.get(doklad.clenenieDphId ?? '') ?? null,
          kv: doklad.clenenieKvKod ?? null,
        },
        navrh: {
          predkontacia: kod.get(navrh?.predkontacia_id ?? '') ?? null,
          clenenieDph: kod.get(navrh?.clenenie_dph_id ?? '') ?? null,
          kv: navrh?.clenenie_kv_kod ?? null,
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

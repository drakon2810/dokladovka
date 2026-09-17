import type { DphPravidloOdpoctu, DphProfil, SamozdanenieDruh } from './dphProfileService.js';
import { popisKodu } from './pohodaDphKody.js';
import { DRUHY_SAMOZDANENIA, type DruhSamozdanenia } from './profilKatalog.js';

// dphAdvisor — čistá funkcia posudDph(dokument, profil). Jediný zdroj pravdy
// pre DPH kontroly: worker (návrhy pre AI), approve (blokácie) a detail
// dokladu (varovania) volajú tú istú logiku. AI výstup je len návrh —
// blokácie sú deterministické a vynucuje ich server.

export interface DphZistenie {
  kod: string;
  sprava: string;
  kategoria?: string;
  percento?: number;
  clenenieDphId?: string;
  clenenieKvKod?: string;
}

export interface DphPosudok {
  navrhy: DphZistenie[];
  varovania: DphZistenie[];
  blokacie: DphZistenie[];
}

export interface DphPosudokDokument {
  documentType: string;
  /** Normalizované extracted JSONB dokladu (slovenské kľúče). */
  extracted: Record<string, unknown> | null | undefined;
  /** Zvolené zaúčtovanie (documents.accounting). */
  accounting?: Record<string, string | undefined> | null;
  /** Zvolené členenie DPH rozpísané z číselníka — pre kontrolu odpočtu. */
  clenenieDph?: { id: string; kod: string; nazov: string };
  /** Členenia DPH položiek s vlastným členením, rozpísané z číselníka podľa id. */
  cleneniaPoloziek?: Array<{ id: string; kod: string; nazov: string }>;
}

export const EU_DPH_PREFIXY = [
  'AT', 'BE', 'BG', 'CY', 'CZ', 'DE', 'DK', 'EE', 'EL', 'ES', 'FI', 'FR', 'GR',
  'HR', 'HU', 'IE', 'IT', 'LT', 'LU', 'LV', 'MT', 'NL', 'PL', 'PT', 'RO', 'SE', 'SI',
];

function bezDiakritiky(value: string): string {
  let vysledok = '';
  for (const znak of value.normalize('NFD')) {
    const kod = znak.codePointAt(0) ?? 0;
    if (kod < 0x0300 || kod > 0x036f) vysledok += znak;
  }
  return vysledok.toLocaleLowerCase('sk');
}

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

/**
 * Slovenské sadzby DPH podľa dňa zdaniteľného plnenia (§ 27 zákona o DPH) —
 * jediná tabuľka na serveri, číta ju export do POHODY aj DPH poradca. Od
 * 1. 1. 2025 základná 23 %, znížené 19 % a 5 %; predtým základná 20 % a znížená
 * 10 %, k nim od 1. 1. 2023 aj 5 % (štátom podporované nájomné bývanie).
 * Rozhoduje deň plnenia, nie vystavenia — decembrová dodávka fakturovaná
 * v januári 2025 nesie ešte 20 %.
 *
 * ponytail: plnenie pred rokom 2011 (vtedy 19 % a 10 %) tabuľka nepozná;
 * riadok pridať, keď taký doklad príde. Klient má kópiu
 * v src/data/xml/pohodaDataPack.ts — meniť obe naraz.
 */
export const SK_SADZBY_DPH: ReadonlyArray<{ od: string; high: number; low: number; third?: number }> = [
  { od: '2025-01-01', high: 23, low: 19, third: 5 },
  { od: '2023-01-01', high: 20, low: 10, third: 5 },
  { od: '2011-01-01', high: 20, low: 10 },
];

/** Sadzby platné v deň plnenia; bez dátumu dnešné. */
export function sadzbyDphPre(datum: string | undefined) {
  return SK_SADZBY_DPH.find((riadok) => !datum || riadok.od <= datum.slice(0, 10));
}

interface ExtraktDokladu {
  dodavatelNazov: string;
  dodavatelIcDph: string;
  /** Krajina adresy dodávateľa (ISO) — spolu s IČ DPH hovorí, čia daň je na doklade. */
  dodavatelKrajina: string;
  mena: string;
  duzp?: string;
  sumaSpolu: number;
  zaklad: number;
  dphSpolu: number;
  texty: string[];
}

function extrakt(dokument: DphPosudokDokument): ExtraktDokladu {
  const extracted = (dokument.extracted ?? {}) as Record<string, any>;
  const dodavatel = (extracted.dodavatel ?? {}) as Record<string, any>;
  const rozpis = Array.isArray(extracted.rozpisDph) ? extracted.rozpisDph : [];
  const polozky = Array.isArray(extracted.polozky) ? extracted.polozky : [];
  const sumaSpolu = Number(extracted.sumaSpolu ?? 0) || 0;
  // Cudzia daň v rozpise DPH už nie je — normalizácia z nej spravila jednu
  // nezdaniteľnú sumu, lebo do slovenského priznania nemá čo vstúpiť. Pre
  // posúdenie dokladu je to však stále daň, ktorú dodávateľ účtoval: bez nej
  // by doklad vyzeral ako plnenie bez dane, teda ako kandidát na samozdanenie.
  const cudziaDan = Number(extracted.cudziaDan ?? 0) || 0;
  const dphSpolu = rozpis.reduce((sum: number, row: any) => sum + (Number(row?.dph) || 0), 0) + cudziaDan;
  const zakladZRozpisu = rozpis.reduce((sum: number, row: any) => sum + (Number(row?.zaklad) || 0), 0);
  const texty = [
    String(dodavatel.nazov ?? ''),
    ...polozky.map((polozka: any) => String(polozka?.popis ?? '')),
    String(extracted.textPolozky ?? ''),
  ].filter(Boolean);
  return {
    dodavatelNazov: String(dodavatel.nazov ?? ''),
    dodavatelIcDph: String(dodavatel.icDph ?? '').replace(/\s+/g, '').toUpperCase(),
    dodavatelKrajina: String(dodavatel.krajina ?? '').trim().toUpperCase(),
    mena: String(extracted.mena ?? 'EUR'),
    duzp: (extracted.datumDodania ?? extracted.datumVystavenia) as string | undefined,
    sumaSpolu,
    zaklad: zakladZRozpisu > 0 ? zakladZRozpisu : sumaSpolu,
    dphSpolu,
    texty,
  };
}

export function najdiKlucoveSlovo(texty: string[], klucoveSlova: string[]): string | undefined {
  for (const slovo of klucoveSlova) {
    const hladane = bezDiakritiky(slovo.trim());
    if (!hladane) continue;
    if (texty.some((text) => bezDiakritiky(text).includes(hladane))) return slovo;
  }
  return undefined;
}

/**
 * Zahraničný dodávateľ, ktorý účtuje VLASTNÚ daň (rakúskych 20 %, českých 21 %,
 * nemeckých 19 %). Firma so slovenským IČ DPH fakturuje slovenskú daň, aj keď
 * sídli v cudzine — podľa prefixu sem preto nespadne. Keď o krajine nevieme
 * nič, doklad sa berie ako tuzemský: mlčať je bezpečnejšie než blokovať.
 * Používa to aj normalizácia extrakcie (rozpis DPH cudzej dane).
 */
export function jeCudziDodavatel(dodavatel: { icDph?: string; krajina?: string }): boolean {
  const krajina = String(dodavatel.krajina ?? '').trim().toUpperCase();
  const prefix = String(dodavatel.icDph ?? '').replace(/\s+/g, '').toUpperCase().slice(0, 2);
  return krajina !== '' && krajina !== 'SK' && prefix !== 'SK';
}

/**
 * Uplatňuje členenie odpočet? Kód z referenčného zoznamu POHODY rozhoduje
 * podľa riadkov priznania, do ktorých zapisuje — názov v číselníku o tom môže
 * mlčať („Nadobudnutie tovaru prvým odberateľom" do priznania nevstupuje).
 * Vlastný kód firmy sa posúdi heuristikou podľa kódu a názvu.
 */
export function clenenieVyzeraNaOdpocet(clenenie: { kod: string; nazov: string }): boolean {
  const popis = popisKodu(clenenie.kod);
  if (popis?.strana === 'P') return popis.riadky.length > 0;
  const text = bezDiakritiky(`${clenenie.kod} ${clenenie.nazov}`);
  if (/bez\s*(naroku|odpoctu)/.test(text)) return false;
  if (/neodpocitava|neplatitel|mimo\s*dph|nezahrnovat/.test(text)) return false;
  const kod = clenenie.kod.trim().toUpperCase();
  if (kod === 'BO' || kod === 'KN' || kod === 'BN' || kod.startsWith('UN')) return false;
  return true;
}

/**
 * Pravidlo pre autá delí dve rôzne dane: daňový náklad (základ) a odpočet DPH.
 * Pomerné odpočítanie (§ 49 ods. 4) delí len odpočet — základ ostáva na účte.
 */
function pravidloVarovanie(kod: string, pravidla: DphPravidloOdpoctu[], texty: string[], lenOdpocet: boolean, documentType: string): DphZistenie[] {
  return pravidla.flatMap((pravidlo) => {
    if (pravidlo.typyDokladov?.length && !pravidlo.typyDokladov.includes(documentType)) return [];
    const zhoda = najdiKlucoveSlovo(texty, pravidlo.klucoveSlova);
    if (!zhoda) return [];
    const odpocet = pravidlo.percentoDph ?? pravidlo.percento;
    const podiely = lenOdpocet ? `Odpočet DPH ${odpocet} %` : `Daňový náklad ${pravidlo.percento} %, odpočet DPH ${odpocet} %`;
    return [{ kod, kategoria: pravidlo.kategoria, percento: pravidlo.percento, sprava: `${podiely} — ${pravidlo.kategoria} (nájdené „${zhoda}“).` }];
  });
}

const NAZVY_DRUHOV: Record<DruhSamozdanenia, string> = {
  sluzby_eu: 'Služby z EÚ (§69 ods. 3)',
  sluzby_mimo_eu: 'Služby spoza EÚ (§69 ods. 3)',
  tovar_eu: 'Nadobudnutie tovaru z EÚ (§11)',
  prenesenie_prijate: 'Tuzemské prenesenie daňovej povinnosti, prijaté (§69 ods. 12)',
  dovoz: 'Dovoz tovaru',
  prenesenie_vystavene: 'Tuzemské prenesenie daňovej povinnosti, vystavené (§69 ods. 12)',
  sluzby_zahranicie_vystavene: 'Služby s miestom dodania v zahraničí, vystavené',
  zahranicie_vystavene: 'Iné plnenie s miestom dodania v zahraničí, vystavené',
  tovar_do_eu: 'Dodanie tovaru do EÚ',
};

/** „Služby z EÚ (§69 ods. 3): faktúra PN, KV KN; interný doklad DDsl§69 a PDsluz, KV B1" — kódy, nie id. */
function vetaDruhu(druh: DruhSamozdanenia, nastavenie: SamozdanenieDruh): string | undefined {
  const kv = (kod?: string) => (kod ? `, KV ${kod}` : '');
  const sPredkontaciou = (kod?: string, predkontacia?: string) =>
    kod && (predkontacia ? `${kod} (predkontácia ${predkontacia})` : kod);
  const casti = [
    nastavenie.faktura && `faktúra ${nastavenie.faktura.clenenieKod}${kv(nastavenie.faktura.kv)}`,
    nastavenie.interny && `interný doklad ${[
      sPredkontaciou(nastavenie.interny.ddKod, nastavenie.interny.ddPredkontaciaKod),
      sPredkontaciou(nastavenie.interny.pKod, nastavenie.interny.pPredkontaciaKod),
    ].filter(Boolean).join(' a ')}${kv(nastavenie.interny.kv)}`,
  ].filter(Boolean);
  return casti.length > 0 ? `${NAZVY_DRUHOV[druh]}: ${casti.join('; ')}` : undefined;
}

export function posudDph(dokument: DphPosudokDokument, profil: DphProfil): DphPosudok {
  const navrhy: DphZistenie[] = [];
  const varovania: DphZistenie[] = [];
  const blokacie: DphZistenie[] = [];
  const doklad = extrakt(dokument);
  // Firma bez profilu (nezname) nie je ani platiteľ, ani neplatiteľ: blokácie
  // odpočtu ani kontroly krátenia pre ňu nebežia, kým to účtovník nevyplní.
  const bezNarokuNaOdpocet = profil.platitelDph === 'neplatitel' || profil.platitelDph === 'registracia_7a';
  // Členenia, ktoré doklad naozaj uplatní: hlavička a každá položka s vlastným
  // členením (prázdne pole položky dedí hlavičku). Export ich posiela za riadok,
  // takže odpočet na položke je odpočet aj pod hlavičkou „bez odpočtu" — kým sa
  // posudzovala len hlavička, neplatiteľ s položkou PD prešiel bez blokácie.
  const zoznamPoloziek = dokument.extracted?.polozky;
  const polozky: Array<Record<string, any>> = Array.isArray(zoznamPoloziek) ? zoznamPoloziek : [];
  const clenenia = [
    dokument.clenenieDph,
    ...polozky.map((polozka) => dokument.cleneniaPoloziek?.find((clenenie) => clenenie.id === polozka?.ucto?.clenenieDphId)),
  ].filter((clenenie, index, vsetky): clenenie is { id: string; kod: string; nazov: string } =>
    Boolean(clenenie) && vsetky.findIndex((ine) => ine?.id === clenenie?.id) === index);

  // Neplatiteľ / registrácia §7a: nikdy nemá nárok na odpočet.
  if (bezNarokuNaOdpocet) {
    navrhy.push({
      kod: 'dph_bez_odpoctu',
      sprava: profil.platitelDph === 'neplatitel'
        ? 'Organizácia nie je platiteľ DPH — doklad účtovať bez odpočtu.'
        : 'Organizácia je registrovaná podľa §7a — bez nároku na odpočet DPH.',
      clenenieDphId: profil.clenenieBezOdpoctuId,
    });
    for (const clenenie of clenenia) {
      const povolene = profil.clenenieBezOdpoctuId
        ? clenenie.id === profil.clenenieBezOdpoctuId
        : !clenenieVyzeraNaOdpocet(clenenie);
      if (!povolene) {
        blokacie.push({
          kod: 'dph_neplatitel_odpocet',
          sprava: `Organizácia nemá nárok na odpočet DPH, ale členenie „${clenenie.kod} — ${clenenie.nazov}“ odpočet uplatňuje. Vyberte členenie bez odpočtu.`,
          clenenieDphId: profil.clenenieBezOdpoctuId,
        });
      }
    }
  }

  // Kandidát na samozdanenie: cudzí dodávateľ (z EÚ aj spoza nej) a doklad bez
  // DPH. Beží aj bez profilu — o tom, že daň priznáva príjemca, rozhoduje doklad,
  // nie nastavenie. IČ DPH z EÚ stačí aj bez prečítanej krajiny.
  const prefix = doklad.dodavatelIcDph.slice(0, 2);
  const cudziDodavatel = jeCudziDodavatel({ icDph: doklad.dodavatelIcDph, krajina: doklad.dodavatelKrajina })
    || EU_DPH_PREFIXY.includes(prefix);
  if (cudziDodavatel && doklad.dphSpolu === 0 && doklad.sumaSpolu > 0) {
    // Cudzia firma so slovenskou adresou je cudzia podľa IČ DPH.
    const uzemie = doklad.dodavatelKrajina && doklad.dodavatelKrajina !== 'SK' ? doklad.dodavatelKrajina : prefix;
    const sadzba = sadzbyDphPre(doklad.duzp)?.high;
    const dan = sadzba
      ? ` DPH ${sadzba} % = ${round2((doklad.zaklad * sadzba) / 100).toFixed(2)} na vstupe aj výstupe.` : '';
    // Druh plnenia (služba či tovar) z dokladu nevyčítame. Členenie faktúry sa
    // preto navrhne, len keď ho všetky potvrdené druhy pre územie majú rovnaké.
    const druhy = (EU_DPH_PREFIXY.includes(uzemie) ? ['sluzby_eu', 'tovar_eu'] as const : ['sluzby_mimo_eu'] as const)
      .flatMap((druh) => (profil.samozdanenie[druh] ? [[druh, profil.samozdanenie[druh]!] as const] : []));
    const faktury = new Set(druhy.map(([, nastavenie]) => nastavenie.faktura?.clenenieDphId));
    const kv = new Set(druhy.map(([, nastavenie]) => nastavenie.faktura?.kv));
    const clenenieDphId = faktury.size === 1 ? [...faktury][0] : undefined;
    const vety = druhy.map(([druh, nastavenie]) => vetaDruhu(druh, nastavenie)).filter(Boolean);
    navrhy.push({
      kod: 'dph_samozdanenie_kandidat',
      sprava: `Kandidát na samozdanenie: dodávateľ z ${uzemie} fakturuje bez DPH.${dan}${vety.length > 0 ? ` Firma účtuje: ${vety.join('. ')}.` : ''}`,
      clenenieDphId,
      clenenieKvKod: clenenieDphId && kv.size === 1 ? [...kv][0] : undefined,
    });
  }

  // Cudzia daň: dodávateľ so zahraničnou adresou účtuje daň pod vlastným
  // (neslovenským) IČ DPH — rakúskych 20 %, českých 21 %, nemeckých 19 %. Taká
  // daň do slovenského priznania nevstupuje a odpočítať sa nedá (vrátiť ju vie
  // len žiadosť podľa §55f), takže tuzemské členenie s odpočtom je chyba, nie
  // odhad. Zahraničná firma s IČ DPH „SK…" fakturuje slovenskú daň — tá je
  // bežný tuzemský nákup a podmienkou na prefixe sem nespadne.
  const cudziaDan = doklad.dphSpolu > 0
    && jeCudziDodavatel({ icDph: doklad.dodavatelIcDph, krajina: doklad.dodavatelKrajina });
  if (cudziaDan) {
    const sprava = `Dodávateľ z ${doklad.dodavatelKrajina} fakturuje vlastnú DPH ${doklad.dphSpolu.toFixed(2)} ${doklad.mena} — zahraničná daň nevstupuje do slovenského priznania ani do kontrolného výkazu a nie je odpočítateľná.`;
    navrhy.push({ kod: 'dph_cudzia_dan', sprava });
    for (const clenenie of clenenia.filter(clenenieVyzeraNaOdpocet)) {
      blokacie.push({
        kod: 'dph_cudzia_dan_odpocet',
        sprava: `${sprava} Členenie „${clenenie.kod} — ${clenenie.nazov}“ pritom odpočet uplatňuje. Vyberte členenie bez nároku na odpočet (nezahrnované do priznania).`,
      });
    }
  }

  // Tuzemské prenesenie daňovej povinnosti (§69 ods. 12): SK dodávateľ fakturuje
  // bez DPH — len vo firme, ktorá prenesenie podľa účtovníka prijíma.
  if (profil.samozdanenie.prenesenie_prijate && prefix === 'SK' && doklad.dphSpolu === 0 && doklad.sumaSpolu > 0) {
    const bezneClenenie = dokument.clenenieDph && clenenieVyzeraNaOdpocet(dokument.clenenieDph);
    varovania.push({
      kod: 'dph_prenesenie_kandidat',
      sprava: bezneClenenie
        ? 'Doklad vyzerá na tuzemské prenesenie daňovej povinnosti (§69), ale je zvolené bežné členenie DPH — skontrolujte zaúčtovanie.'
        : 'Doklad vyzerá na tuzemské prenesenie daňovej povinnosti (§69) — DPH priznáva odberateľ.',
    });
  }

  // Sekcia B2/B3 patrí plneniu, pri ktorom sa odpočítava (§ 78a). Posudzuje sa
  // celý doklad: hlavička PD s B2 a riadky PN sú čiastočný odpočet, zákonný —
  // takých má produkcia 675. Podozrivý je až doklad, na ktorom sa neodpočítava
  // nič. Ani vtedy nie blokácia: „PN s B2" môže mať vysvetlenie (odpočet
  // v inom období, lízing), preto len návrh KN a rozhodne účtovník. Členenie,
  // ktoré sa nedá rozpísať z číselníka, nič nedokazuje — vtedy mlčíme.
  const kvHlavicky = dokument.accounting?.clenenieKvKod;
  const riadkyDokladu = [
    { clenenie: dokument.clenenieDph, kv: kvHlavicky },
    ...polozky.map((polozka) => ({
      clenenie: polozka?.ucto?.clenenieDphId
        ? dokument.cleneniaPoloziek?.find((clenenie) => clenenie.id === polozka.ucto.clenenieDphId)
        : dokument.clenenieDph,
      kv: polozka?.ucto?.clenenieKvKod || kvHlavicky,
    })),
  ];
  if (riadkyDokladu.some((riadok) => riadok.kv === 'B2' || riadok.kv === 'B3')
    && riadkyDokladu.every((riadok) => riadok.clenenie && !clenenieVyzeraNaOdpocet(riadok.clenenie))) {
    navrhy.push({
      kod: 'dph_kv_bez_odpoctu',
      sprava: 'Doklad má sekciu B.2/B.3, ale nenašli sme uplatnený odpočet DPH. Overte celý doklad a obdobie odpočtu.',
      clenenieKvKod: 'KN',
    });
  }

  // Pravidlá pre autá, pomerné odpočítanie a koeficient — len pre platiteľa.
  if (profil.platitelDph === 'platitel') {
    varovania.push(...pravidloVarovanie('dph_auto_odpocet', profil.pravidlaAut, doklad.texty, false, dokument.documentType));
    varovania.push(...pravidloVarovanie('dph_pomerny_odpocet', profil.pomerneOdpocitanie, doklad.texty, true, dokument.documentType));
    if (profil.oslobodenePlnenia && profil.koeficient !== undefined) {
      navrhy.push({
        kod: 'dph_koeficient',
        percento: round2(profil.koeficient * 100),
        sprava: `Organizácia kráti odpočet koeficientom ${profil.koeficient.toFixed(2).replace('.', ',')}.`,
      });
    }
  }

  return { navrhy, varovania, blokacie };
}

/**
 * Pokyny pre AI (návrh zaúčtovania, právna kontrola, asistent) z potvrdených
 * faktov — nezávislé od dokladu. Nesú KÓDY z číselníka firmy, nie id: model
 * id nerozlúšti a surové id v pokyne mu podsúvalo kód bez významu.
 */
export function dphPokynyPreAi(profil: DphProfil): string[] {
  const pokyny: string[] = [];
  const slova = (pravidlo: DphPravidloOdpoctu) => pravidlo.klucoveSlova.map((slovo) => `„${slovo}“`).join(', ');
  if (profil.platitelDph === 'neplatitel' || profil.platitelDph === 'registracia_7a') {
    pokyny.push(`Organizácia nemá nárok na odpočet DPH — vždy vyber členenie DPH bez odpočtu${profil.clenenieBezOdpoctuKod ? ` (${profil.clenenieBezOdpoctuKod})` : ''}.`);
  }
  for (const druh of DRUHY_SAMOZDANENIA) {
    const veta = profil.samozdanenie[druh] && vetaDruhu(druh, profil.samozdanenie[druh]!);
    if (veta) pokyny.push(`${veta}.`);
  }
  if (profil.oslobodenePlnenia === true) {
    const koeficient = profil.koeficient === undefined ? '' : ` ${profil.koeficient.toFixed(2).replace('.', ',')}`;
    pokyny.push(`Organizácia má aj oslobodené plnenia — odpočet kráti koeficientom${koeficient} (členenia krátenia PK).`);
  } else if (profil.oslobodenePlnenia === false) {
    pokyny.push('Organizácia nemá oslobodené plnenia — odpočet nekráti, členenia krátenia (PK) nepoužívaj.');
  }
  for (const pravidlo of profil.pravidlaAut) {
    const nedanove = pravidlo.clenenieDphNedanoveKod ? ` s členením ${pravidlo.clenenieDphNedanoveKod}` : '';
    const typy = pravidlo.typyDokladov?.length ? ` typu ${pravidlo.typyDokladov.join(', ')}` : '';
    pokyny.push(`Ak sa v doklade${typy} vyskytuje ${slova(pravidlo)}, daňový náklad je ${pravidlo.percento} % a odpočet DPH ${pravidlo.percentoDph ?? pravidlo.percento} % (${pravidlo.kategoria}; daňová časť ${pravidlo.predkontaciaKod}, nedaňová ${pravidlo.predkontaciaNedanovaKod}${nedanove}).`);
  }
  for (const pravidlo of profil.pomerneOdpocitanie) {
    pokyny.push(`Ak sa v doklade vyskytuje ${slova(pravidlo)}, odpočet DPH je len ${pravidlo.percentoDph ?? pravidlo.percento} % (${pravidlo.kategoria}; obe časti na ${pravidlo.predkontaciaKod}, neodpočítaná s členením ${pravidlo.clenenieDphNedanoveKod}).`);
  }
  for (const ucet of profil.bezNarokuUcty) {
    pokyny.push(`Na účte ${ucet.predkontaciaKod} firma neodpočítava — členenie ${ucet.clenenieKod}.`);
  }
  if (profil.vratenieDph) {
    pokyny.push(profil.vratenieDph.uplatnujeme
      ? `Zahraničnú DPH si firma nechá vrátiť (§55a) — položka cudzej dane je pohľadávka${profil.vratenieDph.predkontaciaKod ? ` na ${profil.vratenieDph.predkontaciaKod}` : ''}, nie náklad.`
      : 'Zahraničnú DPH si firma vrátiť nenecháva — cudzia daň je súčasťou nákladu.');
  }
  if (profil.tovarNaCeste !== undefined) {
    pokyny.push(profil.tovarNaCeste ? 'Firma účtuje tovar na ceste (účet 139).' : 'Firma tovar na ceste (účet 139) neúčtuje.');
  }
  if (profil.drobnyMajetokHranica !== undefined) {
    pokyny.push(`Majetok so základom od ${profil.drobnyMajetokHranica} € je dlhodobý; lacnejší je drobný majetok v nákladoch.`);
  }
  return pokyny;
}

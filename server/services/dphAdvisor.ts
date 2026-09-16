import type {
  DphKoeficientZaznam,
  DphPravidloOdpoctu,
  DphProfil,
} from './dphProfileService.js';
import { popisKodu } from './pohodaDphKody.js';

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

const EU_DPH_PREFIXY = [
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
 * Koeficient pre rok plnenia. Keď na ten rok zápis chýba, platí ročný
 * koeficient predchádzajúceho roka — počas roka sa odpočet kráti práve ním
 * (§ 50 ods. 4). Starší sa nepoužije: koeficient z roku 2024 na doklade z roku
 * 2026 je iné číslo, nie odhad.
 */
function koeficientPre(zaznamy: DphKoeficientZaznam[], duzp?: string): DphKoeficientZaznam | undefined {
  if (!duzp) return undefined;
  const datum = duzp.slice(0, 10);
  const rok = Number(datum.slice(0, 4));
  const platne = zaznamy.filter((zaznam) => pravidloPlati(zaznam, datum));
  const preRok = platne.filter((zaznam) => zaznam.rok === rok);
  return preRok.find((zaznam) => zaznam.typ === 'zalohovy') ?? preRok[0]
    ?? platne.find((zaznam) => zaznam.rok === rok - 1 && zaznam.typ === 'rocny');
}

/**
 * Platí pravidlo (alebo koeficient) pre plnenie k danému dňu? Bez dátumov
 * platí vždy. S dátumami a bez dňa plnenia nie — nevieme, či doň patrí.
 */
export function pravidloPlati(pravidlo: { platnostOd?: string; platnostDo?: string }, datum: string | undefined): boolean {
  if (!pravidlo.platnostOd && !pravidlo.platnostDo) return true;
  if (!datum) return false;
  const den = datum.slice(0, 10);
  return (!pravidlo.platnostOd || pravidlo.platnostOd <= den) && (!pravidlo.platnostDo || den <= pravidlo.platnostDo);
}

function pravidloVarovanie(
  kod: string,
  pravidla: DphPravidloOdpoctu[],
  texty: string[],
  duzp: string | undefined,
): DphZistenie[] {
  const zistenia: DphZistenie[] = [];
  for (const pravidlo of pravidla.filter((item) => pravidloPlati(item, duzp))) {
    const zhoda = najdiKlucoveSlovo(texty, pravidlo.klucoveSlova);
    if (!zhoda) continue;
    zistenia.push({
      kod,
      kategoria: pravidlo.kategoria,
      percento: pravidlo.percento,
      sprava: `Odpočet len ${pravidlo.percento} % — ${pravidlo.kategoria} (nájdené „${zhoda}“).`,
    });
  }
  return zistenia;
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

  // Uzavreté DPH obdobie: DUZP v už podanom období = dodatočné priznanie.
  if (profil.uzavreteDo && doklad.duzp && doklad.duzp.slice(0, 10) <= profil.uzavreteDo) {
    const obdobie = profil.obdobieDph === 'mesacne' ? 'mesačné' : 'štvrťročné';
    varovania.push({
      kod: 'dph_obdobie_uzavrete',
      sprava: `DUZP ${doklad.duzp.slice(0, 10)} spadá do už podaného obdobia (${obdobie}, podané do ${profil.uzavreteDo}) — zvážte dodatočné priznanie.`,
    });
  }

  // Kandidát na samozdanenie: dodávateľ s IČ DPH z inej krajiny EÚ a doklad bez DPH.
  const prefix = doklad.dodavatelIcDph.slice(0, 2);
  const jeEuDodavatel = EU_DPH_PREFIXY.includes(prefix);
  const relevantneSamozdanenie = profil.samozdanenieAktivne || profil.nakupyZEu || profil.sluzbyZEu
    || profil.platitelDph === 'registracia_7a';
  if (relevantneSamozdanenie && jeEuDodavatel && doklad.dphSpolu === 0 && doklad.sumaSpolu > 0) {
    const sadzba = sadzbyDphPre(doklad.duzp)?.high;
    const dan = sadzba
      ? ` DPH ${sadzba} % = ${round2((doklad.zaklad * sadzba) / 100).toFixed(2)} na vstupe aj výstupe.` : '';
    navrhy.push({
      kod: 'dph_samozdanenie_kandidat',
      sprava: `Kandidát na samozdanenie: dodávateľ s IČ DPH ${prefix} fakturuje bez DPH.${dan}`,
      clenenieDphId: profil.samozdanenieClenenieDphId,
      clenenieKvKod: profil.samozdanenieClenenieKvKod,
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

  // Tuzemské prenesenie daňovej povinnosti (§69): SK dodávateľ fakturuje bez DPH.
  if (profil.prenesenieDp && prefix === 'SK' && doklad.dphSpolu === 0 && doklad.sumaSpolu > 0) {
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

  // Pravidlá pre autá a pomerné odpočítanie — len pre platiteľa.
  if (profil.platitelDph === 'platitel') {
    varovania.push(...pravidloVarovanie('dph_auto_odpocet', profil.pravidlaAut, doklad.texty, doklad.duzp));
    varovania.push(...pravidloVarovanie('dph_pomerny_odpocet', profil.pomerneOdpocitanie, doklad.texty, doklad.duzp));

    for (const kategoria of profil.bezNaroku) {
      const zhoda = najdiKlucoveSlovo(doklad.texty, kategoria.klucoveSlova);
      if (!zhoda) continue;
      varovania.push({
        kod: 'dph_bez_naroku',
        kategoria: kategoria.kategoria,
        sprava: `Bez nároku na odpočet — ${kategoria.kategoria} (nájdené „${zhoda}“).`,
      });
    }

    const koeficient = koeficientPre(profil.koeficient, doklad.duzp);
    if (koeficient) {
      navrhy.push({
        kod: 'dph_koeficient',
        percento: round2(koeficient.hodnota * 100),
        sprava: `Organizácia kráti odpočet koeficientom ${koeficient.hodnota.toFixed(2).replace('.', ',')} (${koeficient.typ === 'zalohovy' ? 'zálohový' : 'ročný'}, ${koeficient.rok}).`,
      });
    }
  }

  return { navrhy, varovania, blokacie };
}

/**
 * Pokyny pre AI návrh zaúčtovania odvodené z profilu — nezávislé od dokladu.
 * Vkladajú sa do promptu ako dáta (profilKlienta.pokyny).
 */
export function dphPokynyPreAi(profil: DphProfil): string[] {
  const pokyny: string[] = [];
  if (profil.platitelDph === 'neplatitel' || profil.platitelDph === 'registracia_7a') {
    pokyny.push('Organizácia nemá nárok na odpočet DPH — vždy vyber členenie DPH bez odpočtu.');
  }
  if (profil.samozdanenieAktivne || profil.nakupyZEu || profil.sluzbyZEu) {
    pokyny.push('Pri dodávateľovi z EÚ s dokladom bez DPH ide o samozdanenie'
      + (profil.samozdanenieClenenieDphId ? ` — použi členenie DPH s id ${profil.samozdanenieClenenieDphId}.` : '.'));
  }
  if (profil.prenesenieDp) {
    pokyny.push('Organizácia účtuje tuzemské prenesenie daňovej povinnosti (§69) — SK doklad bez DPH nie je bežný nákup.');
  }
  for (const pravidlo of [...profil.pravidlaAut, ...profil.pomerneOdpocitanie]) {
    if (pravidlo.klucoveSlova.length === 0) continue;
    // Pokyny sú nezávislé od dokladu, preto obdobie ide do textu — model ho
    // porovná s dňom plnenia sám a deterministický rez ho aj tak overí.
    const obdobie = [pravidlo.platnostOd && `od ${pravidlo.platnostOd}`, pravidlo.platnostDo && `do ${pravidlo.platnostDo}`]
      .filter(Boolean).join(' ');
    pokyny.push(`Ak sa v doklade vyskytuje ${pravidlo.klucoveSlova.map((slovo) => `„${slovo}“`).join(', ')}, odpočet je len ${pravidlo.percento} % (${pravidlo.kategoria}${obdobie ? `; platí pre plnenie ${obdobie}` : ''}).`);
  }
  for (const kategoria of profil.bezNaroku) {
    if (kategoria.klucoveSlova.length === 0) continue;
    pokyny.push(`Ak sa v doklade vyskytuje ${kategoria.klucoveSlova.map((slovo) => `„${slovo}“`).join(', ')}, je to ${kategoria.kategoria} bez nároku na odpočet.`);
  }
  return pokyny;
}

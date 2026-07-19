import type {
  DphKoeficientZaznam,
  DphPravidloOdpoctu,
  DphProfil,
} from './dphProfileService.js';

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

interface ExtraktDokladu {
  dodavatelNazov: string;
  dodavatelIcDph: string;
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
  const dphSpolu = rozpis.reduce((sum: number, row: any) => sum + (Number(row?.dph) || 0), 0);
  const zakladZRozpisu = rozpis.reduce((sum: number, row: any) => sum + (Number(row?.zaklad) || 0), 0);
  const texty = [
    String(dodavatel.nazov ?? ''),
    ...polozky.map((polozka: any) => String(polozka?.popis ?? '')),
    String(extracted.textPolozky ?? ''),
  ].filter(Boolean);
  return {
    dodavatelNazov: String(dodavatel.nazov ?? ''),
    dodavatelIcDph: String(dodavatel.icDph ?? '').replace(/\s+/g, '').toUpperCase(),
    duzp: (extracted.datumDodania ?? extracted.datumVystavenia) as string | undefined,
    sumaSpolu,
    zaklad: zakladZRozpisu > 0 ? zakladZRozpisu : sumaSpolu,
    dphSpolu,
    texty,
  };
}

function najdiKlucoveSlovo(texty: string[], klucoveSlova: string[]): string | undefined {
  for (const slovo of klucoveSlova) {
    const hladane = bezDiakritiky(slovo.trim());
    if (!hladane) continue;
    if (texty.some((text) => bezDiakritiky(text).includes(hladane))) return slovo;
  }
  return undefined;
}

/** Heuristika: členenie DPH podľa kódu/názvu nevyzerá ako „bez odpočtu“. */
export function clenenieVyzeraNaOdpocet(clenenie: { kod: string; nazov: string }): boolean {
  const text = bezDiakritiky(`${clenenie.kod} ${clenenie.nazov}`);
  if (/bez\s*(naroku|odpoctu)/.test(text)) return false;
  if (/neodpocitava|neplatitel|mimo\s*dph|nezahrnovat/.test(text)) return false;
  const kod = clenenie.kod.trim().toUpperCase();
  if (kod === 'BO' || kod === 'KN' || kod === 'BN' || kod.startsWith('UN')) return false;
  return true;
}

function koeficientPre(zaznamy: DphKoeficientZaznam[], duzp?: string): DphKoeficientZaznam | undefined {
  if (zaznamy.length === 0) return undefined;
  const rok = duzp ? Number(duzp.slice(0, 4)) : undefined;
  const preRok = rok ? zaznamy.filter((zaznam) => zaznam.rok === rok) : [];
  const kandidati = preRok.length > 0
    ? preRok
    : [...zaznamy].sort((a, b) => b.rok - a.rok).filter((zaznam, _, all) => zaznam.rok === all[0].rok);
  return kandidati.find((zaznam) => zaznam.typ === 'zalohovy') ?? kandidati[0];
}

function pravidloVarovanie(
  kod: string,
  pravidla: DphPravidloOdpoctu[],
  texty: string[],
): DphZistenie[] {
  const zistenia: DphZistenie[] = [];
  for (const pravidlo of pravidla) {
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
  const bezNarokuNaOdpocet = profil.platitelDph !== 'platitel';

  // Neplatiteľ / registrácia §7a: nikdy nemá nárok na odpočet.
  if (bezNarokuNaOdpocet) {
    navrhy.push({
      kod: 'dph_bez_odpoctu',
      sprava: profil.platitelDph === 'neplatitel'
        ? 'Organizácia nie je platiteľ DPH — doklad účtovať bez odpočtu.'
        : 'Organizácia je registrovaná podľa §7a — bez nároku na odpočet DPH.',
      clenenieDphId: profil.clenenieBezOdpoctuId,
    });
    if (dokument.clenenieDph) {
      const povolene = profil.clenenieBezOdpoctuId
        ? dokument.clenenieDph.id === profil.clenenieBezOdpoctuId
        : !clenenieVyzeraNaOdpocet(dokument.clenenieDph);
      if (!povolene) {
        blokacie.push({
          kod: 'dph_neplatitel_odpocet',
          sprava: `Organizácia nemá nárok na odpočet DPH, ale členenie „${dokument.clenenieDph.kod} — ${dokument.clenenieDph.nazov}“ odpočet uplatňuje. Vyberte členenie bez odpočtu.`,
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
    const dph23 = round2(doklad.zaklad * 0.23);
    navrhy.push({
      kod: 'dph_samozdanenie_kandidat',
      sprava: `Kandidát na samozdanenie: dodávateľ s IČ DPH ${prefix} fakturuje bez DPH. DPH 23 % = ${dph23.toFixed(2)} na vstupe aj výstupe.`,
      clenenieDphId: profil.samozdanenieClenenieDphId,
      clenenieKvKod: profil.samozdanenieClenenieKvKod,
    });
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

  // Pravidlá pre autá a pomerné odpočítanie — len pre platiteľa.
  if (!bezNarokuNaOdpocet) {
    varovania.push(...pravidloVarovanie('dph_auto_odpocet', profil.pravidlaAut, doklad.texty));
    varovania.push(...pravidloVarovanie('dph_pomerny_odpocet', profil.pomerneOdpocitanie, doklad.texty));

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
  if (profil.platitelDph !== 'platitel') {
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
    pokyny.push(`Ak sa v doklade vyskytuje ${pravidlo.klucoveSlova.map((slovo) => `„${slovo}“`).join(', ')}, odpočet je len ${pravidlo.percento} % (${pravidlo.kategoria}).`);
  }
  for (const kategoria of profil.bezNaroku) {
    if (kategoria.klucoveSlova.length === 0) continue;
    pokyny.push(`Ak sa v doklade vyskytuje ${kategoria.klucoveSlova.map((slovo) => `„${slovo}“`).join(', ')}, je to ${kategoria.kategoria} bez nároku na odpočet.`);
  }
  return pokyny;
}

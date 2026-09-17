import type { NavrhPravidlaDelenia, ProfilDokaz, ProfilFakt, ProfilKlienta, ProfilOtazka, VariantOtazky } from '../../data/types';
import { sk, t, tv, type SkKey } from '../../i18n/sk';

/**
 * Klientská časť katalógu profilu klienta: poradie, texty a ľudská veta hodnoty.
 * Tvar hodnôt a overenie drží server (server/services/profilKatalog.ts) — tu
 * sa nič neoveruje proti číselníku, len sa skladá formulár a veta.
 */

export type Sekcia = 'dph' | 'samozdanenie' | 'vozidla' | 'naklady' | 'zasady';

/** Druhy s faktúrou dodávateľa aj interným dokladom (DD… a P…). */
export const DRUHY_S_INTERNYM = ['sluzby_eu', 'sluzby_mimo_eu', 'tovar_eu', 'prenesenie_prijate'];
/** Prijaté hore, vystavené dole — dovoz je nákup, len bez interného dokladu. */
export const DRUHY_PRIJATE = [...DRUHY_S_INTERNYM, 'dovoz'];
export const DRUHY_VYSTAVENE = ['prenesenie_vystavene', 'sluzby_zahranicie_vystavene', 'zahranicie_vystavene', 'tovar_do_eu'];

export const SEKCIE: ReadonlyArray<{ id: Sekcia; kluce: readonly string[] }> = [
  { id: 'dph', kluce: ['dph.status', 'dph.clenenie_bez_odpoctu', 'dph.oslobodene_plnenia'] },
  {
    id: 'samozdanenie',
    kluce: [...DRUHY_PRIJATE, ...DRUHY_VYSTAVENE].map((druh) => `samozdanenie.${druh}`).concat('zahranicie.vratenie_dph'),
  },
  { id: 'vozidla', kluce: ['vozidla.pravidla'] },
  { id: 'naklady', kluce: ['naklady.bez_naroku', 'naklady.pomerne'] },
  { id: 'zasady', kluce: ['zasady.tovar_na_ceste', 'zasady.drobny_majetok'] },
];

/** Fakty, ktorých hodnota je zoznam — upravuje sa po položkách, ukladá celý. */
export const ZOZNAMOVE = new Set(['vozidla.pravidla', 'naklady.bez_naroku', 'naklady.pomerne']);

export const STATUSY = ['platitel', 'registracia_7', 'registracia_7a', 'neplatitel'] as const;

type Obj = Record<string, unknown>;
const obj = (hodnota: unknown): Obj => (hodnota && typeof hodnota === 'object' && !Array.isArray(hodnota) ? hodnota as Obj : {});
const text = (hodnota: unknown) => (typeof hodnota === 'string' ? hodnota : '');
const zoznam = (hodnota: unknown): Obj[] => (Array.isArray(hodnota) ? hodnota.map(obj) : []);
/** Texty bez typovej kontroly kľúča — test drží, že pre každý kľúč katalógu existujú. */
const tk = (kluc: string) => (sk as Record<string, string>)[kluc] ?? kluc;

export const nazovFaktu = (kluc: string) => tk(`profilKlienta.fakt.${kluc}.nazov`);
export const popisFaktu = (kluc: string) => tk(`profilKlienta.fakt.${kluc}.popis`);
export const kluceFaktov = () => SEKCIE.flatMap((sekcia) => sekcia.kluce);
/** Názov do stredu vety: „Služby z EÚ" → „služby z EÚ". */
export const malym = (veta: string) => veta.replace(/^./, (pismeno) => pismeno.toLocaleLowerCase('sk'));

const cislo = (hodnota: number) => new Intl.NumberFormat('sk-SK', { maximumFractionDigits: 4 }).format(hodnota);

/** Kódy POHODY v hodnote (aj vnorené a v zozname) — na tooltip s názvami. */
export function kodyHodnoty(hodnota: unknown): string[] {
  const kody: string[] = [];
  const prejdi = (uzol: unknown) => {
    if (Array.isArray(uzol)) return uzol.forEach(prejdi);
    if (!uzol || typeof uzol !== 'object') return;
    for (const [pole, cast] of Object.entries(uzol)) {
      if (/Kod$/.test(pole) && typeof cast === 'string') kody.push(cast);
      else prejdi(cast);
    }
  };
  prejdi(hodnota);
  return [...new Set(kody)];
}

/** Hodnota faktu jednou vetou pre účtovníčku. Neznámy tvar → „—". */
export function vetaHodnoty(kluc: string, hodnota: unknown): string {
  if (hodnota === null || hodnota === undefined) return '—';
  const h = obj(hodnota);
  const kv = (cast: Obj) => (text(cast.kv) ? `, ${tv('profilKlienta.veta.kv', { kv: text(cast.kv) })}` : '');
  switch (kluc) {
    case 'dph.status':
      return (STATUSY as readonly string[]).includes(text(h.status)) ? t(`profilKlienta.status.${h.status}` as SkKey) : '—';
    case 'dph.clenenie_bez_odpoctu':
      return text(h.clenenieKod) ? tv('profilKlienta.veta.clenenieBezOdpoctu', { kod: text(h.clenenieKod) }) : '—';
    case 'dph.oslobodene_plnenia':
      if (h.ano !== true) return h.ano === false ? t('profilKlienta.veta.oslobodeneNie') : '—';
      return typeof h.koeficient === 'number'
        ? tv('profilKlienta.veta.oslobodeneKoeficient', { koeficient: cislo(h.koeficient) }) : t('profilKlienta.veta.oslobodeneAno');
    case 'zahranicie.vratenie_dph':
      if (h.uplatnujeme !== true) return h.uplatnujeme === false ? t('profilKlienta.veta.vratenieNie') : '—';
      return text(h.predkontaciaKod) ? tv('profilKlienta.veta.vratenieAnoUcet', { kod: text(h.predkontaciaKod) }) : t('profilKlienta.veta.vratenieAno');
    case 'vozidla.pravidla':
    case 'naklady.pomerne':
      return zoznam(hodnota).length ? tv('profilKlienta.veta.pocetPravidiel', { n: String(zoznam(hodnota).length) }) : t('profilKlienta.veta.ziadne');
    case 'naklady.bez_naroku':
      return zoznam(hodnota).length
        ? tv('profilKlienta.veta.bezNaroku', { ucty: zoznam(hodnota).map((ucet) => `${text(ucet.predkontaciaKod)} (${text(ucet.clenenieKod)})`).join(', ') })
        : t('profilKlienta.veta.ziadne');
    case 'zasady.tovar_na_ceste':
      return h.pouziva === true ? t('profilKlienta.veta.tovarNaCesteAno') : h.pouziva === false ? t('profilKlienta.veta.tovarNaCesteNie') : '—';
    case 'zasady.drobny_majetok':
      return typeof h.hranica === 'number' ? tv('profilKlienta.veta.drobnyMajetok', { suma: `${cislo(h.hranica)} €` }) : '—';
  }
  if (!kluc.startsWith('samozdanenie.')) return '—';
  const faktura = obj(h.faktura);
  const interny = obj(h.interny);
  const casti = [
    text(faktura.clenenieKod) && tv('profilKlienta.veta.faktura', { kod: text(faktura.clenenieKod) }) + kv(faktura),
    text(interny.ddKod) && tv('profilKlienta.veta.interny', { kody: [interny.ddKod, interny.pKod].filter(text).join(' a ') }) + kv(interny),
  ].filter(Boolean);
  return casti.length ? casti.join(' · ') : t('profilKlienta.veta.bezKodov');
}

/** Variant dôkazu nemá vždy tvar hodnoty faktu (napr. len DD kód) — stačia jeho kódy za sebou. */
export function vetaVariantu(hodnota: unknown): string {
  const casti: string[] = [];
  const prejdi = (uzol: unknown) => {
    if (uzol && typeof uzol === 'object') Object.values(uzol).forEach(prejdi);
    else if (uzol !== undefined && uzol !== null && uzol !== '') casti.push(String(uzol));
  };
  prejdi(hodnota);
  return casti.join(' · ') || '—';
}

/** Status z potvrdeného alebo navrhnutého faktu — len podľa neho sa ukáže členenie bez odpočtu. */
export function relevantneKluce(fakty: ProfilFakt[]): string[] {
  const status = obj(fakty.find((fakt) => fakt.kluc === 'dph.status' && fakt.stav !== 'nepouziva_sa')?.hodnota).status;
  // Potvrdené členenie engine používa vždy — skryť ho by znamenalo, že ho nikto nezmení.
  const bezOdpoctuPotvrdene = fakty.some((fakt) => fakt.kluc === 'dph.clenenie_bez_odpoctu' && fakt.stav === 'potvrdene');
  return kluceFaktov().filter((kluc) => kluc !== 'dph.clenenie_bez_odpoctu' || status !== 'platitel' || bezOdpoctuPotvrdene);
}

export type StavFaktu = 'potvrdene' | 'navrhnute' | 'odpovedat' | 'nepouziva_sa' | 'nevyplnene';

export function stavFaktu(kluc: string, profil: Pick<ProfilKlienta, 'fakty' | 'otazky'>): StavFaktu {
  const fakt = profil.fakty.find((item) => item.kluc === kluc);
  if (fakt) return fakt.stav;
  return profil.otazky.some((otazka) => otazka.kluc === `fakt:${kluc}`) ? 'odpovedat' : 'nevyplnene';
}

/** „Potvrdené" v hlavičke a prstenci zahŕňa aj „nepoužíva sa" — aj to je rozhodnutie účtovníka. */
export const rozhodnute = (stav: StavFaktu) => stav === 'potvrdene' || stav === 'nepouziva_sa';

export function pocty(profil: ProfilKlienta) {
  const stavy = relevantneKluce(profil.fakty).map((kluc) => stavFaktu(kluc, profil));
  return {
    relevantnych: stavy.length,
    potvrdenych: stavy.filter(rozhodnute).length,
    navrhnutych: stavy.filter((stav) => stav === 'navrhnute').length + profil.navrhyDelenia.length,
    otazok: profil.otazky.length,
    blokuje: profil.otazky.some((otazka) => otazka.blokuje),
  };
}

export type BodkaSekcie = 'blokuje' | 'odpovedat' | 'navrhnute' | 'hotovo' | 'prazdne';

/** Bodka a počet v navigácii: čo v sekcii čaká na účtovníka (otázky a návrhy). */
export function stavSekcie(sekcia: Sekcia, profil: ProfilKlienta): { bodka: BodkaSekcie; pocet: number } {
  const kluce = relevantneKluce(profil.fakty).filter((kluc) => SEKCIE.find((item) => item.id === sekcia)!.kluce.includes(kluc));
  const otazky = profil.otazky.filter((otazka) => otazka.druh === 'fakt' && kluce.includes(otazka.kluc.slice('fakt:'.length)));
  const stavy = kluce.map((kluc) => stavFaktu(kluc, profil));
  const navrhnutych = stavy.filter((stav) => stav === 'navrhnute').length + (sekcia === 'vozidla' ? profil.navrhyDelenia.length : 0);
  const bodka: BodkaSekcie = otazky.some((otazka) => otazka.blokuje) ? 'blokuje'
    : otazky.length ? 'odpovedat'
      : navrhnutych ? 'navrhnute'
        : stavy.every(rozhodnute) ? 'hotovo' : 'prazdne';
  return { bodka, pocet: otazky.length + navrhnutych };
}

/** Blokujúce prvé, potom podľa počtu dokladov; odložené zvlášť. */
export function triedOtazky(otazky: ProfilOtazka[]): { otvorene: ProfilOtazka[]; odlozene: ProfilOtazka[] } {
  const zoradene = [...otazky].sort((a, b) => Number(b.blokuje) - Number(a.blokuje) || b.dokladov - a.dokladov);
  return {
    otvorene: zoradene.filter((otazka) => otazka.stav === 'otvorena'),
    odlozene: zoradene.filter((otazka) => otazka.stav === 'odlozena'),
  };
}

/** Jedna veta do hlavičky len z potvrdených faktov. */
export function suhrnProfilu(fakty: ProfilFakt[]): string {
  const potvrdene = new Map(fakty.filter((fakt) => fakt.stav === 'potvrdene').map((fakt) => [fakt.kluc, fakt.hodnota]));
  const druhy = [...DRUHY_PRIJATE, ...DRUHY_VYSTAVENE].filter((druh) => potvrdene.has(`samozdanenie.${druh}`))
    .map((druh) => malym(nazovFaktu(`samozdanenie.${druh}`)));
  const pocet = (kluc: string, kluc18n: SkKey) => (zoznam(potvrdene.get(kluc)).length
    ? tv(kluc18n, { n: String(zoznam(potvrdene.get(kluc)).length) }) : '');
  const casti = [
    potvrdene.has('dph.status') ? vetaHodnoty('dph.status', potvrdene.get('dph.status')) : '',
    druhy.length ? tv('profilKlienta.suhrn.samozdanenie', { druhy: druhy.join(', ') }) : '',
    pocet('vozidla.pravidla', 'profilKlienta.suhrn.vozidla'),
    pocet('naklady.bez_naroku', 'profilKlienta.suhrn.bezNaroku'),
    pocet('naklady.pomerne', 'profilKlienta.suhrn.pomerne'),
  ].filter(Boolean);
  return casti.length ? casti.join(' · ').replace(/^./, (pismeno) => pismeno.toLocaleUpperCase('sk')) : t('profilKlienta.suhrn.prazdny');
}

/**
 * Návrh delenia z histórie (id číselníka) → pravidlo vozidiel (kódy). Kód, ktorý
 * firma v číselníku už nemá, sa nedá preložiť — vtedy undefined, nie hádanie.
 */
export function pravidloZNavrhu(navrh: NavrhPravidlaDelenia, kodPodlaId: (id: string) => string | undefined): Obj | undefined {
  const predkontaciaKod = kodPodlaId(navrh.predkontaciaId);
  const predkontaciaNedanovaKod = kodPodlaId(navrh.predkontaciaNedanovaId);
  const clenenieDphNedanoveKod = navrh.clenenieDphNedanoveId ? kodPodlaId(navrh.clenenieDphNedanoveId) : undefined;
  if (!predkontaciaKod || !predkontaciaNedanovaKod || (navrh.clenenieDphNedanoveId && !clenenieDphNedanoveKod)) return undefined;
  // Limity schémy servera: názov 120 znakov, najviac 30 slov po 60 znakov.
  const klucoveSlova = navrh.klucoveSlova.slice(0, 30).map((slovo) => slovo.slice(0, 60));
  return {
    nazov: klucoveSlova.slice(0, 3).join(', ').slice(0, 120) || nazovFaktu('vozidla.pravidla'),
    klucoveSlova,
    percentoZakladu: navrh.percento,
    percentoDph: navrh.percentoDph ?? navrh.percento,
    predkontaciaKod,
    predkontaciaNedanovaKod,
    ...(clenenieDphNedanoveKod ? { clenenieDphNedanoveKod } : {}),
  };
}

// ===== Otázky =====

export interface DataFaktovejOtazky { kluc: string; navrh?: unknown; dokaz?: ProfilDokaz; rozpor?: boolean; napoveda?: string }
export interface DataSporu { agenda: string; protistrana: string; protistranaIco?: string; varianty: VariantOtazky[] }

export function nadpisOtazky(otazka: ProfilOtazka): string {
  if (otazka.druh === 'spor_protistrany') return tv('profilKlienta.otazka.spor', { protistrana: (otazka.data as DataSporu).protistrana });
  const data = otazka.data as DataFaktovejOtazky;
  if (data.rozpor) return tv('profilKlienta.otazka.rozpor', { nazov: nazovFaktu(data.kluc) });
  const vlastny = (sk as Record<string, string>)[`profilKlienta.otazka.${data.kluc}`];
  if (vlastny) return vlastny;
  return tv(data.navrh === undefined ? 'profilKlienta.otazka.nastavit' : 'profilKlienta.otazka.malo', { nazov: malym(nazovFaktu(data.kluc)) });
}

/** Prečo sa pýtame — z dát otázky, nie všeobecná veta. */
export function popisOtazky(otazka: ProfilOtazka, fakty: ProfilFakt[], nazovAgendy: (agenda: string) => string): string {
  if (otazka.druh === 'spor_protistrany') return tv('profilKlienta.otazka.spor.popis', { agenda: nazovAgendy((otazka.data as DataSporu).agenda) });
  const data = otazka.data as DataFaktovejOtazky;
  const dokladov = String(data.dokaz?.dokladov ?? otazka.dokladov);
  if (data.rozpor) {
    const fakt = fakty.find((item) => item.kluc === data.kluc);
    return tv('profilKlienta.otazka.rozpor.popis', {
      potvrdene: fakt?.stav === 'nepouziva_sa' ? t('profilKlienta.stav.nepouziva_sa') : vetaHodnoty(data.kluc, fakt?.hodnota),
      historia: vetaHodnoty(data.kluc, data.navrh),
      dokladov,
    });
  }
  const vlastny = (sk as Record<string, string>)[`profilKlienta.otazka.${data.kluc}.popis`];
  if (vlastny) {
    const napoveda = data.napoveda ? (sk as Record<string, string>)[`profilKlienta.otazka.${data.kluc}.napoveda`] : undefined;
    return [vlastny.replace('{dokladov}', dokladov), napoveda].filter(Boolean).join(' ');
  }
  return data.navrh === undefined ? popisFaktu(data.kluc)
    : tv('profilKlienta.otazka.malo.popis', { dokladov, veta: vetaHodnoty(data.kluc, data.navrh) });
}

// ===== Formulár faktu =====

export type TypPola = 'status' | 'anoNie' | 'predkontacia' | 'clenenie' | 'kv' | 'text' | 'slova' | 'cislo';

export interface PoleFormulara {
  /** Cesta v hodnote; s bodkou je v skupine (faktura.kv) — prázdna skupina sa vynechá celá. */
  cesta: string;
  typ: TypPola;
  povinne?: boolean;
  min?: number;
  max?: number;
  /** Pole sa ukáže (a uloží) len pri „áno" v tomto poli. */
  ked?: string;
}

const FAKTURA: PoleFormulara[] = [{ cesta: 'faktura.clenenieKod', typ: 'clenenie', povinne: true }, { cesta: 'faktura.kv', typ: 'kv' }];
const INTERNY: PoleFormulara[] = [
  { cesta: 'interny.ddKod', typ: 'clenenie', povinne: true }, { cesta: 'interny.pKod', typ: 'clenenie' }, { cesta: 'interny.kv', typ: 'kv' },
];
const NAZOV_A_SLOVA: PoleFormulara[] = [{ cesta: 'nazov', typ: 'text', povinne: true }, { cesta: 'klucoveSlova', typ: 'slova', povinne: true }];

const POLIA: Record<string, PoleFormulara[]> = {
  'dph.status': [{ cesta: 'status', typ: 'status', povinne: true }],
  'dph.clenenie_bez_odpoctu': [{ cesta: 'clenenieKod', typ: 'clenenie', povinne: true }],
  'dph.oslobodene_plnenia': [{ cesta: 'ano', typ: 'anoNie', povinne: true }, { cesta: 'koeficient', typ: 'cislo', min: 0, max: 1, ked: 'ano' }],
  'zahranicie.vratenie_dph': [{ cesta: 'uplatnujeme', typ: 'anoNie', povinne: true }, { cesta: 'predkontaciaKod', typ: 'predkontacia', ked: 'uplatnujeme' }],
  'vozidla.pravidla': [
    ...NAZOV_A_SLOVA,
    { cesta: 'percentoZakladu', typ: 'cislo', min: 0, max: 100, povinne: true },
    { cesta: 'percentoDph', typ: 'cislo', min: 0, max: 100, povinne: true },
    { cesta: 'predkontaciaKod', typ: 'predkontacia', povinne: true },
    { cesta: 'predkontaciaNedanovaKod', typ: 'predkontacia', povinne: true },
    { cesta: 'clenenieDphNedanoveKod', typ: 'clenenie' },
  ],
  'naklady.bez_naroku': [{ cesta: 'predkontaciaKod', typ: 'predkontacia', povinne: true }, { cesta: 'clenenieKod', typ: 'clenenie', povinne: true }],
  'naklady.pomerne': [
    ...NAZOV_A_SLOVA,
    { cesta: 'percentoDph', typ: 'cislo', min: 1, max: 99, povinne: true },
    { cesta: 'predkontaciaKod', typ: 'predkontacia', povinne: true },
    { cesta: 'clenenieDphNedanoveKod', typ: 'clenenie', povinne: true },
  ],
  'zasady.tovar_na_ceste': [{ cesta: 'pouziva', typ: 'anoNie', povinne: true }],
  'zasady.drobny_majetok': [{ cesta: 'hranica', typ: 'cislo', min: 1, povinne: true }],
};

/** Polia formulára; pri zozname sú to polia jednej položky. */
export function poliaFaktu(kluc: string): PoleFormulara[] {
  const druh = kluc.replace(/^samozdanenie\./, '');
  if (druh !== kluc) return DRUHY_S_INTERNYM.includes(druh) ? [...FAKTURA, ...INTERNY] : FAKTURA;
  return POLIA[kluc] ?? [];
}

/** Popis poľa: najprv špecifický pre fakt, potom všeobecný. */
export function popisPola(kluc: string, cesta: string, pripona = ''): string | undefined {
  const texty = sk as Record<string, string>;
  return texty[`profilKlienta.pole.${kluc}.${cesta}${pripona}`] ?? texty[`profilKlienta.pole.${cesta}${pripona}`];
}

const cestou = (hodnota: unknown, cesta: string) => cesta.split('.').reduce<unknown>((uzol, cast) => obj(uzol)[cast], hodnota);

export function formularZHodnoty(kluc: string, hodnota: unknown): Record<string, string> {
  return Object.fromEntries(poliaFaktu(kluc).map((pole) => {
    const cast = cestou(hodnota, pole.cesta);
    return [pole.cesta, cast === undefined || cast === null ? '' : Array.isArray(cast) ? cast.join(', ') : String(cast)];
  }));
}

/** Formulár → hodnota faktu, alebo cesta prvého zle vyplneného poľa. */
export function hodnotaZFormulara(kluc: string, formular: Record<string, string>): { hodnota: Obj } | { chyba: string } {
  const polia = poliaFaktu(kluc);
  const vyplnene = (cesta: string) => Boolean((formular[cesta] ?? '').trim());
  const hodnota: Obj = {};
  for (const pole of polia) {
    if (pole.ked && formular[pole.ked] !== 'true') continue;
    const [skupina, meno] = pole.cesta.includes('.') ? pole.cesta.split('.') : [undefined, pole.cesta];
    if (skupina && !polia.some((ine) => ine.cesta.startsWith(`${skupina}.`) && vyplnene(ine.cesta))) continue;
    const vstup = (formular[pole.cesta] ?? '').trim();
    if (!vstup) {
      if (pole.povinne) return { chyba: pole.cesta };
      continue;
    }
    let vysledok: unknown = vstup;
    if (pole.typ === 'cislo') {
      vysledok = Number(vstup.replace(/\s/g, '').replace(',', '.'));
      const n = vysledok as number;
      if (!Number.isFinite(n) || (pole.min !== undefined && n < pole.min) || (pole.max !== undefined && n > pole.max)) return { chyba: pole.cesta };
    } else if (pole.typ === 'anoNie') {
      vysledok = vstup === 'true';
    } else if (pole.typ === 'slova') {
      vysledok = vstup.split(',').map((slovo) => slovo.trim()).filter(Boolean);
      if (!(vysledok as string[]).length) return { chyba: pole.cesta };
    }
    const ciel = skupina ? (hodnota[skupina] ??= {}) as Obj : hodnota;
    ciel[meno] = vysledok;
  }
  return { hodnota };
}

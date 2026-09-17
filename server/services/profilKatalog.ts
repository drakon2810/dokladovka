import { z } from 'zod';
import { popisKodu } from './pohodaDphKody.js';

/**
 * Katalóg faktov profilu klienta — jeden pre všetky firmy. Server tu drží
 * kľúče a tvar hodnôt; poradie a texty má klient vo vlastnom zozname (i18n).
 * Kódy POHODY sú v hodnotách ako KÓDY, nie id: id sa pri importe číselníka mení.
 */

export type SekciaProfilu = 'dph' | 'samozdanenie' | 'vozidla' | 'naklady' | 'zasady';

export interface PolozkaKatalogu {
  kluc: string;
  sekcia: SekciaProfilu;
  schema: z.ZodTypeAny;
  /** Bez odpovede sa účtovať nedá — otázka ide navrch a pripravenosť čaká. */
  blokuje: boolean;
}

const kod = z.string().trim().min(1).max(100);
const kv = z.string().trim().min(1).max(10);
const percento = z.number().min(0).max(100);
const nazov = z.string().trim().min(1).max(120);
const klucoveSlova = z.array(z.string().trim().min(1).max(60)).min(1).max(30);

/** Druhy samozdanenia a zahraničných plnení — jeden fakt na druh. */
export const DRUHY_SAMOZDANENIA = [
  // Prijatá strana: faktúra dodávateľa + interný doklad (DD… a P…); dovoz podľa § 84a má tiež interný.
  'sluzby_eu', 'sluzby_mimo_eu', 'tovar_eu', 'prenesenie_prijate', 'dovoz',
  // Len faktúra.
  'prenesenie_vystavene', 'sluzby_zahranicie_vystavene', 'zahranicie_vystavene', 'tovar_do_eu',
] as const;
export type DruhSamozdanenia = typeof DRUHY_SAMOZDANENIA[number];

/** Vydané druhy podľa RefTpDph kódu na hlavičke faktúry (pohodaDphKody.ts). Dovoz sa pozná cez jeDovozTovaru. */
export const REFY_VYDANYCH_DRUHOV: Partial<Record<DruhSamozdanenia, readonly string[]>> = {
  prenesenie_vystavene: ['U21', 'U36', 'U37'],
  sluzby_zahranicie_vystavene: ['U22', 'U23'],
  zahranicie_vystavene: ['U12', 'U13'],
  tovar_do_eu: ['U04', 'U05'],
};
/** DD strana: nadobudnutie tovaru (aj nový dopravný prostriedok) je tovar z EÚ bez ohľadu na krajinu. */
export const DD_REFY_TOVAR = ['D01', 'D03'];
/** DD strana: služby a tovary s daňou u príjemcu — druh určí krajina dodávateľa. */
export const DD_REFY_SLUZBY = ['D02', 'D05'];
/** DD strana: dovoz s daňou priznanou podľa § 84a ods. 3. */
export const DD_REFY_DOVOZ = ['D07'];
/**
 * Odpočet patriaci k dani na výstupe (RefTpDph). Partner, ktorý dodáva tovar aj
 * služby, inak spáruje DDnadEU s PDsluz — odpočet musí byť z rovnakej rodiny.
 */
export const P_REFY_PRE_DD: Readonly<Record<string, readonly string[]>> = {
  D01: ['P04', 'P05', 'P06'], D03: ['P14'], D02: ['P07', 'P08', 'P09'], D05: ['P07', 'P08', 'P09'], D07: ['P29', 'P30'],
};

const faktura = z.object({ clenenieKod: kod, kv: kv.optional() }).strict();
const prijaty = z.object({
  faktura: faktura.optional(),
  // Interné doklady sú dva: vymeranie dane (DD…, napr. predkontácia aInt) a odpočet (P…, bInt).
  interny: z.object({
    ddKod: kod, ddPredkontaciaKod: kod.optional(), pKod: kod.optional(), pPredkontaciaKod: kod.optional(), kv: kv.optional(),
  }).strict().optional(),
}).strict();
const lenFaktura = z.object({ faktura: faktura.optional() }).strict();

export const PROFIL_KATALOG: readonly PolozkaKatalogu[] = [
  {
    kluc: 'dph.status', sekcia: 'dph', blokuje: true,
    schema: z.object({ status: z.enum(['platitel', 'registracia_7', 'registracia_7a', 'neplatitel']) }).strict(),
  },
  { kluc: 'dph.clenenie_bez_odpoctu', sekcia: 'dph', blokuje: false, schema: z.object({ clenenieKod: kod }).strict() },
  {
    kluc: 'dph.oslobodene_plnenia', sekcia: 'dph', blokuje: false,
    schema: z.object({ ano: z.boolean(), koeficient: z.number().min(0).max(1).optional() }).strict()
      .refine((hodnota) => hodnota.ano || hodnota.koeficient === undefined, { message: 'Koeficient len pri oslobodených plneniach' }),
  },
  ...DRUHY_SAMOZDANENIA.map((druh): PolozkaKatalogu => ({
    kluc: `samozdanenie.${druh}`, sekcia: 'samozdanenie', blokuje: false,
    schema: ['sluzby_eu', 'sluzby_mimo_eu', 'tovar_eu', 'prenesenie_prijate', 'dovoz'].includes(druh) ? prijaty : lenFaktura,
  })),
  // Ako firma samozdanenie prijatých faktúr rieši: Dokladovka zakladá interné
  // doklady, firma si ich zakladá sama v POHODE, alebo sa samozdanenie na
  // prijatých faktúrach nerieši vôbec (blok sa neponúkne a faktúra ide bez neho).
  {
    kluc: 'samozdanenie.postup', sekcia: 'samozdanenie', blokuje: false,
    schema: z.object({ postup: z.enum(['dokladovka', 'v_pohode', 'neriesime']) }).strict(),
  },
  {
    kluc: 'zahranicie.vratenie_dph', sekcia: 'samozdanenie', blokuje: false,
    schema: z.object({ uplatnujeme: z.boolean(), predkontaciaKod: kod.optional() }).strict(),
  },
  {
    kluc: 'vozidla.pravidla', sekcia: 'vozidla', blokuje: false,
    schema: z.array(z.object({
      nazov, klucoveSlova, percentoZakladu: percento, percentoDph: percento,
      predkontaciaKod: kod, predkontaciaNedanovaKod: kod, clenenieDphNedanoveKod: kod.optional(),
      // Ten istý benzín sa na faktúre karty účtuje inak ako na bločku zaplatenom kartou (iný záväzok).
      typyDokladov: z.array(z.enum(['FP', 'FV', 'OZ', 'PD', 'BV', 'MZDY'])).min(1).max(6).optional(),
    }).strict().refine((pravidlo) => pravidlo.percentoDph === 100 || Boolean(pravidlo.clenenieDphNedanoveKod), {
      // Bez vlastného členenia by neodpočítaná časť zdedila odpočtové členenie hlavičky.
      message: 'Časť bez odpočtu potrebuje členenie DPH bez nároku', path: ['clenenieDphNedanoveKod'],
    })).max(50),
  },
  {
    kluc: 'naklady.bez_naroku', sekcia: 'naklady', blokuje: false,
    schema: z.array(z.object({ predkontaciaKod: kod, clenenieKod: kod }).strict()).max(100),
  },
  {
    kluc: 'naklady.pomerne', sekcia: 'naklady', blokuje: false,
    schema: z.array(z.object({
      nazov, klucoveSlova, percentoDph: z.number().min(1).max(99), predkontaciaKod: kod, clenenieDphNedanoveKod: kod,
    }).strict()).max(50),
  },
  { kluc: 'zasady.tovar_na_ceste', sekcia: 'zasady', blokuje: false, schema: z.object({ pouziva: z.boolean() }).strict() },
  { kluc: 'zasady.drobny_majetok', sekcia: 'zasady', blokuje: false, schema: z.object({ hranica: z.number().positive() }).strict() },
];

const PODLA_KLUCA = new Map(PROFIL_KATALOG.map((polozka) => [polozka.kluc, polozka]));

export function polozkaKatalogu(kluc: string): PolozkaKatalogu | undefined {
  return PODLA_KLUCA.get(kluc);
}

/** Pole hodnoty → druh číselníka. Nové pole s kódom treba doplniť sem, inak ho server neoverí. */
const DRUH_POLA: Record<string, 'predkontacie' | 'cleneniaDph' | 'kv'> = {
  predkontaciaKod: 'predkontacie',
  predkontaciaNedanovaKod: 'predkontacie',
  clenenieKod: 'cleneniaDph',
  clenenieDphNedanoveKod: 'cleneniaDph',
  ddKod: 'cleneniaDph',
  ddPredkontaciaKod: 'predkontacie',
  pKod: 'cleneniaDph',
  pPredkontaciaKod: 'predkontacie',
  kv: 'kv',
  // Sekcia KV prepísaná na jednom riadku interného dokladu (samozdanenie na doklade).
  ddKv: 'kv',
  pKv: 'kv',
};

/**
 * Kód v nesprávnej úlohe: DD na faktúre, P ako daň na výstupe, U na prijatej
 * faktúre, KV mimo samozdanenia. Kód, ktorý POHODA nepozná, sa neposudzuje.
 */
export function chybaRoliKodov(kluc: string, hodnota: unknown): string | undefined {
  if (!kluc.startsWith('samozdanenie.')) return undefined;
  const h = (hodnota ?? {}) as {
    faktura?: { clenenieKod?: string };
    interny?: { ddKod?: string; pKod?: string; kv?: string; ddKv?: string; pKv?: string };
  };
  const strana = (kod?: string) => (kod ? popisKodu(kod)?.strana : undefined);
  const vydany = kluc.slice('samozdanenie.'.length) in REFY_VYDANYCH_DRUHOV;
  const dd = strana(h.interny?.ddKod);
  if (dd && dd !== 'DD') return `${h.interny!.ddKod} nie je daň na výstupe (DD…)`;
  const p = strana(h.interny?.pKod);
  if (p && p !== 'P') return `${h.interny!.pKod} nie je odpočet (P…)`;
  const faktura = strana(h.faktura?.clenenieKod);
  if (faktura === 'DD') return `${h.faktura!.clenenieKod} patrí na interný doklad, nie na faktúru`;
  if (faktura && (faktura === 'U') !== vydany) return `${h.faktura!.clenenieKod} nepatrí na ${vydany ? 'vydanú' : 'prijatú'} faktúru`;
  // Aj sekcia prepísaná na jednom riadku interného dokladu (ddKv/pKv) musí
  // ostať v rodine samozdanenia — vymeranie do B1, odpočet niekedy do KN.
  for (const sekcia of [h.interny?.kv, h.interny?.ddKv, h.interny?.pKv]) {
    if (sekcia && !['B1', 'KN'].includes(sekcia)) return `Sekcia KV ${sekcia} k samozdaneniu nepatrí`;
  }
  return undefined;
}

/** Všetky kódy v hodnote faktu podľa druhu číselníka — na overenie pri zápise. */
export function kodyHodnoty(hodnota: unknown): Record<'predkontacie' | 'cleneniaDph' | 'kv', string[]> {
  const kody = { predkontacie: [] as string[], cleneniaDph: [] as string[], kv: [] as string[] };
  const prejdi = (uzol: unknown) => {
    if (Array.isArray(uzol)) return uzol.forEach(prejdi);
    if (!uzol || typeof uzol !== 'object') return;
    for (const [pole, hodnotaPola] of Object.entries(uzol)) {
      const druh = DRUH_POLA[pole];
      if (druh && typeof hodnotaPola === 'string') kody[druh].push(hodnotaPola);
      else prejdi(hodnotaPola);
    }
  };
  prejdi(hodnota);
  return kody;
}

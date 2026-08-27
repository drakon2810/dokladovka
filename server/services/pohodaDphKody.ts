/**
 * Čo jednotlivé členenia DPH v POHODE naozaj robia.
 *
 * Číselník firmy nesie len kód a názov, a práve názov je pasca: „UDzahr —
 * Miesto plnenia v zahraničí s možnosťou odpočítania dane" znie pre moldavského
 * odberateľa presne, lenže ten kód zapisuje sumu do riadku 13 daňového
 * priznania. Poučenie DPHv25 pritom v bode 9 hovorí: „V daňovom priznaní sa
 * neuvádzajú transakcie s miestom dodania mimo tuzemska." Bez tejto tabuľky sa
 * ten rozpor z názvu nedá vidieť — a nevidel ho ani model, ani účtovníci.
 *
 * Zdroj: referenčný zoznam členení POHODA SK (Skratka · RefTpDph · Riadok
 * v priznaní · Kód pre súhrnný výkaz). Zoznam je pre POHODU rovnaký vo všetkých
 * firmách; číselník konkrétnej firmy je jeho podmnožinou. Kód, ktorý si firma
 * založila sama, tu nie je — a vtedy o ňom radšej mlčíme, než by sme hádali.
 *
 * strana: U = uskutočnené plnenia (vydané doklady), P = prijaté plnenia,
 * DD = daňová povinnosť pri samozdanení, ktorá patrí na samostatný interný
 * doklad, nie na faktúru.
 */

export type StranaPlnenia = 'U' | 'P' | 'DD';

export interface PohodaDphKod {
  kod: string;
  /** RefTpDph z POHODY — U01, P07, D05. Prvé písmeno určuje stranu. */
  ref: string;
  strana: StranaPlnenia;
  /** Riadky daňového priznania, do ktorých kód sumu zapíše. Prázdne = nikam. */
  riadky: readonly number[];
  /** Kód pre súhrnný výkaz, alebo null keď doň plnenie nevstupuje. */
  sv: string | null;
  nazov: string;
}

export const POHODA_DPH_KODY: readonly PohodaDphKod[] = [
  { kod: 'DD2odb', ref: 'D04', strana: 'DD', riadky: [11, 12], sv: null, nazov: 'Tovary, pri ktorých daň platí druhý odberateľ' },
  { kod: 'DDdopr', ref: 'D03', strana: 'DD', riadky: [5, 6, 7, 8], sv: null, nazov: 'Nadobudnutie nového dopravného prostriedku' },
  { kod: 'DDnadEU', ref: 'D01', strana: 'DD', riadky: [5, 6, 7, 8], sv: null, nazov: 'Nadobudnutie tovaru z iného štátu EU' },
  { kod: 'DDsluz', ref: 'D02', strana: 'DD', riadky: [9, 10], sv: null, nazov: 'Tovary a služby, pri ktorých daň platí príjemca' },
  { kod: 'DDsl§69', ref: 'D05', strana: 'DD', riadky: [9, 10], sv: null, nazov: 'Služby, pri ktorých príjemca platí daň podľa § 69 ods.3 zákona' },
  { kod: 'DRozdiel', ref: 'D06', strana: 'DD', riadky: [24, 25], sv: null, nazov: 'Rozdiel v zákl. dane a v dani po oprave (§25 od.1 až 3) - tovary a služby (D01 - D05)' },
  { kod: 'PB', ref: 'P03', strana: 'P', riadky: [], sv: null, nazov: 'Tuzemské plnenia - bez nároku' },
  { kod: 'PBnadEU', ref: 'P06', strana: 'P', riadky: [], sv: null, nazov: 'Nadobudnutie tovaru z iného štátu EU - bez nároku' },
  { kod: 'PBsluz', ref: 'P09', strana: 'P', riadky: [], sv: null, nazov: 'Poskytnutie služieb a tovarov, pri ktorých daň platí príjemca - bez nároku' },
  { kod: 'PBtovar', ref: 'P12', strana: 'P', riadky: [], sv: null, nazov: 'Dovoz tovaru - bez nároku' },
  { kod: 'PD', ref: 'P01', strana: 'P', riadky: [18, 19, 20, 21], sv: null, nazov: 'Tuzemské plnenia' },
  { kod: 'PD-OsU', ref: 'P19', strana: 'P', riadky: [18, 19, 20, 21], sv: null, nazov: 'Tuzemské plnenia - osobitná úprava §68d' },
  { kod: 'PD-OsUdod', ref: 'P23', strana: 'P', riadky: [18, 19, 20, 21], sv: null, nazov: 'Tuzemské plnenia - faktúra vystavená v osobitnej úprave §68d' },
  { kod: 'PD1odb', ref: 'P13', strana: 'P', riadky: [], sv: null, nazov: 'Nadobudnutie tovaru prvým odberateľom' },
  { kod: 'PDdopr', ref: 'P14', strana: 'P', riadky: [18, 19], sv: null, nazov: 'Nadobudnutie nového dopravného prostriedku' },
  { kod: 'PDnadEU', ref: 'P04', strana: 'P', riadky: [18, 19], sv: null, nazov: 'Nadobudnutie tovaru z iného štátu EU' },
  { kod: 'PDopr-OsU', ref: 'P21', strana: 'P', riadky: [28], sv: null, nazov: 'Oprava odpočítanej dane - osobitná úprava §68d' },
  { kod: 'PDopr-OsUdod', ref: 'P25', strana: 'P', riadky: [28], sv: null, nazov: 'Oprava odpočítanej dane - faktúra vystavená v osobitnej úprave §68d' },
  { kod: 'PDoprava', ref: 'P15', strana: 'P', riadky: [28], sv: null, nazov: 'Oprava odpočítanej dane' },
  { kod: 'PDopr§53b', ref: 'P27', strana: 'P', riadky: [29], sv: null, nazov: 'Oprava odpočítanej dane (§53b)' },
  { kod: 'PDsluz', ref: 'P07', strana: 'P', riadky: [18, 19], sv: null, nazov: 'Poskytnutie služieb a tovarov, pri ktorých daň platí príjemca' },
  { kod: 'PDtovar', ref: 'P10', strana: 'P', riadky: [18, 19, 22, 23], sv: null, nazov: 'Dovoz tovaru' },
  { kod: 'PK', ref: 'P02', strana: 'P', riadky: [18, 19, 20, 21], sv: null, nazov: 'Tuzemské plnenia - krátiť nárok' },
  { kod: 'PK-OsU', ref: 'P20', strana: 'P', riadky: [18, 19, 20, 21], sv: null, nazov: 'Tuzemské plnenia - osobitná úprava §68d - krátiť nárok' },
  { kod: 'PK-OsUdod', ref: 'P24', strana: 'P', riadky: [18, 19, 20, 21], sv: null, nazov: 'Tuzemské plnenia - faktúra vystavená v osobitnej úprave §68d - krátiť nárok' },
  { kod: 'PKnadEU', ref: 'P05', strana: 'P', riadky: [18, 19], sv: null, nazov: 'Nadobudnutie tovaru z iného štátu EU - krátiť nárok' },
  { kod: 'PKopr-OsU', ref: 'P22', strana: 'P', riadky: [28], sv: null, nazov: 'Oprava odpočítanej dane - osobitná úprava §68d - krátiť nárok' },
  { kod: 'PKopr-OsUdod', ref: 'P26', strana: 'P', riadky: [28], sv: null, nazov: 'Oprava odpočítanej dane - faktúra vystavená v osobitnej úprave §68d - krátiť nárok' },
  { kod: 'PKoprava', ref: 'P18', strana: 'P', riadky: [28], sv: null, nazov: 'Oprava odpočítanej dane (§ 53) - krátiť nárok' },
  { kod: 'PKopr§53b', ref: 'P28', strana: 'P', riadky: [29], sv: null, nazov: 'Oprava odpočítanej dane (§53b) – krátiť nárok' },
  { kod: 'PKsluz', ref: 'P08', strana: 'P', riadky: [18, 19], sv: null, nazov: 'Poskytnutie služieb a tovarov, pri ktorých daň platí príjemca - krátiť nárok' },
  { kod: 'PKtovar', ref: 'P11', strana: 'P', riadky: [18, 19, 22, 23], sv: null, nazov: 'Dovoz tovaru - krátiť nárok' },
  { kod: 'PN', ref: 'P', strana: 'P', riadky: [], sv: null, nazov: 'Nezahrňovať do priznania DPH' },
  { kod: 'PNnevymer', ref: 'P', strana: 'P', riadky: [], sv: null, nazov: 'Nezahrňovať do priznania DPH - nevymeriavať DPH' },
  { kod: 'PVdaň', ref: 'P16', strana: 'P', riadky: [31], sv: null, nazov: 'Vrátená daň' },
  { kod: 'UD', ref: 'U01', strana: 'U', riadky: [1, 2, 3, 4], sv: null, nazov: 'Tuzemské plnenia' },
  { kod: 'UD-OsU', ref: 'U30', strana: 'U', riadky: [1, 2, 3, 4], sv: null, nazov: 'Tuzemské plnenia - osobitná úprava §68d' },
  { kod: 'UDcest', ref: 'U14', strana: 'U', riadky: [], sv: null, nazov: 'Osobitná úprava pre cestovné služby' },
  { kod: 'UDdod3', ref: 'U07', strana: 'U', riadky: [], sv: '1', nazov: 'Dodanie tovaru druhým podnikateľom pri trojstrannom obchode' },
  { kod: 'UDdodEU', ref: 'U04', strana: 'U', riadky: [13, 14], sv: null, nazov: 'Dodanie tovaru do iného štátu EU' },
  { kod: 'UDdopr11', ref: 'U24', strana: 'U', riadky: [13], sv: null, nazov: 'Dodanie nového dopravného prostriedku' },
  { kod: 'UDobch', ref: 'U16', strana: 'U', riadky: [], sv: null, nazov: 'Osobitná úprava pre obchody s použ. tovarom a umením' },
  { kod: 'UDpdp', ref: 'U36', strana: 'U', riadky: [], sv: null, nazov: 'Prenesenie daňovej povinnosti §69 ods. 12 (s uvedením sadzby dane)' },
  { kod: 'UDzahr', ref: 'U12', strana: 'U', riadky: [13], sv: null, nazov: 'Miesto plnenia v zahraničí s možnosťou odpočítania dane' },
  { kod: 'UDzahrSl', ref: 'U22', strana: 'U', riadky: [], sv: '2', nazov: 'Miesto plnenia v zahraničí s možnosťou odpočítania dane' },
  { kod: 'UDzasEUl', ref: 'U03', strana: 'U', riadky: [1, 2, 3, 4], sv: null, nazov: 'Zaslanie tovaru do iného štátu EU - do limitu' },
  { kod: 'UDzrušReg', ref: 'U38', strana: 'U', riadky: [1, 2, 3, 4], sv: null, nazov: 'Zrušenie registrácie platiteľa' },
  { kod: 'UK', ref: 'U02', strana: 'U', riadky: [1, 2, 3, 4], sv: null, nazov: 'Tuzemské plnenia - nezapočítať do koeficientu' },
  { kod: 'UK-OsU', ref: 'U31', strana: 'U', riadky: [1, 2, 3, 4], sv: null, nazov: 'Tuzemské plnenia - osobitná úprava §68d - nezapočítať do koeficientu' },
  { kod: 'UKcest', ref: 'U15', strana: 'U', riadky: [], sv: null, nazov: 'Osobitná úprava pre cestovné služby - nezapočítať do koeficientu' },
  { kod: 'UKdodEU', ref: 'U05', strana: 'U', riadky: [13, 14], sv: null, nazov: 'Dodanie tovaru do iného štátu EU - nezapočítať do koeficientu' },
  { kod: 'UKobch', ref: 'U17', strana: 'U', riadky: [], sv: null, nazov: 'Osobitná úprava pre obchody s použ. tovarom a umením - nezapočítať do koeficientu' },
  { kod: 'UKodpBez', ref: 'U11', strana: 'U', riadky: [13], sv: null, nazov: 'Oslobodené plnenia bez možnosti odpočítania dane - nezapočítať do koeficientu' },
  { kod: 'UKodpBez-OsU', ref: 'U35', strana: 'U', riadky: [13], sv: null, nazov: 'Oslobodené plnenia bez možnosti odpočítania dane - nezapočítať do koeficientu – osobitná úprava §68d' },
  { kod: 'UKodpS', ref: 'U09', strana: 'U', riadky: [13, 15], sv: null, nazov: 'Oslobodené plnenia s možnosťou odpoč. dane - nezapočítať do koeficientu' },
  { kod: 'UKpdp', ref: 'U37', strana: 'U', riadky: [], sv: null, nazov: 'Prenesenie daňovej povinnosti §69 ods. 12 (s uvedením sadzby dane) - nezapočítať do koeficientu' },
  { kod: 'UKroz-OsU', ref: 'U33', strana: 'U', riadky: [24, 25], sv: null, nazov: 'Rozdiel v zákl.dane a v dani po opr.(§25 ods.1 až 3, §65 ods.10 a 11)-os. úpr. §68d-nezap. do koef.' },
  { kod: 'UKrozdiel', ref: 'U25', strana: 'U', riadky: [24, 25], sv: null, nazov: 'Rozdiel v zákl. dane a v dani po oprave (§25 ods. 1 až 3, §65 ods. 10 a 11) - nezapočítať do koef.' },
  { kod: 'UKroz§25a', ref: 'U27', strana: 'U', riadky: [26, 27], sv: null, nazov: 'Rozdiel v základe dane a v dani po oprave (§25a) - nezapočítať do koeficientu' },
  { kod: 'UKzahr', ref: 'U13', strana: 'U', riadky: [13], sv: null, nazov: 'Miesto plnenia v zahraničí s možnosťou odpočítania dane - nezapočítať do koeficientu' },
  { kod: 'UKzahrSl', ref: 'U23', strana: 'U', riadky: [], sv: '2', nazov: 'Miesto plnenia v zahraničí s možnosťou odpočítania dane - nezapočítať do koeficientu' },
  { kod: 'UN', ref: 'U', strana: 'U', riadky: [], sv: null, nazov: 'Nezahrňovať do priznania DPH' },
  { kod: 'UNodpBez', ref: 'U10', strana: 'U', riadky: [13], sv: null, nazov: 'Oslobodené plnenia bez možnosti odpočítania dane' },
  { kod: 'UNodpBez-OsU', ref: 'U34', strana: 'U', riadky: [13], sv: null, nazov: 'Oslobodené plnenia bez možnosti odpočítania dane – osobitná úprava §68d' },
  { kod: 'UNodpS', ref: 'U08', strana: 'U', riadky: [13, 15], sv: null, nazov: 'Oslobodené plnenia s možnosťou odpoč. dane' },
  { kod: 'UNoslob', ref: 'U29', strana: 'U', riadky: [13], sv: null, nazov: 'Oslobodené plnenia §65 ods. 7 a §67 ods.3' },
  { kod: 'UN§69', ref: 'U21', strana: 'U', riadky: [], sv: null, nazov: 'Prenesenie daňovej povinnosti §69 ods. 12' },
  { kod: 'URozdiel', ref: 'U19', strana: 'U', riadky: [24, 25], sv: null, nazov: 'Rozdiel v základe dane a v dani po oprave (§25 ods. 1 až 3, §65 ods. 10 a 11)' },
  { kod: 'URoz§25a', ref: 'U26', strana: 'U', riadky: [26, 27], sv: null, nazov: 'Rozdiel v základe dane a v dani po oprave (§25a)' },
  { kod: 'UVdaň', ref: 'U18', strana: 'U', riadky: [], sv: null, nazov: 'Vrátená daň' },
  { kod: 'UZinýEU', ref: 'U20', strana: 'U', riadky: [1, 2, 3, 4], sv: null, nazov: 'Zaslanie tovaru z iného štátu EU s plnením v tuzemsku' },
  { kod: 'Uroz-OsU', ref: 'U32', strana: 'U', riadky: [24, 25], sv: null, nazov: 'Rozdiel v základe dane a v dani po oprave (§25 ods. 1 až 3, §65 ods. 10 a 11) - os. úprava §68d' },
];

const PODLA_KODU = new Map(POHODA_DPH_KODY.map((polozka) => [polozka.kod, polozka]));

/** Čo kód robí. undefined = kód nie je v referenčnom zozname POHODY. */
export function popisKodu(kod: string | undefined | null): PohodaDphKod | undefined {
  return kod ? PODLA_KODU.get(kod.trim()) : undefined;
}

/**
 * Kódy, ktoré smú stáť na doklade danej strany. Vydaná faktúra nesie U…,
 * prijatá P…; DD… je vymeranie dane na internom doklade a na faktúre nemá čo
 * robiť. Kód mimo referenčného zoznamu neprejde — nevieme, čo by spôsobil.
 */
export function kodyPreDoklad(documentType: string, kody: readonly string[]): string[] {
  const strana: StranaPlnenia | undefined = documentType === 'FV' ? 'U' : documentType === 'FP' ? 'P' : undefined;
  if (!strana) return [...kody];
  return kody.filter((kod) => popisKodu(kod)?.strana === strana);
}

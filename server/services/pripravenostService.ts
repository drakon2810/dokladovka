/**
 * Pripravenosť firmy na návrhy zaúčtovania — poctivá odpoveď sprievodcu (R12, F13).
 *
 * Sprievodca doteraz hlásil „hotové", len čo niečo existovalo: prázdne
 * prepojenie z založenia firmy spárovalo Mostík, prvá dávka pamäte naučila
 * históriu a prvá dávka analýzy dokončila profil. Tu každý signál nesie stav
 * a kód dôvodu z dôkazov, ktoré server naozaj má — manifest prenosu histórie,
 * stav jobu analýzy, meranie presnosti. Pravidlá sú rovnaké pre každú firmu.
 *
 * Čistá funkcia: dopyty robí route, čas prichádza zvonka — dá sa testovať
 * tabuľkou bez databázy.
 */

export type StavSignalu = 'chyba' | 'caka' | 'overit' | 'ok';

export interface Signal {
  stav: StavSignalu;
  /** Kód dôvodu — text je v UI (pripravenost.<kód>). */
  dovod: string;
  kedy?: string;
  pocet?: number;
  detail?: unknown;
}

export interface Pripravenost {
  stav: 'nepripravena' | 'overit' | 'pripravena';
  signaly: Record<'mostik' | 'firma' | 'ciselniky' | 'historia' | 'profil' | 'meranie', Signal>;
}

type Cas = Date | string | null | undefined;

export interface ImportHistorie {
  stav: 'prijima' | 'publikovany' | 'zamietnuty';
  chyba: string | null;
  manifest: { databaza?: string; rok?: number; agendy?: Array<{
    poziadavka: string; agenda?: string; stav: string; dokladov: number; poloziek: number; riadkov: number;
  }> } | null;
  vytvoreny: Cas;
  publikovany: Cas;
}

export interface VstupPripravenosti {
  mostikZapnuty: boolean;
  /** Inštalácie agenta tenanta so status='connected'. */
  pripojenychAgentov: number;
  /** Najnovší last_seen_at z pripojených inštalácií. */
  agentVideny: Cas;
  prepojenie: { dbName: string | null; uctovnyRok: string | null; matchRule: string | null } | null;
  /** Najnovší beh synchronizácie (agent_sync_runs) tejto firmy. */
  poslednaSynchronizacia: Cas;
  /** Povinné druhy číselníkov: posledný beh a aktívne položky. */
  ciselniky: Array<{
    druh: string;
    beh: { stav: string; poloziek: number; chyba: string | null; kedy: Cas } | null;
    zPohody: number;
    spolu: number;
  }>;
  historia: {
    /** Najnovší prenos histórie v akomkoľvek stave. */
    posledny: ImportHistorie | null;
    /** Najnovší publikovaný prenos — živá história. */
    publikovany: ImportHistorie | null;
    /** Riadky ucto_historia bez prenosu so manifestom (starší Mostík). */
    bezManifestu: boolean;
  };
  /** Posledný job 'ucto_analyza': zaradený (created_at) a naposledy zmenený (updated_at). */
  analyza: { stav: string; chyba: string | null; zarazena: Cas; kedy: Cas; kategorii?: number; zlyhanychDavok?: number } | null;
  kategorie: boolean;
  /** Posledné meranie metodikou 2 a agendy jeho okna, ktoré sa do vzorky nedostali (manifest.vynechaneAgendy). */
  meranie: { kedy: Cas; vynechane: string[] } | null;
}

// ponytail: pevné 3 h na čerstvosť synchronizácie firmy — agent ťahá číselníky
//   každú hodinu (CodeListSyncMinutes=60). Dlhší interval na počítači kancelárie
//   dá falošné „nesynchronizovaná"; potom to dať do konfigurácie tenanta.
const FIRMA_SYNC_HODIN = 3;
// Prenos, ktorý hodinu neprijal publikáciu, sa už nedokončí — agent padol.
const PRENOS_HODIN = 1;

const ok: Signal = { stav: 'ok', dovod: 'ok' };

function iso(cas: Cas): string | undefined {
  return cas ? new Date(cas).toISOString() : undefined;
}

export function vypocitajPripravenost(
  vstup: VstupPripravenosti,
  moznosti: { teraz: Date; agentOfflineHodin: number },
): Pripravenost {
  const hodin = (cas: Cas) => cas ? (moznosti.teraz.getTime() - new Date(cas).getTime()) / 3_600_000 : Infinity;
  const skor = (a: Cas, b: Cas) => Boolean(a && b && new Date(a).getTime() < new Date(b).getTime());

  const mostik: Signal = !vstup.mostikZapnuty ? { stav: 'chyba', dovod: 'mostik_vypnuty' }
    : vstup.pripojenychAgentov === 0 ? { stav: 'caka', dovod: 'agent_nesparovany' }
    : hodin(vstup.agentVideny) > moznosti.agentOfflineHodin ? { stav: 'chyba', dovod: 'agent_offline', kedy: iso(vstup.agentVideny) }
    : { ...ok, kedy: iso(vstup.agentVideny) };

  // Prázdne prepojenie vzniká pri založení firmy — spárovaná je až s databázou.
  // Agent je v tenante jeden pre všetky firmy, preto čerstvosť firmy nesie až
  // jej vlastný beh synchronizácie.
  const link = vstup.prepojenie;
  const detailFirmy = link?.dbName ? { dbName: link.dbName, uctovnyRok: link.uctovnyRok, matchRule: link.matchRule } : undefined;
  const firma: Signal = !detailFirmy ? { stav: 'caka', dovod: mostik.stav === 'ok' ? 'firma_nenajdena' : 'caka_na_agenta' }
    : !vstup.poslednaSynchronizacia ? { stav: 'overit', dovod: 'sparovane_bez_synchronizacie', detail: detailFirmy }
    : hodin(vstup.poslednaSynchronizacia) > FIRMA_SYNC_HODIN
      ? { stav: 'chyba', dovod: 'firma_nesynchronizovana', kedy: iso(vstup.poslednaSynchronizacia), detail: detailFirmy }
    : { ...ok, kedy: iso(vstup.poslednaSynchronizacia), detail: detailFirmy };

  const zlyhany = vstup.ciselniky.find((druh) => druh.beh?.stav === 'error');
  const bezPohody = vstup.ciselniky.find((druh) => druh.zPohody === 0);
  // Prázdna odpoveď nič nedeaktivuje — staré položky ostanú a počet klame.
  const prazdnaOdpoved = vstup.ciselniky.find((druh) => druh.beh?.stav === 'ok' && druh.beh.poloziek === 0);
  // Chyba nesie čas posledného behu: sprievodca podľa neho pozná, že agent na
  // požiadavku odpovedal, a spinner kroku zhasne aj bez „hotovo".
  const behy = vstup.ciselniky.flatMap((druh) => (druh.beh?.kedy ? [new Date(druh.beh.kedy).getTime()] : []));
  const poslednyBeh = behy.length ? new Date(Math.max(...behy)).toISOString() : undefined;
  const ciselniky: Signal = zlyhany
    ? { stav: 'chyba', dovod: 'ciselnik_chyba', kedy: poslednyBeh, detail: `${zlyhany.druh}: ${zlyhany.beh!.chyba ?? 'error'}` }
    : vstup.ciselniky.every((druh) => druh.spolu === 0) ? { stav: 'caka', dovod: 'ciselniky_chybaju' }
    : vstup.ciselniky.every((druh) => druh.zPohody === 0) ? { stav: 'overit', dovod: 'ciselniky_rucne' }
    : bezPohody ? { stav: 'chyba', dovod: 'ciselnik_chyba_druh', kedy: poslednyBeh, detail: bezPohody.druh }
    : prazdnaOdpoved ? { stav: 'overit', dovod: 'ciselnik_prazdna_odpoved', detail: prazdnaOdpoved.druh }
    : { ...ok, pocet: vstup.ciselniky.reduce((sucet, druh) => sucet + druh.zPohody, 0) };

  // Úplnosť histórie dokazuje manifest prenosu — publikácia prejde, len keď
  // každá agenda POHODY skončila 'ok' a sedia dávky aj riadky.
  const { posledny, publikovany } = vstup.historia;
  const agendy = publikovany?.manifest?.agendy ?? [];
  const historia: Signal = !posledny
    ? vstup.historia.bezManifestu ? { stav: 'overit', dovod: 'historia_bez_manifestu' } : { stav: 'caka', dovod: 'historia_nestiahnuta' }
    : posledny.stav === 'zamietnuty' ? { stav: 'chyba', dovod: 'historia_neuplna', kedy: iso(posledny.vytvoreny), detail: posledny.chyba ?? undefined }
    : posledny.stav === 'prijima'
      ? hodin(posledny.vytvoreny) > PRENOS_HODIN
        ? { stav: 'chyba', dovod: 'historia_neukoncena', kedy: iso(posledny.vytvoreny) }
        : { stav: 'caka', dovod: 'historia_prebieha', kedy: iso(posledny.vytvoreny) }
    : agendy.reduce((sucet, agenda) => sucet + agenda.riadkov, 0) === 0 ? { stav: 'overit', dovod: 'historia_prazdna', kedy: iso(posledny.publikovany) }
    // Hlavičková prax je legitímna — rozpis na položky sa z nej ale nenaučí.
    : agendy.every((agenda) => agenda.poloziek === 0) ? { stav: 'overit', dovod: 'historia_len_hlavicky', kedy: iso(posledny.publikovany) }
    : {
      ...ok,
      kedy: iso(posledny.publikovany),
      pocet: agendy.reduce((sucet, agenda) => sucet + agenda.dokladov, 0),
      detail: agendy.map((agenda) => ({
        agenda: agenda.agenda ?? agenda.poziadavka, dokladov: agenda.dokladov, poloziek: agenda.poloziek, riadkov: agenda.riadkov,
      })),
    };

  // Analýza publikuje kategórie po každej dávke — hotová je až job, nie prvé kategórie.
  const analyza = vstup.analyza;
  const profil: Signal = !analyza
    ? vstup.kategorie ? { stav: 'overit', dovod: 'profil_bez_behu' } : { stav: 'caka', dovod: 'analyza_nespustena' }
    : analyza.stav === 'queued' || analyza.stav === 'running' ? { stav: 'caka', dovod: 'analyza_bezi', kedy: iso(analyza.kedy) }
    : analyza.stav !== 'succeeded' ? { stav: 'chyba', dovod: 'analyza_zlyhala', kedy: iso(analyza.kedy), detail: analyza.chyba ?? undefined }
    : !analyza.kategorii ? { stav: 'chyba', dovod: 'analyza_prazdna', kedy: iso(analyza.kedy) }
    : analyza.zlyhanychDavok ? { stav: 'overit', dovod: 'analyza_ciastocna', kedy: iso(analyza.kedy), pocet: analyza.zlyhanychDavok }
    // Analýza číta históriu pri štarte a beží desiatky minút — rozhoduje čas
    // zaradenia, nie dokončenia. Čakanie vo fronte dá nanajvýš zbytočné „overiť".
    : skor(analyza.zarazena, publikovany?.publikovany) ? { stav: 'overit', dovod: 'profil_starsi_ako_historia', kedy: iso(analyza.kedy) }
    : { ...ok, kedy: iso(analyza.kedy), pocet: analyza.kategorii };

  // Pokrytie hovorí meranie samo: agendy, ktoré mali v jeho okne merateľné
  // doklady, a do vzorky sa nedostali. Porovnanie s agendami manifestu histórie
  // sa splniť nedalo — OP meranie merať nevie a zriedkavá agenda (FP-T) v okne
  // doklad nemá, takže firma by nebola „pripravená" nikdy.
  const meranie = vstup.meranie;
  const meranieSignal: Signal = !meranie ? { stav: 'overit', dovod: 'meranie_chyba' }
    : skor(meranie.kedy, publikovany?.publikovany) ? { stav: 'overit', dovod: 'meranie_starsie', kedy: iso(meranie.kedy) }
    : meranie.vynechane.length > 0
      ? { stav: 'overit', dovod: 'meranie_ciastocne', kedy: iso(meranie.kedy), detail: meranie.vynechane.join(', ') }
    : { ...ok, kedy: iso(meranie.kedy) };

  const signaly = { mostik, firma, ciselniky, historia, profil, meranie: meranieSignal };
  // Meranie nikdy neblokuje: bez neho sa dá účtovať, len sa nevie, ako presne.
  const stav = [mostik, firma, ciselniky, historia, profil].some((signal) => signal.stav === 'chyba' || signal.stav === 'caka')
    ? 'nepripravena'
    : Object.values(signaly).every((signal) => signal.stav === 'ok') ? 'pripravena' : 'overit';
  return { stav, signaly };
}

// Samozdanenie na prijatej faktúre bez DPH — jeden riadok v karte zaúčtovania,
// ktorý sa rozbalí na mieste (maketa „Samozdanenie kompaktne", variant 1b).
// Zvinutý riadok nesie druh plnenia, vymeranú daň a to, čo účtovníka zablokuje
// pri schválení; celý blok zaberá výšku len vtedy, keď ho naozaj otvorí.
// Počíta server (základ, daň, dátum, kódy z profilu klienta); editor volí,
// prepisuje druh, dátum, sadzbu, kurz, kódy interných dokladov a základ.
// Každá zmena sa hneď uloží — server ostáva jediným zdrojom toho, čo pôjde
// do POHODY.
//
// Rozpracovaný doklad blok SLEDUJE: základ a daň sa prepočítajú zo sumy, ktorú
// má editor práve v ruke, a riadok ich označí ako neuložené. ROFA prepísala na
// faktúre AF260391 položku z 1 542,80 na 150,00 (spolu 7 184,77) a blok ďalej
// ukazoval základ 8 577,57 a DPH 1 972,84 — účtovník videl v položkách jedno
// číslo a v dani, ktorú sa chystal vytvoriť, druhé.
import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import type {
  BlokSamozdanenia, CodeListItem, DovodNevznikaSamozdanenia, DruhSamozdaneniaPrijateho, InternySamozdanenia,
  RozhodnutieSamozdanenia, VolbaSamozdanenia,
} from '../../data/types';
import { getSamozdanenie, potvrdKodySamozdanenia, ulozSamozdanenie } from '../../data/api';
import { predkontaciePreTyp } from '../../data/pohoda/agendas';
import { showToast } from '../../components/toast';
import { sk, t, tv, type SkKey } from '../../i18n/sk';
import { DcCell, DcPick, formatDateSk, type DcOption } from './DcInline';
import { fmtMoney } from './ItemsSection';

const VOLBY: VolbaSamozdanenia[] = ['vytvorit', 'v_pohode', 'nevznika'];
const DRUHY: DruhSamozdaneniaPrijateho[] = ['sluzby_eu', 'tovar_eu', 'sluzby_mimo_eu', 'prenesenie_prijate', 'dovoz'];
const DOVODY: DovodNevznikaSamozdanenia[] = ['slovenska_dph', 'miesto_dodania', 'nie_plnenie', 'iny'];
/** Sekcie KV, ktoré k samozdaneniu patria — zhodne so `chybaRoliKodov` na serveri. */
const KV_SAMOZDANENIA = ['B1', 'KN'];
/** Ktoré polia prepisu nesie ktorý riadok náhľadu. */
const POLIA_RIADKU = {
  vymeranie: { predkontacia: 'ddPredkontaciaKod', clenenie: 'ddKod', kv: 'ddKv' },
  odpocet: { predkontacia: 'pPredkontaciaKod', clenenie: 'pKod', kv: 'pKv' },
} as const;

export const nazovDruhu = (druh: DruhSamozdaneniaPrijateho) => (sk as Record<string, string>)[`profilKlienta.fakt.samozdanenie.${druh}.nazov`] ?? druh;

export type ZmenaSamozdanenia =
  | { pole: 'volba'; hodnota: VolbaSamozdanenia }
  | { pole: 'druh'; hodnota: DruhSamozdaneniaPrijateho }
  | { pole: 'datum'; hodnota: string }
  | { pole: 'sadzba' | 'kurz' | 'zaklad'; hodnota: number | undefined }
  | { pole: 'interny'; hodnota: Partial<InternySamozdanenia> }
  | { pole: 'dovod'; hodnota: DovodNevznikaSamozdanenia | undefined }
  | { pole: 'dovodText' | 'cislaInternych'; hodnota: string };

/**
 * Nové rozhodnutie po jednej zmene v bloku. Iný druh prepočíta dátum aj sadzbu
 * (tovar z EÚ má iný dátum) a dovoz prepne na „Už zaúčtované v POHODE"; iný
 * dátum prepočíta sadzbu. Ručný kurz ostáva — mena sa nemenila. Druh ide len
 * ako ručný (rucne.druh) — inak ho server určí z dodávateľa.
 */
export function zmenRozhodnutie(blok: BlokSamozdanenia['hodnota'], zmena: ZmenaSamozdanenia): RozhodnutieSamozdanenia {
  const { volba, dovod, dovodText, cislaInternych, rucne = {} } = blok;
  const teraz: RozhodnutieSamozdanenia = { volba, dovod, dovodText, cislaInternych, rucne };
  switch (zmena.pole) {
    case 'volba': return { ...teraz, volba: zmena.hodnota };
    // Iný druh plnenia = iná rodina kódov (DDnadEU proti DDsluz), takže prepis
    // kódov padá s ním; vlastný základ je o sume faktúry a rodiny sa netýka.
    case 'druh': return {
      ...teraz, volba: zmena.hodnota === 'dovoz' ? 'v_pohode' : volba,
      rucne: { kurz: rucne.kurz, zaklad: rucne.zaklad, druh: zmena.hodnota },
    };
    case 'datum': return {
      ...teraz,
      rucne: {
        kurz: rucne.kurz, zaklad: rucne.zaklad, interny: rucne.interny, druh: rucne.druh,
        datumDanovejPovinnosti: zmena.hodnota || undefined,
      },
    };
    case 'sadzba': return { ...teraz, rucne: { ...rucne, sadzba: zmena.hodnota } };
    case 'kurz': return { ...teraz, rucne: { ...rucne, kurz: zmena.hodnota } };
    case 'zaklad': return { ...teraz, rucne: { ...rucne, zaklad: zmena.hodnota } };
    // Prepis kódov sa dopĺňa po poliach: zmena predkontácie vymerania nesmie
    // zahodiť členenie odpočtu, ktoré účtovník opravil pred ňou.
    case 'interny': return { ...teraz, rucne: { ...rucne, interny: { ...rucne.interny, ...zmena.hodnota } } };
    case 'dovod': return { ...teraz, dovod: zmena.hodnota, dovodText: zmena.hodnota === 'iny' ? dovodText : undefined };
    default: return { ...teraz, [zmena.pole]: zmena.hodnota || undefined };
  }
}

/**
 * Riadky náhľadu interných dokladov; odpočet len keď firma daň odpočítava.
 * Sekcia KV je na každom riadku vlastná — spoločné `kv` z profilu platí, kým
 * ju účtovník na doklade nerozdelí (vymeranie B1, odpočet niekedy KN).
 */
export function riadkyNahladu(hodnota: BlokSamozdanenia['hodnota']) {
  const interny = hodnota.interny;
  const odpocet = hodnota.odpocet === undefined ? Boolean(interny?.pKod) : hodnota.odpocet > 0;
  return [
    {
      kluc: 'vymeranie' as const, predkontacia: interny?.ddPredkontaciaKod, clenenie: interny?.ddKod,
      kv: interny?.ddKv ?? interny?.kv, zaklad: hodnota.zaklad, dan: hodnota.dan,
    },
    ...(odpocet ? [{
      kluc: 'odpocet' as const, predkontacia: interny?.pPredkontaciaKod, clenenie: interny?.pKod,
      kv: interny?.pKv ?? interny?.kv, zaklad: hodnota.zaklad, dan: hodnota.odpocet,
    }] : []),
  ];
}

/**
 * Základ zo sumy rozpracovaného dokladu — musí sedieť na cent so serverom
 * (`zostavSamozdanenie` v server/services/samozdanenieService.ts): v EUR je to
 * suma dokladu, v cudzej mene suma delená kurzom, oboje na centy.
 *
 * ponytail: dva riadky aritmetiky sú zámerne zdvojené — server a prehliadač
 * nemajú spoločný modul a ťahať kvôli tomu serverový kód do bundle by bolo
 * horšie ako duplicita, ktorú drží test.
 */
export function zakladZDokladu(sumaSpolu: number | undefined, mena: string, kurz?: number): number | undefined {
  const suma = Number(sumaSpolu);
  if (!(suma > 0)) return undefined;
  if (mena === 'EUR') return Math.round(suma * 100) / 100;
  return kurz && kurz > 0 ? Math.round((suma / kurz + Number.EPSILON) * 100) / 100 : undefined;
}

/** Daň na centy podľa §26 ods. 3 — zhodne s `danZoZakladu` na serveri. */
export function danZoZakladu(zaklad: number, sadzba: number): number {
  return Math.round((Math.round(zaklad * 100) * sadzba) / 100) / 100;
}

/**
 * Hodnota, ktorú blok ukazuje: uložený stav zo servera, a na rozpracovanom
 * doklade základ a daň prepočítané z editora. Vlastný základ účtovníka
 * (zmiešaná faktúra) prepočet neprebíja — to nie je suma dokladu.
 */
export function hodnotaSEditorom(
  blok: BlokSamozdanenia,
  sumaSpolu: number | undefined,
): { hodnota: BlokSamozdanenia['hodnota']; neulozene: boolean } {
  const { hodnota } = blok;
  if (hodnota.rucne?.zaklad !== undefined || sumaSpolu === undefined) return { hodnota, neulozene: false };
  const zaklad = zakladZDokladu(sumaSpolu, blok.mena, hodnota.kurz);
  if (zaklad === undefined || zaklad === hodnota.zaklad) return { hodnota, neulozene: false };
  const dan = hodnota.sadzba === undefined ? undefined : danZoZakladu(zaklad, hodnota.sadzba);
  return {
    neulozene: true,
    hodnota: { ...hodnota, zaklad, dan, ...(hodnota.odpocet ? { odpocet: dan } : {}) },
  };
}

/**
 * Čo účtovníkovi zabráni schváliť doklad — v zvinutom riadku. Bez toho by
 * stlačil „Schváliť" a dostal 409 bez toho, aby blok vôbec otvoril.
 */
export function chybyRiadku(blok: BlokSamozdanenia): Array<{ kluc: string; text: string; odkaz?: boolean }> {
  const druh = nazovDruhu(blok.hodnota.druh);
  return [
    ...(blok.chyby.includes('kody') ? [{ kluc: 'kody', text: tv('samozdanenie.chyba.kody', { druh }), odkaz: true }] : []),
    ...(blok.statusNepotvrdeny ? [{ kluc: 'status', text: t('samozdanenie.statusNepotvrdeny') }] : []),
    ...(blok.chyby.includes('dovoz') ? [{ kluc: 'dovoz', text: t('samozdanenie.dovoz') }] : []),
    ...(blok.chyby.includes('kurz') ? [{ kluc: 'kurz', text: tv('samozdanenie.chyba.kurz', { mena: blok.mena }) }] : []),
    ...(blok.chyby.includes('datum') ? [{ kluc: 'datum', text: t('samozdanenie.chyba.datum') }] : []),
    ...(blok.chyby.includes('dovod') ? [{ kluc: 'dovod', text: t('samozdanenie.dovodVyber') }] : []),
  ];
}

const cislo = (raw: string) => {
  const hodnota = Number(raw.replace(/\s/g, '').replace(',', '.'));
  return raw.trim() && Number.isFinite(hodnota) && hodnota > 0 ? hodnota : undefined;
};

export interface SamozdanenieBlokProps {
  documentId: string;
  version: number;
  readOnly: boolean;
  /** Suma z rozpracovaného editora — základ a daň ju musia sledovať. */
  sumaSpolu?: number;
  /**
   * Predkontácia z rozpracovaného editora. Doklad ju uloženú ešte nemusí mať
   * a server z nej odvodzuje rodinu plnenia — bez nej by účtovník rodinu videl
   * zmeniť až po schválení.
   */
  predkontaciaId?: string;
  /** Číselníky firmy pre prepis kódov interných dokladov; bez nich zostáva náhľad textom. */
  codeLists?: { predkontacie: CodeListItem[]; cleneniaDph: CodeListItem[] };
}

export function SamozdanenieBlok({
  documentId, version, readOnly, sumaSpolu, predkontaciaId, codeLists,
}: SamozdanenieBlokProps) {
  const [blok, setBlok] = useState<BlokSamozdanenia | null>(null);
  const [uklada, setUklada] = useState(false);
  const [otvorene, setOtvorene] = useState(false);
  const [zmenaDruhu, setZmenaDruhu] = useState(false);
  const [pamatat, setPamatat] = useState(true);

  // Znova zo servera len pri zmene dokladu, po uložení (version) a pri zmene
  // účtu — nie pri písaní. Sumu si blok prepočíta sám (hodnotaSEditorom).
  useEffect(() => {
    let active = true;
    getSamozdanenie(documentId, predkontaciaId)
      .then((nacitany) => {
        if (!active) return;
        setBlok(nacitany);
        // Uložené „nepamätať" ostáva vypnuté; inak je zapnuté (predvolene).
        if (nacitany?.hodnota.volba === 'nevznika' && nacitany.hodnota.zdroj === 'uctovnik') setPamatat(nacitany.pamatDodavatela);
      })
      .catch(() => undefined);
    return () => { active = false; };
  }, [documentId, version, predkontaciaId]);

  if (!blok) return null;
  const upravitelny = blok.upravitelny && !readOnly && !uklada;
  // Zvinutý riadok aj náhľad ukazujú to isté číslo, aké je v položkách.
  const { hodnota, neulozene } = hodnotaSEditorom(blok, upravitelny ? sumaSpolu : undefined);

  // Ukladá sa vždy uložený stav zo servera plus jedna zmena — nikdy nie
  // predbežne prepočítaný základ z editora.
  const uloz = async (zmena: ZmenaSamozdanenia, navyse: { pamatatDodavatela?: boolean; vsetkyFaktury?: boolean } = {}) => {
    const rozhodnutie = zmenRozhodnutie(blok.hodnota, zmena);
    setUklada(true);
    try {
      const ulozeny = await ulozSamozdanenie(documentId, {
        ...rozhodnutie,
        ...(rozhodnutie.volba === 'nevznika' ? { pamatatDodavatela: pamatat } : {}),
        ...navyse,
      });
      if (ulozeny) setBlok(ulozeny);
    } catch (chyba) {
      showToast(chyba instanceof Error && chyba.message ? chyba.message : t('samozdanenie.ulozenieZlyhalo'), { tone: 'error' });
    } finally {
      setUklada(false);
    }
  };
  // Dátum mimo tabuľky sadzieb sadzbu nemá — server hlási chybu dátumu.
  const sadzba = hodnota.sadzba ?? blok.sadzby[0] ?? '—';
  const euro = (suma?: number) => (suma === undefined ? '—' : fmtMoney(suma, 'EUR'));

  // Návrh kódov z histórie firmy: náhľad ho ukáže našedo a potvrdí sa jedným
  // tlačidlom — inak by účtovník videl samé pomlčky a musel hľadať profil sám.
  const navrh = blok.navrhKodov;
  const potvrdKody = async () => {
    setUklada(true);
    try {
      const ulozeny = await potvrdKodySamozdanenia(documentId);
      if (ulozeny) setBlok(ulozeny);
    } catch (chyba) {
      showToast(chyba instanceof Error && chyba.message ? chyba.message : t('samozdanenie.ulozenieZlyhalo'), { tone: 'error' });
    } finally {
      setUklada(false);
    }
  };

  // Prepis kódov: ponúkajú sa len aktívne kódy firmy — presne tie, ktoré
  // server pri uložení pustí. Predkontácie sú z agendy interných dokladov,
  // sekcia KV len z rodiny samozdanenia. Prázdna položka vráti kód z profilu.
  const kodOpts = (items: CodeListItem[] | undefined, vybrany?: string): DcOption[] => [
    { value: '', label: t('samozdanenie.zProfilu') },
    ...(items ?? []).filter((item) => item.active || item.kod === vybrany)
      .map((item) => ({ value: item.kod, label: `${item.kod} · ${item.nazov}`, title: `${item.kod} · ${item.nazov}` })),
  ];
  const predkontaciaOpts = kodOpts(codeLists && predkontaciePreTyp(codeLists.predkontacie, { typ: 'MZDY', podtyp: 'bezna' }));
  const clenenieOpts = kodOpts(codeLists?.cleneniaDph);
  const kvOpts: DcOption[] = [{ value: '', label: t('samozdanenie.zProfilu') }, ...KV_SAMOZDANENIA.map((kod) => ({ value: kod, label: kod }))];
  /** Prepis jedného poľa riadka; prázdna hodnota prepis zruší a vráti profil. */
  const prepis = (kluc: 'vymeranie' | 'odpocet', pole: 'predkontacia' | 'clenenie' | 'kv') => (kod: string) =>
    void uloz({ pole: 'interny', hodnota: { [POLIA_RIADKU[kluc][pole]]: kod.trim() || undefined } });
  // Vlastný základ účtovníka, ktorý nesedí so sumou faktúry, je legitímny
  // (zmiešaná faktúra), ale v riadku musí byť vidieť, že je jeho — nie dokladu.
  const vlastnyZaklad = hodnota.rucne?.zaklad !== undefined && hodnota.rucne.zaklad !== blok.zakladDokladu;
  // Prepis je OPRAVA praxe firmy, nie jej náhrada: kým profil pre tento druh
  // nemá kódy (alebo ich len navrhuje), patrí sem odkaz do profilu a potvrdenie
  // návrhu — inak by účtovník vypĺňal doklad kódmi, ktoré firma nikde nemá.
  const opravitelne = upravitelny && !navrh && Boolean(codeLists) && Boolean(hodnota.interny);

  const chyby = chybyRiadku(blok);
  // Tón riadku: zamknutý doklad je sivý, blokujúca chyba jantárová, inak modrá
  // ako celé zaúčtovanie do POHODY.
  const ton = !blok.upravitelny || readOnly ? 'citanie' : chyby.length > 0 ? 'chyba' : 'ok';
  const suhrn = hodnota.volba === 'nevznika'
    ? nazovDruhu(hodnota.druh)
    : `${nazovDruhu(hodnota.druh)} · ${euro(hodnota.dan)}`;

  const vyberDruhu = upravitelny && (
    <>
      <button type="button" className="sz-odkaz" onClick={() => setZmenaDruhu(!zmenaDruhu)} aria-expanded={zmenaDruhu}>
        {t('samozdanenie.zmenitDruh')}
      </button>
      {zmenaDruhu && (
        <select
          className="sz-select" value={hodnota.druh} aria-label={t('samozdanenie.zmenitDruh')}
          onChange={(event) => { setZmenaDruhu(false); void uloz({ pole: 'druh', hodnota: event.target.value as DruhSamozdaneniaPrijateho }); }}
        >
          {DRUHY.map((druh) => <option key={druh} value={druh}>{nazovDruhu(druh)}</option>)}
        </select>
      )}
    </>
  );

  return (
    <div className={`sz-blok sz-blok-${ton}`} data-testid="samozdanenie">
      <button
        type="button" className="sz-hlava" aria-expanded={otvorene}
        onClick={() => setOtvorene(!otvorene)}
      >
        <span className="sz-hlava-lbl">{t('samozdanenie.titul')}</span>
        <span
          className={`sz-suhrn${neulozene ? ' sz-neulozene' : ''}`}
          title={neulozene ? t('samozdanenie.neulozenaSuma') : undefined}
        >
          <span className="sz-bod" aria-hidden="true" />{suhrn}
        </span>
        <span className="sz-hlava-volba">
          {t(`samozdanenie.volba.${hodnota.volba}` as SkKey)}
          <span className="sz-caret" aria-hidden="true">{otvorene ? '▾' : '▸'}</span>
        </span>
      </button>

      {!otvorene && chyby.length > 0 && (
        <div className="sz-hlava-chyby">
          {chyby.map((chyba) => (
            <p key={chyba.kluc} className="sz-varovanie">
              {chyba.odkaz ? <Link to="/profil-klienta">{chyba.text}</Link> : chyba.text}
            </p>
          ))}
        </div>
      )}

      {otvorene && (
        <div className="sz-telo">
          {/* Druh plnenia sa dá zmeniť pri každej voľbe, nielen pri vytváraní
              dokladov: firma, ktorá si ich zakladá v POHODE, opravuje ten istý
              štítok. */}
          <div className="sz-head">
            <span className="sz-druh">{nazovDruhu(hodnota.druh)}</span>
            <span className="sz-popis">{t(`samozdanenie.popis.${blok.uzemie}` as SkKey)}</span>
            {vyberDruhu}
          </div>
          {!blok.upravitelny && <p className="sz-info">{t('samozdanenie.lenCitanie')}</p>}

          <div className="sz-volby" role="radiogroup" aria-label={t('samozdanenie.titul')}>
            {VOLBY.map((volba) => (
              <div key={volba} className={`sz-volba${hodnota.volba === volba ? ' sz-volba-on' : ''}`}>
                <label className="sz-volba-label">
                  <input
                    type="radio" name={`samozdanenie-${documentId}`} checked={hodnota.volba === volba} disabled={!upravitelny}
                    onChange={() => void uloz({ pole: 'volba', hodnota: volba })}
                  />
                  {t(`samozdanenie.volba.${volba}` as SkKey)}
                </label>

                {hodnota.volba === volba && volba === 'vytvorit' && (
                  <div className="sz-obsah">
                    {hodnota.druh === 'dovoz' && <p className="sz-varovanie">{t('samozdanenie.dovoz')}</p>}
                    {blok.chyby.includes('kody') && (navrh ? (
                      <div className="sz-riadok sz-varovanie">
                        <span>{t('samozdanenie.navrhKodov')}</span>
                        <button type="button" className="sz-potvrdit" disabled={!upravitelny} onClick={() => void potvrdKody()}>
                          {t('samozdanenie.potvrditKody')}
                        </button>
                      </div>
                    ) : (
                      <p className="sz-varovanie">
                        <Link to="/profil-klienta">{tv('samozdanenie.chyba.kody', { druh: nazovDruhu(hodnota.druh) })}</Link>
                      </p>
                    ))}
                    {blok.statusNepotvrdeny && <p className="sz-varovanie">{t('samozdanenie.statusNepotvrdeny')}</p>}
                    <table className="sz-tabulka">
                      <thead>
                        <tr>
                          <th>{t('samozdanenie.stlpec.doklad')}</th>
                          <th>{t('samozdanenie.stlpec.predkontacia')}</th>
                          <th>{t('samozdanenie.stlpec.clenenie')}</th>
                          <th>{t('samozdanenie.stlpec.kv')}</th>
                          <th className="dk-r">{t('samozdanenie.stlpec.zaklad')}</th>
                          <th className="dk-r">
                            {hodnota.druh === 'tovar_eu' && blok.sadzby.length > 1 ? (
                              <select
                                className="sz-select" value={sadzba} disabled={!upravitelny} aria-label={tv('samozdanenie.stlpec.dph', { sadzba: String(sadzba) })}
                                onChange={(event) => void uloz({ pole: 'sadzba', hodnota: Number(event.target.value) })}
                              >
                                {blok.sadzby.map((moznost) => <option key={moznost} value={moznost}>{tv('samozdanenie.stlpec.dph', { sadzba: String(moznost) })}</option>)}
                              </select>
                            ) : tv('samozdanenie.stlpec.dph', { sadzba: String(sadzba) })}
                          </th>
                        </tr>
                      </thead>
                      <tbody>
                        {/* Kódy a základ sa opravujú priamo tu: profil klienta
                            drží prax firmy, ale jeden doklad sa od nej môže
                            líšiť a účtovník ho inak nemá ako opraviť. Navrhnuté
                            kódy (našedo) sa najprv potvrdzujú, neprepisujú. */}
                        {riadkyNahladu(navrh ? { ...hodnota, interny: navrh } : hodnota).map((riadok) => (
                          <tr key={riadok.kluc}>
                            <td>{t(`samozdanenie.riadok.${riadok.kluc}`)}</td>
                            {opravitelne ? (
                              <>
                                <td>
                                  <DcPick
                                    value={riadok.predkontacia} options={predkontaciaOpts} searchable
                                    title={t('samozdanenie.stlpec.predkontacia')} onChange={prepis(riadok.kluc, 'predkontacia')}
                                  />
                                </td>
                                <td>
                                  <DcPick
                                    value={riadok.clenenie} options={clenenieOpts} searchable
                                    title={t('samozdanenie.stlpec.clenenie')} onChange={prepis(riadok.kluc, 'clenenie')}
                                  />
                                </td>
                                <td>
                                  <DcPick
                                    value={riadok.kv} options={kvOpts}
                                    title={t('samozdanenie.stlpec.kv')} onChange={prepis(riadok.kluc, 'kv')}
                                  />
                                </td>
                                <td className="dk-r">
                                  <DcCell
                                    align="right" inputMode="decimal" commit="blur"
                                    tone={vlastnyZaklad ? 'warn' : undefined}
                                    title={vlastnyZaklad ? tv('samozdanenie.vlastnyZaklad', { suma: euro(blok.zakladDokladu) }) : undefined}
                                    value={riadok.zaklad === undefined ? '' : String(riadok.zaklad)}
                                    display={euro(riadok.zaklad)}
                                    onCommit={(raw) => {
                                      const zadany = cislo(raw);
                                      // Prázdne pole prepis zruší — základ sa vráti k sume dokladu.
                                      if (zadany !== hodnota.rucne?.zaklad) void uloz({ pole: 'zaklad', hodnota: zadany });
                                    }}
                                  />
                                </td>
                              </>
                            ) : (
                              <>
                                <td className={navrh ? 'sz-nepotvrdene' : undefined}>{riadok.predkontacia ?? '—'}</td>
                                <td className={navrh ? 'sz-nepotvrdene' : undefined}>{riadok.clenenie ?? '—'}</td>
                                <td className={navrh ? 'sz-nepotvrdene' : undefined}>{riadok.kv ?? '—'}</td>
                                <td className="dk-r">{euro(riadok.zaklad)}</td>
                              </>
                            )}
                            <td className={`dk-r${neulozene ? ' sz-neulozene' : ''}`}>{euro(riadok.dan)}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                    {neulozene && <p className="sz-varovanie">{t('samozdanenie.neulozenaSuma')}</p>}
                    {vlastnyZaklad && <p className="sz-info">{tv('samozdanenie.vlastnyZaklad', { suma: euro(blok.zakladDokladu) })}</p>}
                    <div className="sz-riadok">
                      <span>{t('samozdanenie.datum')}</span>
                      {upravitelny ? (
                        <input
                          type="date" className="sz-input" value={hodnota.datumDanovejPovinnosti ?? ''}
                          onChange={(event) => event.target.value && void uloz({ pole: 'datum', hodnota: event.target.value })}
                        />
                      ) : <strong>{formatDateSk(hodnota.datumDanovejPovinnosti) || '—'}</strong>}
                      {blok.mena !== 'EUR' && (
                        <>
                          <span>· {t('samozdanenie.kurz')}</span>
                          {upravitelny ? (
                            <input
                              key={hodnota.kurz ?? 'bez-kurzu'} className={`sz-input sz-kurz${blok.chyby.includes('kurz') ? ' sz-input-err' : ''}`}
                              inputMode="decimal" defaultValue={hodnota.kurz ?? ''} title={tv('samozdanenie.kurzTitle', { mena: blok.mena })}
                              onBlur={(event) => { const kurz = cislo(event.target.value); if (kurz !== hodnota.kurz) void uloz({ pole: 'kurz', hodnota: kurz }); }}
                            />
                          ) : <strong>{hodnota.kurz ?? '—'}</strong>}
                        </>
                      )}
                    </div>
                    {blok.chyby.includes('kurz') && <p className="sz-varovanie">{tv('samozdanenie.chyba.kurz', { mena: blok.mena })}</p>}
                    {blok.chyby.includes('datum') && <p className="sz-varovanie">{t('samozdanenie.chyba.datum')}</p>}
                    <p className="sz-info">{t('samozdanenie.info')}</p>
                  </div>
                )}

                {hodnota.volba === volba && volba === 'v_pohode' && (
                  <div className="sz-obsah">
                    {hodnota.druh === 'dovoz' && <p className="sz-varovanie">{t('samozdanenie.dovoz')}</p>}
                    <label className="sz-riadok">
                      <span>{t('samozdanenie.cislaInternych')}</span>
                      <input
                        key={hodnota.cislaInternych ?? ''} className="sz-input sz-siroky" disabled={!upravitelny} maxLength={240}
                        defaultValue={hodnota.cislaInternych ?? ''} placeholder={t('samozdanenie.cislaInternychPlaceholder')}
                        onBlur={(event) => { if (event.target.value.trim() !== (hodnota.cislaInternych ?? '')) void uloz({ pole: 'cislaInternych', hodnota: event.target.value.trim() }); }}
                      />
                    </label>
                    <label className="sz-check">
                      <input
                        type="checkbox" checked={blok.robimeVPohode} disabled={!upravitelny}
                        onChange={(event) => void uloz({ pole: 'volba', hodnota: 'v_pohode' }, { vsetkyFaktury: event.target.checked })}
                      />
                      {t('samozdanenie.vsetkyFaktury')}
                    </label>
                  </div>
                )}

                {hodnota.volba === volba && volba === 'nevznika' && (
                  <div className="sz-obsah">
                    <div className="sz-riadok">
                      <select
                        className={`sz-select${blok.chyby.includes('dovod') ? ' sz-input-err' : ''}`} value={hodnota.dovod ?? ''} disabled={!upravitelny}
                        aria-label={t('samozdanenie.dovodVyber')}
                        onChange={(event) => void uloz({ pole: 'dovod', hodnota: (event.target.value || undefined) as DovodNevznikaSamozdanenia | undefined })}
                      >
                        <option value="">{t('samozdanenie.dovodVyber')}</option>
                        {DOVODY.map((dovod) => <option key={dovod} value={dovod}>{t(`samozdanenie.dovod.${dovod}` as SkKey)}</option>)}
                      </select>
                      {hodnota.dovod === 'iny' && (
                        <input
                          key={hodnota.dovodText ?? ''} className={`sz-input sz-siroky${blok.chyby.includes('dovod') ? ' sz-input-err' : ''}`}
                          disabled={!upravitelny} maxLength={240} defaultValue={hodnota.dovodText ?? ''} placeholder={t('samozdanenie.dovodText')}
                          onBlur={(event) => { if (event.target.value.trim() !== (hodnota.dovodText ?? '')) void uloz({ pole: 'dovodText', hodnota: event.target.value.trim() }); }}
                        />
                      )}
                    </div>
                    <label className="sz-check">
                      <input
                        type="checkbox" checked={pamatat} disabled={!upravitelny}
                        onChange={(event) => { setPamatat(event.target.checked); void uloz({ pole: 'volba', hodnota: 'nevznika' }, { pamatatDodavatela: event.target.checked }); }}
                      />
                      {tv('samozdanenie.pamatat', { meno: blok.dodavatel || '—' })}
                    </label>
                  </div>
                )}
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

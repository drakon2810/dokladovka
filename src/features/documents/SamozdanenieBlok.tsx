// Samozdanenie na prijatej faktúre bez DPH — jeden riadok v karte zaúčtovania,
// ktorý sa rozbalí na mieste (maketa „Samozdanenie kompaktne", variant 1b).
// Zvinutý riadok nesie druh plnenia, vymeranú daň a to, čo účtovníka zablokuje
// pri schválení; celý blok zaberá výšku len vtedy, keď ho naozaj otvorí.
// Počíta server (základ, daň, dátum, kódy z profilu klienta); editor len volí a
// prepisuje druh, dátum, sadzbu a kurz. Každá zmena sa hneď uloží.
import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import type { BlokSamozdanenia, DovodNevznikaSamozdanenia, DruhSamozdaneniaPrijateho, RozhodnutieSamozdanenia, VolbaSamozdanenia } from '../../data/types';
import { getSamozdanenie, ulozSamozdanenie } from '../../data/api';
import { showToast } from '../../components/toast';
import { sk, t, tv, type SkKey } from '../../i18n/sk';
import { formatDateSk } from './DcInline';
import { fmtMoney } from './ItemsSection';

const VOLBY: VolbaSamozdanenia[] = ['vytvorit', 'v_pohode', 'nevznika'];
const DRUHY: DruhSamozdaneniaPrijateho[] = ['sluzby_eu', 'tovar_eu', 'sluzby_mimo_eu', 'prenesenie_prijate', 'dovoz'];
const DOVODY: DovodNevznikaSamozdanenia[] = ['slovenska_dph', 'miesto_dodania', 'nie_plnenie', 'iny'];

export const nazovDruhu = (druh: DruhSamozdaneniaPrijateho) => (sk as Record<string, string>)[`profilKlienta.fakt.samozdanenie.${druh}.nazov`] ?? druh;

export type ZmenaSamozdanenia =
  | { pole: 'volba'; hodnota: VolbaSamozdanenia }
  | { pole: 'druh'; hodnota: DruhSamozdaneniaPrijateho }
  | { pole: 'datum'; hodnota: string }
  | { pole: 'sadzba' | 'kurz'; hodnota: number | undefined }
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
    case 'druh': return {
      ...teraz, volba: zmena.hodnota === 'dovoz' ? 'v_pohode' : volba, rucne: { kurz: rucne.kurz, druh: zmena.hodnota },
    };
    case 'datum': return { ...teraz, rucne: { kurz: rucne.kurz, druh: rucne.druh, datumDanovejPovinnosti: zmena.hodnota || undefined } };
    case 'sadzba': return { ...teraz, rucne: { ...rucne, sadzba: zmena.hodnota } };
    case 'kurz': return { ...teraz, rucne: { ...rucne, kurz: zmena.hodnota } };
    case 'dovod': return { ...teraz, dovod: zmena.hodnota, dovodText: zmena.hodnota === 'iny' ? dovodText : undefined };
    default: return { ...teraz, [zmena.pole]: zmena.hodnota || undefined };
  }
}

/** Riadky náhľadu interných dokladov; odpočet len keď firma daň odpočítava. */
export function riadkyNahladu(hodnota: BlokSamozdanenia['hodnota']) {
  const interny = hodnota.interny;
  const odpocet = hodnota.odpocet === undefined ? Boolean(interny?.pKod) : hodnota.odpocet > 0;
  return [
    { kluc: 'vymeranie' as const, predkontacia: interny?.ddPredkontaciaKod, clenenie: interny?.ddKod, kv: interny?.kv, zaklad: hodnota.zaklad, dan: hodnota.dan },
    ...(odpocet ? [{ kluc: 'odpocet' as const, predkontacia: interny?.pPredkontaciaKod, clenenie: interny?.pKod, kv: interny?.kv, zaklad: hodnota.zaklad, dan: hodnota.odpocet }] : []),
  ];
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

export function SamozdanenieBlok({ documentId, version, readOnly }: { documentId: string; version: number; readOnly: boolean }) {
  const [blok, setBlok] = useState<BlokSamozdanenia | null>(null);
  const [uklada, setUklada] = useState(false);
  const [otvorene, setOtvorene] = useState(false);
  const [zmenaDruhu, setZmenaDruhu] = useState(false);
  const [pamatat, setPamatat] = useState(true);

  useEffect(() => {
    let active = true;
    getSamozdanenie(documentId)
      .then((nacitany) => {
        if (!active) return;
        setBlok(nacitany);
        // Uložené „nepamätať" ostáva vypnuté; inak je zapnuté (predvolene).
        if (nacitany?.hodnota.volba === 'nevznika' && nacitany.hodnota.zdroj === 'uctovnik') setPamatat(nacitany.pamatDodavatela);
      })
      .catch(() => undefined);
    return () => { active = false; };
  }, [documentId, version]);

  if (!blok) return null;
  const { hodnota } = blok;
  const upravitelny = blok.upravitelny && !readOnly && !uklada;

  const uloz = async (zmena: ZmenaSamozdanenia, navyse: { pamatatDodavatela?: boolean; vsetkyFaktury?: boolean } = {}) => {
    const rozhodnutie = zmenRozhodnutie(hodnota, zmena);
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
        <span className="sz-suhrn"><span className="sz-bod" aria-hidden="true" />{suhrn}</span>
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
                    {blok.chyby.includes('kody') && (
                      <p className="sz-varovanie">
                        <Link to="/profil-klienta">{tv('samozdanenie.chyba.kody', { druh: nazovDruhu(hodnota.druh) })}</Link>
                      </p>
                    )}
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
                        {riadkyNahladu(hodnota).map((riadok) => (
                          <tr key={riadok.kluc}>
                            <td>{t(`samozdanenie.riadok.${riadok.kluc}`)}</td>
                            <td>{riadok.predkontacia ?? '—'}</td>
                            <td>{riadok.clenenie ?? '—'}</td>
                            <td>{riadok.kv ?? '—'}</td>
                            <td className="dk-r">{euro(riadok.zaklad)}</td>
                            <td className="dk-r">{euro(riadok.dan)}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
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

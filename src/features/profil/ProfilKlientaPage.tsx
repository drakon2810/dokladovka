import { useEffect, useState, type ReactNode } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import { UCTO_AGENDA_NAZOV, getProfil, odpovedzOtazke, prepocitajProfil, rozhodniPraxBanky, ulozFakt } from '../../data/api';
import { useDataQuery } from '../../data/query';
import { useOrgSelection } from '../../data/orgSelection';
import type { OdpovedOtazky, PraxBanky, ProfilDokaz, ProfilFakt, ProfilKlienta, ProfilOtazka } from '../../data/types';
import { ConfirmDialog } from '../../components/ui';
import { showToast } from '../../components/toast';
import { formatDate, formatDateTime } from '../../lib/format';
import { t, tv, type SkKey } from '../../i18n/sk';
import { FaktModal } from './FaktModal';
import {
  DRUHY_PRIJATE, DRUHY_VYSTAVENE, SEKCIE, STATUSY, ZOZNAMOVE,
  kodyHodnoty, nadpisOtazky, nazovFaktu, pocty, popisFaktu, popisOtazky, pravidloZNavrhu, relevantneKluce, rozhodnute,
  stavFaktu, stavSekcie, suhrnProfilu, triedOtazky, vetaHodnoty, vetaVariantu,
  type BodkaSekcie, type DataFaktovejOtazky, type DataSporu, type Sekcia, type StavFaktu,
} from './profilKatalog';

/**
 * Profil klienta — čo o firme vieme a podľa čoho sa jej doklady účtujú.
 * Fakty sú potvrdené účtovníkom alebo navrhnuté z histórie POHODY; engine
 * používa len potvrdené. Hore otázky, bez ktorých sa prax firmy nedá zistiť.
 * Stav sa nedrží v klientovi: každý zápis vráti celý profil zo servera.
 */

type Filter = 'odpovedat' | 'navrhnute' | 'potvrdene';
type TeloFaktu = { stav: 'potvrdene'; hodnota: unknown } | { stav: 'nepouziva_sa' };
/** Otvorené okno: celý fakt, alebo položka zoznamu (index -1 = nová). */
interface Uprava { kluc: string; pociatok: unknown; index?: number }

type Obj = Record<string, unknown>;
const polozkyHodnoty = (hodnota: unknown): Obj[] => (Array.isArray(hodnota) ? hodnota as Obj[] : []);
const retazec = (hodnota: unknown) => (typeof hodnota === 'string' ? hodnota : '');
const MAX_OTAZOK = 5;

const PILULKY: Record<StavFaktu, { pill: string; dot: string }> = {
  potvrdene: { pill: 'border-green-200 bg-green-50 text-green-800', dot: 'bg-green-600' },
  navrhnute: { pill: 'border-dashed border-sky-300 bg-sky-50 text-sky-800', dot: 'bg-sky-600' },
  odpovedat: { pill: 'border-amber-200 bg-amber-50 text-amber-800', dot: 'bg-amber-600' },
  nepouziva_sa: { pill: 'border-gray-200 bg-gray-100 text-gray-600', dot: 'bg-gray-400' },
  nevyplnene: { pill: 'border-line bg-surface text-ink-faint', dot: 'bg-[#C9D0CB]' },
};
const BODKY: Record<BodkaSekcie, string> = {
  blokuje: 'bg-red-600', odpovedat: 'bg-amber-500', navrhnute: 'bg-sky-500', hotovo: 'bg-green-600', prazdne: 'bg-[#C9D0CB]',
};

const stroke = { fill: 'none', stroke: 'currentColor', strokeWidth: 1.9, strokeLinecap: 'round', strokeLinejoin: 'round' } as const;

function IkonaSipka({ otvorene }: { otvorene: boolean }) {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" {...stroke} strokeWidth={2}
      className={`shrink-0 transition-transform duration-200 ${otvorene ? '' : '-rotate-90'}`} aria-hidden>
      <path d="m6 9 6 6 6-6" />
    </svg>
  );
}
function IkonaPrepocet() {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" {...stroke} aria-hidden>
      <path d="M21 12a9 9 0 0 1-15.5 6.2L3 16" /><path d="M3 21v-5h5" />
      <path d="M3 12a9 9 0 0 1 15.5-6.2L21 8" /><path d="M21 3v5h-5" />
    </svg>
  );
}
function IkonaPlus() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" {...stroke} strokeWidth={2.2} aria-hidden><path d="M12 5v14" /><path d="M5 12h14" /></svg>
  );
}

function Rozbalenie({ otvorene, children }: { otvorene: boolean; children: ReactNode }) {
  return (
    <AnimatePresence initial={false}>
      {otvorene && (
        <motion.div
          initial={{ height: 0, opacity: 0 }}
          animate={{ height: 'auto', opacity: 1 }}
          exit={{ height: 0, opacity: 0 }}
          transition={{ duration: 0.26, ease: [0.32, 0.72, 0, 1] }}
          className="overflow-hidden"
        >
          {children}
        </motion.div>
      )}
    </AnimatePresence>
  );
}

function Volba({ children, onClick, disabled, druh = 'bezna' }: {
  children: ReactNode; onClick: () => void; disabled: boolean; druh?: 'bezna' | 'hlavna' | 'jemna';
}) {
  const trieda = druh === 'jemna'
    ? 'rounded px-2.5 py-1.5 text-[13px] font-medium text-ink-soft transition hover:text-ink disabled:opacity-50'
    : `btn px-3 py-1.5 text-[13px] ${druh === 'hlavna' ? 'btn-primary' : ''}`;
  return <button type="button" className={trieda} disabled={disabled} onClick={onClick}>{children}</button>;
}

const priklady = (dokaz: ProfilDokaz) =>
  (dokaz.priklady ?? []).map((priklad) => `${priklad.agenda} ${priklad.cislo} (${formatDate(priklad.datum)})`).join(', ');

function DokazRiadok({ dokaz }: { dokaz: ProfilDokaz }) {
  const casti = [
    tv('profilKlienta.dokaz.dokladov', { dokladov: String(dokaz.dokladov) }),
    dokaz.od && dokaz.do ? `${formatDate(dokaz.od)} – ${formatDate(dokaz.do)}` : '',
    dokaz.priklady?.length ? tv('profilKlienta.dokaz.priklady', { priklady: priklady(dokaz) }) : '',
  ].filter(Boolean);
  return <p className="mt-2 text-xs text-ink-faint tnum">{casti.join(' · ')}</p>;
}

/** „Prečo to navrhujeme": varianty s pásikmi podľa počtu dokladov a príklady. */
function DokazPanel({ dokaz }: { dokaz: ProfilDokaz }) {
  const najviac = Math.max(1, ...(dokaz.varianty ?? []).map((variant) => variant.dokladov));
  return (
    <div className="mt-2 rounded-[10px] border border-line-soft bg-surface-2 p-3 text-[12.5px]">
      <DokazRiadok dokaz={dokaz} />
      {dokaz.varianty && dokaz.varianty.length > 1 && (
        <div className="mt-2.5">
          <p className="text-[10.5px] font-semibold uppercase tracking-wider text-ink-mute">{t('profilKlienta.dokaz.varianty')}</p>
          <ul className="mt-1.5 space-y-1.5">
            {dokaz.varianty.map((variant, index) => (
              <li key={index} className="grid grid-cols-[minmax(0,180px)_1fr_auto] items-center gap-3">
                <span className="truncate text-ink" title={vetaVariantu(variant.hodnota)}>{vetaVariantu(variant.hodnota)}</span>
                <span className="h-1.5 overflow-hidden rounded-full bg-line-soft">
                  <span
                    className={`block h-full rounded-full ${index === 0 ? 'bg-sky-500' : 'bg-sky-300'}`}
                    style={{ width: `${Math.max(4, (variant.dokladov / najviac) * 100)}%` }}
                  />
                </span>
                <span className="tnum text-ink-soft">{variant.dokladov}</span>
              </li>
            ))}
          </ul>
        </div>
      )}
      <p className="mt-2.5 text-[11.5px] italic text-ink-faint">{t('profilKlienta.dokaz.poznamka')}</p>
    </div>
  );
}

function PilulkaStavu({ stav, fakt }: { stav: StavFaktu; fakt?: ProfilFakt }) {
  const styl = PILULKY[stav];
  const text = stav === 'navrhnute' && fakt?.dokaz?.dokladov
    ? tv('profilKlienta.stav.navrhnutePocet', { dokladov: String(fakt.dokaz.dokladov) })
    : t(`profilKlienta.stav.${stav}` as SkKey);
  return (
    <div>
      <span className={`inline-flex items-center gap-1.5 whitespace-nowrap rounded-full border px-2.5 py-0.5 text-xs font-semibold ${styl.pill}`}>
        <span className={`h-[7px] w-[7px] shrink-0 rounded-full ${styl.dot}`} aria-hidden />
        {text}
      </span>
      {rozhodnute(stav) && fakt?.potvrdil && (
        <p className="mt-1 text-[11.5px] text-ink-faint">
          {tv('profilKlienta.potvrdil', { meno: fakt.potvrdil, datum: formatDate(fakt.potvrdeneAt) })}
        </p>
      )}
    </div>
  );
}

/**
 * Menu „⋯" — natívny details, bez vlastného stavu otvorenia. Zavrie sa, keď
 * fokus odíde mimo; položka si fokus nevezme, aby klik stihol prejsť.
 */
function MenuDalsie({ disabled, onNepouzivaSa }: { disabled: boolean; onNepouzivaSa: () => void }) {
  return (
    <details
      className="relative"
      onBlur={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget as Node | null)) event.currentTarget.removeAttribute('open');
      }}
    >
      <summary
        className="btn cursor-pointer list-none px-2 py-1 text-xs [&::-webkit-details-marker]:hidden"
        aria-label={t('profilKlienta.akcia.dalsie')}
        title={t('profilKlienta.akcia.dalsie')}
      >
        ⋯
      </summary>
      <div className="absolute right-0 z-20 mt-1 w-44 rounded-xl border border-line bg-surface p-1 shadow-pop">
        <button
          type="button"
          disabled={disabled}
          className="w-full rounded-[8px] px-2.5 py-2 text-left text-[13px] transition hover:bg-app disabled:opacity-50"
          onMouseDown={(event) => event.preventDefault()}
          onClick={(event) => {
            event.currentTarget.closest('details')?.removeAttribute('open');
            onNepouzivaSa();
          }}
        >
          {t('profilKlienta.akcia.nepouzivaSa')}
        </button>
      </div>
    </details>
  );
}

function RiadokFaktu({ kluc, profil, busy, titulKodov, onFakt, onUprav, children }: {
  kluc: string;
  profil: ProfilKlienta;
  busy: boolean;
  titulKodov: (hodnota: unknown) => string | undefined;
  onFakt: (kluc: string, telo: TeloFaktu) => void;
  onUprav: (uprava: Uprava) => void;
  children?: ReactNode;
}) {
  const [precoOtvorene, setPrecoOtvorene] = useState(false);
  const fakt = profil.fakty.find((item) => item.kluc === kluc);
  const stav = stavFaktu(kluc, profil);
  const otazka = profil.otazky.find((item) => item.kluc === `fakt:${kluc}`);
  const data = otazka?.data as DataFaktovejOtazky | undefined;
  const hodnota = fakt?.stav === 'nepouziva_sa' ? undefined : fakt?.hodnota;
  return (
    <div className="py-4 first:pt-1 last:pb-1">
      <div className="grid gap-x-4 gap-y-2 md:grid-cols-[minmax(0,1fr)_220px_auto] md:items-start">
        <div className="min-w-0">
          <p className="text-[13.5px] font-semibold text-ink">{nazovFaktu(kluc)}</p>
          <p className={`mt-0.5 text-[13.5px] ${hodnota === undefined ? 'text-ink-mute' : 'text-ink'}`} title={titulKodov(hodnota)}>
            {vetaHodnoty(kluc, hodnota)}
          </p>
          <p className="mt-1 max-w-2xl text-xs leading-relaxed text-ink-faint">{popisFaktu(kluc)}</p>
          {data?.rozpor && (
            <p className="mt-2 inline-block rounded-lg border border-amber-200 bg-amber-50 px-2.5 py-1 text-xs text-amber-900" title={titulKodov(data.navrh)}>
              {tv('profilKlienta.historiaUkazuje', {
                veta: vetaHodnoty(kluc, data.navrh), dokladov: String(data.dokaz?.dokladov ?? otazka!.dokladov),
              })}
            </p>
          )}
        </div>
        <PilulkaStavu stav={stav} fakt={fakt} />
        <div className="flex items-center gap-1.5 md:justify-end">
          {stav === 'navrhnute' && (
            <button type="button" className="btn btn-primary px-2.5 py-1 text-xs" disabled={busy}
              onClick={() => onFakt(kluc, { stav: 'potvrdene', hodnota: fakt!.hodnota })}>
              {t('profilKlienta.akcia.potvrdit')}
            </button>
          )}
          {!ZOZNAMOVE.has(kluc) && (
            <button type="button" className="btn px-2.5 py-1 text-xs" disabled={busy}
              // Návrh z otázky (málo dokladov) predvyplní okno, kým fakt neexistuje.
              onClick={() => onUprav({ kluc, pociatok: hodnota ?? data?.navrh })}>
              {stav === 'nevyplnene' || stav === 'odpovedat' || stav === 'nepouziva_sa'
                ? t('profilKlienta.akcia.nastavit') : t('profilKlienta.akcia.zmenit')}
            </button>
          )}
          {/* Zoznam s položkami by „Nepoužíva sa" zmazalo celý a bez histórie sa neobnoví. */}
          {kluc !== 'dph.status' && stav !== 'nepouziva_sa' && !(ZOZNAMOVE.has(kluc) && polozkyHodnoty(hodnota).length > 0) && (
            <MenuDalsie disabled={busy} onNepouzivaSa={() => onFakt(kluc, { stav: 'nepouziva_sa' })} />
          )}
        </div>
      </div>
      {children}
      {fakt?.dokaz && fakt.dokaz.dokladov > 0 && (
        <>
          <button
            type="button"
            className="mt-2 inline-flex items-center gap-1 text-xs font-medium text-accent transition hover:text-accent-hover"
            aria-expanded={precoOtvorene}
            onClick={() => setPrecoOtvorene((otvorene) => !otvorene)}
          >
            <IkonaSipka otvorene={precoOtvorene} />
            {t('profilKlienta.akcia.precoNavrh')}
          </button>
          <Rozbalenie otvorene={precoOtvorene}><DokazPanel dokaz={fakt.dokaz} /></Rozbalenie>
        </>
      )}
    </div>
  );
}

function Dlazdica({ navrh, nadpis, slova, riadky, title, children }: {
  navrh?: string; nadpis: string; slova: string[]; riadky: string[]; title?: string; children: ReactNode;
}) {
  return (
    <div className={`flex flex-col gap-2 rounded-[12px] border p-3.5 ${navrh ? 'border-dashed border-sky-300 bg-sky-50/50' : 'border-line bg-surface-2'}`}>
      {navrh && <p className="text-[11.5px] font-semibold text-sky-800">{navrh}</p>}
      <p className="text-[13.5px] font-semibold text-ink">{nadpis}</p>
      {slova.length > 0 && (
        <div className="flex flex-wrap gap-1">
          {slova.map((slovo) => (
            <span key={slovo} className="rounded-md border border-line bg-surface px-1.5 py-0.5 text-[11.5px] text-ink-soft">{slovo}</span>
          ))}
        </div>
      )}
      <div className="text-[12.5px] text-ink-soft tnum" title={title}>
        {riadky.map((riadok) => <p key={riadok}>{riadok}</p>)}
      </div>
      <div className="mt-auto flex flex-wrap justify-end gap-1.5 pt-1">{children}</div>
    </div>
  );
}

function KartaOtazky({ otazka, profil, busy, onFakt, onOdpoved, onUprav }: {
  otazka: ProfilOtazka;
  profil: ProfilKlienta;
  busy: boolean;
  onFakt: (kluc: string, telo: TeloFaktu) => void;
  onOdpoved: (otazka: ProfilOtazka, odpoved: OdpovedOtazky) => void;
  onUprav: (uprava: Uprava) => void;
}) {
  /** undefined = pole „Iné" je zatvorené. */
  const [ine, setIne] = useState<string>();
  const fakt = otazka.druh === 'fakt' ? otazka.data as DataFaktovejOtazky : undefined;
  const kluc = fakt?.kluc ?? '';
  const potvrdHodnotu = (hodnota: unknown) => onFakt(kluc, { stav: 'potvrdene', hodnota });
  const volba = (text: string, onClick: () => void, druh?: 'hlavna') => (
    <Volba key={text} disabled={busy} onClick={onClick} druh={druh}>{text}</Volba>
  );

  let moznosti: ReactNode;
  if (otazka.druh === 'spor_protistrany') {
    const spor = otazka.data as DataSporu;
    moznosti = (
      <>
        <ul className="w-full space-y-1.5">
          {spor.varianty.map((variant, index) => (
            <li key={index} className="flex flex-wrap items-center justify-between gap-2 rounded-[10px] border border-[#D6E9F8] bg-[#F0F7FD] px-3 py-2 text-[13px]">
              <span>
                <strong className="tnum">
                  {variant.kody.predkontacia} · {variant.kody.clenenieDph}{variant.kody.clenenieKv ? ` · KV ${variant.kody.clenenieKv}` : ''}
                </strong>
                <span className="text-ink-soft">
                  {' — '}{tv('otazka.variant', { dokladov: String(variant.dokladov), od: formatDate(variant.od), do: formatDate(variant.do) })}
                </span>
              </span>
              {volba(t('otazka.pouzit'), () => onOdpoved(otazka, { akcia: 'variant', index }))}
            </li>
          ))}
        </ul>
        {ine === undefined && volba(t('profilKlienta.akcia.ine'), () => setIne(''))}
      </>
    );
  } else if (fakt?.rozpor) {
    const potvrdeny = profil.fakty.find((item) => item.kluc === kluc);
    moznosti = [
      // Zoznam z histórie nepozná ručne pridané položky — prevzatie by ich zmazalo.
      !ZOZNAMOVE.has(kluc) && volba(t('profilKlienta.akcia.prevziat'), () => potvrdHodnotu(fakt.navrh), 'hlavna'),
      volba(t('profilKlienta.akcia.ponechat'), () => onFakt(kluc, potvrdeny?.stav === 'potvrdene'
        ? { stav: 'potvrdene', hodnota: potvrdeny.hodnota } : { stav: 'nepouziva_sa' })),
      !ZOZNAMOVE.has(kluc) && volba(t('profilKlienta.akcia.zmenitDialog'), () => onUprav({ kluc, pociatok: potvrdeny?.hodnota ?? fakt.navrh })),
    ];
  } else if (kluc === 'dph.status') {
    moznosti = STATUSY.map((status) => volba(t(`profilKlienta.status.${status}`), () => potvrdHodnotu({ status }),
      fakt?.napoveda === status ? 'hlavna' : undefined));
  } else if (kluc === 'zasady.drobny_majetok') {
    moznosti = [
      ...[1700, 2400].map((hranica) => volba(`${hranica.toLocaleString('sk-SK')} €`, () => potvrdHodnotu({ hranica }))),
      volba(t('profilKlienta.akcia.inaSuma'), () => onUprav({ kluc, pociatok: undefined })),
    ];
  } else if (kluc === 'zahranicie.vratenie_dph') {
    moznosti = [
      volba(t('profilKlienta.akcia.uplatnujeme'), () => onUprav({ kluc, pociatok: { uplatnujeme: true } })),
      volba(t('profilKlienta.akcia.neuplatnujeme'), () => potvrdHodnotu({ uplatnujeme: false })),
    ];
  } else if (fakt?.navrh !== undefined) {
    moznosti = [
      volba(tv('profilKlienta.akcia.potvrditHodnotu', { veta: vetaHodnoty(kluc, fakt.navrh) }), () => potvrdHodnotu(fakt.navrh), 'hlavna'),
      volba(t('profilKlienta.akcia.zmenitDialog'), () => onUprav({ kluc, pociatok: fakt.navrh })),
      volba(t('profilKlienta.akcia.nepouzivaSa'), () => onFakt(kluc, { stav: 'nepouziva_sa' })),
    ];
  } else {
    moznosti = volba(t('profilKlienta.akcia.nastavit'), () => onUprav({ kluc, pociatok: undefined }));
  }

  return (
    <article className="rounded-[14px] border border-[#F2D49B] bg-[#FFFBF2] p-4 shadow-card">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <h3 className="text-[14.5px] font-semibold text-ink">{nadpisOtazky(otazka)}</h3>
        {otazka.blokuje && (
          <span className="inline-flex items-center gap-1.5 whitespace-nowrap rounded-full border border-red-200 bg-red-50 px-2.5 py-0.5 text-xs font-semibold text-red-800">
            <span className="h-[7px] w-[7px] rounded-full bg-red-600" aria-hidden />
            {t('profilKlienta.otazka.blokuje')}
          </span>
        )}
      </div>
      <p className="mt-1 max-w-3xl text-[13px] leading-relaxed text-ink-soft">
        {popisOtazky(otazka, profil.fakty, (agenda) => UCTO_AGENDA_NAZOV[agenda] ?? agenda)}
      </p>
      {fakt?.dokaz && <DokazRiadok dokaz={fakt.dokaz} />}
      <div className="mt-3 flex flex-wrap items-center gap-2">
        {moznosti}
        {otazka.stav === 'otvorena' && (
          <Volba disabled={busy} druh="jemna" onClick={() => onOdpoved(otazka, { akcia: 'neskor' })}>{t('profilKlienta.akcia.neskor')}</Volba>
        )}
      </div>
      {ine !== undefined && (
        <div className="mt-3 space-y-2">
          <textarea
            className="input min-h-[84px]"
            value={ine}
            maxLength={2000}
            placeholder={t('profilKlienta.otazka.inePlaceholder')}
            aria-label={t('profilKlienta.akcia.ine')}
            onChange={(event) => setIne(event.target.value)}
          />
          <div className="flex gap-2">
            <button type="button" className="btn btn-primary px-3 py-1.5 text-[13px]" disabled={busy || !ine.trim()}
              onClick={() => onOdpoved(otazka, { akcia: 'ine', text: ine.trim() })}>
              {t('profilKlienta.akcia.ulozitPokyn')}
            </button>
            <button type="button" className="btn px-3 py-1.5 text-[13px]" onClick={() => setIne(undefined)}>{t('akcia.zrusit')}</button>
          </div>
        </div>
      )}
    </article>
  );
}

type RozhodnutieBanky = { stav: 'potvrdene'; predkontaciaKod: string } | { stav: 'zamietnute' };

/** Jedna prax banky: partner alebo text, smer a dôkaz, predkontácia (pri viacerých kandidátoch výber) a rozhodnutie. */
function RiadokPraxeBanky({ prax, busy, nazvyKodov, onRozhodni }: {
  prax: PraxBanky;
  busy: boolean;
  nazvyKodov: Map<string, string>;
  onRozhodni: (telo: RozhodnutieBanky) => void;
}) {
  const kandidati = prax.dokaz?.kandidati ?? [];
  // Z viacerých kandidátov sa nevyberá za účtovníka — výber je prázdny, kým ho nezvolí.
  const [volba, setVolba] = useState(kandidati.length === 1 ? kandidati[0] : '');
  const kod = prax.stav === 'potvrdene' ? prax.predkontaciaKod : volba;
  const smer = t(`profilKlienta.banka.smer.${prax.smer}` as SkKey);
  const styl = PILULKY[prax.stav === 'zamietnute' ? 'nepouziva_sa' : prax.stav];
  const nazovKodu = (kodPredkontacie: string) => (nazvyKodov.has(kodPredkontacie) ? `${kodPredkontacie} — ${nazvyKodov.get(kodPredkontacie)}` : kodPredkontacie);
  return (
    <li className="grid gap-x-4 gap-y-2 px-3.5 py-3 text-[13px] md:grid-cols-[minmax(0,1fr)_minmax(0,260px)_auto] md:items-center">
      <div className="min-w-0">
        <p className="truncate font-semibold text-ink" title={prax.partnerMena.join(', ') || undefined}>
          {prax.slova.length > 0 ? tv('profilKlienta.banka.text', { slova: prax.slova.join(' ') }) : prax.partnerMena[0] ?? prax.partnerIco}
          {prax.partnerIco && <span className="tnum font-normal text-ink-faint"> · IČO {prax.partnerIco}</span>}
        </p>
        <p className="mt-0.5 text-xs text-ink-faint tnum">
          {prax.dokaz
            ? tv('profilKlienta.banka.dokaz', {
              smer, protiucet: prax.protiucet, riadkov: String(prax.dokaz.riadkov), od: formatDate(prax.dokaz.od), do: formatDate(prax.dokaz.do),
            })
            : tv('profilKlienta.banka.bezDokazu', { smer, protiucet: prax.protiucet })}
        </p>
      </div>
      <div className="min-w-0">
        {prax.stav !== 'potvrdene' && kandidati.length > 1 ? (
          <select
            className="input py-1 text-[13px]"
            value={volba}
            disabled={busy}
            aria-label={t('profilKlienta.banka.vyberte')}
            onChange={(event) => setVolba(event.target.value)}
          >
            <option value="">{t('profilKlienta.banka.vyberte')}</option>
            {kandidati.map((kandidat) => <option key={kandidat} value={kandidat}>{nazovKodu(kandidat)}</option>)}
          </select>
        ) : kod ? (
          <span className="block truncate" title={nazovKodu(kod)}>
            <b className="tnum">{kod}</b> <span className="text-ink-soft">{nazvyKodov.get(kod) ?? ''}</span>
          </span>
        ) : (
          <span className="text-ink-mute">{tv('profilKlienta.banka.bezPredkontacie', { protiucet: prax.dokaz?.protiucet ?? prax.protiucet })}</span>
        )}
      </div>
      <div className="flex flex-wrap items-center gap-1.5 md:justify-end">
        <span className={`inline-flex items-center gap-1.5 whitespace-nowrap rounded-full border px-2.5 py-0.5 text-xs font-semibold ${styl.pill}`}>
          <span className={`h-[7px] w-[7px] shrink-0 rounded-full ${styl.dot}`} aria-hidden />
          {prax.stav === 'zamietnute' ? t('profilKlienta.banka.zamietnute') : t(`profilKlienta.stav.${prax.stav}` as SkKey)}
        </span>
        {prax.stav !== 'potvrdene' && kandidati.length > 0 && (
          <button type="button" className="btn btn-primary px-2.5 py-1 text-xs" disabled={busy || !volba}
            onClick={() => onRozhodni({ stav: 'potvrdene', predkontaciaKod: volba })}>
            {t('profilKlienta.akcia.potvrdit')}
          </button>
        )}
        {prax.stav !== 'zamietnute' && (
          <button type="button" className="btn px-2.5 py-1 text-xs" disabled={busy} onClick={() => onRozhodni({ stav: 'zamietnute' })}>
            {t('profilKlienta.akcia.zamietnut')}
          </button>
        )}
      </div>
    </li>
  );
}

function Kostra() {
  return (
    <div className="mx-auto max-w-[1240px] space-y-4" aria-busy="true">
      <div className="skeleton h-[148px]" />
      <div className="skeleton h-[220px]" />
      <div className="skeleton h-[180px]" />
    </div>
  );
}

export function ProfilKlientaPage() {
  const { data, loading, error } = useDataQuery();
  const { orgId } = useOrgSelection();
  const [nacitany, setNacitany] = useState<{ orgId: string; profil?: ProfilKlienta; chyba?: string }>();
  const [pokus, setPokus] = useState(0);
  const [busy, setBusy] = useState(false);
  const [prepocitava, setPrepocitava] = useState(false);
  const [filter, setFilter] = useState<Filter>();
  const [uprava, setUprava] = useState<Uprava>();
  const [mazanie, setMazanie] = useState<{ kluc: string; index: number }>();
  const [vsetkyOtazky, setVsetkyOtazky] = useState(false);
  const [odlozeneOtvorene, setOdlozeneOtvorene] = useState(false);

  useEffect(() => {
    if (!orgId) return undefined;
    let zive = true;
    getProfil(orgId)
      .then((profil) => { if (zive) setNacitany({ orgId, profil }); })
      .catch((chyba) => { if (zive) setNacitany({ orgId, chyba: chyba instanceof Error ? chyba.message : String(chyba) }); });
    return () => { zive = false; };
  }, [orgId, pokus]);

  if (loading) return <Kostra />;
  if (error || !data) return <p className="text-sm text-red-700">{t('chyba.vseobecna')}</p>;
  if (!orgId) return <p className="text-sm text-ink-soft">{t('profilKlienta.ziadnaFirma')}</p>;
  if (nacitany?.orgId !== orgId) return <Kostra />;
  if (!nacitany.profil) {
    return (
      <div className="card mx-auto max-w-lg p-6 text-center">
        <p className="font-semibold text-ink">{t('profilKlienta.chybaNacitania')}</p>
        <p className="mt-1 text-sm text-ink-soft">{nacitany.chyba}</p>
        <button type="button" className="btn mt-4" onClick={() => { setNacitany(undefined); setPokus((n) => n + 1); }}>
          {t('profilKlienta.skusitZnova')}
        </button>
      </div>
    );
  }

  const profil = nacitany.profil;
  const organizacia = data.organizations.find((org) => org.id === orgId);
  const aktivne = (druh: 'predkontacie' | 'cleneniaDph') => data.codeLists[druh].filter((item) => item.orgId === orgId && item.active);
  const predkontacie = aktivne('predkontacie');
  const clenenia = aktivne('cleneniaDph');
  const nazvyKodov = new Map([...predkontacie, ...clenenia].map((item) => [item.kod.trim(), item.nazov]));
  const titulKodov = (hodnota: unknown) =>
    kodyHodnoty(hodnota).map((kod) => (nazvyKodov.has(kod) ? `${kod} — ${nazvyKodov.get(kod)}` : kod)).join('\n') || undefined;
  const kodPodlaId = (id: string) =>
    [...data.codeLists.predkontacie, ...data.codeLists.cleneniaDph].find((item) => item.id === id && item.orgId === orgId)?.kod.trim();
  const polozky = (kluc: string) => polozkyHodnoty(profil.fakty.find((fakt) => fakt.kluc === kluc)?.hodnota);
  const cisla = pocty(profil);
  const { otvorene, odlozene } = triedOtazky(profil.otazky);
  const relevantne = relevantneKluce(profil.fakty);
  const prazdny = profil.fakty.length === 0 && profil.otazky.length === 0 && profil.navrhyDelenia.length === 0 && profil.banka.length === 0;
  // „Potvrdené" zahŕňa aj zamietnuté — aj to je rozhodnutie účtovníka.
  const bankaVidno = profil.banka.filter((prax) => !filter || (filter === 'navrhnute' ? prax.stav === 'navrhnute' : filter === 'potvrdene' && prax.stav !== 'navrhnute'));
  const navrhnutejBanky = profil.banka.filter((prax) => prax.stav === 'navrhnute').length;
  const ukazBanku = bankaVidno.length > 0 || (!filter && !prazdny);

  const vidno = (kluc: string) => {
    if (!relevantne.includes(kluc)) return false;
    if (kluc === 'vozidla.pravidla' && filter === 'navrhnute' && profil.navrhyDelenia.length > 0) return true;
    const stav = stavFaktu(kluc, profil);
    return !filter || (filter === 'potvrdene' ? rozhodnute(stav) : stav === filter);
  };

  /** Každý zápis vráti celý profil; firma sa zachytí pred čakaním, aby prepnutie firmy neprepísalo cudzí profil. */
  async function vykonaj(zapis: (firma: string) => Promise<ProfilKlienta>, hlaska: SkKey): Promise<boolean> {
    const firma = orgId;
    setBusy(true);
    try {
      const profil = await zapis(firma);
      setNacitany((stary) => (stary && stary.orgId !== firma ? stary : { orgId: firma, profil }));
      showToast(t(hlaska));
      return true;
    } catch (chyba) {
      showToast(chyba instanceof Error ? chyba.message : t('chyba.vseobecna'), { tone: 'error' });
      // Otázku mohol medzitým uzavrieť niekto iný alebo prepočet — bez obnovy by každé ďalšie kliknutie zlyhalo rovnako.
      void getProfil(firma)
        .then((cerstvy) => setNacitany((stary) => (stary && stary.orgId !== firma ? stary : { orgId: firma, profil: cerstvy })))
        .catch(() => undefined);
      return false;
    } finally {
      setBusy(false);
    }
  }
  const ulozTelo = (kluc: string, telo: TeloFaktu) => vykonaj((firma) => ulozFakt(firma, kluc, telo), 'profilKlienta.ulozene');
  const onFakt = (kluc: string, telo: TeloFaktu) => void ulozTelo(kluc, telo);
  /**
   * Zoznam sa ukladá celý. Pred zápisom sa over, že ho medzitým nezmenil niekto
   * iný (druhý používateľ, iná karta) — inak by sa jeho zmena ticho prepísala.
   */
  const ulozZoznam = (kluc: string, zmen: (polozky: Obj[]) => Obj[]) => vykonaj(async (firma) => {
    const cerstvy = await getProfil(firma);
    const cerstve = polozkyHodnoty(cerstvy.fakty.find((fakt) => fakt.kluc === kluc)?.hodnota);
    if (JSON.stringify(cerstve) !== JSON.stringify(polozky(kluc))) {
      setNacitany({ orgId: firma, profil: cerstvy });
      throw new Error(t('profilKlienta.zoznamZmeneny'));
    }
    return ulozFakt(firma, kluc, { stav: 'potvrdene', hodnota: zmen(cerstve) });
  }, 'profilKlienta.ulozene');
  /** Navrhnutý zoznam sa potvrdzuje celý — úprava jednej položky by potvrdila aj neskontrolované ostatné. */
  const navrhnutyZoznam = (kluc: string) => profil.fakty.find((fakt) => fakt.kluc === kluc)?.stav === 'navrhnute';
  const onOdpoved = (otazka: ProfilOtazka, odpoved: OdpovedOtazky) => void vykonaj(
    (firma) => odpovedzOtazke(firma, otazka.id, odpoved),
    odpoved.akcia === 'neskor' ? 'profilKlienta.odlozene' : odpoved.akcia === 'ine' ? 'profilKlienta.pokynUlozeny' : 'profilKlienta.pravidloUlozene',
  );
  const onRozhodniBanku = (prax: PraxBanky, telo: RozhodnutieBanky) =>
    void vykonaj((firma) => rozhodniPraxBanky(firma, prax.id, telo), 'profilKlienta.ulozene');
  const prepocitaj = () => {
    setPrepocitava(true);
    void vykonaj(prepocitajProfil, 'profilKlienta.prepocitane').finally(() => setPrepocitava(false));
  };
  const prejdi = (id: string) => {
    setFilter(undefined);
    requestAnimationFrame(() => document.getElementById(`pk-${id}`)?.scrollIntoView({ behavior: 'smooth', block: 'start' }));
  };

  const riadok = (kluc: string, children?: ReactNode) => vidno(kluc) && (
    <RiadokFaktu key={kluc} kluc={kluc} profil={profil} busy={busy} titulKodov={titulKodov} onFakt={onFakt} onUprav={setUprava}>
      {children}
    </RiadokFaktu>
  );
  const skupina = (nadpis: SkKey, kluce: string[]) => kluce.some(vidno) && (
    <div key={nadpis} className="pt-4 first:pt-0">
      <p className="text-[10.5px] font-semibold uppercase tracking-wider text-ink-mute">{t(nadpis)}</p>
      <div className="divide-y divide-line-soft">{kluce.map((kluc) => riadok(kluc))}</div>
    </div>
  );
  const upravitOdstranit = (kluc: string, polozka: Obj, index: number) => !navrhnutyZoznam(kluc) && (
    <>
      <button type="button" className="btn px-2.5 py-1 text-xs" disabled={busy} onClick={() => setUprava({ kluc, pociatok: polozka, index })}>
        {t('akcia.upravit')}
      </button>
      <button type="button" className="btn btn-danger px-2.5 py-1 text-xs" disabled={busy} onClick={() => setMazanie({ kluc, index })}>
        {t('profilKlienta.akcia.odstranit')}
      </button>
    </>
  );
  const pridat = (kluc: string, text: SkKey) => !navrhnutyZoznam(kluc) && (
    <button
      type="button"
      className="flex min-h-[112px] items-center justify-center gap-1.5 rounded-[12px] border border-dashed border-line text-[13px] font-medium text-ink-soft transition hover:border-[#A7D9C9] hover:text-accent-hover disabled:opacity-50"
      disabled={busy}
      onClick={() => setUprava({ kluc, pociatok: undefined, index: -1 })}
    >
      <IkonaPlus /> {t(text)}
    </button>
  );
  const clenenieText = (kod: unknown) => (retazec(kod) ? ` · ${tv('profilKlienta.dlazdica.clenenie', { kod: retazec(kod) })}` : '');

  const obsahSekcie = (sekcia: Sekcia): ReactNode => {
    switch (sekcia) {
      case 'samozdanenie':
        return [
          skupina('profilKlienta.skupina.prijate', DRUHY_PRIJATE.map((druh) => `samozdanenie.${druh}`)),
          skupina('profilKlienta.skupina.vystavene', DRUHY_VYSTAVENE.map((druh) => `samozdanenie.${druh}`)),
          skupina('profilKlienta.skupina.vratenie', ['zahranicie.vratenie_dph']),
        ];
      case 'vozidla':
        return riadok('vozidla.pravidla', (
          <div className="mt-3 grid gap-3 md:grid-cols-2 xl:grid-cols-3">
            {polozky('vozidla.pravidla').map((pravidlo, index) => (
              <Dlazdica
                key={index}
                nadpis={retazec(pravidlo.nazov)}
                slova={(pravidlo.klucoveSlova as string[] | undefined) ?? []}
                riadky={[
                  tv('profilKlienta.dlazdica.percenta', { zaklad: String(pravidlo.percentoZakladu), dph: String(pravidlo.percentoDph) }),
                  tv('profilKlienta.dlazdica.ucty', { danovy: retazec(pravidlo.predkontaciaKod), nedanovy: retazec(pravidlo.predkontaciaNedanovaKod) })
                    + clenenieText(pravidlo.clenenieDphNedanoveKod),
                  ...(Array.isArray(pravidlo.typyDokladov) && pravidlo.typyDokladov.length
                    ? [tv('profilKlienta.dlazdica.typy', { typy: (pravidlo.typyDokladov as string[]).join(', ') })] : []),
                ]}
                title={titulKodov(pravidlo)}
              >
                {upravitOdstranit('vozidla.pravidla', pravidlo, index)}
              </Dlazdica>
            ))}
            {profil.navrhyDelenia.map((navrh) => {
              const pravidlo = pravidloZNavrhu(navrh, kodPodlaId);
              return (
                <Dlazdica
                  key={`${navrh.predkontaciaId}|${navrh.predkontaciaNedanovaId}|${navrh.klucoveSlova.join(',')}`}
                  navrh={tv('profilKlienta.dlazdica.navrh', { dokladov: String(navrh.dokladov) })}
                  nadpis={retazec(pravidlo?.nazov) || navrh.klucoveSlova.slice(0, 3).join(', ')}
                  slova={navrh.klucoveSlova}
                  riadky={[
                    tv('profilKlienta.dlazdica.percenta', { zaklad: String(navrh.percento), dph: String(navrh.percentoDph ?? navrh.percento) }),
                    tv('profilKlienta.dlazdica.ucty', {
                      danovy: kodPodlaId(navrh.predkontaciaId) ?? '—', nedanovy: kodPodlaId(navrh.predkontaciaNedanovaId) ?? '—',
                    }),
                    ...(navrh.priklady.length
                      ? [tv('profilKlienta.dlazdica.priklady', { priklady: navrh.priklady.map((p) => `${p.cislo} (${formatDate(p.datum)})`).join(', ') })]
                      : []),
                  ]}
                  title={titulKodov(pravidlo)}
                >
                  <button
                    type="button"
                    className="btn btn-primary px-2.5 py-1 text-xs"
                    disabled={busy}
                    onClick={() => {
                      if (!pravidlo) return showToast(t('profilKlienta.kodNenajdeny'), { tone: 'error' });
                      void ulozZoznam('vozidla.pravidla', (aktualne) => [...aktualne, pravidlo]);
                    }}
                  >
                    {t('profilKlienta.akcia.potvrdit')}
                  </button>
                </Dlazdica>
              );
            })}
            {pridat('vozidla.pravidla', 'profilKlienta.akcia.pridatPravidlo')}
          </div>
        ));
      case 'naklady':
        return [
          riadok('naklady.bez_naroku', (
            <div className="mt-3">
              {polozky('naklady.bez_naroku').length > 0 && (
                <ul className="divide-y divide-line-soft overflow-hidden rounded-[12px] border border-line">
                  {polozky('naklady.bez_naroku').map((ucet, index) => (
                    <li key={index} className="flex flex-wrap items-center justify-between gap-2 bg-surface-2 px-3.5 py-2.5 text-[13px]">
                      <span title={titulKodov(ucet)}>
                        <b className="tnum">{retazec(ucet.predkontaciaKod)}</b>
                        <span className="text-ink-soft"> {nazvyKodov.get(retazec(ucet.predkontaciaKod)) ?? ''}{clenenieText(ucet.clenenieKod)}</span>
                      </span>
                      <span className="flex gap-1.5">{upravitOdstranit('naklady.bez_naroku', ucet, index)}</span>
                    </li>
                  ))}
                </ul>
              )}
              {!navrhnutyZoznam('naklady.bez_naroku') && (
                <button type="button" className="btn mt-2 px-2.5 py-1 text-xs" disabled={busy}
                  onClick={() => setUprava({ kluc: 'naklady.bez_naroku', pociatok: undefined, index: -1 })}>
                  <IkonaPlus /> {t('profilKlienta.akcia.pridatUcet')}
                </button>
              )}
            </div>
          )),
          riadok('naklady.pomerne', (
            <div className="mt-3 grid gap-3 md:grid-cols-2 xl:grid-cols-3">
              {polozky('naklady.pomerne').map((pravidlo, index) => (
                <Dlazdica
                  key={index}
                  nadpis={retazec(pravidlo.nazov)}
                  slova={(pravidlo.klucoveSlova as string[] | undefined) ?? []}
                  riadky={[
                    tv('profilKlienta.dlazdica.odpocet', { dph: String(pravidlo.percentoDph) }),
                    tv('profilKlienta.dlazdica.ucet', { ucet: retazec(pravidlo.predkontaciaKod) }) + clenenieText(pravidlo.clenenieDphNedanoveKod),
                  ]}
                  title={titulKodov(pravidlo)}
                >
                  {upravitOdstranit('naklady.pomerne', pravidlo, index)}
                </Dlazdica>
              ))}
              {pridat('naklady.pomerne', 'profilKlienta.akcia.pridatPravidlo')}
            </div>
          )),
        ];
      default:
        return (SEKCIE.find((item) => item.id === sekcia)?.kluce ?? []).map((kluc) => riadok(kluc));
    }
  };

  const podiel = cisla.relevantnych ? cisla.potvrdenych / cisla.relevantnych : 0;
  const chipy: Array<{ id: Filter; pocet: number; trieda: string; bodka: string }> = [
    { id: 'odpovedat', pocet: cisla.otazok, trieda: 'border-amber-200 bg-amber-50 text-amber-900', bodka: cisla.blokuje ? 'bg-red-600' : 'bg-amber-500' },
    { id: 'navrhnute', pocet: cisla.navrhnutych, trieda: 'border-dashed border-sky-300 bg-sky-50 text-sky-900', bodka: 'bg-sky-500' },
    { id: 'potvrdene', pocet: cisla.potvrdenych, trieda: 'border-green-200 bg-green-50 text-green-900', bodka: 'bg-green-600' },
  ];
  const navigacia: Array<{ id: string; nazov: string; bodka: BodkaSekcie; pocet: number }> = [
    ...(profil.otazky.length > 0
      ? [{ id: 'otazky', nazov: t('profilKlienta.sekcia.otazky'), bodka: (cisla.blokuje ? 'blokuje' : 'odpovedat') as BodkaSekcie, pocet: profil.otazky.length }]
      : []),
    ...SEKCIE.map((sekcia) => ({ id: sekcia.id, nazov: t(`profilKlienta.sekcia.${sekcia.id}` as SkKey), ...stavSekcie(sekcia.id, profil) })),
    {
      id: 'banka', nazov: t('profilKlienta.sekcia.banka'), pocet: navrhnutejBanky,
      bodka: navrhnutejBanky ? 'navrhnute' : profil.banka.length ? 'hotovo' : 'prazdne',
    },
  ];
  const sekcie = SEKCIE.filter((sekcia) => sekcia.kluce.some(vidno));
  const ukazOtazky = (!filter || filter === 'odpovedat') && profil.otazky.length > 0;

  return (
    <div className="mx-auto max-w-[1240px]">
      <section className="card border-l-[3px] p-5 sm:p-6" style={{ borderLeftColor: organizacia?.farba }}>
        <div className="flex flex-wrap items-start justify-between gap-5">
          <div className="min-w-0 flex-1">
            <p className="text-[11px] font-semibold uppercase tracking-widest text-ink-mute">{t('profilKlienta.titulok')}</p>
            <h1 className="mt-1 text-[22px] font-bold tracking-tight text-ink">{organizacia?.nazov}</h1>
            <p className="mt-1 text-[14px] font-medium text-ink">{suhrnProfilu(profil.fakty)}</p>
            <p className="mt-1.5 max-w-3xl text-[13px] leading-relaxed text-ink-soft">{t('profilKlienta.popis')}</p>
          </div>
          <div
            role="img"
            aria-label={tv('profilKlienta.prstenec', { x: String(cisla.potvrdenych), y: String(cisla.relevantnych) })}
            className="grid h-[84px] w-[84px] shrink-0 place-items-center rounded-full"
            style={{ background: `conic-gradient(#0E7A5F ${podiel * 360}deg, #E4E8E4 0)` }}
          >
            <div className="flex h-[70px] w-[70px] flex-col items-center justify-center rounded-full bg-surface leading-tight">
              <span className="tnum text-[18px] font-bold text-ink">
                {cisla.potvrdenych}<span className="text-[13px] font-semibold text-ink-faint">/{cisla.relevantnych}</span>
              </span>
              <span className="text-[10px] text-ink-faint">{t('profilKlienta.potvrdenych')}</span>
            </div>
          </div>
        </div>
        <div className="mt-5 flex flex-wrap items-center justify-between gap-3 border-t border-line-soft pt-4">
          <div role="tablist" aria-label={t('profilKlienta.filtre')} className="flex flex-wrap gap-2">
            {chipy.map((chip) => (
              <button
                key={chip.id}
                type="button"
                role="tab"
                aria-selected={filter === chip.id}
                title={chip.id === 'odpovedat' && cisla.blokuje ? t('profilKlienta.filter.blokuje') : undefined}
                className={`inline-flex items-center gap-2 rounded-full border px-3 py-1.5 text-[13px] font-medium transition hover:shadow-card ${chip.trieda} ${
                  filter === chip.id ? 'ring-2 ring-accent/40 ring-offset-1' : ''
                }`}
                onClick={() => setFilter(filter === chip.id ? undefined : chip.id)}
              >
                <span className={`h-2 w-2 rounded-full ${chip.bodka}`} aria-hidden />
                {t(`profilKlienta.filter.${chip.id}` as SkKey)}
                <span className="tnum font-bold">{chip.pocet}</span>
              </button>
            ))}
          </div>
          <div className="flex flex-wrap items-center gap-3">
            <span className="text-xs text-ink-faint">
              {profil.prepocitaneAt
                ? tv('profilKlienta.prepocitaneAt', { cas: formatDateTime(profil.prepocitaneAt) })
                : t('profilKlienta.nePrepocitane')}
            </span>
            <button type="button" className="btn" disabled={busy} onClick={prepocitaj}>
              <IkonaPrepocet /> {prepocitava ? t('profilKlienta.prepocitavam') : t('profilKlienta.prepocitat')}
            </button>
          </div>
        </div>
      </section>

      <div className="mt-6 lg:grid lg:grid-cols-[220px_minmax(0,1fr)] lg:gap-6">
        <nav aria-label={t('profilKlienta.navigacia')} className="mb-4 lg:sticky lg:top-6 lg:mb-0 lg:self-start">
          <ul className="flex gap-2 overflow-x-auto pb-1 lg:flex-col lg:gap-0.5 lg:overflow-visible lg:pb-0">
            {navigacia.map((polozka) => (
              <li key={polozka.id} className="shrink-0">
                <button
                  type="button"
                  className="flex w-full items-center gap-2.5 whitespace-nowrap rounded-full border border-line bg-surface px-3 py-1.5 text-[13px] font-medium text-ink-soft transition hover:text-ink lg:rounded-[10px] lg:border-transparent lg:bg-transparent lg:py-2 lg:hover:bg-surface lg:hover:shadow-card"
                  onClick={() => prejdi(polozka.id)}
                >
                  <span className={`h-2 w-2 shrink-0 rounded-full ${BODKY[polozka.bodka]}`} aria-hidden />
                  <span className="min-w-0 flex-1 truncate text-left">{polozka.nazov}</span>
                  {polozka.pocet > 0 && (
                    <span className="tnum rounded-full bg-app px-1.5 text-[11px] font-semibold text-ink-soft">{polozka.pocet}</span>
                  )}
                </button>
              </li>
            ))}
          </ul>
        </nav>

        <div className="min-w-0 space-y-6">
          {prazdny && (
            <div className="card flex flex-col items-center gap-2 border-dashed p-8 text-center">
              <p className="font-semibold text-ink">{t('profilKlienta.prazdny.titulok')}</p>
              <p className="max-w-lg text-sm text-ink-soft">{t('profilKlienta.prazdny.popis')}</p>
              <button type="button" className="btn btn-primary mt-2" disabled={busy} onClick={prepocitaj}>
                <IkonaPrepocet /> {t('profilKlienta.prepocitat')}
              </button>
            </div>
          )}

          {ukazOtazky && (
            <section id="pk-otazky" className="scroll-mt-6">
              <h2 className="text-[15px] font-semibold tracking-tight text-ink">
                {t('profilKlienta.sekcia.otazky')} <span className="tnum text-ink-faint">{profil.otazky.length}</span>
              </h2>
              <p className="mt-0.5 text-[13px] text-ink-soft">{t('profilKlienta.sekcia.otazky.popis')}</p>
              <div className="mt-3 space-y-3">
                {otvorene.slice(0, vsetkyOtazky ? undefined : MAX_OTAZOK).map((otazka) => (
                  <KartaOtazky key={otazka.id} otazka={otazka} profil={profil} busy={busy} onFakt={onFakt} onOdpoved={onOdpoved} onUprav={setUprava} />
                ))}
              </div>
              {!vsetkyOtazky && otvorene.length > MAX_OTAZOK && (
                <button type="button" className="btn mt-3 px-3 py-1.5 text-[13px]" onClick={() => setVsetkyOtazky(true)}>
                  {tv('profilKlienta.akcia.zobrazitDalsie', { n: String(otvorene.length - MAX_OTAZOK) })}
                </button>
              )}
              {odlozene.length > 0 && (
                <div className="mt-3">
                  <button
                    type="button"
                    className="inline-flex items-center gap-1.5 text-[13px] font-medium text-ink-soft transition hover:text-ink"
                    aria-expanded={odlozeneOtvorene}
                    onClick={() => setOdlozeneOtvorene((otvorene) => !otvorene)}
                  >
                    <IkonaSipka otvorene={odlozeneOtvorene} />
                    {tv('profilKlienta.akcia.odlozene', { n: String(odlozene.length) })}
                  </button>
                  <Rozbalenie otvorene={odlozeneOtvorene}>
                    <div className="space-y-3 pt-3">
                      {odlozene.map((otazka) => (
                        <KartaOtazky key={otazka.id} otazka={otazka} profil={profil} busy={busy} onFakt={onFakt} onOdpoved={onOdpoved} onUprav={setUprava} />
                      ))}
                    </div>
                  </Rozbalenie>
                </div>
              )}
            </section>
          )}

          {sekcie.map((sekcia) => (
            <section key={sekcia.id} id={`pk-${sekcia.id}`} className="card scroll-mt-6 p-5">
              <h2 className="text-[15px] font-semibold tracking-tight text-ink">{t(`profilKlienta.sekcia.${sekcia.id}` as SkKey)}</h2>
              <p className="mt-0.5 max-w-3xl text-[13px] text-ink-soft">{t(`profilKlienta.sekcia.${sekcia.id}.popis` as SkKey)}</p>
              <div className="mt-3 divide-y divide-line-soft">{obsahSekcie(sekcia.id)}</div>
            </section>
          ))}

          {ukazBanku && (
            <section id="pk-banka" className="card scroll-mt-6 p-5">
              <h2 className="text-[15px] font-semibold tracking-tight text-ink">{t('profilKlienta.sekcia.banka')}</h2>
              <p className="mt-0.5 max-w-3xl text-[13px] text-ink-soft">{t('profilKlienta.sekcia.banka.popis')}</p>
              {bankaVidno.length > 0 ? (
                <ul className="mt-3 divide-y divide-line-soft overflow-hidden rounded-[12px] border border-line bg-surface-2">
                  {bankaVidno.map((prax) => (
                    <RiadokPraxeBanky
                      key={`${prax.id}|${prax.stav}|${prax.dokaz?.kandidati.join(',') ?? ''}`}
                      prax={prax} busy={busy} nazvyKodov={nazvyKodov}
                      onRozhodni={(telo) => onRozhodniBanku(prax, telo)}
                    />
                  ))}
                </ul>
              ) : (
                <p className="mt-3 text-[13px] text-ink-mute">{t('profilKlienta.banka.prazdne')}</p>
              )}
            </section>
          )}

          {filter && sekcie.length === 0 && !ukazOtazky && !ukazBanku && (
            <p className="card border-dashed p-8 text-center text-sm text-ink-soft">{t('profilKlienta.filter.ziadne')}</p>
          )}
        </div>
      </div>

      {uprava && (
        <FaktModal
          kluc={uprava.kluc}
          pociatok={uprava.pociatok}
          predkontacie={predkontacie}
          clenenia={clenenia}
          busy={busy}
          onClose={() => setUprava(undefined)}
          onUloz={(hodnota) => {
            if (uprava.index === undefined) return ulozTelo(uprava.kluc, { stav: 'potvrdene', hodnota });
            const index = uprava.index;
            return ulozZoznam(uprava.kluc, (aktualne) => {
              const nove = [...aktualne];
              nove.splice(index < 0 ? nove.length : index, index < 0 ? 0 : 1, hodnota as Obj);
              return nove;
            });
          }}
        />
      )}
      {mazanie && (
        <ConfirmDialog
          title={t('profilKlienta.odstranitTitulok')}
          text={t('profilKlienta.odstranitPotvrdenie')}
          confirmLabel={t('profilKlienta.akcia.odstranit')}
          danger
          onConfirm={() => void ulozZoznam(mazanie.kluc, (aktualne) => aktualne.filter((_, index) => index !== mazanie.index))}
          onClose={() => setMazanie(undefined)}
        />
      )}
    </div>
  );
}

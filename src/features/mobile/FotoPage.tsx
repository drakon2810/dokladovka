import { useEffect, useMemo, useRef, useState } from 'react';
import { uploadDocumentFile } from '../../data/api';
import { useDataQuery } from '../../data/query';
import { useAuth } from '../../auth/AuthContext';
import { t } from '../../i18n/sk';
import type { Organization } from '../../data/types';
import {
  doPdf, doklady, iniciality, noveId, pripravSnimku, strany,
  type Doklad, type Strana,
} from './fotoModel';
import { useKamera } from './useKamera';

/**
 * Snímanie dokladov telefónom — celá cesta od výberu firmy po odoslanie.
 *
 * Obrazovka stojí na dvoch úrovniach: snímka je STRANA, viac strán je JEDEN
 * doklad, viac dokladov je dávka, ktorá odchádza naraz. Väčšina dokladov je
 * jednostranová, preto „Hotovo" doklad uzavrie a hľadáčik ostane otvorený —
 * stopka bločkov sa tak sníma bez prechodov medzi obrazovkami.
 *
 * ponytail: dávka žije v pamäti stránky. Obnovenie ju stratí a offline fronta
 *   v IndexedDB je ďalší krok — až po tom, čo sa obrazovka overí v ruke.
 */

type Obrazovka = 'firmy' | 'snimanie' | 'davka' | 'doklad' | 'odosielanie' | 'hotovo';

const TMAVA = '#111613';
const RAM = '#16A37B';

export function FotoPage() {
  const { data, loading, error } = useDataQuery();
  const { session, logout } = useAuth();
  const firmy = useMemo(
    () => (data?.organizations ?? []).filter((firma) => !firma.archived),
    [data],
  );

  const [obrazovka, setObrazovka] = useState<Obrazovka>('firmy');
  const [firma, setFirma] = useState<Organization>();
  const [hladanie, setHladanie] = useState('');
  const [doklad, setDoklad] = useState<Doklad[]>([]);
  const [rozpracovany, setRozpracovany] = useState<Strana[]>([]);
  const [otvoreny, setOtvoreny] = useState<number>();
  const [oznam, setOznam] = useState('');
  const [zablesk, setZablesk] = useState(false);
  const [chyba, setChyba] = useState('');
  const vstup = useRef<HTMLInputElement>(null);
  const casovacOznamu = useRef<number>();
  const casovacZablesku = useRef<number>();

  const kamera = useKamera(obrazovka === 'snimanie');

  useEffect(() => () => {
    window.clearTimeout(casovacOznamu.current);
    window.clearTimeout(casovacZablesku.current);
  }, []);

  // Náhľady sú objectURL; bez uvoľnenia by pri veľkej dávke narástla pamäť.
  useEffect(() => () => {
    for (const strana of rozpracovany) URL.revokeObjectURL(strana.nahlad);
    for (const item of doklad) for (const strana of item.strany) URL.revokeObjectURL(strana.nahlad);
  }, [doklad, rozpracovany]);

  function ukazOznam(text: string) {
    window.clearTimeout(casovacOznamu.current);
    setOznam(text);
    casovacOznamu.current = window.setTimeout(() => setOznam(''), 1700);
  }

  async function pridajStranu(zdroj: Blob) {
    try {
      const jpeg = await pripravSnimku(zdroj);
      setRozpracovany((zoznam) => [...zoznam, { id: noveId(), jpeg, nahlad: URL.createObjectURL(jpeg) }]);
      setChyba('');
    } catch {
      setChyba(t('foto.chybaSpracovania'));
    }
  }

  async function odfot() {
    if (kamera.nedostupna) {
      vstup.current?.click();
      return;
    }
    window.clearTimeout(casovacZablesku.current);
    setZablesk(true);
    casovacZablesku.current = window.setTimeout(() => setZablesk(false), 130);
    try {
      await pridajStranu(await kamera.odfot());
    } catch {
      setChyba(t('foto.chybaSpracovania'));
    }
  }

  /** „Hotovo": doklad sa uzavrie a hľadáčik ostáva otvorený na ďalší. */
  function uzavriDoklad() {
    if (rozpracovany.length === 0) return;
    setDoklad((zoznam) => [...zoznam, { id: noveId(), strany: rozpracovany, stav: 'caka' }]);
    setRozpracovany([]);
    ukazOznam(t('foto.dokladUlozeny'));
  }

  /**
   * Späť na výber firmy. Firma platí pre celú dávku, takže jej zmena znamená
   * zahodiť rozfotené — pýtame sa len vtedy, keď je čo stratiť.
   */
  function zmenitFirmu() {
    const rozrobene = rozpracovany.length > 0 || doklad.length > 0;
    if (rozrobene && !window.confirm(t('foto.zmenaFirmyZahodi'))) return;
    setRozpracovany([]);
    setDoklad([]);
    setOtvoreny(undefined);
    setFirma(undefined);
    setObrazovka('firmy');
  }

  async function odosli() {
    if (!firma) return;
    setObrazovka('odosielanie');
    for (const item of doklad) {
      if (item.stav === 'hotovo') continue;
      setDoklad((zoznam) => zoznam.map((polozka) =>
        polozka.id === item.id ? { ...polozka, stav: 'odosiela', chyba: undefined } : polozka));
      try {
        const pdf = await doPdf(item.strany);
        const nazov = `foto-${new Date().toISOString().slice(0, 10)}-${item.id}.pdf`;
        const vysledok = await uploadDocumentFile(
          firma.id, new File([pdf], nazov, { type: 'application/pdf' }));
        // Karanténa ani duplicita sa nesmú tváriť ako odoslané: účtovník by
        // doklad považoval za vybavený a nikdy sa k nemu nevrátil.
        if (vysledok.status !== 'queued') throw new Error(vysledok.reason ?? vysledok.status);
        setDoklad((zoznam) => zoznam.map((polozka) =>
          polozka.id === item.id ? { ...polozka, stav: 'hotovo' } : polozka));
      } catch (dovod) {
        setDoklad((zoznam) => zoznam.map((polozka) => polozka.id === item.id
          ? { ...polozka, stav: 'chyba', chyba: dovod instanceof Error ? dovod.message : '' }
          : polozka));
      }
    }
    setDoklad((zoznam) => {
      if (zoznam.length > 0 && zoznam.every((polozka) => polozka.stav === 'hotovo')) {
        setObrazovka('hotovo');
      }
      return zoznam;
    });
  }

  async function opakuj(id: string) {
    const item = doklad.find((polozka) => polozka.id === id);
    if (!item || !firma) return;
    setDoklad((zoznam) => zoznam.map((polozka) =>
      polozka.id === id ? { ...polozka, stav: 'odosiela', chyba: undefined } : polozka));
    try {
      const pdf = await doPdf(item.strany);
      const vysledok = await uploadDocumentFile(
        firma.id, new File([pdf], `foto-${item.id}.pdf`, { type: 'application/pdf' }));
      if (vysledok.status !== 'queued') throw new Error(vysledok.reason ?? vysledok.status);
      setDoklad((zoznam) => zoznam.map((polozka) =>
        polozka.id === id ? { ...polozka, stav: 'hotovo' } : polozka));
    } catch (dovod) {
      setDoklad((zoznam) => zoznam.map((polozka) => polozka.id === id
        ? { ...polozka, stav: 'chyba', chyba: dovod instanceof Error ? dovod.message : '' }
        : polozka));
    }
  }

  function novaDavka() {
    setDoklad([]);
    setRozpracovany([]);
    setOtvoreny(undefined);
    setObrazovka('snimanie');
  }

  const hotovych = doklad.filter((item) => item.stav === 'hotovo').length;
  const naOdoslanie = doklad.filter((item) => item.stav !== 'hotovo').length;

  const skryteVstupy = (
    <input
      ref={vstup}
      type="file"
      accept="image/*"
      capture="environment"
      className="hidden"
      onChange={(udalost) => {
        const subor = udalost.target.files?.[0];
        if (subor) void pridajStranu(subor);
        udalost.target.value = '';
      }}
    />
  );

  if (obrazovka === 'firmy') {
    return (
      <Ramec>
        <VyberFirmy
          firmy={firmy}
          hladanie={hladanie}
          onHladanie={setHladanie}
          onVyber={(vybrana) => { setFirma(vybrana); setObrazovka('snimanie'); }}
          prazdno={!loading && firmy.length === 0}
          chybaNacitania={error?.message}
          email={session?.user.email}
          onOdhlasit={() => void logout()}
        />
      </Ramec>
    );
  }

  if (obrazovka === 'snimanie') {
    return (
      <Ramec tmavy>
        {skryteVstupy}
        <Snimanie
          firma={firma?.nazov ?? ''}
          cisloDokladu={doklad.length + 1}
          strany={rozpracovany}
          vDavke={doklad.length}
          kamera={kamera}
          zablesk={zablesk}
          oznam={oznam}
          chyba={chyba}
          onOdfot={() => void odfot()}
          onHotovo={uzavriDoklad}
          onZahodStranu={(id) => setRozpracovany((zoznam) => zoznam.filter((s) => s.id !== id))}
          onDavka={() => setObrazovka('davka')}
          onZmenitFirmu={zmenitFirmu}
        />
      </Ramec>
    );
  }

  if (obrazovka === 'hotovo') {
    return (
      <Ramec>
        <div className="flex min-h-0 flex-1 flex-col bg-app">
          <div className="flex flex-1 flex-col items-center justify-center gap-2 px-7 text-center">
            <span className="mb-2.5 grid h-[78px] w-[78px] place-items-center rounded-full bg-tint text-[34px] text-accent">✓</span>
            <span className="text-[21px] font-bold tracking-tight text-ink">{t('foto.davkaOdoslana')}</span>
            <span className="text-[14px] leading-normal text-ink-soft">
              {t('foto.odoslanych')} {doklad.length} {doklady(doklad.length)} · {firma?.nazov}
            </span>
            <span className="mt-1 text-[13px] leading-normal text-ink-faint">{t('foto.spracujeAi')}</span>
          </div>
          <div className="flex-none px-4 pb-2 pt-2.5">
            <Tlacidlo onClick={novaDavka}>{t('foto.novaDavka')}</Tlacidlo>
          </div>
        </div>
      </Ramec>
    );
  }

  if (obrazovka === 'doklad' && otvoreny !== undefined && doklad[otvoreny]) {
    const otvorenyDoklad = doklad[otvoreny];
    return (
      <Ramec>
        <Zoznam
          nazov={`${t('foto.doklad')} ${otvoreny + 1}`}
          podnadpis={`${otvorenyDoklad.strany.length} ${strany(otvorenyDoklad.strany.length)}`}
          firma={firma?.nazov ?? ''}
          onSpat={() => { setOtvoreny(undefined); setObrazovka('davka'); }}
          pata={(
            <Tlacidlo onClick={() => { setOtvoreny(undefined); setObrazovka('davka'); }}>
              {t('foto.hotovo')}
            </Tlacidlo>
          )}
        >
          <div className="grid grid-cols-2 gap-2.5">
            {otvorenyDoklad.strany.map((strana, poradie) => (
              <div key={strana.id} className="relative overflow-hidden rounded border border-line bg-surface">
                <img src={strana.nahlad} alt="" className="aspect-[3/4] w-full object-cover" />
                <span
                  className="absolute left-2 top-2 rounded-md px-1.5 py-0.5 text-[11px] font-bold text-white"
                  style={{ background: 'rgba(22,32,27,.7)' }}
                >
                  {t('foto.stranaCislo')} {poradie + 1}
                </span>
                <button
                  type="button"
                  aria-label={t('foto.zahodStranu')}
                  onClick={() => setDoklad((zoznam) => zoznam.map((polozka, index) => index === otvoreny
                    ? { ...polozka, strany: polozka.strany.filter((s) => s.id !== strana.id) }
                    : polozka))}
                  className="absolute right-0 top-0 grid h-11 w-11 place-items-center"
                >
                  <span
                    className="grid h-7 w-7 place-items-center rounded-full text-white"
                    style={{ background: 'rgba(22,32,27,.7)' }}
                  >
                    ×
                  </span>
                </button>
              </div>
            ))}
          </div>
        </Zoznam>
      </Ramec>
    );
  }

  const odosielaSa = obrazovka === 'odosielanie';
  return (
    <Ramec>
      <Zoznam
        nazov={odosielaSa ? t('foto.odosielanie') : t('foto.davka')}
        podnadpis={odosielaSa
          ? `${hotovych} / ${doklad.length}`
          : `${doklad.length} ${doklady(doklad.length)}`}
        firma={firma?.nazov ?? ''}
        onSpat={() => setObrazovka('snimanie')}
        pata={odosielaSa ? (
          <div className="flex items-center justify-between gap-2.5">
            <span className="tnum text-[15px] font-bold text-ink">
              {t('foto.odoslanych')} {hotovych} {t('foto.z')} {doklad.length}
            </span>
            <button
              type="button"
              onClick={() => setObrazovka('snimanie')}
              className="min-h-[48px] rounded border border-line bg-surface px-3.5 text-[14px] font-bold text-accent"
            >
              {t('foto.snimatDalej')}
            </button>
          </div>
        ) : doklad.length > 0 ? (
          <Tlacidlo onClick={() => void odosli()}>
            {t('foto.odoslat')} {naOdoslanie} {doklady(naOdoslanie)}
          </Tlacidlo>
        ) : undefined}
      >
        {!odosielaSa && (
          <button
            type="button"
            onClick={() => setObrazovka('snimanie')}
            className="mb-2.5 flex min-h-[52px] w-full items-center justify-center gap-2 rounded border bg-tint text-[15px] font-bold text-accent"
            style={{ borderColor: '#C7E3D8' }}
          >
            + {t('foto.novyDoklad')}
          </button>
        )}

        {doklad.length === 0 ? (
          <PrazdnaDavka />
        ) : (
          <div className="flex flex-col gap-2.5">
            {doklad.map((item, poradie) => (
              <KartaDokladu
                key={item.id}
                poradie={poradie}
                item={item}
                akcie={!odosielaSa}
                onOtvor={() => { setOtvoreny(poradie); setObrazovka('doklad'); }}
                onZahod={() => setDoklad((zoznam) => zoznam.filter((polozka) => polozka.id !== item.id))}
                onOpakuj={() => void opakuj(item.id)}
              />
            ))}
          </div>
        )}
      </Zoznam>
    </Ramec>
  );
}

/* ── Spoločný rámec ─────────────────────────────────────────────────────── */

/**
 * Bezpečné okraje. Spodné tlačidlá musia ostať nad systémovými pruhmi:
 * home indicator na iPhone (34 px) aj navigačná lišta Androidu (až 48 px,
 * keď má používateľ tri tlačidlá namiesto gest).
 */
function Ramec({ children, tmavy }: { children: React.ReactNode; tmavy?: boolean }) {
  return (
    <div
      className="flex min-h-[100dvh] flex-col"
      style={{
        background: tmavy ? TMAVA : undefined,
        paddingTop: 'env(safe-area-inset-top)',
        paddingBottom: 'max(env(safe-area-inset-bottom), 8px)',
      }}
    >
      {children}
    </div>
  );
}

function Tlacidlo({ children, onClick }: { children: React.ReactNode; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="min-h-[56px] w-full rounded bg-accent text-[16px] font-bold text-white shadow-glow active:bg-accent-hover"
    >
      {children}
    </button>
  );
}

/* ── 1. Výber firmy ─────────────────────────────────────────────────────── */

function VyberFirmy({
  firmy, hladanie, onHladanie, onVyber, prazdno, chybaNacitania, email, onOdhlasit,
}: {
  firmy: Organization[];
  hladanie: string;
  onHladanie: (hodnota: string) => void;
  onVyber: (firma: Organization) => void;
  prazdno: boolean;
  chybaNacitania?: string;
  email?: string;
  onOdhlasit: () => void;
}) {
  const dopyt = hladanie.trim().toLocaleLowerCase('sk');
  const najdene = firmy.filter((firma) => !dopyt
    || firma.nazov.toLocaleLowerCase('sk').includes(dopyt)
    || firma.ico.includes(dopyt));

  return (
    <div className="flex min-h-0 flex-1 flex-col bg-app">
      <div className="px-4 pb-2 pt-2.5">
        <h1 className="text-[22px] font-bold leading-tight tracking-tight text-ink">{t('foto.vyberFirmy')}</h1>
        <p className="mt-0.5 text-[13px] text-ink-soft">{t('foto.platiPreDavku')}</p>
      </div>
      <div className="px-4 pb-2.5">
        <div className="flex h-12 items-center gap-2 rounded border border-line bg-surface px-3">
          <span className="text-ink-faint">⌕</span>
          <input
            value={hladanie}
            onChange={(udalost) => onHladanie(udalost.target.value)}
            placeholder={t('foto.hladatFirmu')}
            className="min-w-0 flex-1 border-0 bg-transparent text-[15px] text-ink outline-none"
          />
        </div>
      </div>

      {(prazdno || chybaNacitania) && (
        <div className="mx-4 mb-2.5 rounded bg-amber-50 px-3 py-2 text-[13px] text-amber-800">
          {chybaNacitania ? t('foto.chybaNacitania') : t('foto.ziadneFirmy')}
          {email && <span className="mt-1 block text-amber-700">{email}</span>}
          {/* Text chyby doslova: server odpovedá 200 aj vtedy, keď zlyhá zápis
              v prehliadači, takže bez neho sa príčina hľadá naslepo. */}
          {chybaNacitania && <span className="mt-1 block break-words text-amber-700">{chybaNacitania}</span>}
        </div>
      )}

      <div className="flex min-h-0 flex-1 flex-col gap-2 overflow-y-auto px-4 pb-5">
        {najdene.map((firma) => (
          <button
            key={firma.id}
            type="button"
            onClick={() => onVyber(firma)}
            className="flex min-h-[66px] w-full items-center gap-3 rounded border border-line bg-surface p-3 text-left shadow-card active:bg-surface-2"
          >
            <span className="grid h-10 w-10 flex-none place-items-center rounded-[10px] bg-tint text-[14px] font-bold text-accent">
              {iniciality(firma.nazov)}
            </span>
            <span className="flex min-w-0 flex-1 flex-col gap-0.5">
              <span className="text-[15px] font-semibold leading-tight text-ink">{firma.nazov}</span>
              <span className="tnum text-[12px] leading-tight text-ink-faint">IČO {firma.ico}</span>
            </span>
            <span className="flex-none text-ink-faint">›</span>
          </button>
        ))}
        {najdene.length === 0 && !prazdno && !chybaNacitania && (
          <div className="px-3 py-8 text-center text-[14px] text-ink-faint">{t('foto.ziadnaVyhovuje')}</div>
        )}
      </div>
      {/* Pod ktorým účtom telefón beží a ako z neho von. Bez toho sa účet
          nedal prepnúť inak než vymazaním údajov prehliadača — a keď bol
          prihlásený iný než na počítači, zoznam firiem vyzeral pokazený. */}
      <div className="flex flex-none items-center gap-3 border-t border-line px-4 py-3">
        <span className="min-w-0 flex-1 truncate text-[13px] text-ink-soft">{email ?? ''}</span>
        <button
          type="button"
          onClick={onOdhlasit}
          className="flex-none rounded border border-line px-3 py-1.5 text-[13px] font-medium text-ink"
        >
          {t('auth.odhlasit')}
        </button>
      </div>
    </div>
  );
}

/* ── 2. Snímanie ────────────────────────────────────────────────────────── */

function Snimanie({
  firma, cisloDokladu, strany: zoznamStran, vDavke, kamera, zablesk, oznam, chyba,
  onOdfot, onHotovo, onZahodStranu, onDavka, onZmenitFirmu,
}: {
  firma: string;
  cisloDokladu: number;
  strany: Strana[];
  vDavke: number;
  kamera: ReturnType<typeof useKamera>;
  zablesk: boolean;
  oznam: string;
  chyba: string;
  onOdfot: () => void;
  onHotovo: () => void;
  onZahodStranu: (id: string) => void;
  onDavka: () => void;
  onZmenitFirmu: () => void;
}) {
  const napoveda = chyba
    || (kamera.nedostupna ? t('foto.kameraNedostupna')
      : zoznamStran.length === 0 ? t('foto.zarovnajte') : t('foto.dalsiaAleboHotovo'));

  return (
    <div className="relative flex min-h-0 flex-1 flex-col" style={{ background: TMAVA }}>
      <div
        className="flex h-[38px] flex-none items-center justify-between gap-2.5 px-4"
        style={{ background: 'rgba(9,13,11,.55)' }}
      >
        {/* Jediná cesta späť na výber firmy. Bez nej sa dá odísť len tlačidlom
            prehliadača, ktoré vyhodí z /foto na hlavnú stránku — a v režime
            appky (pridané na plochu) tam žiadne tlačidlo prehliadača nie je. */}
        <button
          type="button"
          onClick={onZmenitFirmu}
          className="flex min-w-0 items-center gap-1.5 text-[13px] font-medium"
          style={{ color: '#DDE4E0' }}
        >
          <span aria-hidden className="flex-none text-[15px]">‹</span>
          <span className="min-w-0 truncate">{firma}</span>
        </button>
        <span className="tnum flex-none text-[13px] font-bold text-white">
          {t('foto.doklad')} {cisloDokladu} · {t('foto.strana')} {zoznamStran.length + 1}
        </span>
      </div>

      <div className="relative grid min-h-0 flex-1 place-items-center overflow-hidden">
        <video
          ref={kamera.video}
          playsInline
          muted
          className="absolute inset-0 h-full w-full object-cover"
          style={{ display: kamera.bezi ? 'block' : 'none' }}
        />
        {!kamera.bezi && (
          <div
            className="absolute inset-0"
            style={{ background: 'radial-gradient(120% 80% at 50% 40%, #20282400, #0A0D0B)' }}
          />
        )}
        {/* Rám dokladu: hranice, do ktorých sa má doklad zmestiť. */}
        <div className="relative" style={{ width: '70%', aspectRatio: '3 / 4', maxHeight: '78%' }}>
          {([
            { top: -2, left: -2, borderTop: `3px solid ${RAM}`, borderLeft: `3px solid ${RAM}`, borderRadius: '6px 0 0 0' },
            { top: -2, right: -2, borderTop: `3px solid ${RAM}`, borderRight: `3px solid ${RAM}`, borderRadius: '0 6px 0 0' },
            { bottom: -2, left: -2, borderBottom: `3px solid ${RAM}`, borderLeft: `3px solid ${RAM}`, borderRadius: '0 0 0 6px' },
            { bottom: -2, right: -2, borderBottom: `3px solid ${RAM}`, borderRight: `3px solid ${RAM}`, borderRadius: '0 0 6px 0' },
          ] as const).map((roh, index) => (
            <div key={index} className="absolute h-[30px] w-[30px]" style={roh} />
          ))}
        </div>
        <div className="absolute bottom-3 left-0 right-0 flex justify-center px-5">
          <span
            className="max-w-full rounded-full px-3.5 py-2 text-center text-[13px] font-semibold leading-tight text-white"
            style={{ background: chyba ? '#B45309' : 'rgba(9,13,11,.62)' }}
          >
            {napoveda}
          </span>
        </div>
        {zablesk && <div className="absolute inset-0 bg-white opacity-85" />}
      </div>

      <div className="flex min-h-[84px] flex-none items-center gap-2 overflow-x-auto px-3.5 pb-1 pt-2">
        {zoznamStran.map((strana, poradie) => (
          <div
            key={strana.id}
            className="relative h-[72px] w-[56px] flex-none overflow-hidden rounded-lg"
            style={{ border: '1px solid rgba(255,255,255,.22)' }}
          >
            <img src={strana.nahlad} alt="" className="h-full w-full object-cover" />
            <span
              className="tnum absolute bottom-0 left-0 px-1.5 py-px text-[10px] font-bold text-white"
              style={{ background: 'rgba(9,13,11,.72)', borderRadius: '0 6px 0 6px' }}
            >
              {poradie + 1}
            </span>
            <button
              type="button"
              aria-label={t('foto.zahodStranu')}
              onClick={() => onZahodStranu(strana.id)}
              className="absolute right-0 top-0 grid h-[30px] w-[30px] place-items-center text-white"
              style={{ background: 'rgba(9,13,11,.62)', borderRadius: '0 8px 0 10px' }}
            >
              ×
            </button>
          </div>
        ))}
        {zoznamStran.length === 0 && (
          <span className="text-[12px]" style={{ color: 'rgba(255,255,255,.5)' }}>
            {t('foto.zatialZiadneStrany')}
          </span>
        )}
      </div>

      <div className="grid flex-none grid-cols-[1fr_auto_1fr] items-center gap-2 px-4 pb-2 pt-1">
        <button
          type="button"
          onClick={onDavka}
          className="flex min-h-[48px] items-center gap-2 justify-self-start rounded-full py-0 pl-3 pr-3.5"
          style={{ border: '1px solid rgba(255,255,255,.22)', background: 'rgba(255,255,255,.08)' }}
        >
          <span className="tnum grid h-[26px] min-w-[26px] place-items-center rounded-full px-1.5 text-[13px] font-bold text-white" style={{ background: RAM }}>
            {vDavke}
          </span>
          <span className="text-[13px] font-semibold text-white">{t('foto.davka')}</span>
        </button>
        <button
          type="button"
          onClick={onOdfot}
          aria-label={t('foto.odfotit')}
          className="h-[78px] w-[78px] justify-self-center rounded-full bg-transparent p-[5px]"
          style={{ border: '4px solid #FFFFFF' }}
        >
          <span className="block h-full w-full rounded-full bg-white" />
        </button>
        {kamera.maBlesk ? (
          <button
            type="button"
            onClick={kamera.prepniBlesk}
            aria-label={t('foto.blesk')}
            className="grid h-[52px] w-[52px] place-items-center justify-self-end rounded-full text-[18px]"
            style={{
              border: `1px solid ${kamera.blesk ? '#FFFFFF' : 'rgba(255,255,255,.22)'}`,
              background: kamera.blesk ? '#FFFFFF' : 'rgba(255,255,255,.08)',
              color: kamera.blesk ? TMAVA : '#FFFFFF',
            }}
          >
            ⚡
          </button>
        ) : <span />}
      </div>

      <div className="flex flex-none gap-2.5 px-4 pb-2.5">
        <button
          type="button"
          onClick={onOdfot}
          className="min-h-[52px] flex-1 rounded bg-transparent text-[15px] font-semibold text-white"
          style={{ border: '1.5px solid rgba(255,255,255,.42)' }}
        >
          {t('foto.dalsiaStrana')}
        </button>
        <button
          type="button"
          onClick={onHotovo}
          disabled={zoznamStran.length === 0}
          className="min-h-[52px] flex-1 rounded bg-accent text-[15px] font-bold text-white shadow-glow active:bg-accent-hover disabled:opacity-40"
        >
          {t('foto.hotovo')}
        </button>
      </div>

      {oznam && (
        <div className="pointer-events-none absolute bottom-[154px] left-0 right-0 flex justify-center">
          <span
            className="rounded-full px-4 py-2.5 text-[14px] font-semibold text-white"
            style={{ background: 'rgba(9,13,11,.86)' }}
          >
            ✓ {oznam}
          </span>
        </div>
      )}
    </div>
  );
}

/* ── 3./4. Dávka, doklad, odosielanie ───────────────────────────────────── */

function Zoznam({
  nazov, podnadpis, firma, onSpat, pata, children,
}: {
  nazov: string;
  podnadpis: string;
  firma: string;
  onSpat: () => void;
  pata?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <div className="flex min-h-0 flex-1 flex-col bg-app">
      <div className="flex flex-none items-center gap-1.5 border-b border-line px-3 pb-2 pt-0.5">
        <button type="button" aria-label={t('foto.spat')} onClick={onSpat} className="grid h-12 w-12 flex-none place-items-center text-[20px] text-ink">
          ‹
        </button>
        <span className="flex min-w-0 flex-1 flex-col">
          <span className="text-[17px] font-bold tracking-tight text-ink">{nazov}</span>
          <span className="truncate text-[12px] text-ink-faint">{firma}</span>
        </span>
        <span className="tnum flex-none rounded-full bg-tint px-2.5 py-1 text-[12px] font-bold text-accent">
          {podnadpis}
        </span>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto px-4 pb-4 pt-3">{children}</div>
      {pata && <div className="flex-none border-t border-line bg-surface-2 px-4 pb-2 pt-2.5">{pata}</div>}
    </div>
  );
}

function KartaDokladu({
  poradie, item, akcie, onOtvor, onZahod, onOpakuj,
}: {
  poradie: number;
  item: Doklad;
  akcie: boolean;
  onOtvor: () => void;
  onZahod: () => void;
  onOpakuj: () => void;
}) {
  const pocet = item.strany.length;
  return (
    <div className="flex items-center gap-3 rounded border border-line bg-surface p-2.5 pl-3 shadow-card">
      <div className="relative h-[60px] w-[46px] flex-none overflow-hidden rounded-md border border-line bg-surface-2">
        {item.strany[0] && <img src={item.strany[0].nahlad} alt="" className="h-full w-full object-cover" />}
        {pocet > 1 && (
          <span
            className="tnum absolute bottom-0.5 right-0.5 rounded px-1 text-[9px] font-bold text-white"
            style={{ background: 'rgba(22,32,27,.72)' }}
          >
            {pocet}
          </span>
        )}
      </div>
      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span className="text-[15px] font-semibold text-ink">
          {t('foto.doklad')} {poradie + 1} · {pocet} {strany(pocet)}
        </span>
        {item.stav === 'odosiela' && <span className="text-[13px] text-ink-soft">{t('foto.odosielam')}</span>}
        {item.stav === 'caka' && !akcie && <span className="text-[13px] text-ink-soft">{t('foto.vPoradi')}</span>}
        {item.stav === 'chyba' && (
          <span className="text-[12px] font-semibold text-rose-700">{t('foto.nepodariloSa')}</span>
        )}
      </div>
      {akcie && (
        <div className="flex flex-none items-center">
          <button type="button" aria-label={t('foto.zahod')} onClick={onZahod} className="grid h-12 w-12 place-items-center text-ink-faint">
            🗑
          </button>
          <button type="button" aria-label={t('foto.otvorit')} onClick={onOtvor} className="grid h-12 w-12 place-items-center text-[18px] text-ink-soft">
            ›
          </button>
        </div>
      )}
      {item.stav === 'hotovo' && (
        <span className="mr-2 grid h-[30px] w-[30px] flex-none place-items-center rounded-full bg-tint text-accent">✓</span>
      )}
      {item.stav === 'chyba' && (
        <button
          type="button"
          onClick={onOpakuj}
          className="min-h-[48px] flex-none rounded border border-rose-200 bg-rose-50 px-3 text-[13px] font-bold text-rose-700"
        >
          {t('foto.skusitZnova')}
        </button>
      )}
    </div>
  );
}

function PrazdnaDavka() {
  return (
    <div className="mt-8 flex flex-col items-center gap-1.5 px-6 text-center">
      <span className="mb-1.5 grid h-16 w-16 place-items-center rounded-full bg-tint text-[26px]">◎</span>
      <span className="text-[17px] font-bold text-ink">{t('foto.prazdnaDavka')}</span>
      <span className="text-[14px] leading-snug text-ink-soft">{t('foto.odfotitePrvy')}</span>
    </div>
  );
}

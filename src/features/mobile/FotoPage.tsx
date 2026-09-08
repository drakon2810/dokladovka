import { useEffect, useMemo, useRef, useState } from 'react';
import { PDFDocument } from 'pdf-lib';
import { uploadDocumentFile } from '../../data/api';
import { useDataQuery } from '../../data/query';
import { t } from '../../i18n/sk';

/**
 * Snímanie dokladov telefónom.
 *
 * Dve úrovne, a celá obrazovka je o nich: snímka je STRANA, viac strán je
 * JEDEN doklad (faktúra na tri listy), viac dokladov je dávka, ktorá odchádza
 * naraz. Bez toho by z faktúry na tri listy vznikli tri doklady — server robí
 * jeden doklad z jedného súboru.
 *
 * Strany sa preto ešte v telefóne zlepia do PDF a odchádza jeden súbor.
 * Serverom to nehýbe vôbec: viacstranové PDF pozná celý zvyšok cesty —
 * extrakcia, prehliadač dokladu aj export. Druhá cesta (poslať obrázky ako
 * skupinu) by si vyžiadala nový pojem v korpuse aj vlastný prehliadač.
 *
 * Fotí sa cez natívnu kameru systému (input capture), nie cez getUserMedia:
 * dá lepší obraz, ostrenie aj blesk zadarmo a používateľ ju pozná. Vlastný
 * hľadáčik má zmysel až pri sériovom snímaní bez potvrdzovania, čo je iná
 * úloha než prvá verzia.
 *
 * ponytail: dávka žije len v pamäti stránky — obnovenie ju stratí. Offline
 *   fronta v IndexedDB je ďalší krok, po tom, čo sa obrazovka overí v ruke.
 */

/** Dlhšia strana snímky po zmenšení. Na čítanie dokladu bohato stačí. */
const MAX_HRANA = 2000;
/** Kvalita JPEG pri prekódovaní. Nižšie sa už drobné písmo rozpadá. */
const KVALITA = 0.82;

interface Strana {
  id: string;
  /** Prekódovaná snímka — jednotné JPEG bez ohľadu na to, čo dal telefón. */
  jpeg: Blob;
  nahlad: string;
}

interface Doklad {
  id: string;
  strany: Strana[];
  stav: 'caka' | 'odosiela' | 'hotovo' | 'chyba';
  chyba?: string;
}

let pocitadlo = 0;
const noveId = () => `f${(pocitadlo += 1)}-${Date.now()}`;

/**
 * Snímku z telefónu zmenší a prekóduje na JPEG.
 *
 * Rieši tri veci naraz: HEIC z iPhonu (prehliadač ho dekóduje, canvas vyhodí
 * JPEG, ktoré server pozná), veľkosť (12 Mpx doklad je zbytočný a base64 ho
 * ešte o tretinu nafúkne) aj otočenie podľa EXIF, ktoré createImageBitmap
 * urobí sám.
 */
async function pripravSnimku(subor: File): Promise<Blob> {
  const bitmapa = await createImageBitmap(subor, { imageOrientation: 'from-image' });
  const mierka = Math.min(1, MAX_HRANA / Math.max(bitmapa.width, bitmapa.height));
  const sirka = Math.round(bitmapa.width * mierka);
  const vyska = Math.round(bitmapa.height * mierka);
  const platno = document.createElement('canvas');
  platno.width = sirka;
  platno.height = vyska;
  const kontext = platno.getContext('2d');
  if (!kontext) throw new Error(t('foto.chybaSpracovania'));
  kontext.drawImage(bitmapa, 0, 0, sirka, vyska);
  bitmapa.close();
  const blob = await new Promise<Blob | null>((hotovo) =>
    platno.toBlob(hotovo, 'image/jpeg', KVALITA));
  if (!blob) throw new Error(t('foto.chybaSpracovania'));
  return blob;
}

/** Strany jedného dokladu do jedného PDF — server tak vidí jeden doklad. */
async function doPdf(strany: Strana[]): Promise<Blob> {
  const pdf = await PDFDocument.create();
  for (const strana of strany) {
    const obrazok = await pdf.embedJpg(await strana.jpeg.arrayBuffer());
    const stranaPdf = pdf.addPage([obrazok.width, obrazok.height]);
    stranaPdf.drawImage(obrazok, { x: 0, y: 0, width: obrazok.width, height: obrazok.height });
  }
  return new Blob([await pdf.save()], { type: 'application/pdf' });
}

export function FotoPage() {
  const { data } = useDataQuery();
  const firmy = useMemo(
    () => (data?.organizations ?? []).filter((organizacia) => !organizacia.archived),
    [data],
  );
  const [firmaId, setFirmaId] = useState('');
  const [doklady, setDoklady] = useState<Doklad[]>([]);
  const [rozpracovany, setRozpracovany] = useState<Strana[]>([]);
  const [odosielam, setOdosielam] = useState(false);
  const [chyba, setChyba] = useState<string>();
  const vstup = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!firmaId && firmy.length === 1) setFirmaId(firmy[0].id);
  }, [firmaId, firmy]);

  // Náhľady sú objectURL; bez uvoľnenia by pri veľkej dávke narástla pamäť.
  useEffect(() => () => {
    for (const strana of rozpracovany) URL.revokeObjectURL(strana.nahlad);
    for (const doklad of doklady) for (const strana of doklad.strany) URL.revokeObjectURL(strana.nahlad);
  }, [doklady, rozpracovany]);

  async function prijmiSnimku(subor: File | undefined) {
    if (!subor) return;
    setChyba(undefined);
    try {
      const jpeg = await pripravSnimku(subor);
      setRozpracovany((strany) => [...strany, { id: noveId(), jpeg, nahlad: URL.createObjectURL(jpeg) }]);
    } catch (dovod) {
      setChyba(dovod instanceof Error ? dovod.message : t('foto.chybaSpracovania'));
    }
  }

  /** „Hotovo": doklad sa uzavrie a hneď sa otvára kamera na ďalší. */
  function uzavriDoklad(pokracovat: boolean) {
    if (rozpracovany.length === 0) return;
    setDoklady((zoznam) => [...zoznam, { id: noveId(), strany: rozpracovany, stav: 'caka' }]);
    setRozpracovany([]);
    if (pokracovat) setTimeout(() => vstup.current?.click(), 0);
  }

  async function odosli() {
    if (!firmaId || odosielam) return;
    setOdosielam(true);
    setChyba(undefined);
    // Doklad po doklade: jeden pád nesmie strhnúť zvyšok dávky a účtovník má
    // vidieť, ktorý presne neprešiel.
    for (const doklad of doklady) {
      if (doklad.stav === 'hotovo') continue;
      setDoklady((zoznam) => zoznam.map((polozka) =>
        polozka.id === doklad.id ? { ...polozka, stav: 'odosiela', chyba: undefined } : polozka));
      try {
        const pdf = await doPdf(doklad.strany);
        const nazov = `foto-${new Date().toISOString().slice(0, 10)}-${doklad.id}.pdf`;
        const vysledok = await uploadDocumentFile(
          firmaId, new File([pdf], nazov, { type: 'application/pdf' }));
        // Server neodmieta výnimkou: karanténa aj duplicita prídu ako stav.
        // Ticho ich zobraziť ako odoslané by znamenalo, že účtovník doklad
        // považuje za vybavený a nikdy sa k nemu nevráti.
        if (vysledok.status !== 'queued') throw new Error(vysledok.reason ?? vysledok.status);
        setDoklady((zoznam) => zoznam.map((polozka) =>
          polozka.id === doklad.id ? { ...polozka, stav: 'hotovo' } : polozka));
      } catch (dovod) {
        setDoklady((zoznam) => zoznam.map((polozka) => polozka.id === doklad.id
          ? { ...polozka, stav: 'chyba', chyba: dovod instanceof Error ? dovod.message : '' }
          : polozka));
      }
    }
    setOdosielam(false);
  }

  const naOdoslanie = doklady.filter((doklad) => doklad.stav !== 'hotovo').length;
  const odoslanych = doklady.filter((doklad) => doklad.stav === 'hotovo').length;

  return (
    // Spodný odsadok drží tlačidlá nad systémovými pruhmi: home indicator na
    // iPhone aj navigačná lišta Androidu (tá s tromi tlačidlami je najvyššia).
    <div
      className="flex min-h-[100dvh] flex-col bg-app"
      style={{ paddingBottom: 'max(env(safe-area-inset-bottom), 12px)' }}
    >
      <header
        className="flex items-center justify-between gap-3 border-b border-line bg-surface px-4 py-3"
        style={{ paddingTop: 'max(env(safe-area-inset-top), 12px)' }}
      >
        <select
          value={firmaId}
          onChange={(udalost) => setFirmaId(udalost.target.value)}
          className="min-w-0 flex-1 truncate rounded border border-line bg-surface px-2 py-2 text-[15px] text-ink"
        >
          <option value="">{t('foto.vyberteFirmu')}</option>
          {firmy.map((firma) => (
            <option key={firma.id} value={firma.id}>{firma.nazov}</option>
          ))}
        </select>
        <span className="shrink-0 text-[13px] text-ink-soft">
          {t('foto.doklad')} {doklady.length + (rozpracovany.length > 0 ? 1 : 0)}
          {rozpracovany.length > 0 ? ` · ${t('foto.strana')} ${rozpracovany.length}` : ''}
        </span>
      </header>

      <main className="flex-1 overflow-y-auto px-4 py-4">
        {chyba && (
          <p className="mb-3 rounded bg-rose-50 px-3 py-2 text-[13px] text-rose-800">{chyba}</p>
        )}

        {rozpracovany.length > 0 && (
          <section className="mb-4">
            <h2 className="mb-2 text-[13px] font-medium text-ink-soft">{t('foto.rozpracovanyDoklad')}</h2>
            <div className="flex gap-2 overflow-x-auto pb-1">
              {rozpracovany.map((strana, poradie) => (
                <div key={strana.id} className="relative shrink-0">
                  <img src={strana.nahlad} alt="" className="h-28 w-20 rounded object-cover shadow-card" />
                  <span className="absolute bottom-1 left-1 rounded bg-ink/70 px-1 text-[11px] text-white">
                    {poradie + 1}
                  </span>
                  <button
                    type="button"
                    aria-label={t('foto.zahodStranu')}
                    onClick={() => setRozpracovany((strany) => strany.filter((item) => item.id !== strana.id))}
                    className="absolute -right-1 -top-1 h-6 w-6 rounded-full bg-ink text-white"
                  >
                    ×
                  </button>
                </div>
              ))}
            </div>
          </section>
        )}

        {doklady.length === 0 && rozpracovany.length === 0 ? (
          <p className="py-10 text-center text-[15px] text-ink-faint">{t('foto.prazdnaDavka')}</p>
        ) : (
          <ul className="space-y-2">
            {doklady.map((doklad, poradie) => (
              <li key={doklad.id} className="flex items-center gap-3 rounded bg-surface p-2 shadow-card">
                <img src={doklad.strany[0].nahlad} alt="" className="h-14 w-11 rounded object-cover" />
                <span className="flex-1 text-[14px] text-ink">
                  {t('foto.doklad')} {poradie + 1} · {doklad.strany.length} {t('foto.stran')}
                </span>
                {doklad.stav === 'odosiela' && <span className="text-[13px] text-ink-soft">…</span>}
                {doklad.stav === 'hotovo' && <span className="text-[13px] text-accent">✓</span>}
                {doklad.stav === 'chyba' && <span className="text-[13px] text-rose-700">!</span>}
                {doklad.stav !== 'hotovo' && (
                  <button
                    type="button"
                    onClick={() => setDoklady((zoznam) => zoznam.filter((item) => item.id !== doklad.id))}
                    className="h-11 px-2 text-[13px] text-ink-faint"
                  >
                    {t('foto.zahod')}
                  </button>
                )}
              </li>
            ))}
          </ul>
        )}
      </main>

      <input
        ref={vstup}
        type="file"
        accept="image/*"
        capture="environment"
        className="hidden"
        onChange={(udalost) => {
          void prijmiSnimku(udalost.target.files?.[0]);
          udalost.target.value = '';
        }}
      />

      <footer className="space-y-2 border-t border-line bg-surface px-4 pt-3">
        <button
          type="button"
          onClick={() => vstup.current?.click()}
          className="h-14 w-full rounded bg-accent text-[17px] font-medium text-white active:bg-accent-hover"
        >
          {rozpracovany.length === 0 ? t('foto.odfotit') : t('foto.dalsiaStrana')}
        </button>
        {rozpracovany.length > 0 && (
          <button
            type="button"
            onClick={() => uzavriDoklad(true)}
            className="h-12 w-full rounded border border-line bg-surface text-[15px] text-ink"
          >
            {t('foto.hotovo')}
          </button>
        )}
        {naOdoslanie > 0 && rozpracovany.length === 0 && (
          <button
            type="button"
            disabled={!firmaId || odosielam}
            onClick={() => void odosli()}
            className="h-12 w-full rounded bg-ink text-[15px] text-white disabled:opacity-40"
          >
            {odosielam
              ? `${t('foto.odosielam')} ${odoslanych}/${doklady.length}`
              : `${t('foto.odoslat')} ${naOdoslanie}`}
          </button>
        )}
      </footer>
    </div>
  );
}

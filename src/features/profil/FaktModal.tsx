import { Fragment, useState } from 'react';
import { Modal } from '../../components/ui';
import { showToast } from '../../components/toast';
import { CLENENIE_KV_KODY, type CodeListItem } from '../../data/types';
import { t, tv, type SkKey } from '../../i18n/sk';
import {
  STATUSY, formularZHodnoty, hodnotaZFormulara, nazovFaktu, poliaFaktu, popisFaktu, popisPola, type PoleFormulara,
} from './profilKatalog';

/**
 * Okno jedného faktu (pri zozname jednej položky). Polia a prevod hodnoty
 * sú v katalógu — okno len vykreslí formulár; kódy sa vyberajú z aktívneho
 * číselníka firmy ako „kód — názov".
 */
export function FaktModal({ kluc, pociatok, predkontacie, clenenia, busy, onUloz, onClose }: {
  kluc: string;
  pociatok: unknown;
  predkontacie: CodeListItem[];
  clenenia: CodeListItem[];
  busy: boolean;
  /** true = uložené, okno sa zavrie; chybu servera ukáže volajúci. */
  onUloz: (hodnota: unknown) => Promise<boolean>;
  onClose: () => void;
}) {
  const [formular, setFormular] = useState(() => formularZHodnoty(kluc, pociatok));
  const polia = poliaFaktu(kluc).filter((pole) => !pole.ked || formular[pole.ked] === 'true');
  const skupina = (pole?: PoleFormulara) => (pole?.cesta.includes('.') ? pole.cesta.split('.')[0] : undefined);

  async function uloz() {
    const vysledok = hodnotaZFormulara(kluc, formular);
    if ('chyba' in vysledok) {
      showToast(tv('profilKlienta.chybaPola', { pole: popisPola(kluc, vysledok.chyba) ?? vysledok.chyba }), { tone: 'error' });
      return;
    }
    if (await onUloz(vysledok.hodnota)) onClose();
  }

  return (
    <Modal title={nazovFaktu(kluc)} onClose={onClose} wide={polia.length > 3 || polia.some((pole) => pole.typ === 'status')}>
      <p className="-mt-2 mb-4 max-w-2xl text-[13px] leading-relaxed text-ink-soft">{popisFaktu(kluc)}</p>
      <form className="grid gap-3 md:grid-cols-2" onSubmit={(event) => { event.preventDefault(); void uloz(); }}>
        {polia.map((pole, index) => (
          <Fragment key={pole.cesta}>
            {skupina(pole) && skupina(pole) !== skupina(polia[index - 1]) && (
              <p className="mt-1 text-[11px] font-semibold uppercase tracking-wider text-ink-mute md:col-span-2">
                {t(`profilKlienta.skupina.${skupina(pole)}` as SkKey)}
              </p>
            )}
            <Pole
              kluc={kluc}
              pole={pole}
              hodnota={formular[pole.cesta] ?? ''}
              polozky={pole.typ === 'predkontacia' ? predkontacie : clenenia}
              onChange={(hodnota) => setFormular((stary) => ({ ...stary, [pole.cesta]: hodnota }))}
            />
          </Fragment>
        ))}
        <div className="mt-2 flex justify-end gap-2 md:col-span-2">
          <button type="button" className="btn" onClick={onClose}>{t('akcia.zrusit')}</button>
          <button type="submit" className="btn btn-primary" disabled={busy}>{busy ? t('stav.nacitavam') : t('akcia.ulozit')}</button>
        </div>
      </form>
    </Modal>
  );
}

function Pole({ kluc, pole, hodnota, polozky, onChange }: {
  kluc: string;
  pole: PoleFormulara;
  hodnota: string;
  polozky: CodeListItem[];
  onChange: (hodnota: string) => void;
}) {
  const id = `pk-pole-${pole.cesta}`;
  const popis = popisPola(kluc, pole.cesta) ?? pole.cesta;
  const napoveda = popisPola(kluc, pole.cesta, '.napoveda');

  if (pole.typ === 'status' || pole.typ === 'anoNie') {
    const volby = pole.typ === 'status'
      ? STATUSY.map((status) => ({
        hodnota: status, text: t(`profilKlienta.status.${status}`), popis: t(`profilKlienta.statusPopis.${status}`),
      }))
      : [{ hodnota: 'true', text: t('profilKlienta.ano'), popis: '' }, { hodnota: 'false', text: t('profilKlienta.nie'), popis: '' }];
    return (
      <fieldset className="md:col-span-2">
        <legend className="label">{popis}</legend>
        <div className={`grid gap-2 ${pole.typ === 'status' ? 'sm:grid-cols-2' : 'grid-cols-2 sm:max-w-xs'}`}>
          {volby.map((volba) => (
            <label
              key={volba.hodnota}
              className={`flex cursor-pointer items-start gap-2.5 rounded-[10px] border px-3 py-2.5 text-[13px] transition ${
                hodnota === volba.hodnota ? 'border-accent bg-tint' : 'border-line hover:border-[#A7D9C9]'
              }`}
            >
              <input
                type="radio"
                name={id}
                className="mt-0.5 accent-[#0E7A5F]"
                checked={hodnota === volba.hodnota}
                onChange={() => onChange(volba.hodnota)}
              />
              <span>
                <span className="block font-medium text-ink">{volba.text}</span>
                {volba.popis && <span className="mt-0.5 block text-xs text-ink-soft">{volba.popis}</span>}
              </span>
            </label>
          ))}
        </div>
      </fieldset>
    );
  }

  // Ten istý kód býva v číselníku pre viac rokov — v ponuke stačí raz.
  const kody = [...new Map(polozky.map((polozka) => [polozka.kod.trim(), polozka])).values()]
    .sort((a, b) => a.kod.trim().localeCompare(b.kod.trim(), 'sk'));
  return (
    <label className={`block ${pole.typ === 'text' || pole.typ === 'slova' ? 'md:col-span-2' : ''}`} htmlFor={id}>
      <span className="label">
        {popis}
        {!pole.povinne && <span className="font-normal text-ink-faint"> {t('profilKlienta.nepovinne')}</span>}
      </span>
      {pole.typ === 'kv' ? (
        <select id={id} className="input" value={hodnota} onChange={(event) => onChange(event.target.value)}>
          <option value="">{t('nast.dph.bezVyberu')}</option>
          {CLENENIE_KV_KODY.map((kod) => <option key={kod} value={kod}>{kod}</option>)}
        </select>
      ) : pole.typ === 'predkontacia' || pole.typ === 'clenenie' ? (
        <select id={id} className="input" value={hodnota} onChange={(event) => onChange(event.target.value)}>
          <option value="">{t('nast.dph.bezVyberu')}</option>
          {/* Kód, ktorý medzičasom z číselníka zmizol, ostane viditeľný — server ho pri uložení odmietne. */}
          {hodnota && !kody.some((polozka) => polozka.kod.trim() === hodnota) && (
            <option value={hodnota}>{tv('profilKlienta.neaktivnyKod', { kod: hodnota })}</option>
          )}
          {kody.map((polozka) => (
            <option key={polozka.id} value={polozka.kod.trim()}>{polozka.kod.trim()} — {polozka.nazov}</option>
          ))}
        </select>
      ) : (
        <input
          id={id}
          className="input"
          value={hodnota}
          maxLength={pole.typ === 'text' ? 120 : 2000}
          inputMode={pole.typ === 'cislo' ? 'decimal' : undefined}
          onChange={(event) => onChange(event.target.value)}
        />
      )}
      {napoveda && <span className="mt-1 block text-xs text-ink-faint">{napoveda}</span>}
    </label>
  );
}

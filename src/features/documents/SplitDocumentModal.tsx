// Rozdelenie dokladu na dva zápisy v POHODE. Jeden prijatý súbor (typicky
// rekapitulácia miezd) často patrí do dvoch agend naraz — hrubé mzdy interným
// dokladom, odvody poisťovni ako ostatný záväzok. Účtovník vyberie položky,
// ktoré sa majú oddeliť, a zvolí agendu nového dokladu.
import { useState } from 'react';
import type { DocumentItem, DocumentType } from '../../data/types';
import { splitDocument } from '../../data/api';
import { Modal } from '../../components/ui';
import { showToast } from '../../components/toast';
import { t, type SkKey } from '../../i18n/sk';
import { fmtMoney } from './ItemsSection';

const TYPY: DocumentType[] = ['OZ', 'MZDY', 'FP', 'FV', 'PD'];

export function SplitDocumentModal({
  doklad,
  onClose,
  onSplit,
}: {
  doklad: DocumentItem;
  onClose: () => void;
  /** Rodič presmeruje na novú časť, nech ju účtovník rovno doúčtuje. */
  onSplit: (novyId: string) => void;
}) {
  const polozky = doklad.extracted.polozky ?? [];
  const [vybrane, setVybrane] = useState<string[]>([]);
  const [typ, setTyp] = useState<DocumentType>('OZ');
  const [busy, setBusy] = useState(false);

  const suma = (ids: string[]) => polozky
    .filter((polozka) => ids.includes(polozka.id))
    .reduce((sucet, polozka) => sucet + (polozka.sumaSpolu ?? 0), 0);
  const zostane = polozky.filter((polozka) => !vybrane.includes(polozka.id)).map((polozka) => polozka.id);

  async function rozdel() {
    setBusy(true);
    try {
      const novyId = await splitDocument(doklad.id, { polozkaIds: vybrane, typ, expectedVersion: doklad.version });
      showToast(t('rozdelenie.hotovo'));
      onSplit(novyId);
    } catch (cause) {
      showToast(cause instanceof Error && cause.message ? cause.message : t('chyba.vseobecna'), { tone: 'error' });
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal title={t('rozdelenie.titulok')} onClose={() => { if (!busy) onClose(); }}>
      <p className="mb-3 text-sm text-ink-soft">{t('rozdelenie.popis')}</p>

      <div className="mb-3 max-h-72 space-y-1 overflow-y-auto rounded-xl border border-line p-2">
        {polozky.map((polozka, index) => (
          <label key={polozka.id} className="flex cursor-pointer items-center gap-2 rounded-lg px-2 py-1.5 text-sm hover:bg-app">
            <input
              type="checkbox"
              checked={vybrane.includes(polozka.id)}
              onChange={(event) => setVybrane((doterajsie) => (event.target.checked
                ? [...doterajsie, polozka.id]
                : doterajsie.filter((id) => id !== polozka.id)))}
            />
            <span className="w-5 shrink-0 text-ink-faint">{index + 1}</span>
            <span className="min-w-0 flex-1 truncate">{polozka.popis || t('rozdelenie.bezTextu')}</span>
            <span className="tnum shrink-0 text-ink-soft">{fmtMoney(polozka.sumaSpolu ?? 0, doklad.extracted.mena)}</span>
          </label>
        ))}
      </div>

      <label className="block">
        <span className="label">{t('rozdelenie.typNoveho')}</span>
        <select className="input w-full" value={typ} onChange={(event) => setTyp(event.target.value as DocumentType)}>
          {TYPY.map((option) => (
            <option key={option} value={option}>
              {t(`typ.${option}` as SkKey)} — {t(`typ.${option}.dlhy` as SkKey)}
            </option>
          ))}
        </select>
      </label>

      <div className="mt-3 grid grid-cols-2 gap-2 text-sm">
        <div className="rounded-xl border border-line bg-app/40 p-2.5">
          <p className="text-xs text-ink-soft">{t('rozdelenie.ostane')}</p>
          <p className="tnum font-semibold">{fmtMoney(suma(zostane), doklad.extracted.mena)}</p>
          <p className="text-xs text-ink-faint">{zostane.length} {t('rozdelenie.poloziek')}</p>
        </div>
        <div className="rounded-xl border border-accent/40 bg-tint p-2.5">
          <p className="text-xs text-accent-hover">{t('rozdelenie.oddeli')}</p>
          <p className="tnum font-semibold text-accent-hover">{fmtMoney(suma(vybrane), doklad.extracted.mena)}</p>
          <p className="text-xs text-accent-hover/80">{vybrane.length} {t('rozdelenie.poloziek')}</p>
        </div>
      </div>

      {/* Server to isté kontroluje znova — tu ide o to, aby účtovník nekliknul zbytočne. */}
      {vybrane.length > 0 && zostane.length === 0 && (
        <p className="mt-2 text-xs text-amber-800">{t('rozdelenie.vsetkyPolozky')}</p>
      )}

      <div className="mt-4 flex justify-end gap-2">
        <button type="button" className="btn" disabled={busy} onClick={onClose}>{t('akcia.zrusit')}</button>
        <button
          type="button"
          className="btn btn-primary"
          disabled={busy || vybrane.length === 0 || zostane.length === 0}
          onClick={() => void rozdel()}
        >
          {busy ? t('stav.nacitavam') : t('rozdelenie.rozdelit')}
        </button>
      </div>
    </Modal>
  );
}

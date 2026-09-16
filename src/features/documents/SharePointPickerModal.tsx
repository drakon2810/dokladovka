// Okno „Nahrať zo SharePointu": obsah priečinka firmy, výber súborov, nahratie.
//
// Server už nesťahuje všetko, čo v priečinku pribudne — účtovník si tu vyberie.
// Súbor ostáva v „nespracované", kým jeho doklad neprejde do POHODY, preto má
// každý súbor stav: nový sa dá vybrať, nahratý a práve nahrávaný nie.
import { useCallback, useEffect, useMemo, useState } from 'react';
import { Modal } from '../../components/ui';
import { showToast } from '../../components/toast';
import {
  nacitajSharePointSubory,
  nahrajZoSharePointu,
  type SharePointSubor,
  type SharePointZdroj,
} from '../../data/api';
import type { Organization } from '../../data/types';
import { t, tv } from '../../i18n/sk';

function velkostText(bajty: number): string {
  if (bajty < 1024 * 1024) return `${Math.max(1, Math.round(bajty / 1024))} KB`;
  return `${(bajty / (1024 * 1024)).toFixed(1).replace('.', ',')} MB`;
}

function datumText(iso: string | null): string {
  if (!iso) return '';
  const kedy = new Date(iso);
  return `${kedy.getDate()}. ${kedy.getMonth() + 1}. ${kedy.getFullYear()}`;
}

export function SharePointPickerModal({ organization, onClose }: { organization: Organization; onClose: () => void }) {
  const [zdroj, setZdroj] = useState<SharePointZdroj>('nespracovane');
  const [subory, setSubory] = useState<SharePointSubor[]>();
  const [nastavene, setNastavene] = useState(true);
  const [chyba, setChyba] = useState('');
  const [hladanie, setHladanie] = useState('');
  const [vybrane, setVybrane] = useState<Set<string>>(new Set());
  const [odosiela, setOdosiela] = useState(false);

  const nacitaj = useCallback(async (priecinok: SharePointZdroj) => {
    setSubory(undefined);
    setChyba('');
    try {
      const data = await nacitajSharePointSubory(organization.id, priecinok);
      setNastavene(data.nastavene);
      setSubory(data.subory);
    } catch (error) {
      setChyba(error instanceof Error ? error.message : String(error));
      setSubory([]);
    }
  }, [organization.id]);

  // Iný priečinok = iné súbory; výber z predchádzajúcej karty nedáva zmysel.
  useEffect(() => {
    setVybrane(new Set());
    setHladanie('');
    void nacitaj(zdroj);
  }, [zdroj, nacitaj]);

  const zobrazene = useMemo(() => {
    const dopyt = hladanie.trim().toLocaleLowerCase('sk');
    return (subory ?? []).filter((subor) => !dopyt || subor.nazov.toLocaleLowerCase('sk').includes(dopyt));
  }, [subory, hladanie]);
  const vybratelne = zobrazene.filter((subor) => subor.stav === 'nove');
  const vsetkyVybrane = vybratelne.length > 0 && vybratelne.every((subor) => vybrane.has(subor.id));

  function prepni(id: string) {
    setVybrane((povodne) => {
      const dalsie = new Set(povodne);
      if (dalsie.has(id)) dalsie.delete(id); else dalsie.add(id);
      return dalsie;
    });
  }

  function prepniVsetky() {
    setVybrane((povodne) => {
      const dalsie = new Set(povodne);
      for (const subor of vybratelne) {
        if (vsetkyVybrane) dalsie.delete(subor.id); else dalsie.add(subor.id);
      }
      return dalsie;
    });
  }

  async function nahraj() {
    setOdosiela(true);
    setChyba('');
    try {
      const vysledok = await nahrajZoSharePointu(organization.id, zdroj, [...vybrane]);
      showToast(tv('sp.picker.odoslane', { pocet: String(vysledok.zaradene) }));
      onClose();
    } catch (error) {
      setChyba(error instanceof Error ? error.message : String(error));
      setOdosiela(false);
    }
  }

  return (
    <Modal title={`${t('sp.picker.titul')} — ${organization.nazov}`} onClose={onClose} wide>
      <div className="flex flex-col gap-3">
        <div className="flex gap-1 border-b border-line" role="tablist">
          {(['nespracovane', 'chybne'] as const).map((karta) => (
            <button
              key={karta}
              type="button"
              role="tab"
              aria-selected={zdroj === karta}
              onClick={() => setZdroj(karta)}
              className={`-mb-px border-b-2 px-3 py-2 text-sm font-medium ${
                zdroj === karta ? 'border-accent text-ink' : 'border-transparent text-ink-soft hover:text-ink'
              }`}
            >
              {t(karta === 'nespracovane' ? 'sp.picker.nespracovane' : 'sp.picker.chybne')}
            </button>
          ))}
        </div>

        {zdroj === 'chybne' && nastavene && <p className="text-xs text-ink-soft">{t('sp.picker.chybnePopis')}</p>}

        <div className="flex flex-wrap items-center gap-2">
          <input
            className="input min-w-0 flex-1"
            placeholder={t('sp.picker.hladat')}
            value={hladanie}
            onChange={(udalost) => setHladanie(udalost.target.value)}
          />
          <button type="button" className="btn" onClick={prepniVsetky} disabled={vybratelne.length === 0}>
            {t(vsetkyVybrane ? 'sp.picker.zrusitVyber' : 'sp.picker.oznacitVsetky')}
          </button>
          <button type="button" className="btn" onClick={() => void nacitaj(zdroj)} disabled={!subory}>
            {t('sp.picker.obnovit')}
          </button>
        </div>

        {chyba && <div className="rounded border border-rose-200 bg-rose-50 p-2 text-sm text-rose-800">{chyba}</div>}

        <div className="max-h-[50vh] min-h-[12rem] overflow-y-auto rounded border border-line">
          {!subory ? (
            <p className="p-4 text-sm text-ink-soft">{t('sp.picker.nacitavam')}</p>
          ) : !nastavene ? (
            <p className="p-4 text-sm text-ink-soft">{t('sp.picker.chybneNenastavene')}</p>
          ) : subory.length === 0 ? (
            !chyba && <p className="p-4 text-sm text-ink-soft">{t('sp.picker.prazdne')}</p>
          ) : zobrazene.length === 0 ? (
            <p className="p-4 text-sm text-ink-soft">{t('sp.picker.nicNeodpoveda')}</p>
          ) : (
            <ul>
              {zobrazene.map((subor) => {
                const volny = subor.stav === 'nove';
                return (
                  <li key={subor.id} className="border-b border-line last:border-0">
                    <label
                      className={`flex items-center gap-3 px-3 py-2 text-sm ${volny ? 'cursor-pointer hover:bg-tint' : 'opacity-60'}`}
                      title={subor.stav === 'nahrate' ? t('sp.picker.nahrateTooltip') : undefined}
                    >
                      <input
                        type="checkbox"
                        disabled={!volny}
                        checked={vybrane.has(subor.id)}
                        onChange={() => prepni(subor.id)}
                      />
                      <span className="min-w-0 flex-1 truncate">{subor.nazov}</span>
                      {!volny && (
                        <span className="shrink-0 rounded bg-tint px-1.5 py-0.5 text-xs text-ink-soft">
                          {t(subor.stav === 'nahrate' ? 'sp.picker.stavNahrate' : 'sp.picker.stavCaka')}
                        </span>
                      )}
                      <span className="w-20 shrink-0 text-right text-xs text-ink-soft tnum">{datumText(subor.upravene)}</span>
                      <span className="w-16 shrink-0 text-right text-xs text-ink-soft tnum">{velkostText(subor.velkost)}</span>
                    </label>
                  </li>
                );
              })}
            </ul>
          )}
        </div>

        <div className="flex items-center justify-end gap-2">
          <button type="button" className="btn" onClick={onClose}>{t('akcia.zrusit')}</button>
          <button
            type="button"
            className="btn btn-primary"
            disabled={vybrane.size === 0 || odosiela}
            onClick={() => void nahraj()}
          >
            {t('sp.picker.nahrat')}{vybrane.size > 0 ? ` (${vybrane.size})` : ''}
          </button>
        </div>
      </div>
    </Modal>
  );
}

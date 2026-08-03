import { useEffect, useState } from 'react';
import {
  analyzeUctoProfil, backfillUctoHistory, getUctoHistoryStats, listUctoKategorie,
  type UctoHistoryStats, type UctoKategoria,
} from '../../data/api';
import { showToast } from '../../components/toast';
import { t } from '../../i18n/sk';

// Účtovný profil firmy: korpus histórie z POHODY a kategórie plnení, ktoré
// z neho vzniknú jednorazovou analýzou. Kategória hovorí, ČO sa kupuje a ako to
// firma účtuje — preto funguje aj pre dodávateľa, ktorý v histórii nikdy nebol.

export function UctovnyProfil({ orgId }: { orgId: string }) {
  const [stats, setStats] = useState<UctoHistoryStats>();
  const [kategorie, setKategorie] = useState<UctoKategoria[]>([]);
  const [busy, setBusy] = useState<'backfill' | 'analyza'>();

  async function obnov() {
    const [nasledujuce, zoznam] = await Promise.all([
      getUctoHistoryStats(orgId).catch(() => undefined),
      listUctoKategorie(orgId).catch(() => []),
    ]);
    setStats(nasledujuce);
    setKategorie(zoznam);
  }

  useEffect(() => {
    let active = true;
    setStats(undefined);
    setKategorie([]);
    void Promise.all([
      getUctoHistoryStats(orgId).catch(() => undefined),
      listUctoKategorie(orgId).catch(() => []),
    ]).then(([nasledujuce, zoznam]) => {
      if (!active) return;
      setStats(nasledujuce);
      setKategorie(zoznam);
    });
    return () => {
      active = false;
    };
  }, [orgId]);

  async function spusti(akcia: 'backfill' | 'analyza') {
    setBusy(akcia);
    try {
      if (akcia === 'backfill') {
        const { imported } = await backfillUctoHistory(orgId);
        showToast(`${t('uctoProfil.preklopene')} (${imported})`);
      } else {
        const vysledok = await analyzeUctoProfil(orgId);
        showToast(`${t('uctoProfil.analyzaHotova')} (${vysledok.kategorii})`);
      }
      await obnov();
    } catch (cause) {
      showToast(cause instanceof Error ? cause.message : t('chyba.vseobecna'), { tone: 'error' });
    } finally {
      setBusy(undefined);
    }
  }

  return (
    <section className="card space-y-3 p-4">
      <div>
        <p className="font-medium text-ink">{t('uctoProfil.titulok')}</p>
        <p className="mt-0.5 text-[13px] text-ink-soft">{t('uctoProfil.popis')}</p>
      </div>

      <div className="flex flex-wrap gap-4 text-[13px]">
        <span>
          {t('uctoProfil.riadkov')}: <b className="tnum">{stats?.spolu ?? 0}</b>
        </span>
        <span>
          {t('uctoProfil.dodavatelov')}: <b className="tnum">{stats?.dodavatelov ?? 0}</b>
        </span>
        <span>
          {t('uctoProfil.roznychTextov')}: <b className="tnum">{stats?.roznychTextov ?? 0}</b>
        </span>
        {stats?.podlaAgendy.map((agenda) => (
          <span key={agenda.agenda} className="rounded-md border border-line px-1.5 py-0.5 text-[11.5px] text-ink-soft">
            {agenda.agenda} <b className="tnum">{agenda.pocet}</b>
          </span>
        ))}
      </div>

      <div className="flex flex-wrap gap-2">
        <button type="button" className="btn" disabled={busy !== undefined} onClick={() => void spusti('backfill')}>
          {busy === 'backfill' ? t('stav.nacitavam') : t('uctoProfil.preklopit')}
        </button>
        <button type="button" className="btn btn-primary" disabled={busy !== undefined || (stats?.spolu ?? 0) < 5}
          onClick={() => void spusti('analyza')}>
          {busy === 'analyza' ? t('uctoProfil.analyzujem') : t('uctoProfil.spustitAnalyzu')}
        </button>
      </div>

      {kategorie.length === 0 ? (
        <p className="text-[13px] text-ink-soft">{t('uctoProfil.ziadneKategorie')}</p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-line text-left text-xs text-ink-soft">
                <th className="px-2 py-2 font-medium">{t('uctoProfil.st.kategoria')}</th>
                <th className="px-2 py-2 font-medium">{t('uctoProfil.st.slovnik')}</th>
                <th className="px-2 py-2 font-medium">{t('uctoProfil.st.ucet')}</th>
                <th className="px-2 py-2 font-medium">{t('uctoProfil.st.dph')}</th>
                <th className="px-2 py-2 text-right font-medium">{t('uctoProfil.st.pocet')}</th>
              </tr>
            </thead>
            <tbody>
              {kategorie.map((kategoria) => (
                <tr key={kategoria.id} className="border-b border-line-soft last:border-0 align-top">
                  <td className="px-2 py-2">
                    <span className="font-medium text-ink">{kategoria.nazov}</span>
                    {kategoria.popis && <span className="block text-[12px] text-ink-faint">{kategoria.popis}</span>}
                    {kategoria.konflikt && (
                      <span className="mt-1 block rounded-md bg-amber-50 px-1.5 py-0.5 text-[11.5px] text-amber-800">
                        {kategoria.konflikt}
                      </span>
                    )}
                  </td>
                  <td className="max-w-[260px] px-2 py-2 text-[12px] text-ink-soft">{kategoria.slovnik.join(', ')}</td>
                  <td className="tnum px-2 py-2">{kategoria.predkontaciaKod ?? '—'}</td>
                  <td className="tnum px-2 py-2">
                    {kategoria.clenenieDphKod ?? '—'}
                    {kategoria.clenenieKvKod && <span className="text-ink-faint"> · KV {kategoria.clenenieKvKod}</span>}
                  </td>
                  <td className="tnum px-2 py-2 text-right">{kategoria.pocet}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

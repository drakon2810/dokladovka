import { useEffect, useState } from 'react';
import {
  UCTO_AGENDA_NAZOV, UCTO_AGENDY,
  analyzeUctoProfil, backfillUctoHistory, deleteUctoKategoria, getUctoHistoryStats,
  listUctoKategorie, updateUctoKategoria,
  type UctoHistoryStats, type UctoKategoria,
} from '../../data/api';
import { useDataQuery } from '../../data/query';
import { CLENENIE_KV_KODY } from '../../data/types';
import { showToast } from '../../components/toast';
import { t } from '../../i18n/sk';

// Účtovný profil firmy: korpus histórie z POHODY a kategórie plnení, ktoré
// z neho vzniknú jednorazovou analýzou. Kategória hovorí, ČO sa kupuje a ako to
// firma účtuje — preto funguje aj pre dodávateľa, ktorý v histórii nikdy nebol.
// Kategórie sa dajú po analýze ručne doladiť — oprava názvu či kódu nesmie
// nútiť púšťať celú analýzu znova.

/** Rozpísaná úprava jednej kategórie — kódy a slovník ako text z formulára. */
interface KategoriaUprava {
  id: string;
  nazov: string;
  popis: string;
  slovnik: string;
  predkontaciaKod: string;
  clenenieDphKod: string;
  clenenieKvKod: string;
}

export function UctovnyProfil({ orgId }: { orgId: string }) {
  const { data } = useDataQuery();
  const [stats, setStats] = useState<UctoHistoryStats>();
  const [kategorie, setKategorie] = useState<UctoKategoria[]>([]);
  const [busy, setBusy] = useState<'backfill' | 'analyza' | 'kategoria'>();
  const [uprava, setUprava] = useState<KategoriaUprava>();
  /** Vybraná agenda, alebo undefined pre všetky — pokladňa sa účtuje inak než faktúry. */
  const [agenda, setAgenda] = useState<string>();

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
    setUprava(undefined);
    setAgenda(undefined);
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
    // Analýza je prepočet celého profilu — ručné úpravy aj zmazania kategórií
    // sa ňou stratia, tak sa to nesmie stať potichu.
    if (akcia === 'analyza' && kategorie.length > 0 && !window.confirm(t('uctoProfil.analyzaPrepise'))) return;
    setUprava(undefined);
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

  function zacniUpravu(kategoria: UctoKategoria) {
    setUprava({
      id: kategoria.id,
      nazov: kategoria.nazov,
      popis: kategoria.popis ?? '',
      slovnik: kategoria.slovnik.join(', '),
      predkontaciaKod: kategoria.predkontaciaKod ?? '',
      clenenieDphKod: kategoria.clenenieDphKod ?? '',
      clenenieKvKod: kategoria.clenenieKvKod ?? '',
    });
  }

  async function ulozUpravu() {
    if (!uprava) return;
    const slovnik = uprava.slovnik.split(',').map((slovo) => slovo.trim()).filter(Boolean);
    if (!uprava.nazov.trim() || slovnik.length === 0) {
      showToast(t('uctoProfil.kategoriaChybaPovinne'), { tone: 'error' });
      return;
    }
    // Limity servera (kategoriaZmenaSchema) — bez tejto kontroly by prišla len
    // všeobecná chyba „neplatné údaje" bez náznaku, ktoré slovo je zlé.
    if (slovnik.length > 30 || slovnik.some((slovo) => slovo.length > 40)) {
      showToast(t('uctoProfil.slovnikLimit'), { tone: 'error' });
      return;
    }
    setBusy('kategoria');
    try {
      const upravena = await updateUctoKategoria(orgId, uprava.id, {
        nazov: uprava.nazov.trim(),
        popis: uprava.popis.trim() || null,
        slovnik,
        predkontaciaKod: uprava.predkontaciaKod.trim() || null,
        clenenieDphKod: uprava.clenenieDphKod.trim() || null,
        clenenieKvKod: uprava.clenenieKvKod || null,
      });
      setKategorie((zoznam) => zoznam.map((item) => (item.id === upravena.id ? upravena : item)));
      setUprava(undefined);
      showToast(t('uctoProfil.kategoriaUlozena'));
    } catch (cause) {
      showToast(cause instanceof Error ? cause.message : t('chyba.vseobecna'), { tone: 'error' });
    } finally {
      setBusy(undefined);
    }
  }

  async function zmazKategoriu(kategoria: UctoKategoria) {
    if (!window.confirm(t('uctoProfil.kategoriaZmazatPotvrdenie'))) return;
    setBusy('kategoria');
    try {
      await deleteUctoKategoria(orgId, kategoria.id);
      setKategorie((zoznam) => zoznam.filter((item) => item.id !== kategoria.id));
      if (uprava?.id === kategoria.id) setUprava(undefined);
      showToast(t('uctoProfil.kategoriaZmazana'));
    } catch (cause) {
      showToast(cause instanceof Error ? cause.message : t('chyba.vseobecna'), { tone: 'error' });
    } finally {
      setBusy(undefined);
    }
  }

  // Kódy číselníkov firmy pre našepkávanie pri úprave (natívny datalist).
  // „BEZ…" predkontácie sa nenašepkávajú — server ich pri úprave odmieta.
  // Rozdelenie podľa agendy. Kategória bez agend (staršia analýza) sa skryť
  // nesmie — inak by po filtri vyzeral profil prázdny a účtovník by nevedel prečo.
  const vAgende = (kategoria: UctoKategoria) =>
    !agenda || kategoria.agendy.length === 0 || kategoria.agendy.includes(agenda);
  const vidielne = kategorie.filter(vAgende);
  const pocetVAgende = (kod: string) =>
    kategorie.filter((kategoria) => kategoria.agendy.includes(kod)).length;

  const kodyPre = (kind: 'predkontacie' | 'cleneniaDph'): string[] =>
    (data?.codeLists[kind] ?? [])
      .filter((item) => item.orgId === orgId && item.active)
      .map((item) => item.kod)
      .filter((kod) => kind !== 'predkontacie' || !kod.trim().toUpperCase().startsWith('BEZ'));

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
        {stats?.podlaAgendy.map((riadok) => (
          <span
            key={riadok.agenda}
            title={UCTO_AGENDA_NAZOV[riadok.agenda] ?? riadok.agenda}
            className="rounded-md border border-line px-1.5 py-0.5 text-[11.5px] text-ink-soft"
          >
            {riadok.agenda} <b className="tnum">{riadok.pocet}</b>
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
          {/* Rozdelenie podľa agendy — pokladničný výdaj a prijatá faktúra sa
              účtujú inak, tak nech si ich účtovník vie pozrieť oddelene. */}
          <div className="mb-2 flex flex-wrap gap-1.5">
            <button
              type="button"
              className={`btn px-2.5 py-1 text-xs${agenda === undefined ? ' btn-primary' : ''}`}
              onClick={() => { setAgenda(undefined); setUprava(undefined); }}
            >
              {t('uctoProfil.agendaVsetky')} <span className="tnum">{kategorie.length}</span>
            </button>
            {UCTO_AGENDY.map((kod) => (
              <button
                key={kod}
                type="button"
                title={UCTO_AGENDA_NAZOV[kod]}
                disabled={pocetVAgende(kod) === 0}
                className={`btn px-2.5 py-1 text-xs${agenda === kod ? ' btn-primary' : ''}`}
                onClick={() => { setAgenda(kod); setUprava(undefined); }}
              >
                {kod} <span className="tnum">{pocetVAgende(kod)}</span>
              </button>
            ))}
          </div>
          <datalist id="ucto-profil-predkontacie">
            {kodyPre('predkontacie').map((kod) => <option key={kod} value={kod} />)}
          </datalist>
          <datalist id="ucto-profil-clenenia">
            {kodyPre('cleneniaDph').map((kod) => <option key={kod} value={kod} />)}
          </datalist>
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-line text-left text-xs text-ink-soft">
                <th className="px-2 py-2 font-medium">{t('uctoProfil.st.kategoria')}</th>
                <th className="px-2 py-2 font-medium">{t('uctoProfil.st.slovnik')}</th>
                <th className="px-2 py-2 font-medium">{t('uctoProfil.st.ucet')}</th>
                <th className="px-2 py-2 font-medium">{t('uctoProfil.st.dph')}</th>
                <th className="px-2 py-2 text-right font-medium">{t('uctoProfil.st.pocet')}</th>
                <th className="px-2 py-2" />
              </tr>
            </thead>
            <tbody>
              {vidielne.length === 0 && (
                <tr><td colSpan={6} className="px-2 py-3 text-[13px] text-ink-soft">
                  {t('uctoProfil.ziadneVAgende')}
                </td></tr>
              )}
              {vidielne.map((kategoria) => (
                uprava?.id === kategoria.id ? (
                  <tr key={kategoria.id} className="border-b border-line-soft align-top last:border-0">
                    <td className="px-2 py-2">
                      <input
                        className="input w-full"
                        value={uprava.nazov}
                        maxLength={80}
                        aria-label={t('uctoProfil.st.kategoria')}
                        onChange={(event) => setUprava({ ...uprava, nazov: event.target.value })}
                      />
                      <input
                        className="input mt-1 w-full text-[12px]"
                        value={uprava.popis}
                        maxLength={300}
                        placeholder={t('uctoProfil.popisPlaceholder')}
                        onChange={(event) => setUprava({ ...uprava, popis: event.target.value })}
                      />
                    </td>
                    <td className="px-2 py-2">
                      <textarea
                        className="input h-20 w-full min-w-[200px] text-[12px]"
                        value={uprava.slovnik}
                        aria-label={t('uctoProfil.st.slovnik')}
                        placeholder={t('uctoProfil.slovnikPlaceholder')}
                        onChange={(event) => setUprava({ ...uprava, slovnik: event.target.value })}
                      />
                    </td>
                    <td className="px-2 py-2">
                      <input
                        className="input w-36"
                        list="ucto-profil-predkontacie"
                        value={uprava.predkontaciaKod}
                        aria-label={t('uctoProfil.st.ucet')}
                        onChange={(event) => setUprava({ ...uprava, predkontaciaKod: event.target.value })}
                      />
                    </td>
                    <td className="px-2 py-2">
                      <input
                        className="input w-28"
                        list="ucto-profil-clenenia"
                        value={uprava.clenenieDphKod}
                        aria-label={t('uctoProfil.st.dph')}
                        onChange={(event) => setUprava({ ...uprava, clenenieDphKod: event.target.value })}
                      />
                      <select
                        className="input mt-1 w-28"
                        value={uprava.clenenieKvKod}
                        aria-label="KV"
                        onChange={(event) => setUprava({ ...uprava, clenenieKvKod: event.target.value })}
                      >
                        <option value="">{t('uctoProfil.kvZiadne')}</option>
                        {CLENENIE_KV_KODY.map((kod) => <option key={kod} value={kod}>{kod}</option>)}
                      </select>
                    </td>
                    <td colSpan={2} className="px-2 py-2">
                      <div className="flex flex-col items-end gap-1.5">
                        <button type="button" className="btn btn-primary px-2.5 py-1 text-xs" disabled={busy !== undefined}
                          onClick={() => void ulozUpravu()}>
                          {t('akcia.ulozit')}
                        </button>
                        <button type="button" className="btn px-2.5 py-1 text-xs" disabled={busy !== undefined}
                          onClick={() => setUprava(undefined)}>
                          {t('akcia.zrusit')}
                        </button>
                        <button type="button" className="btn px-2.5 py-1 text-xs" disabled={busy !== undefined}
                          onClick={() => void zmazKategoriu(kategoria)}>
                          {t('pravidla.zmazat')}
                        </button>
                      </div>
                    </td>
                  </tr>
                ) : (
                  <tr key={kategoria.id} className="border-b border-line-soft align-top last:border-0">
                    <td className="px-2 py-2">
                      <span className="font-medium text-ink">{kategoria.nazov}</span>
                      {/* V pohľade „všetky" nie je inak vidieť, do ktorých agend kategória patrí. */}
                      {agenda === undefined && kategoria.agendy.length > 0 && (
                        <span
                          className="ml-1.5 text-[11px] text-ink-faint"
                          title={kategoria.agendy.map((kod) => UCTO_AGENDA_NAZOV[kod] ?? kod).join(', ')}
                        >
                          {kategoria.agendy.join(' · ')}
                        </span>
                      )}
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
                    <td className="px-2 py-2 text-right">
                      <button type="button" className="btn px-2.5 py-1 text-xs" disabled={busy !== undefined}
                        onClick={() => zacniUpravu(kategoria)}>
                        {t('akcia.upravit')}
                      </button>
                    </td>
                  </tr>
                )
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

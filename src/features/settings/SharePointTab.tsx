// Nastavenie príjmu dokladov zo SharePointu.
//
// Pripojenie je jedno na celú kanceláriu (účtovník sa prihlási svojím kontom),
// priečinky sa priraďujú firme po firme. Priečinok sa nevyberá zo stromu, ale
// vložením adresy — skopírovať ju z prehliadača vie každý a ušetrí to celý
// prehliadač sitov a knižníc, ktorý by inak bolo treba postaviť.
import { useCallback, useEffect, useState, type FormEvent } from 'react';
import {
  disconnectSharePoint,
  loadSharePointState,
  removeSharePointFolders,
  saveSharePointFolders,
  startSharePointLogin,
  type SharePointState,
} from '../../data/api';
import { useDataQuery } from '../../data/query';
import type { Organization } from '../../data/types';
import { ConfirmDialog, Modal, OrgDot } from '../../components/ui';
import { showToast } from '../../components/toast';
import { t } from '../../i18n/sk';

function datum(hodnota: string | null): string {
  if (!hodnota) return t('sp.nikdy');
  return new Date(hodnota).toLocaleString('sk-SK', { dateStyle: 'short', timeStyle: 'short' });
}

export function SharePointTab() {
  const { data } = useDataQuery();
  const [stav, setStav] = useState<SharePointState>();
  const [dialog, setDialog] = useState<Organization>();
  const [odpojit, setOdpojit] = useState(false);
  const [zrusit, setZrusit] = useState<Organization>();
  const [busy, setBusy] = useState(false);

  const nacitaj = useCallback(async () => {
    try {
      setStav(await loadSharePointState());
    } catch {
      setStav({ configured: false, connection: null, folders: [] });
    }
  }, []);

  useEffect(() => { void nacitaj(); }, [nacitaj]);

  // Návrat z prihlásenia u Microsoftu: server presmeruje späť s ?sharepoint=…
  // Bez tohto by účtovník po prihlásení videl starý stav a myslel si, že to
  // nevyšlo.
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const vysledok = params.get('sharepoint');
    if (!vysledok) return;
    showToast(vysledok === 'ok' ? t('sp.pripojene') : vysledok, { tone: vysledok === 'ok' ? 'success' : 'error' });
    params.delete('sharepoint');
    window.history.replaceState({}, '', `${window.location.pathname}?${params}`);
    void nacitaj();
  }, [nacitaj]);

  if (!stav) return <p className="text-sm text-ink-soft">{t('stav.nacitavam')}</p>;

  if (!stav.configured) {
    return (
      <div className="space-y-4">
        <p className="text-sm text-ink-soft">{t('sp.popis')}</p>
        <p className="rounded bg-app p-3 text-sm text-ink-soft">{t('sp.nenakonfigurovane')}</p>
      </div>
    );
  }

  const organizacie = data?.organizations ?? [];
  const podlaFirmy = new Map(stav.folders.map((f) => [f.organizationId, f]));

  return (
    <div className="space-y-4">
      <p className="text-sm text-ink-soft">{t('sp.popis')}</p>

      <section className="card p-4">
        {stav.connection ? (
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <p className="text-sm">
                <strong>{t('sp.pripojeneAko')}</strong> {stav.connection.accountEmail}
                {stav.connection.accountName ? ` (${stav.connection.accountName})` : ''}
              </p>
              <p className="text-xs text-ink-soft">
                {t('sp.pripojeneDna')} {datum(stav.connection.connectedAt)}
              </p>
              {stav.connection.lastError && (
                <p className="mt-2 rounded bg-red-50 p-2 text-sm text-red-700">{t('sp.pripojenieChyba')}</p>
              )}
            </div>
            <button type="button" className="btn" onClick={() => setOdpojit(true)}>{t('sp.odpojit')}</button>
          </div>
        ) : (
          <div className="flex flex-wrap items-center justify-between gap-3">
            <p className="max-w-xl text-sm text-ink-soft">{t('sp.pripojitPopis')}</p>
            <button
              type="button" className="btn btn-primary" disabled={busy}
              onClick={async () => {
                setBusy(true);
                try {
                  window.location.href = await startSharePointLogin();
                } catch {
                  showToast(t('chyba.vseobecna'), { tone: 'error' });
                  setBusy(false);
                }
              }}
            >
              {t('sp.pripojit')}
            </button>
          </div>
        )}
      </section>

      {stav.connection && (
        <section className="card p-4">
          <h2 className="mb-3 text-sm font-semibold">{t('sp.firmy')}</h2>
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left text-xs text-ink-soft">
                <th className="pb-2">{t('sp.firma')}</th>
                <th className="pb-2">{t('sp.stav')}</th>
                <th className="pb-2">{t('sp.poslednyPrechod')}</th>
                <th className="pb-2" />
              </tr>
            </thead>
            <tbody>
              {organizacie.map((org) => {
                const nastavene = podlaFirmy.get(org.id);
                return (
                  <tr key={org.id} className="border-t border-line">
                    <td className="py-2">
                      <span className="flex items-center gap-2"><OrgDot org={org} />{org.nazov}</span>
                    </td>
                    <td className="py-2">
                      {nastavene
                        ? <span className="text-emerald-700">{t('sp.nastavit')} ✓</span>
                        : <span className="text-ink-soft">{t('sp.nenastavene')}</span>}
                      {nastavene?.lastError && (
                        <span className="ml-2 text-red-700">{nastavene.lastError}</span>
                      )}
                    </td>
                    <td className="py-2 text-ink-soft">{nastavene ? datum(nastavene.lastPollAt) : '—'}</td>
                    <td className="py-2 text-right">
                      <button type="button" className="btn" onClick={() => setDialog(org)}>
                        {nastavene ? t('sp.upravit') : t('sp.nastavit')}
                      </button>
                      {nastavene && (
                        <button type="button" className="btn ml-2" onClick={() => setZrusit(org)}>
                          {t('sp.zrusit')}
                        </button>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </section>
      )}

      {dialog && (
        <PriecinkyDialog
          org={dialog}
          onClose={() => setDialog(undefined)}
          onSaved={async () => { setDialog(undefined); await nacitaj(); }}
        />
      )}

      {odpojit && (
        <ConfirmDialog
          title={t('sp.odpojitOtazka')}
          text={t('sp.odpojitPopis')}
          danger
          onClose={() => setOdpojit(false)}
          onConfirm={() => {
            setOdpojit(false);
            void disconnectSharePoint().then(nacitaj);
          }}
        />
      )}

      {zrusit && (
        <ConfirmDialog
          title={t('sp.zrusitOtazka')}
          text={t('sp.zrusitPopis')}
          onClose={() => setZrusit(undefined)}
          onConfirm={() => {
            const org = zrusit;
            setZrusit(undefined);
            void removeSharePointFolders(org.id).then(nacitaj);
          }}
        />
      )}
    </div>
  );
}

function PriecinkyDialog({ org, onClose, onSaved }: {
  org: Organization;
  onClose(): void;
  onSaved(): Promise<void>;
}) {
  const [nespracovane, setNespracovane] = useState('');
  const [spracovane, setSpracovane] = useState('');
  const [chybne, setChybne] = useState('');
  const [busy, setBusy] = useState(false);
  const [chyba, setChyba] = useState<string>();

  async function odosli(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setChyba(undefined);
    try {
      const nazvy = await saveSharePointFolders({
        organizationId: org.id,
        nespracovaneUrl: nespracovane.trim(),
        spracovaneUrl: spracovane.trim(),
        chybneUrl: chybne.trim() || undefined,
      });
      showToast(`${t('sp.ulozene')}: ${nazvy.nespracovane} → ${nazvy.spracovane}`, { tone: 'success' });
      await onSaved();
    } catch (error) {
      setChyba(error instanceof Error ? error.message : t('chyba.vseobecna'));
      setBusy(false);
    }
  }

  return (
    <Modal title={`${t('sp.dialogNazov')} — ${org.nazov}`} onClose={onClose}>
      <form className="space-y-3" onSubmit={odosli}>
        <p className="text-sm text-ink-soft">{t('sp.dialogPopis')}</p>
        <label className="block">
          <span className="text-sm font-medium">{t('sp.nespracovane')}</span>
          <input
            className="input mt-1 w-full" required type="url" value={nespracovane}
            onChange={(event) => setNespracovane(event.target.value)}
            placeholder="https://firma.sharepoint.com/sites/…/Doklady/nespracovane"
          />
        </label>
        <label className="block">
          <span className="text-sm font-medium">{t('sp.spracovane')}</span>
          <input
            className="input mt-1 w-full" required type="url" value={spracovane}
            onChange={(event) => setSpracovane(event.target.value)}
          />
        </label>
        <label className="block">
          <span className="text-sm font-medium">{t('sp.chybne')}</span>
          <input
            className="input mt-1 w-full" type="url" value={chybne}
            onChange={(event) => setChybne(event.target.value)}
          />
          <span className="mt-1 block text-xs text-ink-soft">{t('sp.chybnePopis')}</span>
        </label>
        {chyba && <p className="rounded bg-red-50 p-2 text-sm text-red-700">{chyba}</p>}
        <div className="flex justify-end gap-2 pt-2">
          <button type="button" className="btn" onClick={onClose} disabled={busy}>{t('akcia.zrusit')}</button>
          <button type="submit" className="btn btn-primary" disabled={busy}>
            {busy ? t('sp.overujem') : t('sp.overit')}
          </button>
        </div>
      </form>
    </Modal>
  );
}

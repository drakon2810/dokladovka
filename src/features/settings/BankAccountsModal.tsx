import { useState } from 'react';
import type { Organization } from '../../data/types';
import {
  createBankAccount,
  disableBankAccount,
  updateBankAccount,
} from '../../data/api';
import { useDataQuery } from '../../data/query';
import { Modal } from '../../components/ui';
import { showToast } from '../../components/toast';
import { t } from '../../i18n/sk';

export function BankAccountsModal({
  organization,
  onClose,
}: {
  organization: Organization;
  onClose: () => void;
}) {
  const data = useDataQuery().data;
  const accounts = (data?.bankAccounts ?? []).filter(
    (account) => account.organizationId === organization.id && account.active,
  );
  const [label, setLabel] = useState('Hlavný účet');
  const [iban, setIban] = useState('');
  const [bic, setBic] = useState('');
  const [currency, setCurrency] = useState<'EUR' | 'CZK' | 'USD'>('EUR');
  const [isDefault, setIsDefault] = useState(accounts.length === 0);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setSaving(true);
    setError('');
    try {
      await createBankAccount({
        organizationId: organization.id,
        label,
        iban,
        bic: bic || undefined,
        currency,
        isDefault,
      });
      setIban('');
      setBic('');
      setIsDefault(false);
      showToast(t('toast.ucetUlozeny'));
    } catch {
      setError(t('nast.banka.chyba'));
    } finally {
      setSaving(false);
    }
  }

  return (
    <Modal title={`${t('nast.banka.titulok')}: ${organization.nazov}`} onClose={onClose} wide>
      <div className="space-y-3">
        {accounts.length === 0 ? (
          <p className="rounded border border-line bg-app p-3 text-sm text-ink-soft">{t('nast.banka.ziadne')}</p>
        ) : (
          accounts.map((account) => (
            <div key={account.id} className="flex flex-wrap items-center gap-3 rounded border border-line p-3 text-sm">
              <div className="min-w-0 flex-1">
                <p className="font-medium">
                  {account.label}
                  {account.isDefault && (
                    <span className="ml-2 rounded bg-accent/10 px-1.5 py-0.5 text-xs text-accent">
                      {t('nast.banka.predvoleny')}
                    </span>
                  )}
                </p>
                <p className="tnum mt-1 break-all text-xs text-ink-soft">
                  {account.iban}{account.bic ? ` · ${account.bic}` : ''} · {account.currency}
                </p>
              </div>
              {!account.isDefault && (
                <button
                  type="button"
                  className="btn px-2 py-1 text-xs"
                  onClick={() => void updateBankAccount(account.id, { isDefault: true })}
                >
                  {t('nast.banka.nastavitPredvoleny')}
                </button>
              )}
              <button
                type="button"
                className="btn btn-danger px-2 py-1 text-xs"
                onClick={() => void disableBankAccount(account.id)}
              >
                {t('nast.banka.vypnut')}
              </button>
            </div>
          ))
        )}
      </div>

      <form onSubmit={submit} className="mt-5 border-t border-line pt-4">
        <h3 className="mb-3 text-sm font-semibold">{t('nast.banka.pridat')}</h3>
        <div className="grid gap-3 md:grid-cols-2">
          <label>
            <span className="label">{t('nast.banka.nazov')}</span>
            <input className="input" required value={label} onChange={(event) => setLabel(event.target.value)} />
          </label>
          <label>
            <span className="label">{t('nast.banka.mena')}</span>
            <select className="input" value={currency} onChange={(event) => setCurrency(event.target.value as typeof currency)}>
              <option value="EUR">EUR</option>
              <option value="CZK">CZK</option>
              <option value="USD">USD</option>
            </select>
          </label>
          <label>
            <span className="label">{t('nast.banka.iban')}</span>
            <input className="input tnum" required value={iban} onChange={(event) => setIban(event.target.value)} placeholder="SK…" />
          </label>
          <label>
            <span className="label">{t('nast.banka.bic')}</span>
            <input className="input tnum" value={bic} onChange={(event) => setBic(event.target.value)} placeholder="TATRSKBX" />
          </label>
        </div>
        <label className="mt-3 flex items-center gap-2 text-sm">
          <input type="checkbox" checked={isDefault} onChange={(event) => setIsDefault(event.target.checked)} />
          {t('nast.banka.predvoleny')}
        </label>
        {error && <p className="mt-3 rounded border border-red-200 bg-red-50 p-2 text-sm text-red-700">{error}</p>}
        <div className="mt-4 flex justify-end gap-2">
          <button type="button" className="btn" onClick={onClose}>{t('akcia.zatvorit')}</button>
          <button type="submit" className="btn btn-primary" disabled={saving}>
            {saving ? t('stav.nacitavam') : t('nast.banka.pridat')}
          </button>
        </div>
      </form>
    </Modal>
  );
}

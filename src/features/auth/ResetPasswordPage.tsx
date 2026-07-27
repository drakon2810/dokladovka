import { useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { t } from '../../i18n/sk';
import { AuthApiError, resetPassword } from './authApi';
import { AuthShell, Field, FormError, FormInfo, inputCls, linkBtnCls, primaryBtnCls } from './authUi';

export function ResetPasswordPage() {
  const token = useSearchParams()[0].get('token') ?? '';
  const [password, setPassword] = useState('');
  const [passwordAgain, setPasswordAgain] = useState('');
  const [done, setDone] = useState(false);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    if (password !== passwordAgain) {
      setError(t('auth.hesloNesedi'));
      return;
    }
    setError('');
    setBusy(true);
    try {
      await resetPassword({ token, password });
      setDone(true);
    } catch (cause) {
      setError(cause instanceof AuthApiError ? cause.message : t('auth.nedostupne'));
    } finally {
      setBusy(false);
    }
  }

  return (
    <AuthShell title={t('auth.noveHesloTitul')}>
      {done || !token ? (
        <div className="flex flex-col gap-5">
          {done ? <FormInfo>{t('auth.noveHesloHotovo')}</FormInfo> : <FormError>{t('auth.odkazNeplatny')}</FormError>}
          <Link to={done ? '/login' : '/zabudnute-heslo'} className={linkBtnCls}>
            {done ? t('auth.spatNaPrihlasenie') : t('auth.obnovaOdoslat')}
          </Link>
        </div>
      ) : (
        <form onSubmit={submit} className="flex flex-col" style={{ gap: 18 }}>
          <Field label={t('auth.noveHeslo')}>
            <input
              className={inputCls}
              type="password"
              autoComplete="new-password"
              required
              minLength={10}
              autoFocus
              value={password}
              onChange={(event) => setPassword(event.target.value)}
            />
          </Field>
          <p className="-mt-2 text-xs text-ink-soft">{t('auth.hesloPoziadavka')}</p>
          <Field label={t('auth.hesloZnova')}>
            <input
              className={inputCls}
              type="password"
              autoComplete="new-password"
              required
              minLength={10}
              value={passwordAgain}
              onChange={(event) => setPasswordAgain(event.target.value)}
            />
          </Field>

          {error && <FormError>{error}</FormError>}

          <button type="submit" className={primaryBtnCls} disabled={busy}>
            {busy ? t('stav.nacitavam') : t('auth.noveHesloUlozit')}
          </button>
          <Link to="/login" className={linkBtnCls}>
            {t('auth.spatNaPrihlasenie')}
          </Link>
        </form>
      )}
    </AuthShell>
  );
}

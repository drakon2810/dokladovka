import { useState } from 'react';
import { Link } from 'react-router-dom';
import { t } from '../../i18n/sk';
import { AuthApiError, requestPasswordReset } from './authApi';
import { AuthShell, Field, FormError, FormInfo, Turnstile, inputCls, linkBtnCls, primaryBtnCls } from './authUi';

export function ForgotPasswordPage() {
  const [email, setEmail] = useState('');
  const [captchaToken, setCaptchaToken] = useState('');
  const [captchaReset, setCaptchaReset] = useState(0);
  const [sent, setSent] = useState(false);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setError('');
    setBusy(true);
    try {
      await requestPasswordReset({ email, captchaToken });
      setSent(true);
    } catch (cause) {
      setError(cause instanceof AuthApiError ? cause.message : t('auth.nedostupne'));
      // Spotrebovaný token vymeníme, inak by druhý pokus zlyhal na captchu.
      setCaptchaToken('');
      setCaptchaReset((value) => value + 1);
    } finally {
      setBusy(false);
    }
  }

  return (
    <AuthShell title={t('auth.obnovaTitul')}>
      {sent ? (
        <div className="flex flex-col gap-5">
          <FormInfo>{t('auth.obnovaOdoslane')}</FormInfo>
          <Link to="/login" className={linkBtnCls}>
            {t('auth.spatNaPrihlasenie')}
          </Link>
        </div>
      ) : (
        <form onSubmit={submit} className="flex flex-col" style={{ gap: 18 }}>
          <p className="-mt-2 text-sm leading-relaxed text-ink-soft">{t('auth.obnovaPopis')}</p>
          <Field label={t('auth.email')}>
            <input
              className={inputCls}
              type="email"
              autoComplete="username"
              required
              autoFocus
              value={email}
              onChange={(event) => setEmail(event.target.value)}
            />
          </Field>

          <Turnstile onToken={setCaptchaToken} resetKey={captchaReset} />
          {error && <FormError>{error}</FormError>}

          <button type="submit" className={primaryBtnCls} disabled={busy}>
            {busy ? t('stav.nacitavam') : t('auth.obnovaOdoslat')}
          </button>
          <Link to="/login" className={linkBtnCls}>
            {t('auth.spatNaPrihlasenie')}
          </Link>
        </form>
      )}
    </AuthShell>
  );
}

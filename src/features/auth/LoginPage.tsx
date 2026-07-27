import { useState } from 'react';
import { Link, Navigate, useLocation, useNavigate } from 'react-router-dom';
import { AUTH_MODE, DEMO_ACCOUNTS, DEMO_PASSWORD } from '../../auth/config';
import { useAuth } from '../../auth/AuthContext';
import { startOidc } from '../../auth/sessionGateway';
import { AuthError } from '../../auth/types';
import { t } from '../../i18n/sk';
import { AuthShell, Field, FormError, Turnstile, inputCls, linkBtnCls, primaryBtnCls } from './authUi';

// Redesign прежнего LoginPage.tsx: та же логика, обновлённая композиция.
// Палитра из tailwind.config.ts: accent #0E7A5F, accent-hover #0A6650,
// app #F6F7F5, line #E3E6E2, ink #1B1F1D, ink-soft #5C645F.

function GoogleIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 48 48" aria-hidden>
      <path fill="#EA4335" d="M24 9.5c3.54 0 6.71 1.22 9.21 3.6l6.85-6.85C35.9 2.38 30.47 0 24 0 14.62 0 6.51 5.38 2.56 13.22l7.98 6.19C12.43 13.72 17.74 9.5 24 9.5z" />
      <path fill="#4285F4" d="M46.98 24.55c0-1.57-.15-3.09-.38-4.55H24v9.02h12.94c-.58 2.96-2.26 5.48-4.78 7.18l7.73 6c4.51-4.18 7.09-10.36 7.09-17.65z" />
      <path fill="#FBBC05" d="M10.53 28.59c-.48-1.45-.76-2.99-.76-4.59s.27-3.14.76-4.59l-7.98-6.19C.92 16.46 0 20.12 0 24c0 3.88.92 7.54 2.56 10.78l7.97-6.19z" />
      <path fill="#34A853" d="M24 48c6.48 0 11.93-2.13 15.89-5.81l-7.73-6c-2.15 1.45-4.92 2.3-8.16 2.3-6.26 0-11.57-4.22-13.47-9.91l-7.98 6.19C6.51 42.62 14.62 48 24 48z" />
    </svg>
  );
}

function MicrosoftIcon() {
  return (
    <svg width="17" height="17" viewBox="0 0 21 21" aria-hidden>
      <rect width="10" height="10" fill="#F25022" />
      <rect x="11" width="10" height="10" fill="#7FBA00" />
      <rect y="11" width="10" height="10" fill="#00A4EF" />
      <rect x="11" y="11" width="10" height="10" fill="#FFB900" />
    </svg>
  );
}

const ssoBtn =
  'flex items-center justify-center gap-2.5 rounded-xl border border-line bg-white px-4 py-3 text-sm font-medium text-ink transition ' +
  'hover:border-[#C9D0CB] hover:shadow-md hover:shadow-ink/10 ' +
  'focus:outline-none focus-visible:ring-[3px] focus-visible:ring-accent/25 disabled:cursor-not-allowed disabled:opacity-60';

export function LoginPage() {
  const { session, login } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();
  const [email, setEmail] = useState(AUTH_MODE === 'demo' ? DEMO_ACCOUNTS[0].email : '');
  const [password, setPassword] = useState('');
  const [captchaToken, setCaptchaToken] = useState('');
  const [captchaReset, setCaptchaReset] = useState(0);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  if (session) return <Navigate to="/" replace />;

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setError('');
    setBusy(true);
    try {
      await login({ email, password, captchaToken });
      const state = location.state as { from?: { pathname?: string; search?: string } } | null;
      navigate(`${state?.from?.pathname ?? '/'}${state?.from?.search ?? ''}`, { replace: true });
    } catch (cause) {
      if (cause instanceof AuthError) {
        setError(cause.detail ?? (cause.code === 'invalid_credentials' ? t('auth.neplatne') : t('auth.nedostupne')));
      } else {
        setError(t('auth.nedostupne'));
      }
      // Spotrebovaný token vymeníme, inak by druhý pokus zlyhal na captchu.
      setCaptchaToken('');
      setCaptchaReset((value) => value + 1);
    } finally {
      setBusy(false);
    }
  }

  return (
    <AuthShell
      title={t('auth.vitajte')}
      footer={AUTH_MODE === 'demo' ? t('auth.demo') : t('auth.sessionBff')}
    >
      <div className="grid gap-3 sm:grid-cols-2">
        <button
          type="button"
          className={ssoBtn}
          disabled={AUTH_MODE === 'demo'}
          title={AUTH_MODE === 'demo' ? t('auth.oidcDemo') : undefined}
          onClick={() => startOidc('google')}
        >
          <GoogleIcon />
          {t('auth.google')}
        </button>
        <button
          type="button"
          className={ssoBtn}
          disabled={AUTH_MODE === 'demo'}
          title={AUTH_MODE === 'demo' ? t('auth.oidcDemo') : undefined}
          onClick={() => startOidc('microsoft')}
        >
          <MicrosoftIcon />
          {t('auth.microsoft')}
        </button>
      </div>

      <div className="my-6 flex items-center gap-3.5 text-xs uppercase tracking-wider text-ink-soft">
        <span className="h-px flex-1 bg-gradient-to-r from-transparent to-line" />
        {t('auth.alebo')}
        <span className="h-px flex-1 bg-gradient-to-r from-line to-transparent" />
      </div>

      <form onSubmit={submit} className="flex flex-col" style={{ gap: 18 }}>
        <Field label={t('auth.email')}>
          <input
            className={inputCls}
            type="email"
            autoComplete="username"
            required
            value={email}
            onChange={(event) => setEmail(event.target.value)}
          />
        </Field>
        <Field label={t('auth.heslo')}>
          <input
            className={inputCls}
            type="password"
            autoComplete="current-password"
            required
            value={password}
            onChange={(event) => setPassword(event.target.value)}
          />
        </Field>

        <Turnstile onToken={setCaptchaToken} resetKey={captchaReset} />
        {error && <FormError>{error}</FormError>}

        <button type="submit" className={primaryBtnCls} disabled={busy}>
          {busy ? t('stav.nacitavam') : t('auth.prihlasit')}
        </button>
        <Link to="/zabudnute-heslo" className={linkBtnCls}>
          {t('auth.zabudnute')}
        </Link>
        <Link to="/registracia" className={linkBtnCls}>
          {t('auth.nemateUcet')} {t('auth.registrovat')}
        </Link>
      </form>

      {(AUTH_MODE === 'demo' || import.meta.env.DEV) && (
        <div className="mt-7 rounded-2xl border border-[#F3E3B3] bg-gradient-to-b from-amber-50 to-[#FEF7DC] px-5" style={{ paddingTop: 18, paddingBottom: 18 }}>
          <div className="flex items-center gap-2">
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" aria-hidden>
              <path d="M12 3l9 16H3l9-16z" stroke="#92730A" strokeWidth="1.8" strokeLinejoin="round" />
              <path d="M12 10v4M12 16.5v.5" stroke="#92730A" strokeWidth="1.8" strokeLinecap="round" />
            </svg>
            <p className="text-[13.5px] font-semibold text-[#6B5407]">{t('auth.demo')}</p>
          </div>
          <p className="mt-1.5 text-xs leading-relaxed text-[#85691A]">{t('auth.demoPopis')}</p>
          <div className="mt-3 flex flex-wrap gap-2">
            {DEMO_ACCOUNTS.map((account) => (
              <button
                key={account.email}
                type="button"
                className="rounded-full border border-[#EBD79A] bg-white px-3.5 py-1.5 text-xs font-medium text-[#6B5407] transition hover:border-[#DFC97E] hover:bg-[#FDF3CE] hover:shadow-sm focus:outline-none focus-visible:ring-[3px] focus-visible:ring-[#92730A]/20"
                onClick={() => {
                  setEmail(account.email);
                  setPassword(DEMO_PASSWORD);
                }}
              >
                {t(`rola.${account.role}`)}
              </button>
            ))}
          </div>
          <p className="tnum mt-3 text-xs text-[#85691A]">{t('auth.demoHeslo')}: {DEMO_PASSWORD}</p>
        </div>
      )}
    </AuthShell>
  );
}

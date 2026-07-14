import { useState } from 'react';
import { Navigate, useLocation, useNavigate } from 'react-router-dom';
import { AUTH_MODE, DEMO_ACCOUNTS, DEMO_PASSWORD } from '../../auth/config';
import { useAuth } from '../../auth/AuthContext';
import { startOidc } from '../../auth/sessionGateway';
import { AuthError } from '../../auth/types';
import { t } from '../../i18n/sk';

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

const inputCls =
  'w-full rounded-xl border border-line bg-[#FBFCFB] px-4 py-3 text-[15px] text-ink transition placeholder:text-[#9AA39E] ' +
  'hover:border-[#C9D0CB] focus:border-accent focus:bg-white focus:outline-none focus:ring-[3px] focus:ring-accent/15';

export function LoginPage() {
  const { session, login } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();
  const [email, setEmail] = useState(AUTH_MODE === 'demo' ? DEMO_ACCOUNTS[0].email : '');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [info, setInfo] = useState('');
  const [busy, setBusy] = useState(false);

  if (session) return <Navigate to="/" replace />;

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setError('');
    setInfo('');
    setBusy(true);
    try {
      await login({ email, password });
      const state = location.state as { from?: { pathname?: string; search?: string } } | null;
      navigate(`${state?.from?.pathname ?? '/'}${state?.from?.search ?? ''}`, { replace: true });
    } catch (cause) {
      setError(
        cause instanceof AuthError && cause.code === 'invalid_credentials'
          ? t('auth.neplatne')
          : t('auth.nedostupne'),
      );
    } finally {
      setBusy(false);
    }
  }

  return (
    <main
      className="flex min-h-screen items-center justify-center px-4 py-12"
      style={{
        background:
          'radial-gradient(1100px 600px at 50% -180px, rgba(14,122,95,0.10), rgba(14,122,95,0) 60%), ' +
          'radial-gradient(900px 500px at 85% 110%, rgba(14,122,95,0.06), rgba(14,122,95,0) 55%), #F6F7F5',
      }}
    >
      <div className="flex w-full max-w-[460px] flex-col gap-7">
        <div className="flex items-center justify-center gap-3">
          <span
            className="grid h-11 w-11 place-items-center rounded-[14px] bg-gradient-to-br from-accent to-accent-hover shadow-lg shadow-accent/40"
            aria-hidden
          >
            <svg width="22" height="22" viewBox="0 0 24 24" fill="none">
              <path d="M6 3.5h8.5L19 8v12a1.5 1.5 0 0 1-1.5 1.5h-11A1.5 1.5 0 0 1 5 20V5a1.5 1.5 0 0 1 1-1.5z" stroke="white" strokeWidth="1.8" strokeLinejoin="round" />
              <path d="M9 12.5h6M9 16h6" stroke="white" strokeWidth="1.8" strokeLinecap="round" />
            </svg>
          </span>
          <span className="text-2xl font-bold tracking-tight text-ink">{t('app.nazov')}</span>
        </div>

        <section className="rounded-3xl bg-white p-9 shadow-[0_1px_2px_rgba(27,31,29,0.04),0_12px_32px_-12px_rgba(27,31,29,0.10),0_32px_64px_-32px_rgba(14,122,95,0.12)] sm:p-10">
          <h1 className="mb-7 text-center text-[26px] font-semibold tracking-tight text-ink">{t('auth.vitajte')}</h1>

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
            <label className="flex flex-col gap-1.5">
              <span className="text-[13px] font-medium text-ink-soft">{t('auth.email')}</span>
              <input
                className={inputCls}
                type="email"
                autoComplete="username"
                required
                value={email}
                onChange={(event) => setEmail(event.target.value)}
              />
            </label>
            <label className="flex flex-col gap-1.5">
              <span className="text-[13px] font-medium text-ink-soft">{t('auth.heslo')}</span>
              <input
                className={inputCls}
                type="password"
                autoComplete="current-password"
                required
                value={password}
                onChange={(event) => setPassword(event.target.value)}
              />
            </label>

            {error && <p className="rounded-xl border border-red-200 bg-red-50 px-4 py-2.5 text-sm text-red-700">{error}</p>}
            {info && <p className="rounded-xl border border-sky-200 bg-sky-50 px-4 py-2.5 text-sm text-sky-800">{info}</p>}

            <button
              type="submit"
              className="mt-1 rounded-xl bg-accent px-4 py-3.5 text-[15px] font-semibold text-white shadow-lg shadow-accent/40 transition hover:-translate-y-px hover:bg-accent-hover active:translate-y-0 focus:outline-none focus-visible:ring-[3px] focus-visible:ring-accent/30 disabled:cursor-not-allowed disabled:opacity-70"
              disabled={busy}
            >
              {busy ? t('stav.nacitavam') : t('auth.prihlasit')}
            </button>
            <button
              type="button"
              className="text-center text-[13.5px] font-medium text-accent underline-offset-2 hover:text-accent-hover hover:underline"
              onClick={() => setInfo(t('auth.obnovaBff'))}
            >
              {t('auth.zabudnute')}
            </button>
          </form>

          {AUTH_MODE === 'demo' && (
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
        </section>

        <p className="text-center text-xs text-ink-soft">
          {AUTH_MODE === 'demo' ? t('auth.demo') : t('auth.sessionBff')}
        </p>
      </div>
    </main>
  );
}

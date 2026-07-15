import { useState } from 'react';
import { Navigate, useLocation, useNavigate } from 'react-router-dom';
import { AUTH_MODE, DEMO_ACCOUNTS, DEMO_PASSWORD } from '../../auth/config';
import { useAuth } from '../../auth/AuthContext';
import { startOidc } from '../../auth/sessionGateway';
import { AuthError } from '../../auth/types';
import { t } from '../../i18n/sk';

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
    <main className="flex min-h-screen items-center justify-center bg-[#f5f7fb] px-4 py-10">
      <div className="w-full max-w-xl">
        <div className="mb-8 flex items-center justify-center gap-2 text-2xl font-bold text-accent">
          <span className="grid h-9 w-9 place-items-center rounded-xl bg-accent text-white" aria-hidden>▦</span>
          {t('app.nazov')}
        </div>

        <section className="rounded-3xl border border-line bg-white p-8 shadow-sm sm:p-12">
          <h1 className="text-center text-3xl font-semibold text-ink">{t('auth.vitajte')}</h1>

          <div className="mt-8 grid gap-3 sm:grid-cols-2">
            <button
              type="button"
              className="btn justify-center py-3"
              disabled={AUTH_MODE === 'demo'}
              title={AUTH_MODE === 'demo' ? t('auth.oidcDemo') : undefined}
              onClick={() => startOidc('google')}
            >
              <span className="font-bold text-blue-600" aria-hidden>G</span>
              {t('auth.google')}
            </button>
            <button
              type="button"
              className="btn justify-center py-3"
              disabled={AUTH_MODE === 'demo'}
              title={AUTH_MODE === 'demo' ? t('auth.oidcDemo') : undefined}
              onClick={() => startOidc('microsoft')}
            >
              <span className="grid grid-cols-2 gap-0.5" aria-hidden>
                <i className="h-2 w-2 bg-red-500" /><i className="h-2 w-2 bg-green-500" />
                <i className="h-2 w-2 bg-blue-500" /><i className="h-2 w-2 bg-amber-400" />
              </span>
              {t('auth.microsoft')}
            </button>
          </div>

          <div className="my-8 flex items-center gap-3 text-xs text-ink-soft">
            <span className="h-px flex-1 bg-line" />
            {t('auth.alebo')}
            <span className="h-px flex-1 bg-line" />
          </div>

          <form onSubmit={submit} className="space-y-4">
            <label className="block">
              <span className="label">{t('auth.email')}</span>
              <input
                className="input py-3"
                type="email"
                autoComplete="username"
                required
                value={email}
                onChange={(event) => setEmail(event.target.value)}
              />
            </label>
            <label className="block">
              <span className="label">{t('auth.heslo')}</span>
              <input
                className="input py-3"
                type="password"
                autoComplete="current-password"
                required
                value={password}
                onChange={(event) => setPassword(event.target.value)}
              />
            </label>

            {error && <p className="rounded border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">{error}</p>}
            {info && <p className="rounded border border-sky-200 bg-sky-50 px-3 py-2 text-sm text-sky-800">{info}</p>}

            <button type="submit" className="btn btn-primary w-full justify-center py-3" disabled={busy}>
              {busy ? t('stav.nacitavam') : t('auth.prihlasit')}
            </button>
            <button
              type="button"
              className="w-full text-center text-sm text-accent underline-offset-2 hover:underline"
              onClick={() => setInfo(t('auth.obnovaBff'))}
            >
              {t('auth.zabudnute')}
            </button>
          </form>

          {AUTH_MODE === 'demo' && (
            <div className="mt-8 rounded-xl border border-amber-200 bg-amber-50 p-4 text-sm text-amber-950">
              <p className="font-semibold">{t('auth.demo')}</p>
              <p className="mt-1 text-xs">{t('auth.demoPopis')}</p>
              <div className="mt-3 flex flex-wrap gap-2">
                {DEMO_ACCOUNTS.map((account) => (
                  <button
                    key={account.email}
                    type="button"
                    className="rounded border border-amber-300 bg-white px-2 py-1 text-xs hover:bg-amber-100"
                    onClick={() => {
                      setEmail(account.email);
                      setPassword(DEMO_PASSWORD);
                    }}
                  >
                    {t(`rola.${account.role}`)}
                  </button>
                ))}
              </div>
              <p className="tnum mt-3 text-xs">{t('auth.demoHeslo')}: {DEMO_PASSWORD}</p>
            </div>
          )}
        </section>

        <p className="mt-6 text-center text-xs text-ink-soft">
          {AUTH_MODE === 'demo' ? t('auth.demo') : t('auth.sessionBff')}
        </p>
      </div>
    </main>
  );
}

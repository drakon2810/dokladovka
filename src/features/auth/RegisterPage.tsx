import { useState } from 'react';
import { Link, Navigate } from 'react-router-dom';
import { useAuth } from '../../auth/AuthContext';
import { t } from '../../i18n/sk';
import { AuthApiError, confirmRegistration, requestRegistration } from './authApi';
import { AuthShell, Field, FormError, FormInfo, Turnstile, inputCls, linkBtnCls, primaryBtnCls } from './authUi';

export function RegisterPage() {
  const { session } = useAuth();
  const [step, setStep] = useState<'udaje' | 'kod'>('udaje');
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [passwordAgain, setPasswordAgain] = useState('');
  const [captchaToken, setCaptchaToken] = useState('');
  const [captchaReset, setCaptchaReset] = useState(0);
  const [code, setCode] = useState('');
  const [registrationId, setRegistrationId] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  if (session) return <Navigate to="/" replace />;

  async function run(action: () => Promise<void>) {
    setError('');
    setBusy(true);
    try {
      await action();
    } catch (cause) {
      setError(cause instanceof AuthApiError ? cause.message : t('auth.nedostupne'));
      // Server token spotreboval — bez prekreslenia by ďalší pokus zlyhal.
      setCaptchaToken('');
      setCaptchaReset((value) => value + 1);
    } finally {
      setBusy(false);
    }
  }

  function submitDetails(event: React.FormEvent) {
    event.preventDefault();
    if (password !== passwordAgain) {
      setError(t('auth.hesloNesedi'));
      return;
    }
    void run(async () => {
      setRegistrationId(await requestRegistration({ name, email, password, captchaToken }));
      setCode('');
      setStep('kod');
    });
  }

  function submitCode(event: React.FormEvent) {
    event.preventDefault();
    void run(async () => {
      await confirmRegistration({ registrationId, code });
      // Server nastavil session cookie — plné načítanie ju vyzdvihne.
      window.location.assign('/');
    });
  }

  return (
    <AuthShell title={step === 'udaje' ? t('auth.vytvoritUcet') : t('auth.overteEmail')}>
      {step === 'udaje' ? (
        <form onSubmit={submitDetails} className="flex flex-col" style={{ gap: 18 }}>
          <Field label={t('auth.meno')}>
            <input
              className={inputCls}
              type="text"
              autoComplete="name"
              required
              maxLength={120}
              value={name}
              onChange={(event) => setName(event.target.value)}
            />
          </Field>
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
              autoComplete="new-password"
              required
              minLength={10}
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

          <Turnstile onToken={setCaptchaToken} resetKey={captchaReset} />
          {error && <FormError>{error}</FormError>}

          <button type="submit" className={primaryBtnCls} disabled={busy}>
            {busy ? t('stav.nacitavam') : t('auth.registrovat')}
          </button>
          <Link to="/login" className={linkBtnCls}>
            {t('auth.mateUcet')} {t('auth.prihlasit')}
          </Link>
        </form>
      ) : (
        <form onSubmit={submitCode} className="flex flex-col" style={{ gap: 18 }}>
          <FormInfo>
            {t('auth.kodPoslanyNa')} <strong>{email}</strong>. {t('auth.kodPlatnost')}
          </FormInfo>
          <Field label={t('auth.kod')}>
            <input
              className={`${inputCls} tnum text-center text-xl tracking-[0.4em]`}
              type="text"
              inputMode="numeric"
              autoComplete="one-time-code"
              pattern="\d{6}"
              maxLength={6}
              required
              autoFocus
              value={code}
              onChange={(event) => setCode(event.target.value.replace(/\D/g, ''))}
            />
          </Field>

          {error && <FormError>{error}</FormError>}

          <button type="submit" className={primaryBtnCls} disabled={busy}>
            {busy ? t('stav.nacitavam') : t('auth.potvrditKod')}
          </button>
          <button
            type="button"
            className={linkBtnCls}
            onClick={() => {
              setError('');
              // Widget sa vykreslí nanovo; starý token je už spotrebovaný.
              setCaptchaToken('');
              setStep('udaje');
            }}
          >
            {t('auth.kodZnova')}
          </button>
        </form>
      )}
    </AuthShell>
  );
}

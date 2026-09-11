import { useEffect, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { t, tv } from '../../i18n/sk';
import { AuthApiError, nacitajPozvanku, prijmiPozvanku, type NahladPozvanky } from './authApi';
import { AuthShell, Field, FormError, FormInfo, inputCls, linkBtnCls, primaryBtnCls } from './authUi';

/**
 * Prijatie pozvánky do kancelárie. Dva prípady:
 * - nový človek si nastaví meno a heslo a vznikne mu účet v tejto kancelárii;
 * - adresa už účet má (napr. sa zaregistroval sám a skončil v prázdnej
 *   kancelárii) — potvrdí doterajším heslom a účet sa presunie sem.
 */
export function PozvankaPage() {
  const token = useSearchParams()[0].get('token') ?? '';
  const [nahlad, setNahlad] = useState<NahladPozvanky | null>(null);
  const [neplatna, setNeplatna] = useState(!token);
  const [meno, setMeno] = useState('');
  const [heslo, setHeslo] = useState('');
  const [hesloZnova, setHesloZnova] = useState('');
  const [chyba, setChyba] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!token) return;
    nacitajPozvanku(token)
      .then((data) => { setNahlad(data); setMeno(data.meno); })
      .catch(() => setNeplatna(true));
  }, [token]);

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    if (!nahlad?.existujuciUcet && heslo !== hesloZnova) {
      setChyba(t('auth.hesloNesedi'));
      return;
    }
    setChyba('');
    setBusy(true);
    try {
      await prijmiPozvanku({ token, heslo, meno: nahlad?.existujuciUcet ? undefined : meno });
      // Server nastavil session cookie — plné načítanie ju vyzdvihne.
      window.location.assign('/');
    } catch (cause) {
      setChyba(cause instanceof AuthApiError ? cause.message : t('auth.nedostupne'));
      setBusy(false);
    }
  }

  if (neplatna) {
    return (
      <AuthShell title={t('pozvanka.titul')}>
        <div className="flex flex-col gap-5">
          <FormError>{t('pozvanka.neplatna')}</FormError>
          <Link to="/login" className={linkBtnCls}>{t('auth.spatNaPrihlasenie')}</Link>
        </div>
      </AuthShell>
    );
  }

  if (!nahlad) {
    return <AuthShell title={t('pozvanka.titul')}><p className="text-sm text-ink-soft">{t('stav.nacitavam')}</p></AuthShell>;
  }

  return (
    <AuthShell title={t('pozvanka.titul')}>
      <form onSubmit={submit} className="flex flex-col" style={{ gap: 18 }}>
        <FormInfo>
          {tv('pozvanka.popis', { pozval: nahlad.pozval, kancelaria: nahlad.kancelaria })}
          {' '}
          {nahlad.existujuciUcet
            ? tv('pozvanka.existujuci', { email: nahlad.email })
            : tv('pozvanka.novy', { email: nahlad.email })}
        </FormInfo>

        {!nahlad.existujuciUcet && (
          <Field label={t('pozvanka.meno')}>
            <input className={inputCls} required autoComplete="name" value={meno} onChange={(e) => setMeno(e.target.value)} />
          </Field>
        )}
        <Field label={nahlad.existujuciUcet ? t('pozvanka.doterajsieHeslo') : t('pozvanka.heslo')}>
          <input
            className={inputCls}
            type="password"
            required
            autoFocus
            autoComplete={nahlad.existujuciUcet ? 'current-password' : 'new-password'}
            minLength={nahlad.existujuciUcet ? undefined : 10}
            value={heslo}
            onChange={(e) => setHeslo(e.target.value)}
          />
        </Field>
        {!nahlad.existujuciUcet && (
          <>
            <p className="-mt-2 text-xs text-ink-soft">{t('auth.hesloPoziadavka')}</p>
            <Field label={t('auth.hesloZnova')}>
              <input className={inputCls} type="password" required minLength={10} autoComplete="new-password"
                value={hesloZnova} onChange={(e) => setHesloZnova(e.target.value)} />
            </Field>
          </>
        )}

        {chyba && <FormError>{chyba}</FormError>}

        <button type="submit" className={primaryBtnCls} disabled={busy}>
          {busy ? t('stav.nacitavam') : t('pozvanka.prijat')}
        </button>
      </form>
    </AuthShell>
  );
}

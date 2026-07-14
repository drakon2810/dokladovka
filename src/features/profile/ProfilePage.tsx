import { useEffect, useState } from 'react';
import { useAuth } from '../../auth/AuthContext';
import type { UserNotificationPreferences } from '../../data/types';
import { t } from '../../i18n/sk';

type NotificationKey = keyof UserNotificationPreferences;

const NOTIFICATION_ROWS: Array<{
  key: NotificationKey;
  label:
    | 'profil.notifikacie.email'
    | 'profil.notifikacie.aplikacia'
    | 'profil.notifikacie.komentare'
    | 'profil.notifikacie.zmienky';
}> = [
  { key: 'email', label: 'profil.notifikacie.email' },
  { key: 'inApp', label: 'profil.notifikacie.aplikacia' },
  { key: 'comments', label: 'profil.notifikacie.komentare' },
  { key: 'mentions', label: 'profil.notifikacie.zmienky' },
];

export function ProfilePage() {
  const { session, updateProfile } = useAuth();
  const [name, setName] = useState(session?.user.name ?? '');
  const [notifications, setNotifications] = useState<UserNotificationPreferences>(
    session?.user.notifications ?? {
      email: true,
      inApp: true,
      comments: true,
      mentions: true,
    },
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    if (!session) return;
    setName(session.user.name);
    setNotifications({ ...session.user.notifications });
  }, [session]);

  if (!session) return null;

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    const normalizedName = name.trim();
    setError('');
    setSaved(false);
    if (normalizedName.length === 0 || normalizedName.length > 100) {
      setError(t('profil.chybaMeno'));
      return;
    }

    setBusy(true);
    try {
      await updateProfile({
        name: normalizedName,
        language: 'sk',
        notifications,
      });
      setName(normalizedName);
      setSaved(true);
    } catch {
      setError(t('profil.chybaUlozenia'));
    } finally {
      setBusy(false);
    }
  }

  const security = session.user.security;

  return (
    <div className="mx-auto max-w-4xl">
      <h1 className="mb-4 text-xl font-semibold">{t('profil.titulok')}</h1>

      <form className="space-y-4" onSubmit={submit}>
        <section className="card p-5">
          <h2 className="mb-4 text-base font-semibold">{t('profil.osobneUdaje')}</h2>
          <div className="grid gap-4 sm:grid-cols-2">
            <label className="block">
              <span className="label">{t('profil.meno')}</span>
              <input
                className="input"
                value={name}
                maxLength={100}
                autoComplete="name"
                required
                onChange={(event) => setName(event.target.value)}
              />
            </label>
            <label className="block">
              <span className="label">{t('profil.email')}</span>
              <input className="input bg-app text-ink-soft" value={session.user.email} readOnly />
            </label>
            <label className="block">
              <span className="label">{t('profil.jazyk')}</span>
              <select className="input" value={session.user.language} disabled>
                <option value="sk">{t('profil.jazyk.sk')}</option>
              </select>
            </label>
          </div>
        </section>

        <section className="card p-5">
          <h2 className="mb-3 text-base font-semibold">{t('profil.notifikacie')}</h2>
          <div className="divide-y divide-line">
            {NOTIFICATION_ROWS.map((row) => (
              <label key={row.key} className="flex cursor-pointer items-center justify-between gap-4 py-3 text-sm">
                <span>{t(row.label)}</span>
                <input
                  type="checkbox"
                  className="h-4 w-4 accent-accent"
                  checked={notifications[row.key]}
                  onChange={(event) =>
                    setNotifications((current) => ({
                      ...current,
                      [row.key]: event.target.checked,
                    }))
                  }
                />
              </label>
            ))}
          </div>
        </section>

        <section className="card p-5">
          <h2 className="mb-3 text-base font-semibold">{t('profil.bezpecnost')}</h2>
          <div className="divide-y divide-line text-sm">
            <SecurityRow
              label={t('profil.2fa')}
              active={security.twoFactor.enabled}
              activeLabel={t('profil.stav.zapnute')}
              inactiveLabel={t('profil.stav.vypnute')}
            />
            <SecurityRow
              label={t('profil.google')}
              active={security.google.connected}
              activeLabel={t('profil.stav.prepojene')}
              inactiveLabel={t('profil.stav.neprepojene')}
            />
            <SecurityRow
              label={t('profil.microsoft')}
              active={security.microsoft.connected}
              activeLabel={t('profil.stav.prepojene')}
              inactiveLabel={t('profil.stav.neprepojene')}
            />
          </div>
          <p className="mt-3 text-xs text-ink-soft">
            {session.mode === 'demo' ? t('profil.demoBezpecnost') : t('profil.bffInfo')}
          </p>
        </section>

        {error && (
          <p className="rounded border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700" role="alert">
            {error}
          </p>
        )}
        {saved && (
          <p className="rounded border border-green-200 bg-green-50 px-3 py-2 text-sm text-green-800" role="status">
            {t('profil.ulozene')}
          </p>
        )}

        <div className="flex justify-end">
          <button type="submit" className="btn btn-primary" disabled={busy}>
            {busy ? t('stav.nacitavam') : t('profil.ulozit')}
          </button>
        </div>
      </form>
    </div>
  );
}

function SecurityRow({
  label,
  active,
  activeLabel,
  inactiveLabel,
}: {
  label: string;
  active: boolean;
  activeLabel: string;
  inactiveLabel: string;
}) {
  return (
    <div className="flex items-center justify-between gap-4 py-3">
      <span>{label}</span>
      <span
        className={`rounded-full border px-2 py-0.5 text-xs font-medium ${
          active
            ? 'border-green-200 bg-green-50 text-green-800'
            : 'border-line bg-app text-ink-soft'
        }`}
      >
        {active ? activeLabel : inactiveLabel}
      </span>
    </div>
  );
}

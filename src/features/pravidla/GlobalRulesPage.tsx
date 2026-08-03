import { useAuth } from '../../auth/AuthContext';
import { t } from '../../i18n/sk';
import { PravidlaEditor } from './PravidlaEditor';

// Jediná obrazovka správcu platformy. Účet nemá členstvo v žiadnej organizácii,
// takže sa k dokladom firiem nedostane — vidí a píše len globálne pravidlá.

export function GlobalRulesPage() {
  const { session, logout } = useAuth();
  return (
    <div className="min-h-screen bg-app">
      <header className="border-b border-line bg-surface">
        <div className="mx-auto flex max-w-4xl items-center gap-3 px-6 py-4">
          <div className="flex-1">
            <h1 className="text-lg font-semibold tracking-tight">{t('pravidla.global.titulok')}</h1>
            <p className="text-[13px] text-ink-faint">{session?.user.email}</p>
          </div>
          <button type="button" className="btn" onClick={() => void logout()}>
            {t('auth.odhlasit')}
          </button>
        </div>
      </header>
      <main className="mx-auto max-w-4xl px-6 py-6">
        <p className="mb-4 text-sm text-ink-soft">{t('pravidla.global.popis')}</p>
        <PravidlaEditor />
      </main>
    </div>
  );
}

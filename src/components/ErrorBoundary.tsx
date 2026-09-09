import { Component, type ErrorInfo, type ReactNode } from 'react';
import { t } from '../i18n/sk';

interface Props {
  children: ReactNode;
}

interface State {
  failed: boolean;
  /** Text chyby — bez neho sa nedá zistiť nič, ani z konzoly. */
  sprava?: string;
}

/** Posledná UI ochrana: runtime chyba nesmie používateľovi nechať bielu stránku. */
export class ErrorBoundary extends Component<Props, State> {
  state: State = { failed: false };

  static getDerivedStateFromError(error: Error): State {
    return { failed: true, sprava: `${error.name}: ${error.message}` };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    // TODO: integration point — sanitizovaný frontend error reporting vo Fáze 2.
    //
    // Text chyby ide na obrazovku aj do konzoly. Doteraz sa logovalo len
    // error.name, takže „TypeError" bolo všetko, čo sa dalo zistiť — ani
    // v konzole nebolo vidieť, ktorá hodnota chýba, a hľadalo sa poslepiačky.
    console.error('UI render error', error.name, error.message, info.componentStack);
  }

  render() {
    if (!this.state.failed) return this.props.children;
    return (
      <div className="card mx-auto max-w-lg p-6 text-center" role="alert">
        <h1 className="text-lg font-semibold">{t('chyba.obrazovkaTitulok')}</h1>
        <p className="mt-2 text-sm text-ink-soft">{t('chyba.obrazovkaPopis')}</p>
        {this.state.sprava && (
          <p className="mt-3 break-words rounded bg-app px-3 py-2 text-left text-[12px] font-mono text-ink-soft">
            {this.state.sprava}
          </p>
        )}
        <button
          type="button"
          className="btn btn-primary mt-4"
          onClick={() => window.location.reload()}
        >
          {t('akcia.obnovit')}
        </button>
      </div>
    );
  }
}

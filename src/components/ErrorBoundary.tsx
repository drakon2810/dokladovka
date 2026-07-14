import { Component, type ErrorInfo, type ReactNode } from 'react';
import { t } from '../i18n/sk';

interface Props {
  children: ReactNode;
}

interface State {
  failed: boolean;
}

/** Posledná UI ochrana: runtime chyba nesmie používateľovi nechať bielu stránku. */
export class ErrorBoundary extends Component<Props, State> {
  state: State = { failed: false };

  static getDerivedStateFromError(): State {
    return { failed: true };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    // TODO: integration point — sanitizovaný frontend error reporting vo Fáze 2.
    console.error('UI render error', error.name, info.componentStack);
  }

  render() {
    if (!this.state.failed) return this.props.children;
    return (
      <div className="card mx-auto max-w-lg p-6 text-center" role="alert">
        <h1 className="text-lg font-semibold">{t('chyba.obrazovkaTitulok')}</h1>
        <p className="mt-2 text-sm text-ink-soft">{t('chyba.obrazovkaPopis')}</p>
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

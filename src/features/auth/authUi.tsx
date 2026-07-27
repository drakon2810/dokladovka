import { useEffect, useRef, useState, type ReactNode } from 'react';
import { t } from '../../i18n/sk';

// Spoločná schránka pre všetky stránky bez prihlásenia (prihlásenie,
// registrácia, obnova hesla) — jedna kompozícia namiesto štyroch kópií.

export const inputCls =
  'w-full rounded-xl border border-line bg-[#FBFCFB] px-4 py-3 text-[15px] text-ink transition placeholder:text-[#9AA39E] ' +
  'hover:border-[#C9D0CB] focus:border-accent focus:bg-white focus:outline-none focus:ring-[3px] focus:ring-accent/15';

export const primaryBtnCls =
  'mt-1 rounded-xl bg-accent px-4 py-3.5 text-[15px] font-semibold text-white shadow-lg shadow-accent/40 transition ' +
  'hover:-translate-y-px hover:bg-accent-hover active:translate-y-0 focus:outline-none focus-visible:ring-[3px] ' +
  'focus-visible:ring-accent/30 disabled:cursor-not-allowed disabled:opacity-70';

export const linkBtnCls =
  'text-center text-[13.5px] font-medium text-accent underline-offset-2 hover:text-accent-hover hover:underline';

export function AuthShell({ title, footer, children }: { title: string; footer?: ReactNode; children: ReactNode }) {
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
          <h1 className="mb-7 text-center text-[26px] font-semibold tracking-tight text-ink">{title}</h1>
          {children}
        </section>

        {footer && <p className="text-center text-xs text-ink-soft">{footer}</p>}
      </div>
    </main>
  );
}

export function FormError({ children }: { children: ReactNode }) {
  return <p className="rounded-xl border border-red-200 bg-red-50 px-4 py-2.5 text-sm text-red-700">{children}</p>;
}

export function FormInfo({ children }: { children: ReactNode }) {
  return <p className="rounded-xl border border-sky-200 bg-sky-50 px-4 py-2.5 text-sm text-sky-800">{children}</p>;
}

export function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <label className="flex flex-col gap-1.5">
      <span className="text-[13px] font-medium text-ink-soft">{label}</span>
      {children}
    </label>
  );
}

// ===== Cloudflare Turnstile =====

interface TurnstileApi {
  render(element: HTMLElement, options: Record<string, unknown>): string;
  remove(widgetId: string): void;
}

declare global {
  interface Window {
    turnstile?: TurnstileApi;
    onloadTurnstileCallback?: () => void;
  }
}

let scriptPromise: Promise<void> | null = null;
function loadTurnstileScript(): Promise<void> {
  // Cloudflare volá `onload` callback až keď je window.turnstile pripravené;
  // spoliehať sa na script.onload by vedelo prísť priskoro.
  scriptPromise ??= new Promise<void>((resolve, reject) => {
    window.onloadTurnstileCallback = () => resolve();
    const script = document.createElement('script');
    script.src = 'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit&onload=onloadTurnstileCallback';
    script.async = true;
    script.onerror = () => reject(new Error('turnstile_script_failed'));
    document.head.appendChild(script);
  }).catch((cause) => {
    // Zlyhaný load sa nesmie zakešovať navždy — ďalší pokus načíta znova.
    scriptPromise = null;
    throw cause;
  });
  return scriptPromise;
}

let siteKeyPromise: Promise<string | null> | null = null;
/**
 * Kľúč widgetu chodí za behu z /api/config/public — build frontendu v Dockeri
 * nevidí .env, takže VITE_ premenná by v produkcii ostala prázdna.
 */
function loadSiteKey(): Promise<string | null> {
  siteKeyPromise ??= fetch('/api/config/public')
    .then((response) => {
      if (!response.ok) throw new Error('config_unavailable');
      return response.json() as Promise<{ turnstileSiteKey?: unknown }>;
    })
    .then((data) => (typeof data?.turnstileSiteKey === 'string' && data.turnstileSiteKey ? data.turnstileSiteKey : null))
    .catch(() => {
      // Neúspech nekešujeme: inak by výpadok siete natrvalo skryl captchu a
      // server by potom každé odoslanie odmietol ako captcha_required.
      siteKeyPromise = null;
      return null;
    });
  return siteKeyPromise;
}

/**
 * Widget captcha. Bez nakonfigurovaného kľúča sa nevykreslí (dev).
 * `resetKey` treba zvýšiť po neúspešnom odoslaní formulára — token je
 * jednorazový, bez prekreslenia by druhý pokus zlyhal na „duplicate“.
 */
export function Turnstile({ onToken, resetKey = 0 }: { onToken: (token: string) => void; resetKey?: number }) {
  const [siteKey, setSiteKey] = useState<string | null>(null);
  const container = useRef<HTMLDivElement>(null);
  const callback = useRef(onToken);
  callback.current = onToken;

  useEffect(() => {
    let active = true;
    void loadSiteKey().then((key) => {
      if (active) setSiteKey(key);
    });
    return () => {
      active = false;
    };
  }, []);

  useEffect(() => {
    if (!siteKey) return;
    let active = true;
    let widgetId: string | undefined;
    void loadTurnstileScript()
      .then(() => {
        if (!active || !container.current || !window.turnstile) return;
        widgetId = window.turnstile.render(container.current, {
          sitekey: siteKey,
          language: 'sk',
          callback: (token: string) => callback.current(token),
          'expired-callback': () => callback.current(''),
          'error-callback': () => callback.current(''),
        });
      })
      .catch(() => undefined);
    return () => {
      active = false;
      try {
        if (widgetId) window.turnstile?.remove(widgetId);
      } catch {
        // Widget už zmizol s DOM uzlom — nič na upratanie.
      }
    };
  }, [siteKey, resetKey]);

  if (!siteKey) return null;
  return <div ref={container} className="flex justify-center" />;
}

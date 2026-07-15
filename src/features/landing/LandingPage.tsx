import { useEffect, useRef } from 'react';
import { useNavigate } from 'react-router-dom';

function LogoMark({ size = 36 }: { size?: number }) {
  return (
    <span
      className="grid place-items-center rounded-xl bg-gradient-to-br from-accent to-accent-hover shadow-lg shadow-accent/40"
      style={{ width: size, height: size }}
      aria-hidden
    >
      <svg width={size / 2} height={size / 2} viewBox="0 0 24 24" fill="none">
        <path d="M6 3.5h8.5L19 8v12a1.5 1.5 0 0 1-1.5 1.5h-11A1.5 1.5 0 0 1 5 20V5a1.5 1.5 0 0 1 1-1.5z" stroke="white" strokeWidth="1.8" strokeLinejoin="round" />
        <path d="M9 12.5h6M9 16h6" stroke="white" strokeWidth="1.8" strokeLinecap="round" />
      </svg>
    </span>
  );
}

const FEATURES = [
  {
    title: 'Automatické spracovanie faktúr',
    text: 'Pošlite faktúru e-mailom a umelá inteligencia z nej vytiahne všetky údaje.',
    icon: (
      <svg width="20" height="20" viewBox="0 0 24 24" fill="none">
        <path d="M4 6.5h16v11a1.5 1.5 0 0 1-1.5 1.5h-13A1.5 1.5 0 0 1 4 17.5v-11z" stroke="#0E7A5F" strokeWidth="1.8" strokeLinejoin="round" />
        <path d="M4.5 7l7.5 6 7.5-6" stroke="#0E7A5F" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
    ),
  },
  {
    title: 'Rozpis DPH a predkontácia',
    text: 'Automatický rozpis DPH a návrh predkontácie podľa vášho účtovníctva.',
    icon: (
      <svg width="20" height="20" viewBox="0 0 24 24" fill="none">
        <path d="M6 18L18 6" stroke="#0E7A5F" strokeWidth="1.8" strokeLinecap="round" />
        <circle cx="7.5" cy="7.5" r="2.4" stroke="#0E7A5F" strokeWidth="1.8" />
        <circle cx="16.5" cy="16.5" r="2.4" stroke="#0E7A5F" strokeWidth="1.8" />
      </svg>
    ),
  },
  {
    title: 'Export do POHODA',
    text: 'Jedným klikom vyexportujete doklady vo formáte dataPack XML.',
    icon: (
      <svg width="20" height="20" viewBox="0 0 24 24" fill="none">
        <path d="M12 4v11m0 0l-4.5-4.5M12 15l4.5-4.5" stroke="#0E7A5F" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
        <path d="M5 20h14" stroke="#0E7A5F" strokeWidth="1.8" strokeLinecap="round" />
      </svg>
    ),
  },
  {
    title: 'Vlastný e-mail pre každú firmu',
    text: 'Každá firma má svoju e-mailovú adresu na zasielanie dokladov.',
    icon: (
      <svg width="20" height="20" viewBox="0 0 24 24" fill="none">
        <circle cx="12" cy="12" r="4" stroke="#0E7A5F" strokeWidth="1.8" />
        <path d="M16 12v1.5a2.5 2.5 0 0 0 5 0V12a9 9 0 1 0-3.5 7.1" stroke="#0E7A5F" strokeWidth="1.8" strokeLinecap="round" />
      </svg>
    ),
  },
];

const STEPS = [
  'Pošlite faktúru e-mailom',
  'AI spracuje a rozpozná údaje',
  'Skontrolujte a vyexportujte do POHODA',
];

const HERO_FIELDS = [
  { label: 'Suma s DPH', value: '1 248,00 €', strong: true },
  { label: 'DPH 20 %', value: '208,00 €', green: true },
  { label: 'Dátum dodania', value: '12. 07. 2026' },
  { label: 'Predkontácia', value: '518 / 321' },
];

export function LandingPage() {
  const navigate = useNavigate();
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const root = rootRef.current;
    if (!root) return;
    const els = Array.from(root.querySelectorAll<HTMLElement>('[data-reveal]'));
    els.forEach((el) => {
      el.style.opacity = '0';
      el.style.transform = 'translateY(26px)';
      el.style.transition = 'opacity 0.7s ease, transform 0.7s cubic-bezier(0.16,1,0.3,1)';
      el.style.transitionDelay = `${(Number(el.dataset.reveal) || 0) * 0.12}s`;
    });
    const runCounter = (el: HTMLElement) => {
      if (el.dataset.done) return;
      el.dataset.done = '1';
      const target = Number(el.dataset.counter);
      const start = performance.now();
      const tick = (now: number) => {
        const p = Math.min(1, (now - start) / 1200);
        el.textContent = String(Math.round(target * (1 - Math.pow(1 - p, 3))));
        if (p < 1) requestAnimationFrame(tick);
      };
      requestAnimationFrame(tick);
    };
    const reveal = (el: HTMLElement) => {
      el.style.opacity = '1';
      el.style.transform = 'none';
      const counter = el.querySelector<HTMLElement>('[data-counter]');
      if (counter) runCounter(counter);
    };
    const observer = new IntersectionObserver(
      (entries) => entries.forEach((entry) => {
        if (entry.isIntersecting) {
          reveal(entry.target as HTMLElement);
          observer.unobserve(entry.target);
        }
      }),
      { threshold: 0.15, rootMargin: '0px 0px -40px 0px' },
    );
    els.forEach((el) => observer.observe(el));
    const safety = window.setTimeout(() => els.forEach(reveal), 4000);
    return () => { observer.disconnect(); window.clearTimeout(safety); };
  }, []);

  const toLogin = () => navigate('/login');

  const btnPrimary =
    'rounded-[13px] bg-accent font-semibold text-white shadow-lg shadow-accent/40 transition hover:-translate-y-0.5 hover:bg-accent-hover focus:outline-none focus-visible:ring-[3px] focus-visible:ring-accent/30';
  const btnGhost =
    'rounded-[13px] border border-line bg-white font-semibold text-ink transition hover:border-accent hover:text-accent-hover hover:shadow-md hover:shadow-accent/20 focus:outline-none focus-visible:ring-[3px] focus-visible:ring-accent/25';

  return (
    <div ref={rootRef} className="min-h-screen bg-white text-ink">
      <style>{`@keyframes dkFloat { 0%,100% { transform: translateY(0); } 50% { transform: translateY(-10px); } }`}</style>

      <header className="sticky top-0 z-50 border-b border-line/70 bg-white/85 backdrop-blur-md">
        <div className="mx-auto flex max-w-6xl items-center justify-between gap-4 px-6 py-3.5">
          <a href="/" className="flex items-center gap-2.5">
            <LogoMark />
            <span className="text-lg font-bold tracking-tight text-ink">Dokladovka</span>
          </a>
          <nav className="flex items-center gap-2.5">
            <button type="button" onClick={toLogin} className={`${btnGhost} text-sm`} style={{ padding: '10px 18px' }}>
              Prihlásiť sa
            </button>
            <button type="button" onClick={toLogin} className={`${btnPrimary} text-sm`} style={{ padding: '10px 18px' }}>
              Registrovať sa
            </button>
          </nav>
        </div>
      </header>

      {/* Hero */}
      <section
        className="relative overflow-hidden"
        style={{
          background:
            'radial-gradient(1000px 520px at 15% -120px, rgba(14,122,95,0.10), rgba(14,122,95,0) 60%), ' +
            'radial-gradient(900px 500px at 95% 20%, rgba(14,122,95,0.07), rgba(14,122,95,0) 55%), #fff',
        }}
      >
        <div className="mx-auto grid max-w-6xl items-center gap-14 px-6 pb-24 pt-20 lg:grid-cols-[1.05fr_0.95fr]">
          <div data-reveal="0">
            <div className="inline-flex items-center gap-2 rounded-full bg-accent/10 px-3.5 py-1.5 text-[13px] font-semibold text-accent-hover">
              <span className="h-1.5 w-1.5 rounded-full bg-accent" />
              Pre účtovníkov a účtovné firmy
            </div>
            <h1 className="mt-5 text-4xl font-extrabold leading-[1.08] tracking-tight sm:text-5xl xl:text-[54px]" style={{ textWrap: 'balance' }}>
              Účtovníctvo bez ručného prepisovania faktúr
            </h1>
            <p className="mt-5 max-w-lg text-lg leading-relaxed text-ink-soft" style={{ textWrap: 'pretty' }}>
              Dokladovka automaticky spracuje prijaté faktúry, rozpozná všetky údaje vrátane DPH a pripraví export do systému POHODA.
            </p>
            <div className="mt-8 flex flex-wrap gap-3">
              <button type="button" onClick={toLogin} className={`${btnPrimary} px-7 py-3.5 text-base`}>Začnite zadarmo</button>
              <button type="button" onClick={toLogin} className={`${btnGhost} px-7 py-3.5 text-base`}>Prihlásiť sa</button>
            </div>
          </div>

          {/* Ukážka spracovanej faktúry */}
          <div data-reveal="1" className="relative">
            <div className="absolute -inset-x-2 inset-y-6 rotate-3 rounded-[32px] bg-gradient-to-br from-accent/15 to-accent/5" />
            <div className="relative" style={{ animation: 'dkFloat 7s ease-in-out infinite' }}>
              <div className="rounded-[22px] bg-white p-6 shadow-[0_2px_4px_rgba(27,31,29,0.04),0_24px_48px_-16px_rgba(27,31,29,0.16),0_48px_96px_-32px_rgba(14,122,95,0.18)]">
                <div className="flex items-center justify-between gap-3">
                  <div className="flex items-center gap-2.5">
                    <span className="grid place-items-center rounded-[10px] bg-accent/10" style={{ width: 34, height: 34 }}>
                      <svg width="17" height="17" viewBox="0 0 24 24" fill="none">
                        <path d="M6 3.5h8.5L19 8v12a1.5 1.5 0 0 1-1.5 1.5h-11A1.5 1.5 0 0 1 5 20V5a1.5 1.5 0 0 1 1-1.5z" stroke="#0E7A5F" strokeWidth="1.8" strokeLinejoin="round" />
                        <path d="M9 12.5h6M9 16h6" stroke="#0E7A5F" strokeWidth="1.8" strokeLinecap="round" />
                      </svg>
                    </span>
                    <div>
                      <p className="text-sm font-semibold">Faktúra 2026/0142</p>
                      <p className="mt-0.5 text-xs text-ink-soft">prijatá e-mailom · dnes 9:24</p>
                    </div>
                  </div>
                  <span className="inline-flex items-center gap-1.5 rounded-full bg-accent/10 px-3 py-1.5 text-xs font-semibold text-accent-hover">
                    <svg width="11" height="11" viewBox="0 0 24 24" fill="none"><path d="M4 12.5l5 5L20 6.5" stroke="#0A6650" strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round" /></svg>
                    Spracované AI
                  </span>
                </div>
                <div className="grid grid-cols-2 gap-2.5" style={{ marginTop: 18 }}>
                  <div className="col-span-2 rounded-xl border border-[#EDF0EC] bg-[#FBFCFB] px-3.5 py-3">
                    <p className="text-[11px] font-medium uppercase tracking-wider text-ink-soft">Dodávateľ</p>
                    <p className="mt-1 text-sm font-semibold">Alfa Trade s.r.o. · IČO 36 415 227</p>
                  </div>
                  {HERO_FIELDS.map((f) => (
                    <div key={f.label} className="rounded-xl border border-[#EDF0EC] bg-[#FBFCFB] px-3.5 py-3">
                      <p className="text-[11px] font-medium uppercase tracking-wider text-ink-soft">{f.label}</p>
                      <p className={`tnum mt-1 text-sm font-semibold ${f.green ? 'text-accent-hover' : ''} ${f.strong ? 'text-[15px] font-bold' : ''}`}>{f.value}</p>
                    </div>
                  ))}
                </div>
                <div className="mt-3.5 flex items-center justify-between gap-2.5 rounded-xl bg-gradient-to-r from-accent/10 to-accent/[0.04] px-3.5 py-3">
                  <span className="flex items-center gap-2 text-[13px] font-semibold text-accent-hover">
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none"><path d="M12 4v11m0 0l-4-4m4 4l4-4M5 20h14" stroke="#0A6650" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" /></svg>
                    Export do POHODA · dataPack XML
                  </span>
                  <span className="text-xs font-semibold text-accent">Pripravené</span>
                </div>
              </div>
            </div>
          </div>
        </div>
      </section>

      {/* Prečo Dokladovka */}
      <section className="border-y border-[#EDF0EC] bg-app">
        <div className="mx-auto max-w-6xl px-6 py-20">
          <div data-reveal="0" className="mx-auto max-w-xl text-center">
            <p className="text-[13px] font-bold uppercase tracking-widest text-accent">Prečo Dokladovka</p>
            <h2 className="mt-3.5 text-3xl font-bold tracking-tight sm:text-4xl" style={{ textWrap: 'balance' }}>
              Všetko, čo potrebujete na rýchlejšie účtovanie
            </h2>
          </div>
          <div className="mt-12 grid sm:grid-cols-2 lg:grid-cols-4" style={{ gap: 18 }}>
            {FEATURES.map((f, i) => (
              <div
                key={f.title}
                data-reveal={i}
                className="rounded-[18px] bg-white p-6 shadow-[0_1px_2px_rgba(27,31,29,0.04),0_10px_28px_-14px_rgba(27,31,29,0.12)] transition hover:-translate-y-1 hover:shadow-[0_2px_4px_rgba(27,31,29,0.04),0_18px_40px_-16px_rgba(14,122,95,0.25)]"
              >
                <span className="grid place-items-center rounded-[13px] bg-accent/10" style={{ width: 42, height: 42 }}>{f.icon}</span>
                <h3 className="mt-4 text-base font-semibold">{f.title}</h3>
                <p className="mt-2 text-sm leading-relaxed text-ink-soft">{f.text}</p>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* Ako to funguje */}
      <section className="bg-white">
        <div className="mx-auto max-w-6xl px-6 py-24">
          <div data-reveal="0" className="mx-auto max-w-xl text-center">
            <p className="text-[13px] font-bold uppercase tracking-widest text-accent">Ako to funguje</p>
            <h2 className="mt-3.5 text-3xl font-bold tracking-tight sm:text-4xl" style={{ textWrap: 'balance' }}>
              Tri kroky od e-mailu po zaúčtovanie
            </h2>
          </div>
          <div className="relative mt-14 grid gap-5 sm:grid-cols-3">
            <div
              aria-hidden
              className="absolute left-[16%] right-[16%] top-[27px] hidden h-0.5 sm:block"
              style={{ background: 'repeating-linear-gradient(90deg, #CFE0DA 0 8px, transparent 8px 16px)' }}
            />
            {STEPS.map((step, i) => (
              <div key={step} data-reveal={i} className="relative px-4 text-center">
                <span className="relative z-10 inline-grid h-[54px] w-[54px] place-items-center rounded-full bg-gradient-to-b from-accent to-accent-hover text-xl font-bold text-white shadow-lg shadow-accent/40 ring-[7px] ring-white">
                  {i + 1}
                </span>
                <h3 className="text-[17px] font-semibold" style={{ marginTop: 18 }}>{step}</h3>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* Čísla */}
      <section className="border-t border-[#EDF0EC] bg-gradient-to-b from-app to-white">
        <div className="mx-auto grid max-w-6xl gap-5 px-6 py-20 text-center sm:grid-cols-3">
          <div data-reveal="0">
            <p className="tnum text-5xl font-extrabold tracking-tight text-accent xl:text-[56px]">
              <span data-counter="10">0</span>×
            </p>
            <p className="mt-2 text-[15px] font-medium text-ink-soft">rýchlejšie spracovanie</p>
          </div>
          <div data-reveal="1">
            <p className="text-5xl font-extrabold tracking-tight text-accent xl:text-[56px]">Menej chýb</p>
            <p className="mt-2 text-[15px] font-medium text-ink-soft">pri prepise dokladov</p>
          </div>
          <div data-reveal="2">
            <p className="text-5xl font-extrabold tracking-tight text-accent xl:text-[56px]">Viac času</p>
            <p className="mt-2 text-[15px] font-medium text-ink-soft">na skutočné účtovníctvo</p>
          </div>
        </div>
      </section>

      {/* CTA */}
      <section className="bg-white px-6 pb-24 pt-10">
        <div
          data-reveal="0"
          className="mx-auto max-w-6xl rounded-[28px] text-center shadow-[0_30px_60px_-24px_rgba(10,102,80,0.5)]"
          style={{
            padding: '72px 32px',
            background:
              'radial-gradient(700px 300px at 50% -80px, rgba(255,255,255,0.14), rgba(255,255,255,0) 60%), ' +
              'linear-gradient(145deg, #0E7A5F, #0A6650)',
          }}
        >
          <h2 className="text-3xl font-extrabold tracking-tight text-white sm:text-4xl xl:text-[42px]" style={{ textWrap: 'balance' }}>
            Začnite účtovať rýchlejšie ešte dnes
          </h2>
          <p className="mx-auto mt-4 max-w-md text-base leading-relaxed text-white/80">
            Bez inštalácie a bez zmeny vašich postupov — faktúry len presmerujete e-mailom.
          </p>
          <button
            type="button"
            onClick={toLogin}
            className="mt-8 rounded-[13px] bg-white px-8 py-4 text-base font-bold text-accent-hover shadow-xl transition hover:-translate-y-0.5 focus:outline-none focus-visible:ring-[3px] focus-visible:ring-white/50"
          >
            Vytvoriť účet zadarmo
          </button>
        </div>
      </section>

      <footer className="border-t border-[#EDF0EC] bg-app">
        <div className="mx-auto flex max-w-6xl flex-wrap items-start justify-between gap-7 px-6 pb-10 pt-12">
          <div className="max-w-xs">
            <div className="flex items-center gap-2.5">
              <LogoMark size={32} />
              <span className="text-[17px] font-bold">Dokladovka</span>
            </div>
            <p className="mt-3 text-[13.5px] leading-relaxed text-ink-soft">
              Automatizované spracovanie faktúr a export do systému POHODA pre účtovníkov a účtovné firmy.
            </p>
          </div>
          <nav className="flex gap-7 text-sm font-medium">
            <a href="#" className="text-ink-soft hover:text-accent-hover">Kontakt</a>
            <a href="#" className="text-ink-soft hover:text-accent-hover">Ochrana údajov</a>
            <a href="#" className="text-ink-soft hover:text-accent-hover">Podmienky</a>
          </nav>
        </div>
        <div className="mx-auto max-w-6xl px-6 pb-8">
          <p className="border-t border-line pt-5 text-[12.5px] text-ink-soft">© 2026 Dokladovka. Všetky práva vyhradené.</p>
        </div>
      </footer>
    </div>
  );
}

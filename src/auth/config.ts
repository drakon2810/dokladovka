export const AUTH_MODE: 'demo' | 'bff' =
  import.meta.env.VITE_AUTH_MODE === 'demo' ? 'demo' : 'bff';

/** Verejné demo heslo. Nie je to produkčný secret ani používateľský credential. */
export const DEMO_PASSWORD = 'Dokladovka2026!';

export const DEMO_ACCOUNTS = [
  { email: 'andrej@kancelaria.sk', role: 'admin' as const },
  { email: 'maria@kancelaria.sk', role: 'uctovnik' as const },
  { email: 'peter@kancelaria.sk', role: 'schvalovatel' as const },
] as const;

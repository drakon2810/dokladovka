import { useEffect, useState } from 'react';
import { getCachedSnapshot, getDataSnapshot, subscribeDataChanges } from './api';
import type { AppDataState } from './store';

export interface DataQueryState {
  data?: AppDataState;
  loading: boolean;
  error?: Error;
}

/** React query facade nad async service boundary (mock cache dnes, REST neskôr). */
export function useDataQuery(): DataQueryState {
  // Seed zo zdieľanej cache: pri navigácii (nová stránka, prepnutie firmy)
  // vykreslíme okamžite posledné známe dáta namiesto spinnera, a obnovíme na
  // pozadí. Pri studenom štarte cache neexistuje → klasický loading stav.
  const [state, setState] = useState<DataQueryState>(() => {
    const cached = getCachedSnapshot();
    return cached ? { data: cached, loading: false } : { loading: true };
  });

  useEffect(() => {
    let active = true;
    let request = 0;
    const load = async () => {
      const current = ++request;
      try {
        const data = await getDataSnapshot();
        if (active && current === request) setState({ data, loading: false });
      } catch (cause) {
        if (active && current === request) {
          setState({
            loading: false,
            error: cause instanceof Error ? cause : new Error(String(cause)),
          });
        }
      }
    };

    void load();
    // Zdieľaný poller volá listener bez dát → obnova zo siete (dedup zaručí
    // jediný fetch pre všetkých). Push s dátami (napr. prepnutie firmy) sa
    // aplikuje priamo, bez siete.
    const unsubscribe = subscribeDataChanges((pushed) => {
      if (pushed) {
        if (active) setState({ data: pushed, loading: false });
      } else {
        void load();
      }
    });
    return () => {
      active = false;
      unsubscribe();
    };
  }, []);

  return state;
}

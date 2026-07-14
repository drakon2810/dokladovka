import { useEffect, useState } from 'react';
import { getDataSnapshot, subscribeDataChanges } from './api';
import type { AppDataState } from './store';

export interface DataQueryState {
  data?: AppDataState;
  loading: boolean;
  error?: Error;
}

/** React query facade nad async service boundary (mock cache dnes, REST neskôr). */
export function useDataQuery(): DataQueryState {
  const [state, setState] = useState<DataQueryState>({ loading: true });

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
    const unsubscribe = subscribeDataChanges(() => void load());
    return () => {
      active = false;
      unsubscribe();
    };
  }, []);

  return state;
}

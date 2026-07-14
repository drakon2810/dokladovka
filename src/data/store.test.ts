import { describe, expect, it } from 'vitest';
import { buildSeedState } from './mock/seed';
import { APP_STORE_PERSIST_VERSION, migratePersistedState } from './store';

describe('persist migrácia v5 → v6', () => {
  it('doplní bezpečné defaults pre staré položky číselníkov', () => {
    const persisted = structuredClone(buildSeedState()) as ReturnType<typeof buildSeedState>;
    for (const items of Object.values(persisted.codeLists)) {
      for (const item of items) {
        delete (item as Partial<typeof item>).source;
        delete (item as Partial<typeof item>).active;
      }
    }

    const migrated = migratePersistedState(persisted, 5);

    for (const items of Object.values(migrated.codeLists)) {
      expect(items.length).toBeGreaterThan(0);
      expect(items.every((item) => item.source === 'manual' && item.active)).toBe(true);
    }
  });

  it('zachová už uložený pôvod a neaktívny stav', () => {
    const persisted = structuredClone(buildSeedState());
    persisted.codeLists.predkontacie[0] = {
      ...persisted.codeLists.predkontacie[0],
      source: 'pohoda',
      active: false,
      externalId: '42',
    };

    const migrated = migratePersistedState(persisted, 5);

    expect(migrated.codeLists.predkontacie[0]).toMatchObject({
      source: 'pohoda',
      active: false,
      externalId: '42',
    });
  });

  it('publikuje persist verziu 6', () => {
    expect(APP_STORE_PERSIST_VERSION).toBe(7);
  });
});

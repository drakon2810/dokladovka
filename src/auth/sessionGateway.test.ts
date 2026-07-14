import { beforeEach, describe, expect, it } from 'vitest';
import { resetDemoData, setRole } from '../data/api';
import { storeApi } from '../data/store';
import { DEMO_PASSWORD } from './config';
import { isAuthSession, sessionGateway } from './sessionGateway';

beforeEach(async () => {
  await sessionGateway.logout();
  await setRole('admin');
  await resetDemoData();
});

describe('demo session gateway', () => {
  it('prihlási existujúceho používateľa bez uloženia hesla do session', async () => {
    const session = await sessionGateway.login({
      email: 'andrej@kancelaria.sk',
      password: DEMO_PASSWORD,
    });

    expect(session.mode).toBe('demo');
    expect(session.user.role).toBe('admin');
    expect(storeApi.get().role).toBe('admin');
    expect(JSON.stringify(session)).not.toContain(DEMO_PASSWORD);
    expect((await sessionGateway.getSession())?.user.email).toBe('andrej@kancelaria.sk');
  });

  it('odmietne nesprávne heslo a logout zruší session', async () => {
    await expect(
      sessionGateway.login({ email: 'andrej@kancelaria.sk', password: 'wrong' }),
    ).rejects.toMatchObject({ code: 'invalid_credentials' });

    await sessionGateway.login({ email: 'maria@kancelaria.sk', password: DEMO_PASSWORD });
    await sessionGateway.logout();
    expect(await sessionGateway.getSession()).toBeNull();
  });

  it('uloží vlastný profil a vráti čerstvú session bez hesiel alebo tokenov', async () => {
    const session = await sessionGateway.login({
      email: 'andrej@kancelaria.sk',
      password: DEMO_PASSWORD,
    });

    const updated = await sessionGateway.updateProfile(
      {
        name: '  Andrej Nový  ',
        language: 'sk',
        notifications: {
          email: false,
          inApp: true,
          comments: false,
          mentions: true,
        },
      },
      session,
    );

    expect(updated.user.name).toBe('Andrej Nový');
    expect(updated.user.notifications).toEqual({
      email: false,
      inApp: true,
      comments: false,
      mentions: true,
    });
    expect(updated.user.security).toEqual({
      twoFactor: { enabled: false, canManage: false },
      google: { connected: false, canManage: false },
      microsoft: { connected: false, canManage: false },
    });
    expect((await sessionGateway.getSession())?.user.name).toBe('Andrej Nový');
    expect(storeApi.get().users.find((user) => user.id === session.user.id)?.meno).toBe(
      'Andrej Nový',
    );
    expect(JSON.stringify(updated)).not.toContain(DEMO_PASSWORD);
    expect(JSON.stringify(updated)).not.toContain('accessToken');
  });

  it('validuje bezpečnostný a notifikačný kontrakt session z BFF', () => {
    expect(
      isAuthSession({
        mode: 'bff',
        expiresAt: '2030-01-01T00:00:00.000Z',
        csrfToken: 'csrf-is-not-an-access-token',
        user: {
          id: 'server-user',
          tenantId: 'server-tenant',
          name: 'Server User',
          email: 'user@example.test',
          role: 'uctovnik',
          organizationIds: ['org-1'],
          language: 'sk',
          notifications: { email: true, inApp: true, comments: true, mentions: true },
          security: {
            twoFactor: { enabled: true, canManage: true },
            google: { connected: true, canManage: true },
            microsoft: { connected: false, canManage: true },
          },
        },
      }),
    ).toBe(true);

    expect(
      isAuthSession({
        mode: 'bff',
        expiresAt: '2030-01-01T00:00:00.000Z',
        user: {
          id: 'server-user',
          tenantId: 'server-tenant',
          name: 'Server User',
          email: 'user@example.test',
          role: 'uctovnik',
          organizationIds: [],
          language: 'sk',
          notifications: { email: true },
          security: {},
        },
      }),
    ).toBe(false);
  });
});

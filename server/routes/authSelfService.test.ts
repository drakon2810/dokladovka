import { afterEach, describe, expect, it } from 'vitest';
import { buildApp } from '../app.js';
import { MemoryObjectStorage } from '../storage.js';
import { createTestDatabase, memoryMailer, seedTestUser, testConfig } from '../testHelpers.js';

const databases: Awaited<ReturnType<typeof createTestDatabase>>[] = [];

afterEach(async () => {
  await Promise.all(databases.splice(0).map((database) => database.close()));
});

async function harness() {
  const database = await createTestDatabase();
  databases.push(database);
  const mailer = memoryMailer();
  const app = await buildApp({
    database,
    storage: new MemoryObjectStorage(),
    config: testConfig(),
    logger: false,
    mailer,
  });
  return { app, database, mailer };
}

function codeFromMail(text: string): string {
  return text.match(/\b(\d{6})\b/)?.[1] ?? '';
}

function tokenFromMail(text: string): string {
  return text.match(/obnova-hesla\?token=([^\s]+)/)?.[1] ?? '';
}

describe('registrácia s overovacím kódom', () => {
  it('pošle kód, po potvrdení založí tenanta s adminom a prihlási', async () => {
    const { app, database, mailer } = await harness();
    const registered = await app.inject({
      method: 'POST',
      url: '/api/auth/register',
      payload: { name: 'Nový Účtovník', email: 'novy@firma.sk', password: 'Dokladovka2026!' },
    });
    expect(registered.statusCode).toBe(200);
    // Do users sa pred overením nezapisuje nič.
    expect((await database.query('SELECT 1 FROM users')).rowCount).toBe(0);

    const registrationId = registered.json().registrationId as string;
    const code = codeFromMail(mailer.sent.at(-1)!.text);
    expect(code).toMatch(/^\d{6}$/);

    const wrong = await app.inject({
      method: 'POST',
      url: '/api/auth/register/confirm',
      payload: { registrationId, code: code === '000000' ? '111111' : '000000' },
    });
    expect(wrong.statusCode).toBe(400);
    expect(wrong.json().code).toBe('code_invalid');

    const confirmed = await app.inject({
      method: 'POST',
      url: '/api/auth/register/confirm',
      payload: { registrationId, code },
    });
    expect(confirmed.statusCode).toBe(200);
    expect(confirmed.json()).toMatchObject({ mode: 'bff', user: { email: 'novy@firma.sk', role: 'admin' } });
    expect(String(confirmed.headers['set-cookie'])).toContain('dokladovka_session=');
    expect((await database.query('SELECT 1 FROM pending_registrations')).rowCount).toBe(0);

    // Kód je jednorazový a nové heslo funguje pri bežnom prihlásení.
    const replay = await app.inject({
      method: 'POST',
      url: '/api/auth/register/confirm',
      payload: { registrationId, code },
    });
    expect(replay.statusCode).toBe(400);
    const login = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { email: 'novy@firma.sk', password: 'Dokladovka2026!' },
    });
    expect(login.statusCode).toBe(200);
    await app.close();
  }, 90_000);

  it('na obsadenú adresu neposiela kód a nepodstrčí existujúci účet', async () => {
    const { app, database, mailer } = await harness();
    const seeded = await seedTestUser(database);
    const registered = await app.inject({
      method: 'POST',
      url: '/api/auth/register',
      payload: { name: 'Útočník', email: seeded.email, password: 'ine-heslo-12345' },
    });
    // Rovnaká odpoveď ako pri voľnej adrese (žiadna enumerácia), ale bez kódu.
    expect(registered.statusCode).toBe(200);
    expect(codeFromMail(mailer.sent.at(-1)!.text)).toBe('');
    expect((await database.query('SELECT 1 FROM pending_registrations')).rowCount).toBe(0);

    const stillOldPassword = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { email: seeded.email, password: seeded.password },
    });
    expect(stillOldPassword.statusCode).toBe(200);
    await app.close();
  }, 90_000);

  it('kód po vypršaní platnosti neprejde', async () => {
    const { app, database, mailer } = await harness();
    const registered = await app.inject({
      method: 'POST',
      url: '/api/auth/register',
      payload: { name: 'Pomalý', email: 'pomaly@firma.sk', password: 'Dokladovka2026!' },
    });
    const code = codeFromMail(mailer.sent.at(-1)!.text);
    await database.query("UPDATE pending_registrations SET expires_at = now() - interval '1 minute'");
    const late = await app.inject({
      method: 'POST',
      url: '/api/auth/register/confirm',
      payload: { registrationId: registered.json().registrationId, code },
    });
    expect(late.statusCode).toBe(400);
    expect(late.json().code).toBe('code_invalid');
    await app.close();
  }, 90_000);

  it('po piatich zlých pokusoch je kód mŕtvy aj pri správnom zadaní', async () => {
    const { app, mailer } = await harness();
    const registered = await app.inject({
      method: 'POST',
      url: '/api/auth/register',
      payload: { name: 'Hádač', email: 'hadac@firma.sk', password: 'Dokladovka2026!' },
    });
    const registrationId = registered.json().registrationId as string;
    const code = codeFromMail(mailer.sent.at(-1)!.text);
    const wrong = code === '000000' ? '111111' : '000000';
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const response = await app.inject({
        method: 'POST',
        url: '/api/auth/register/confirm',
        payload: { registrationId, code: wrong },
      });
      expect(response.statusCode).toBe(400);
    }
    const correct = await app.inject({
      method: 'POST',
      url: '/api/auth/register/confirm',
      payload: { registrationId, code },
    });
    expect(correct.statusCode).toBe(400);
    await app.close();
  }, 90_000);

  it('cudzí pokus prepíše čakajúcu registráciu, ale pôvodné id už kód nepotvrdí', async () => {
    const { app, database, mailer } = await harness();
    const obet = await app.inject({
      method: 'POST',
      url: '/api/auth/register',
      payload: { name: 'Obeť', email: 'obet@firma.sk', password: 'Dokladovka2026!' },
    });
    const utocnik = await app.inject({
      method: 'POST',
      url: '/api/auth/register',
      payload: { name: 'Útočník', email: 'obet@firma.sk', password: 'heslo-utocnika-1' },
    });
    // Obeti príde kód útočníka; s vlastným (starým) id ho potvrdiť nemôže,
    // takže si nezaloží účet s heslom útočníka.
    const utocnikovKod = codeFromMail(mailer.sent.at(-1)!.text);
    const podvrhnute = await app.inject({
      method: 'POST',
      url: '/api/auth/register/confirm',
      payload: { registrationId: obet.json().registrationId, code: utocnikovKod },
    });
    expect(podvrhnute.statusCode).toBe(400);
    expect((await database.query('SELECT 1 FROM users')).rowCount).toBe(0);
    // Útočník síce potvrdiť vie — ale iba adresu, ku ktorej má prístup k pošte.
    expect(utocnik.json().registrationId).not.toBe(obet.json().registrationId);
    await app.close();
  }, 90_000);
});

describe('obnova zabudnutého hesla', () => {
  it('pošle odkaz, nastaví heslo a zruší staré relácie', async () => {
    const { app, database, mailer } = await harness();
    const seeded = await seedTestUser(database);
    const login = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { email: seeded.email, password: seeded.password },
    });
    const cookie = String(login.headers['set-cookie']).split(';')[0];

    const requested = await app.inject({
      method: 'POST',
      url: '/api/auth/password/forgot',
      payload: { email: seeded.email },
    });
    expect(requested.statusCode).toBe(200);
    const token = tokenFromMail(mailer.sent.at(-1)!.text);
    expect(token).not.toBe('');

    const reset = await app.inject({
      method: 'POST',
      url: '/api/auth/password/reset',
      payload: { token, password: 'uplne-nove-heslo-9' },
    });
    expect(reset.statusCode).toBe(200);

    // Pôvodná relácia padá, staré heslo neplatí, nové áno.
    const oldSession = await app.inject({ method: 'GET', url: '/api/auth/session', headers: { cookie } });
    expect(oldSession.statusCode).toBe(401);
    const oldPassword = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { email: seeded.email, password: seeded.password },
    });
    expect(oldPassword.statusCode).toBe(401);
    const newPassword = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { email: seeded.email, password: 'uplne-nove-heslo-9' },
    });
    expect(newPassword.statusCode).toBe(200);

    // Token je jednorazový.
    const replay = await app.inject({
      method: 'POST',
      url: '/api/auth/password/reset',
      payload: { token, password: 'este-inace-heslo-1' },
    });
    expect(replay.statusCode).toBe(400);
    await app.close();
  }, 90_000);

  it('neexistujúcu adresu nepriezradí a neposiela odkaz', async () => {
    const { app, mailer } = await harness();
    const response = await app.inject({
      method: 'POST',
      url: '/api/auth/password/forgot',
      payload: { email: 'nikto@firma.sk' },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ status: 'sent' });
    expect(mailer.sent).toHaveLength(0);
    await app.close();
  }, 90_000);

  it('odmietne vypršaný odkaz', async () => {
    const { app, database, mailer } = await harness();
    const seeded = await seedTestUser(database);
    await app.inject({ method: 'POST', url: '/api/auth/password/forgot', payload: { email: seeded.email } });
    const token = tokenFromMail(mailer.sent.at(-1)!.text);
    await database.query("UPDATE password_reset_tokens SET expires_at = now() - interval '1 minute'");
    const response = await app.inject({
      method: 'POST',
      url: '/api/auth/password/reset',
      payload: { token, password: 'uplne-nove-heslo-9' },
    });
    expect(response.statusCode).toBe(400);
    expect(response.json().code).toBe('token_invalid');
    await app.close();
  }, 90_000);
});

describe('captcha', () => {
  it('bez tokenu odmietne prihlásenie, keď je Turnstile zapnutý', async () => {
    const database = await createTestDatabase();
    databases.push(database);
    const seeded = await seedTestUser(database);
    const app = await buildApp({
      database,
      storage: new MemoryObjectStorage(),
      config: testConfig({ turnstile: { siteKey: 'site', secretKey: 'secret' } }),
      logger: false,
      mailer: memoryMailer(),
    });
    const response = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { email: seeded.email, password: seeded.password },
    });
    expect(response.statusCode).toBe(400);
    expect(response.json().code).toBe('captcha_required');
    await app.close();
  }, 90_000);

  it('verejný kľúč widgetu vydáva /api/config/public', async () => {
    const database = await createTestDatabase();
    databases.push(database);
    const app = await buildApp({
      database,
      storage: new MemoryObjectStorage(),
      config: testConfig({ turnstile: { siteKey: '0x4AAA', secretKey: 'secret' } }),
      logger: false,
      mailer: memoryMailer(),
    });
    const response = await app.inject({ method: 'GET', url: '/api/config/public' });
    expect(response.json().turnstileSiteKey).toBe('0x4AAA');
    await app.close();
  }, 90_000);
});

import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import { buildApp } from '../app.js';
import { hashPassword } from '../security.js';
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
  const app = await buildApp({ database, storage: new MemoryObjectStorage(), config: testConfig(), logger: false, mailer });
  const seeded = await seedTestUser(database);
  return { app, database, mailer, seeded };
}

type App = Awaited<ReturnType<typeof harness>>['app'];

async function prihlas(app: App, email: string, password: string) {
  const login = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { email, password } });
  expect(login.statusCode, login.body).toBe(200);
  return { cookie: String(login.headers['set-cookie']).split(';')[0], 'x-csrf-token': login.json().csrfToken as string };
}

function tokenZMailu(text: string): string {
  return decodeURIComponent(text.match(/pozvanka\?token=([^\s]+)/)?.[1] ?? '');
}

async function firma(database: Awaited<ReturnType<typeof createTestDatabase>>, tenantId: string, nazov: string): Promise<string> {
  const id = randomUUID();
  await database.query(
    `INSERT INTO organizations (id,tenant_id,name,ico,dic,color) VALUES ($1,$2,$3,$4,'','#0E7A5F')`,
    [id, tenantId, nazov, String(Math.floor(10_000_000 + Math.random() * 89_999_999))],
  );
  return id;
}

async function firmyPouzivatela(database: Awaited<ReturnType<typeof createTestDatabase>>, userId: string): Promise<string[]> {
  const result = await database.query<{ organization_id: string } & Record<string, unknown>>(
    'SELECT organization_id FROM organization_memberships WHERE user_id=$1 ORDER BY organization_id', [userId],
  );
  return result.rows.map((row) => row.organization_id);
}

describe('pozvánky do kancelárie', () => {
  // Šéfka pozve účtovníka k dvom firmám z troch. Vidí presne tie dve, patrí do
  // tej istej kancelárie — a tým aj k tomu istému Mostíku, ktorý je kancelárie.
  it('účtovník po prijatí vidí len vybrané firmy a je v tej istej kancelárii', async () => {
    const { app, database, mailer, seeded } = await harness();
    const druha = await firma(database, seeded.tenantId, 'Druhá s.r.o.');
    const tretia = await firma(database, seeded.tenantId, 'Tretia s.r.o.');
    const sef = await prihlas(app, seeded.email, seeded.password);

    const pozvanka = await app.inject({
      method: 'POST', url: '/api/users/invitations', headers: sef,
      payload: { email: 'm.kazlouski@upkz.sk', meno: 'Mikita K', rola: 'uctovnik', organizationIds: [seeded.organizationId, druha] },
    });
    expect(pozvanka.statusCode, pozvanka.body).toBe(201);
    const mail = mailer.sent.at(-1)!;
    expect(mail.to).toBe('m.kazlouski@upkz.sk');
    const token = tokenZMailu(mail.text);
    expect(token.length).toBeGreaterThan(16);

    const nahlad = await app.inject({ method: 'GET', url: `/api/invitations/${encodeURIComponent(token)}` });
    expect(nahlad.json()).toMatchObject({ kancelaria: 'Test tenant', email: 'm.kazlouski@upkz.sk', existujuciUcet: false });

    const kratke = await app.inject({ method: 'POST', url: '/api/invitations/accept', payload: { token, heslo: 'kratke' } });
    expect(kratke.json().code).toBe('password_too_short');

    const prijate = await app.inject({ method: 'POST', url: '/api/invitations/accept', payload: { token, heslo: 'Dostatocne-dlhe-heslo' } });
    expect(prijate.statusCode, prijate.body).toBe(200);
    const novy = (await database.query<{ id: string; tenant_id: string; role: string } & Record<string, unknown>>(
      'SELECT id, tenant_id, role FROM users WHERE email=$1', ['m.kazlouski@upkz.sk'],
    )).rows[0];
    // Tá istá kancelária — Mostík (agent_installations.tenant_id) je teda spoločný.
    expect(novy).toMatchObject({ tenant_id: seeded.tenantId, role: 'uctovnik' });
    expect(await firmyPouzivatela(database, novy.id)).toEqual([seeded.organizationId, druha].sort());

    // Tretiu firmu nevidí — prístup ide len cez členstvo.
    const ucto = { cookie: String(prijate.headers['set-cookie']).split(';')[0] };
    expect((await app.inject({ method: 'GET', url: `/api/organizations/${druha}`, headers: ucto })).statusCode).toBe(200);
    expect((await app.inject({ method: 'GET', url: `/api/organizations/${tretia}`, headers: ucto })).statusCode).toBe(404);

    // Odkaz sa dá použiť raz.
    const znova = await app.inject({ method: 'POST', url: '/api/invitations/accept', payload: { token, heslo: 'Dostatocne-dlhe-heslo' } });
    expect(znova.statusCode).toBe(400);
  }, 90_000);

  // Kolega sa zaregistroval sám skôr, než ho šéfka pozvala — registrácia mu
  // založila vlastnú prázdnu kanceláriu. Pozvánka ho presunie, ale len keď
  // dokáže doterajšie heslo: odkaz dokazuje schránku, heslo účet.
  it('presunie účet z prázdnej kancelárie, keď pozvaný zadá svoje doterajšie heslo', async () => {
    const { app, database, mailer, seeded } = await harness();
    const staraKancelaria = randomUUID();
    const kolegaId = randomUUID();
    await database.query('INSERT INTO tenants (id,name) VALUES ($1,$2)', [staraKancelaria, 'Mikita K']);
    await database.query(
      `INSERT INTO users (id,tenant_id,name,email,password_hash,role) VALUES ($1,$2,'Mikita K','m.kazlouski@upkz.sk',$3,'admin')`,
      [kolegaId, staraKancelaria, await hashPassword('Moje-stare-heslo-1')],
    );
    const staraRelacia = await prihlas(app, 'm.kazlouski@upkz.sk', 'Moje-stare-heslo-1');

    const sef = await prihlas(app, seeded.email, seeded.password);
    const pozvanka = await app.inject({
      method: 'POST', url: '/api/users/invitations', headers: sef,
      payload: { email: 'm.kazlouski@upkz.sk', meno: 'Mikita K', rola: 'uctovnik', organizationIds: [seeded.organizationId] },
    });
    expect(pozvanka.statusCode, pozvanka.body).toBe(201);
    expect(mailer.sent.at(-1)!.text).toContain('už účet máte');
    const token = tokenZMailu(mailer.sent.at(-1)!.text);
    expect((await app.inject({ method: 'GET', url: `/api/invitations/${encodeURIComponent(token)}` })).json().existujuciUcet).toBe(true);

    const zle = await app.inject({ method: 'POST', url: '/api/invitations/accept', payload: { token, heslo: 'cudzie-heslo-123' } });
    expect(zle.json().code).toBe('password_invalid');
    const stale = (await database.query<{ tenant_id: string } & Record<string, unknown>>('SELECT tenant_id FROM users WHERE id=$1', [kolegaId])).rows[0];
    expect(stale.tenant_id).toBe(staraKancelaria);

    const prijate = await app.inject({ method: 'POST', url: '/api/invitations/accept', payload: { token, heslo: 'Moje-stare-heslo-1' } });
    expect(prijate.statusCode, prijate.body).toBe(200);
    const presunuty = (await database.query<{ tenant_id: string; role: string } & Record<string, unknown>>(
      'SELECT tenant_id, role FROM users WHERE id=$1', [kolegaId],
    )).rows[0];
    expect(presunuty).toEqual({ tenant_id: seeded.tenantId, role: 'uctovnik' });
    expect(await firmyPouzivatela(database, kolegaId)).toEqual([seeded.organizationId]);
    // Relácia zo starej kancelárie padla.
    expect((await app.inject({ method: 'GET', url: '/api/auth/session', headers: staraRelacia })).statusCode).toBe(401);
  }, 90_000);

  it('nepresunie účet z kancelárie s firmami ani účet platformy', async () => {
    const { app, database, seeded } = await harness();
    const cudzia = randomUUID();
    await database.query('INSERT INTO tenants (id,name) VALUES ($1,$2)', [cudzia, 'Iná kancelária']);
    await database.query(
      `INSERT INTO users (id,tenant_id,name,email,password_hash,role) VALUES ($1,$2,'Cudzí','cudzi@ina.sk',$3,'admin')`,
      [randomUUID(), cudzia, await hashPassword('Nieco-dlhe-123')],
    );
    await firma(database, cudzia, 'Firma inej kancelárie');
    const platforma = randomUUID();
    await database.query('INSERT INTO tenants (id,name) VALUES ($1,$2)', [platforma, 'Platforma']);
    await database.query(
      `INSERT INTO users (id,tenant_id,name,email,password_hash,role) VALUES ($1,$2,'Platforma','platforma@dokladovka.site',$3,'superadmin')`,
      [randomUUID(), platforma, await hashPassword('Nieco-dlhe-123')],
    );

    const sef = await prihlas(app, seeded.email, seeded.password);
    for (const email of ['cudzi@ina.sk', 'platforma@dokladovka.site']) {
      const pozvanka = await app.inject({
        method: 'POST', url: '/api/users/invitations', headers: sef,
        payload: { email, meno: 'X', rola: 'uctovnik', organizationIds: [] },
      });
      expect(pozvanka.statusCode, email).toBe(409);
      expect(pozvanka.json().code).toBe('user_in_other_office');
    }
  }, 90_000);
});

describe('správa prístupu', () => {
  async function pozviAPrijmi(app: App, sef: Record<string, string>, mailer: ReturnType<typeof memoryMailer>, email: string, organizationIds: string[]) {
    const pozvanka = await app.inject({
      method: 'POST', url: '/api/users/invitations', headers: sef,
      payload: { email, meno: email, rola: 'uctovnik', organizationIds },
    });
    expect(pozvanka.statusCode, pozvanka.body).toBe(201);
    const token = tokenZMailu(mailer.sent.at(-1)!.text);
    const prijate = await app.inject({ method: 'POST', url: '/api/invitations/accept', payload: { token, heslo: 'Dostatocne-dlhe-heslo' } });
    expect(prijate.statusCode, prijate.body).toBe(200);
    return prijate;
  }

  // Povýšený na admina dostane všetky firmy; posledného admina degradovať nejde;
  // účtovník správu ľudí nevidí.
  it('rola admin dá všetky firmy, posledný admin ostane, účtovník správu nemá', async () => {
    const { app, database, mailer, seeded } = await harness();
    const druha = await firma(database, seeded.tenantId, 'Druhá s.r.o.');
    const sef = await prihlas(app, seeded.email, seeded.password);
    const prijate = await pozviAPrijmi(app, sef, mailer, 'ucto@upkz.sk', [druha]);
    const ucto = await prihlas(app, 'ucto@upkz.sk', 'Dostatocne-dlhe-heslo');
    expect(prijate.statusCode).toBe(200);

    expect((await app.inject({ method: 'GET', url: '/api/users', headers: ucto })).statusCode).toBe(403);

    const zoznam = (await app.inject({ method: 'GET', url: '/api/users', headers: sef })).json();
    const uctoId = zoznam.users.find((user: { email: string }) => user.email === 'ucto@upkz.sk').id as string;
    expect(zoznam.users.find((user: { id: string }) => user.id === uctoId).organizationIds).toEqual([druha]);

    // Výber firiem sa dá zmeniť.
    const zmena = await app.inject({ method: 'PUT', url: `/api/users/${uctoId}`, headers: sef, payload: { organizationIds: [seeded.organizationId] } });
    expect(zmena.statusCode, zmena.body).toBe(200);
    expect(await firmyPouzivatela(database, uctoId)).toEqual([seeded.organizationId]);

    // Povýšenie na admina = všetky firmy kancelárie.
    await app.inject({ method: 'PUT', url: `/api/users/${uctoId}`, headers: sef, payload: { rola: 'admin' } });
    expect(await firmyPouzivatela(database, uctoId)).toEqual([seeded.organizationId, druha].sort());

    // Dvaja admini: jeden sa degradovať dá, posledný už nie.
    expect((await app.inject({ method: 'PUT', url: `/api/users/${uctoId}`, headers: sef, payload: { rola: 'uctovnik' } })).statusCode).toBe(200);
    const posledny = await app.inject({ method: 'PUT', url: `/api/users/${seeded.userId}`, headers: sef, payload: { rola: 'uctovnik' } });
    expect(posledny.statusCode).toBe(409);
    expect(posledny.json().code).toBe('last_admin');
  }, 90_000);

  // Šéfka musí vidieť aj firmu, ktorú založil jej kolega-admin.
  it('novú firmu vidia všetci admini kancelárie', async () => {
    const { app, database, mailer, seeded } = await harness();
    const sef = await prihlas(app, seeded.email, seeded.password);
    await pozviAPrijmi(app, sef, mailer, 'kolega@upkz.sk', []);
    const kolegaId = (await database.query<{ id: string } & Record<string, unknown>>(
      'SELECT id FROM users WHERE email=$1', ['kolega@upkz.sk'],
    )).rows[0].id;
    await app.inject({ method: 'PUT', url: `/api/users/${kolegaId}`, headers: sef, payload: { rola: 'admin' } });
    const kolega = await prihlas(app, 'kolega@upkz.sk', 'Dostatocne-dlhe-heslo');

    const nova = await app.inject({
      method: 'POST', url: '/api/organizations', headers: kolega,
      payload: { nazov: 'Nová od kolegu', ico: '87654321', farba: '#0E7A5F' },
    });
    expect(nova.statusCode, nova.body).toBe(201);
    const novaId = nova.json().organization.id as string;
    expect(await firmyPouzivatela(database, seeded.userId)).toContain(novaId);
  }, 90_000);

  it('odstránený prišiel o prístup aj o relácie; seba odstrániť nejde', async () => {
    const { app, database, mailer, seeded } = await harness();
    const sef = await prihlas(app, seeded.email, seeded.password);
    await pozviAPrijmi(app, sef, mailer, 'odchadza@upkz.sk', [seeded.organizationId]);
    const odchadza = await prihlas(app, 'odchadza@upkz.sk', 'Dostatocne-dlhe-heslo');
    const id = (await database.query<{ id: string } & Record<string, unknown>>(
      'SELECT id FROM users WHERE email=$1', ['odchadza@upkz.sk'],
    )).rows[0].id;

    expect((await app.inject({ method: 'DELETE', url: `/api/users/${id}`, headers: sef })).statusCode).toBe(200);
    expect(await firmyPouzivatela(database, id)).toEqual([]);
    expect((await app.inject({ method: 'GET', url: '/api/auth/session', headers: odchadza })).statusCode).toBe(401);

    const seba = await app.inject({ method: 'DELETE', url: `/api/users/${seeded.userId}`, headers: sef });
    expect(seba.json().code).toBe('cannot_remove_self');
  }, 90_000);
});

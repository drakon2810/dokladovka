// Schvaľovanie bankového výpisu: POHODA má pre banku vlastné predkontácie
// a smer nesie agenda (bankReceived = príjem, bankIssued = výdaj) — predkontácia
// so známou inou agendou sa nesmie dostať do schváleného výpisu.
import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import { buildApp } from '../app.js';
import { MemoryObjectStorage } from '../storage.js';
import { createTestDatabase, seedTestUser, testConfig } from '../testHelpers.js';

const databases: Awaited<ReturnType<typeof createTestDatabase>>[] = [];
afterEach(async () => Promise.all(databases.splice(0).map((database) => database.close())));

function sessionHeaders(response: { headers: Record<string, unknown>; json(): any }) {
  const cookie = String(response.headers['set-cookie']).split(';')[0];
  return { cookie, 'x-csrf-token': response.json().csrfToken as string };
}

describe('schválenie bankového výpisu — agendy predkontácií', () => {
  it('smer pohybu musí sedieť s agendou predkontácie; bez agendy prechádza', async () => {
    const database = await createTestDatabase();
    databases.push(database);
    const seeded = await seedTestUser(database);
    const app = await buildApp({ database, storage: new MemoryObjectStorage(), config: testConfig(), logger: false });
    const headers = sessionHeaders(await app.inject({
      method: 'POST', url: '/api/auth/login', payload: { email: seeded.email, password: seeded.password },
    }));

    const kody = new Map<string, string>();
    const ciselnik: Array<[string, string, string | null]> = [
      ['bankoveUcty', 'PB', null],
      ['predkontacie', 'Úhrada FP-tuz.', 'bankIssued'],
      ['predkontacie', '221/601', 'bankReceived'],
      ['predkontacie', 'FAKT', 'receivedInvoice'],
      ['predkontacie', 'RUCNA', null],
    ];
    for (const [kind, code, agenda] of ciselnik) {
      const id = randomUUID();
      kody.set(code, id);
      await database.query(
        `INSERT INTO code_list_items (id,tenant_id,organization_id,kind,code,name,source,agenda)
         VALUES ($1,$2,$3,$4,$5,$5,'pohoda',$6)`,
        [id, seeded.tenantId, seeded.organizationId, kind, code, agenda],
      );
    }

    async function vlozVypis(pohyby: Array<Record<string, unknown>>): Promise<string> {
      const id = randomUUID();
      await database.query(
        `INSERT INTO documents (id,tenant_id,organization_id,document_type,status,processing_status,extracted,accounting,total_amount,currency,version)
         VALUES ($1,$2,$3,'BV','na_kontrole','ready_for_review',$4::jsonb,$5::jsonb,100,'EUR',1)`,
        [id, seeded.tenantId, seeded.organizationId,
          JSON.stringify({
            dodavatel: { nazov: 'UniCredit Bank' }, cisloFaktury: 'V-1', cisloVypisu: '1',
            datumVystavenia: '2026-06-30', mena: 'EUR', rozpisDph: [], sumaSpolu: 100,
            polozky: pohyby.map((pohyb, index) => ({ id: `m${index}`, popis: `Pohyb ${index}`, ...pohyb })),
          }),
          JSON.stringify({ bankUcetKod: 'PB' })],
      );
      return id;
    }
    const schval = (id: string) => app.inject({
      method: 'POST', url: `/api/documents/${id}/approve`, headers, payload: { expectedVersion: 1 },
    });

    // Správne smery + ručná predkontácia bez agendy → schváli sa.
    const dobry = await vlozVypis([
      { sumaSpolu: -100, ucto: { predkontaciaId: kody.get('Úhrada FP-tuz.') } },
      { sumaSpolu: 200, ucto: { predkontaciaId: kody.get('221/601') } },
      { sumaSpolu: -5, ucto: { predkontaciaId: kody.get('RUCNA') } },
    ]);
    expect((await schval(dobry)).statusCode).toBe(200);

    // Výdaj s príjmovou predkontáciou (bankReceived) → blok.
    const opacny = await vlozVypis([
      { sumaSpolu: -100, ucto: { predkontaciaId: kody.get('221/601') } },
    ]);
    const opacnyRes = await schval(opacny);
    expect(opacnyRes.statusCode).toBe(409);
    expect(opacnyRes.json().code).toBe('movement_accounting_wrong_agenda');

    // Fakturová predkontácia (receivedInvoice) na pohybe banky → blok.
    const fakturova = await vlozVypis([
      { sumaSpolu: -100, ucto: { predkontaciaId: kody.get('FAKT') } },
    ]);
    const fakturovaRes = await schval(fakturova);
    expect(fakturovaRes.statusCode).toBe(409);
    expect(fakturovaRes.json().code).toBe('movement_accounting_wrong_agenda');
  }, 90_000);
});

import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { maybeAiAccountingSuggestion, rebuildAccountingSuggestion } from './accountingSuggestionService.js';
import { aiOdpoved, createTestDatabase, seedTestUser, testConfig } from '../testHelpers.js';

const databases: Awaited<ReturnType<typeof createTestDatabase>>[] = [];
afterEach(async () => Promise.all(databases.splice(0).map((database) => database.close())));

async function pripravFirmu() {
  const database = await createTestDatabase();
  databases.push(database);
  const seeded = await seedTestUser(database);
  const kde = [seeded.tenantId, seeded.organizationId];
  const kod = async (kind: string, code: string, extra: Record<string, string> = {}) => {
    const id = randomUUID();
    await database.query(
      `INSERT INTO code_list_items (id,tenant_id,organization_id,kind,code,name,source,ucet_md)
       VALUES ($1,$2,$3,$4,$5,$5,'pohoda',$6)`,
      [id, ...kde, kind, code, extra.ucetMd ?? null],
    );
    return id;
  };
  const doklad = async (podtyp: string, extracted: unknown, status = 'na_kontrole', accounting: unknown = {}) => {
    const id = randomUUID();
    await database.query(
      `INSERT INTO documents (id,tenant_id,organization_id,document_type,podtyp,status,processing_status,extracted,accounting,total_amount,currency)
       VALUES ($1,$2,$3,'FP',$4,$5,'ready_for_review',$6::jsonb,$7::jsonb,100,'EUR')`,
      [id, ...kde, podtyp, status, JSON.stringify(extracted), JSON.stringify(accounting)],
    );
    return id;
  };
  return { database, seeded, kde, kod, doklad };
}

const payloadVolania = (parser: { create: ReturnType<typeof vi.fn> }, volanie = 0) =>
  JSON.parse((parser.create.mock.calls[volanie][0] as any).input[0].content[0].text);

// Druh dokladu (typ + podtyp) musí viesť KAŽDÝ zdroj pamäte. Dobropis sa účtuje
// opačným smerom a do C2, takže pamäť bežnej faktúry dodávateľa preň nie je
// dôkaz — a naopak dobropis nesmie určiť ďalšiu bežnú faktúru.
describe('deterministická pamäť a podtyp', () => {
  it('pamäť ani história bežnej FP sa nepoužije pre FP-D a naopak', async () => {
    const { database, seeded, kde, kod, doklad } = await pripravFirmu();
    const pred = await kod('predkontacie', '518/321');
    const predDobropis = await kod('predkontacie', '648/321');
    const dph = await kod('cleneniaDph', 'PD');
    const extracted = { dodavatel: { nazov: 'Servis s.r.o.' }, polozky: [{ popis: 'oprava vozidla' }] };
    const currentId = await doklad('dobropis', extracted);
    // Schválená bežná faktúra toho istého dodávateľa — zdroj supplier_history.
    await doklad('bezna', extracted, 'schvaleny', { predkontaciaId: pred, clenenieDphId: dph });
    await database.query(
      `INSERT INTO ucto_decisions
        (id,tenant_id,organization_id,supplier_name_normalized,line_text_normalized,
         predkontacia_id,clenenie_dph_id,source,document_type,podtyp)
       VALUES ($1,$2,$3,'servis s.r.o.','oprava vozidla',$4,$5,'import','FP','bezna')`,
      [randomUUID(), ...kde, pred, dph],
    );
    const input = { tenantId: seeded.tenantId, organizationId: seeded.organizationId, documentId: currentId, supplierName: 'Servis s.r.o.' };
    const navrh = async () => (await database.query<Record<string, any>>(
      'SELECT source, predkontacia_id FROM accounting_suggestions WHERE document_id=$1', [currentId],
    )).rows[0];

    await rebuildAccountingSuggestion(database, input);
    expect(await navrh()).toMatchObject({ source: 'none', predkontacia_id: null });

    // Naopak: novší dobropis v pamäti nesmie prebiť bežnú faktúru.
    await database.query(
      `INSERT INTO ucto_decisions
        (id,tenant_id,organization_id,supplier_name_normalized,line_text_normalized,
         predkontacia_id,clenenie_dph_id,source,document_type,podtyp,created_at)
       VALUES ($1,$2,$3,'servis s.r.o.','oprava vozidla',$4,$5,'import','FP','dobropis',now() + interval '1 hour')`,
      [randomUUID(), ...kde, predDobropis, dph],
    );
    await database.query(`UPDATE documents SET podtyp='bezna' WHERE id=$1`, [currentId]);
    await rebuildAccountingSuggestion(database, input);
    expect(await navrh()).toMatchObject({ source: 'decision_memory', predkontacia_id: pred });
  }, 90_000);
});

describe('AI kontext druhu dokladu', () => {
  it('dobropis: prompt nesie podtyp a dátumy, história je z FP-D a bez nej z FP s príznakom', async () => {
    const { database, seeded, kde, kod, doklad } = await pripravFirmu();
    const pred = await kod('predkontacie', '518/321');
    const documentId = await doklad('dobropis', {
      dodavatel: { nazov: 'Servis s.r.o.' }, polozky: [{ popis: 'oprava vozidla' }],
      datumVystavenia: '2026-03-10', datumDodania: '2026-03-05',
    });
    const historia = async (agenda: string, text: string) => database.query(
      `INSERT INTO ucto_historia (id,tenant_id,organization_id,agenda,datum,supplier_name_normalized,
         line_text_normalized,predkontacia_kod,source,riadok_hash)
       VALUES ($1,$2,$3,$4,'2026-01-15','servis s.r.o.',$5,'518/321','mdb',$6)`,
      [randomUUID(), ...kde, agenda, text, randomUUID()],
    );
    await historia('FP', 'oprava vozidla faktura');

    const volaj = async () => {
      const parser = {
        create: vi.fn().mockResolvedValue(aiOdpoved({
          predkontaciaId: pred, clenenieDphId: null, clenenieKvKod: null, ciselnyRadId: null,
          confidence: 0.8, reason: 'Dobropis opravy', riadky: null,
        })),
      };
      await maybeAiAccountingSuggestion(database, testConfig(),
        { tenantId: seeded.tenantId, organizationId: seeded.organizationId, documentId, supplierName: 'Servis s.r.o.' },
        { documentType: 'FP', podtyp: 'dobropis', supplierName: 'Servis s.r.o.', totalAmount: 100, currency: 'EUR',
          datumVystavenia: '2026-03-10', lineDescriptions: ['oprava vozidla'] }, parser);
      return parser;
    };

    // Firma ešte dobropis nemala: denník ide z bežných faktúr a model to vie.
    const prvy = await volaj();
    const payload = payloadVolania(prvy);
    expect(payload.dokument).toMatchObject({ podtyp: 'dobropis', datumVystavenia: '2026-03-10', datumDodania: '2026-03-05' });
    expect(payload.dennik.map((riadok: { text: string }) => riadok.text)).toEqual(['oprava vozidla faktura']);
    expect(payload.zakladnaAgenda).toBe(true);
    const instrukcie = (prvy.create.mock.calls[0][0] as any).instructions as string;
    expect(instrukcie).toContain('podtyp');
    expect(instrukcie).toContain('zakladnaAgenda');

    // Prvý dobropis v korpuse: odteraz platí len agenda FP-D, bežná faktúra nie.
    await historia('FP-D', 'oprava vozidla dobropis');
    const druhy = payloadVolania(await volaj());
    expect(druhy.dennik.map((riadok: { text: string }) => riadok.text)).toEqual(['oprava vozidla dobropis']);
    expect(druhy.zakladnaAgenda).toBeUndefined();
  }, 90_000);

  it('rozpis riadka za 15. položkou prežije a index mimo stropu nie', async () => {
    const { database, seeded, kod, doklad } = await pripravFirmu();
    const hlavicka = await kod('predkontacie', '518/321');
    const material = await kod('predkontacie', '501/321');
    const input = (documentId: string) => ({ tenantId: seeded.tenantId, organizationId: seeded.organizationId, documentId, supplierName: 'Sklad s.r.o.' });
    const riadok = (index: number) => ({ index, predkontaciaId: material, clenenieDphId: null, clenenieKvKod: null, podiel: null, podielDph: null });
    const spusti = async (pocet: number, riadky: unknown[]) => {
      const documentId = await doklad('bezna', {});
      const polozky = Array.from({ length: pocet }, (_, index) => ({ popis: `položka ${index} ${'x'.repeat(200)}`, sadzbaDph: 23, suma: 10 }));
      const parser = {
        create: vi.fn().mockResolvedValue(aiOdpoved({
          predkontaciaId: hlavicka, clenenieDphId: null, clenenieKvKod: null, ciselnyRadId: null,
          confidence: 0.8, reason: 'Služby a materiál', riadky,
        })),
      };
      expect(await maybeAiAccountingSuggestion(database, testConfig(), input(documentId), {
        documentType: 'FP', supplierName: 'Sklad s.r.o.', totalAmount: 10 * pocet, currency: 'EUR',
        lineDescriptions: polozky.map((polozka) => polozka.popis), polozky,
      }, parser)).toBe(true);
      const ulozene = (await database.query<Record<string, any>>(
        'SELECT riadky FROM accounting_suggestions WHERE document_id=$1', [documentId],
      )).rows[0].riadky as Array<Record<string, unknown>> | null;
      return { payload: payloadVolania(parser), ulozene: ulozene ?? [] };
    };

    const kratky = await spusti(31, [riadok(30)]);
    expect(kratky.payload.dokument.polozky).toHaveLength(31);
    expect(kratky.ulozene.map((r) => [r.index, r.predkontaciaId])).toEqual([[30, material]]);

    // Nad strop ide modelu prvých 200 položiek a počet vynechaných; riadok pre
    // vynechanú položku sa nesmie zapísať — model ju nevidel.
    const dlhy = await spusti(205, [riadok(150), riadok(202)]);
    expect(dlhy.payload.dokument.polozky).toHaveLength(200);
    expect(dlhy.payload.dokument.polozkyVynechane).toBe(5);
    expect(dlhy.payload.dokument.polozky[0].popis.length).toBeLessThanOrEqual(120);
    expect(dlhy.ulozene.map((r) => r.index)).toEqual([150]);
    // Uložený popis je celý — skrátenie je len úspora v prompte.
    expect(String(dlhy.ulozene[0].popis).length).toBeGreaterThan(120);
  }, 90_000);

  it('pravidlo pre autá z profilu klienta rozreže aj položku za 15. riadkom', async () => {
    const { database, seeded, kod, doklad } = await pripravFirmu();
    const phm = await kod('predkontacie', 'PHM-501200', { ucetMd: '501200' });
    const nadspotreba = await kod('predkontacie', 'PHM-Nadspotreba', { ucetMd: '501201' });
    await database.query(
      `INSERT INTO organization_dph_profiles (organization_id,tenant_id,pravidla_aut) VALUES ($2,$1,$3::jsonb)`,
      [seeded.tenantId, seeded.organizationId, JSON.stringify([{
        kategoria: 'Osobné auto', percento: 80, percentoDph: 50, klucoveSlova: ['natural 95'],
        predkontaciaId: phm, predkontaciaNedanovaId: nadspotreba,
      }])],
    );
    const documentId = await doklad('bezna', {});
    const polozky = Array.from({ length: 20 }, (_, index) => ({ popis: index === 17 ? 'Natural 95' : `Umývanie ${index}`, sadzbaDph: 23, suma: 10 }));
    const parser = {
      create: vi.fn().mockResolvedValue(aiOdpoved({
        predkontaciaId: phm, clenenieDphId: null, clenenieKvKod: null, ciselnyRadId: null,
        confidence: 0.8, reason: 'Palivo', riadky: null,
      })),
    };
    expect(await maybeAiAccountingSuggestion(database, testConfig(),
      { tenantId: seeded.tenantId, organizationId: seeded.organizationId, documentId, supplierName: 'Čerpacia stanica s.r.o.' },
      { documentType: 'FP', supplierName: 'Čerpacia stanica s.r.o.', totalAmount: 200, currency: 'EUR',
        lineDescriptions: polozky.map((polozka) => polozka.popis), polozky }, parser)).toBe(true);
    const riadky = (await database.query<Record<string, any>>(
      'SELECT riadky FROM accounting_suggestions WHERE document_id=$1', [documentId],
    )).rows[0].riadky as Array<Record<string, unknown>>;
    expect(riadky.map((riadok) => [riadok.index, riadok.predkontaciaId, riadok.podiel, riadok.podielDph])).toEqual([
      [17, phm, 0.8, 0.5], [17, nadspotreba, 0.2, 0.5],
    ]);
  }, 90_000);
});

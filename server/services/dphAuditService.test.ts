import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { createTestDatabase, potvrdFakt, seedTestUser, testConfig } from '../testHelpers.js';
import { DphAuditor, bezPrazdnehoNavrhu, kodyPreStranu, nacitajCiselnikPreAudit, overeneFakty, posudNavrhDokladu, trebaDruhyHlas, zluc, zosuladSPraxou, type DphAuditVstup } from './dphAuditService.js';

// Kontrola je druhá mienka k pamäti. Testy držia to, na čom stojí jej dôvera:
// model dostane spoľahlivé fakty o krajine a nikdy nesmie prejsť s kódom,
// ktorý firma nemá v číselníku.

const config = {
  apiKey: 'test', model: 'gpt-test', accountingModel: 'gpt-test', ruleAnalysisModel: 'gpt-test',
  reasoningEffort: '', storeResponses: false, timeoutMs: 1000, maxRetries: 0,
} as unknown as ConstructorParameters<typeof DphAuditor>[0];

const cleneniaDph = [
  { kod: 'PN', nazov: 'Nezahrňovať do priznania DPH' },
  { kod: 'PDsluz', nazov: 'Prijaté služby' },
  { kod: 'DDsl§69', nazov: 'Služby, pri ktorých príjemca platí daň podľa § 69 ods.3 zákona' },
  { kod: 'UN', nazov: 'Nezahrňovať do priznania DPH' },
  { kod: 'UDzahr', nazov: 'Miesto plnenia v zahraničí s možnosťou odpočítania dane' },
  { kod: 'UD', nazov: 'Tuzemské plnenia' },
];
const kvSekcie = [{ kod: 'KN', nazov: 'Nezahŕňať do kontrolného výkazu' }, { kod: 'A1', nazov: 'Dodanie' }];

const moldavskaFaktura: DphAuditVstup = {
  documentType: 'FV',
  extracted: {
    odberatel: { nazov: 'SRL "GTRADE GROUP"', krajina: 'MD', icDph: '0307883' },
    dodavatel: { nazov: 'RCI REAL CARGO INDUSTRY s.r.o.', ico: '57251266' },
    sumaSpolu: 51360,
  },
  navrhnuteClenenieKod: 'UDzahr',
  navrhnutaKvSekcia: 'KN',
  cleneniaDph,
  kvSekcie,
};

describe('overeneFakty', () => {
  // Na tomto sa model pomýlil pri CMA CGM: kód z faktúry si pomýlil so sekciou
  // KV. Krajinu mu preto nedávame hádať — dostane ju hotovú.
  it('pri vydanej faktúre posudzuje odberateľa a rozpozná tretiu krajinu', () => {
    expect(overeneFakty(moldavskaFaktura)).toMatchObject({
      rolaProtistrany: 'odberateľ',
      krajinaProtistrany: 'MD',
      jeVEu: false,
      jeTretiaKrajina: true,
    });
  });

  it('pri prijatej faktúre posudzuje dodávateľa a krajinu vezme z IČ DPH', () => {
    const fakty = overeneFakty({
      ...moldavskaFaktura,
      documentType: 'FP',
      extracted: { dodavatel: { nazov: 'CMA - CGM', icDph: 'FR72562024422' } },
    });
    expect(fakty).toMatchObject({ rolaProtistrany: 'dodávateľ', krajinaProtistrany: 'FR', jeVEu: true });
  });

  it('grécke EL sa berie ako krajina EÚ', () => {
    const fakty = overeneFakty({
      ...moldavskaFaktura,
      documentType: 'FP',
      extracted: { dodavatel: { icDph: 'EL123456789' } },
    });
    expect(fakty).toMatchObject({ krajinaProtistrany: 'EL', jeVEu: true });
  });

  it('bez krajiny aj IČ DPH sa nič nepredstiera', () => {
    const fakty = overeneFakty({ ...moldavskaFaktura, documentType: 'FP', extracted: { dodavatel: {} } });
    expect(fakty).toMatchObject({ jeVEu: null, jeTretiaKrajina: null });
  });
});


describe('kodyPreStranu', () => {
  // POHODA nesie stranu plnenia v prefixe: U… vydané, P… prijaté, DD…
  // vymeranie dane na samostatnom internom doklade. V knihách RCI stojí
  // DDsl§69 91× na INT a ani raz na prijatej faktúre — tam je PN.
  it('prijatá faktúra nevidí kódy vydanej strany ani vymeranie dane', () => {
    const kody = kodyPreStranu('FP', cleneniaDph).map((item) => item.kod);
    expect(kody).toContain('PN');
    expect(kody).toContain('PDsluz');
    expect(kody).not.toContain('DDsl§69');
    expect(kody).not.toContain('UN');
    expect(kody).not.toContain('UDzahr');
  });

  it('vydaná faktúra nevidí prijatú stranu ani vymeranie dane', () => {
    const kody = kodyPreStranu('FV', cleneniaDph).map((item) => item.kod);
    expect(kody).toContain('UN');
    expect(kody).toContain('UDzahr');
    expect(kody).not.toContain('PN');
    expect(kody).not.toContain('DDsl§69');
  });

  // Interný doklad je práve to miesto, kde vymeranie dane žije.
  it('interný doklad vidí celý číselník', () => {
    expect(kodyPreStranu('INT', cleneniaDph)).toHaveLength(cleneniaDph.length);
  });
});
describe('DphAuditor', () => {
  it('vráti nesúhlas s odporúčaním z číselníka firmy', async () => {
    const auditor = new DphAuditor(config, {
      parse: async () => ({
        output_parsed: {
          verdikt: 'nesuhlasi',
          odporucaneClenenieKod: 'UN',
          odporucanaKvSekcia: 'KN',
          dovod: 'Odberateľ je podnikateľ z tretej krajiny, miesto dodania podľa §15 ods. 1 je mimo SR.',
          istota: 0.9,
        },
      }),
    });
    expect(await auditor.posud(moldavskaFaktura)).toMatchObject({
      verdikt: 'nesuhlasi',
      odporucaneClenenieKod: 'UN',
    });
  });

  // Kód mimo číselníka by v POHODE aj tak neprešiel a v karte by len mátol.
  it('vymyslený kód mimo číselníka sa zahodí, dôvod zostane', async () => {
    const auditor = new DphAuditor(config, {
      parse: async () => ({
        output_parsed: {
          verdikt: 'nesuhlasi',
          odporucaneClenenieKod: 'UDdodEU',
          odporucanaKvSekcia: 'B7',
          dovod: 'Model si vymyslel kód, ktorý firma nemá.',
          istota: 0.7,
        },
      }),
    });
    const verdikt = await auditor.posud(moldavskaFaktura);
    expect(verdikt?.odporucaneClenenieKod).toBeNull();
    expect(verdikt?.odporucanaKvSekcia).toBeNull();
    expect(verdikt?.dovod).toContain('vymyslel');
  });

  it('modelu ide celý číselník firmy aj overené fakty', async () => {
    let odoslane = '';
    const auditor = new DphAuditor(config, {
      parse: async (body: any) => {
        odoslane = JSON.stringify(body.input);
        return { output_parsed: { verdikt: 'suhlasi', odporucaneClenenieKod: null, odporucanaKvSekcia: null, dovod: 'ok', istota: 0.8 } };
      },
    });
    await auditor.posud(moldavskaFaktura);
    expect(odoslane).toContain('Miesto plnenia v zahrani');
    expect(odoslane).toContain('jeTretiaKrajina');
  });

  it('prázdna odpoveď nezhodí spracovanie', async () => {
    const auditor = new DphAuditor(config, { parse: async () => ({}) });
    expect(await auditor.posud(moldavskaFaktura)).toBeUndefined();
  });

  // Dobropis sa posudzoval ako bežná faktúra (B2/A1) a z dlhého dokladu model
  // videl len prvých 20 položiek.
  it('modelu ide podtyp dokladu a všetky jeho položky', async () => {
    let odoslane: any;
    const auditor = new DphAuditor(config, {
      parse: async (body: any) => {
        odoslane = JSON.parse(body.input[0].content[0].text);
        return { output_parsed: { verdikt: 'suhlasi', odporucaneClenenieKod: null, odporucanaKvSekcia: null, dovod: 'ok', istota: 0.8 } };
      },
    });
    const polozky = Array.from({ length: 30 }, (_, index) => ({ popis: `položka ${index + 1}`, sadzbaDph: 23 }));
    await auditor.posud({ ...moldavskaFaktura, documentType: 'FP', podtyp: 'dobropis', extracted: { ...moldavskaFaktura.extracted, polozky } });
    expect(odoslane.doklad.podtyp).toBe('dobropis');
    expect(odoslane.doklad.polozky).toHaveLength(30);
  });
});

describe('zvyk firmy podľa druhu dokladu', () => {
  // Dobropis sa učil z bežných faktúr a pokladničný doklad hľadal agendu „PD",
  // ktorú korpus nemá (VPD/PPD) — zladenie so zvykom tak bolo naprázdno.
  it('dobropis počíta prax z FP-D, výdavkový pokladničný doklad z VPD', async () => {
    const database = await createTestDatabase();
    try {
      const { tenantId, organizationId } = await seedTestUser(database);
      for (const [agenda, kod, pocet] of [['FP', 'PNnevymer', 3], ['FP-D', 'PN', 2], ['VPD', 'PD', 1], ['PPD', 'UD', 4]] as const) {
        for (let index = 0; index < pocet; index += 1) {
          await database.query(
            `INSERT INTO ucto_historia
              (id,tenant_id,organization_id,agenda,doklad_cislo,datum,supplier_name_normalized,line_text_normalized,
               predkontacia_kod,clenenie_dph_kod,riadok_index,source,riadok_hash)
             VALUES ($1,$2,$3,$4,$5,'2026-03-10'::date,'dodavatel','sluzba','518/321',$6,0,'mdb',$7)`,
            [randomUUID(), tenantId, organizationId, agenda, `${agenda}${index}`, kod, randomUUID()],
          );
        }
      }
      const prax = async (...druh: [string, string?, string?]) =>
        Object.fromEntries((await nacitajCiselnikPreAudit(database, tenantId, organizationId, ...druh)).prax);
      expect(await prax('FP', 'dobropis')).toEqual({ PN: 2 });
      expect(await prax('FP', 'bezna')).toEqual({ PNnevymer: 3 });
      expect(await prax('PD', undefined, 'expense')).toEqual({ PD: 1 });
      // Prvý ťarchopis firmy: druh históriu nemá, zvyk sa vezme z bežných
      // faktúr — inak by zladenie PNnevymer → PN nebežalo.
      expect(await prax('FP', 'tarchopis')).toEqual({ PNnevymer: 3 });
    } finally {
      await database.close();
    }
  }, 60_000);
});

describe('verdikt len k posúdenému druhu', () => {
  // Zmena druhu počas volania modelu verdikt zmazala a bežiaci job ďalší
  // nezaradí — zápis posudku starého druhu by ho potichu vrátil.
  it('zmena druhu počas kontroly zápis zahodí, nezmenený druh ho uloží', async () => {
    const database = await createTestDatabase();
    try {
      const { tenantId, organizationId } = await seedTestUser(database);
      const documentId = randomUUID();
      await database.query(
        `INSERT INTO code_list_items (id,tenant_id,organization_id,kind,code,name,source)
         VALUES ($1,$2,$3,'cleneniaDph','PN','Nezahrňovať do priznania DPH','pohoda')`,
        [randomUUID(), tenantId, organizationId],
      );
      await database.query(
        `INSERT INTO documents (id,tenant_id,organization_id,document_type,podtyp,status,processing_status,extracted,accounting,total_amount,currency)
         VALUES ($1,$2,$3,'FP','dobropis','na_kontrole','ready_for_review','{}'::jsonb,'{}'::jsonb,-12.3,'EUR')`,
        [documentId, tenantId, organizationId],
      );
      let prepni = false;
      const auditor = new DphAuditor(config, {
        parse: async () => {
          if (prepni) await database.query(`UPDATE documents SET podtyp='zalohova' WHERE id=$1`, [documentId]);
          return { output_parsed: { verdikt: 'suhlasi', odporucaneClenenieKod: null, odporucanaKvSekcia: null, dovod: 'Opravná faktúra.', istota: 0.95 } };
        },
      });
      const posud = () => posudNavrhDokladu(database, testConfig(), {
        tenantId, organizationId, documentId, documentType: 'FP', podtyp: 'dobropis', extracted: {},
      }, auditor);
      const audit = async () => (await database.query<Record<string, any>>(
        'SELECT dovod FROM dph_audit WHERE document_id=$1', [documentId])).rows;

      await posud();
      expect(await audit()).toEqual([{ dovod: 'Opravná faktúra.' }]);
      await database.query('DELETE FROM dph_audit WHERE document_id=$1', [documentId]);
      prepni = true;
      await posud();
      expect(await audit()).toEqual([]);
    } finally {
      await database.close();
    }
  }, 60_000);
});


// Kontrola DPH volá model raz, pri neistote dvakrát — a ani jedno volanie sa
// nezapisovalo. Cena dokladu tak nezahŕňala kontrolu a výpadok druhého hlasu
// nebolo nikde vidieť: doklad potichu dostal len prvú mienku.
describe('záznam behov kontroly DPH', () => {
  it('zapíše oba hlasy so spotrebou a zlyhaný druhý hlas ako chybu', async () => {
    const database = await createTestDatabase();
    try {
      const { tenantId, organizationId } = await seedTestUser(database);
      const documentId = randomUUID();
      await database.query(
        `INSERT INTO code_list_items (id,tenant_id,organization_id,kind,code,name,source)
         VALUES ($1,$2,$3,'cleneniaDph','PN','Nezahrňovať do priznania DPH','pohoda')`,
        [randomUUID(), tenantId, organizationId],
      );
      await database.query(
        `INSERT INTO documents (id,tenant_id,organization_id,document_type,status,processing_status,extracted,accounting,total_amount,currency)
         VALUES ($1,$2,$3,'FP','na_kontrole','ready_for_review','{}'::jsonb,'{}'::jsonb,12.3,'EUR')`,
        [documentId, tenantId, organizationId],
      );
      // Potvrdené zásady firmy idú kontrole ako fakty — inak by radila proti účtovníkovi.
      await potvrdFakt(database, { tenantId, organizationId }, 'zasady.tovar_na_ceste', { pouziva: true });
      let volanie = 0;
      let prompt: any;
      const auditor = new DphAuditor(config, {
        parse: async (body: any) => {
          volanie += 1;
          prompt ??= JSON.parse(body.input[0].content[0].text);
          if (volanie === 2) throw Object.assign(new Error('výpadok'), { status: 500 });
          return {
            output_parsed: { verdikt: 'neisty', odporucaneClenenieKod: 'PN', odporucanaKvSekcia: null, dovod: 'Neviem.', istota: 0.5 },
            usage: { input_tokens: 100, output_tokens: 20 },
          };
        },
      });
      await posudNavrhDokladu(database, testConfig(), {
        tenantId, organizationId, documentId, documentType: 'FP', extracted: {},
      }, auditor);

      const behy = (await database.query<Record<string, any>>(
        `SELECT prompt_version, status, error_code, usage FROM extraction_runs
          WHERE document_id=$1 ORDER BY started_at, status DESC`, [documentId])).rows;
      expect(behy).toEqual([
        expect.objectContaining({ prompt_version: 'dph-kontrola-v1', status: 'succeeded', error_code: null,
          usage: expect.objectContaining({ inputTokens: 100, outputTokens: 20 }) }),
        expect.objectContaining({ prompt_version: 'dph-kontrola-v1', status: 'failed', error_code: 'openai_500', usage: null }),
      ]);
      expect(prompt.zasadyFirmy).toEqual(['Firma účtuje tovar na ceste (účet 139).']);
      // Prvá mienka platí ďalej.
      expect((await database.query('SELECT 1 FROM dph_audit WHERE document_id=$1', [documentId])).rowCount).toBe(1);
    } finally {
      await database.close();
    }
  }, 60_000);
});

describe('zosuladSPraxou', () => {
  // PN aj PNnevymer zapisujú do priznania rovnako — nikam. Zákon medzi nimi
  // nerozhoduje, RCI má v knihách PN stokrát a PNnevymer ani raz.
  it('pri zhodnom správaní vyhrá kód, ktorý firma naozaj používa', () => {
    expect(zosuladSPraxou('PNnevymer', new Map([['PN', 100]]))).toBe('PN');
  });

  // Toto je poistka proti tomu, aby sa zaužívaná chyba vrátila zadnými
  // dvermi: UDzahr zapisuje do riadku 13, UN nikam — zámena sa nesmie stať.
  it('kódy s rôznym správaním sa nezamenia ani pri silnom zvyku', () => {
    expect(zosuladSPraxou('UN', new Map([['UDzahr', 116]]))).toBe('UN');
  });

  it('kód, ktorý firma používa, zostáva nedotknutý', () => {
    expect(zosuladSPraxou('PN', new Map([['PN', 75], ['PNnevymer', 3]]))).toBe('PN');
  });

  // Rovnaké riadky priznania ešte neznamenajú rovnakú daň. PK kráti nárok
  // koeficientom, PD nie; PDsluz je služba od zahraničného dodávateľa,
  // PDnadEU nadobudnutie tovaru z EÚ. Zvyk firmy nesmie jedno ticho vymeniť
  // za druhé — zámena ostáva len v rodine rovnakého kódu (PN ↔ PNnevymer).
  it('rovnaké riadky priznania pri inej dani kód nevymenia', () => {
    expect(zosuladSPraxou('PK', new Map([['PD', 500]]))).toBe('PK');
    expect(zosuladSPraxou('PDsluz', new Map([['PDnadEU', 40]]))).toBe('PDsluz');
    expect(zosuladSPraxou('PKnadEU', new Map([['PDnadEU', 40]]))).toBe('PKnadEU');
  });

  it('bez zvyku a bez popisu sa nič nemení', () => {
    expect(zosuladSPraxou('PNnevymer', new Map())).toBe('PNnevymer');
    expect(zosuladSPraxou('VYMYSLENY', new Map([['PN', 10]]))).toBe('VYMYSLENY');
    expect(zosuladSPraxou(null, new Map())).toBeNull();
  });
});

describe('bezPrazdnehoNavrhu', () => {
  // Skutočný prípad z karty SERMAV: kontrola navrhla PNnevymer, zladenie so
  // zvykom firmy ho vymenilo za PN — a PN na doklade už stálo. Účtovníkovi
  // potom svietilo „Kontrola navrhuje PN" nad poľom, kde PN bolo.
  it('rada zhodná s pamäťou vypadne a spor sa zavrie', () => {
    const vysledok = bezPrazdnehoNavrhu({"verdikt":"nesuhlasi","odporucaneClenenieKod":"PN","odporucanaKvSekcia":"KN","dovod":"d","istota":0.9}, 'PN', 'KN');
    expect(vysledok.odporucaneClenenieKod).toBeNull();
    expect(vysledok.odporucanaKvSekcia).toBeNull();
    expect(vysledok.verdikt).toBe('suhlasi');
  });

  it('keď sa líši aspoň sekcia KV, spor zostáva otvorený', () => {
    const vysledok = bezPrazdnehoNavrhu({"verdikt":"nesuhlasi","odporucaneClenenieKod":"PN","odporucanaKvSekcia":"B1","dovod":"d","istota":0.9}, 'PN', 'KN');
    expect(vysledok.odporucaneClenenieKod).toBeNull();
    expect(vysledok.odporucanaKvSekcia).toBe('B1');
    expect(vysledok.verdikt).toBe('nesuhlasi');
  });

  // Neistý verdikt sa na súhlas neprepisuje — neistota nie je zhoda.
  it('neistý verdikt zostáva neistý', () => {
    expect(bezPrazdnehoNavrhu({"verdikt":"neisty","odporucaneClenenieKod":"PN","odporucanaKvSekcia":"KN","dovod":"d","istota":0.9}, 'PN', 'KN').verdikt).toBe('neisty');
  });

  it('skutočný rozpor prejde nedotknutý', () => {
    const vysledok = bezPrazdnehoNavrhu({"verdikt":"nesuhlasi","odporucaneClenenieKod":"UN","odporucanaKvSekcia":null,"dovod":"d","istota":0.9}, 'UDzahr', undefined);
    expect(vysledok.odporucaneClenenieKod).toBe('UN');
    expect(vysledok.verdikt).toBe('nesuhlasi');
  });
});
describe('druhý hlas', () => {
  // Druhý dopyt nie je zadarmo — pýtame sa len tam, kde by omyl bolel:
  // keď model sám priznáva neistotu, alebo keď chce meniť zaužívanú prax.
  it('pri zhode s pamäťou sa druhý hlas nepýta', () => {
    expect(trebaDruhyHlas(JSON.parse("{\"verdikt\":\"suhlasi\",\"odporucaneClenenieKod\":null,\"odporucanaKvSekcia\":null,\"dovod\":\"d\",\"istota\":0.9}"))).toBe(false);
  });

  it('neistý verdikt si vždy vyžiada druhý hlas', () => {
    expect(trebaDruhyHlas(JSON.parse("{\"verdikt\":\"neisty\",\"odporucaneClenenieKod\":null,\"odporucanaKvSekcia\":null,\"dovod\":\"d\",\"istota\":0.95}"))).toBe(true);
  });

  it('nesúhlas s nízkou istotou si vyžiada druhý hlas, s vysokou nie', () => {
    expect(trebaDruhyHlas(JSON.parse("{\"verdikt\":\"nesuhlasi\",\"odporucaneClenenieKod\":null,\"odporucanaKvSekcia\":null,\"dovod\":\"d\",\"istota\":0.7}"))).toBe(true);
    expect(trebaDruhyHlas(JSON.parse("{\"verdikt\":\"nesuhlasi\",\"odporucaneClenenieKod\":null,\"odporucanaKvSekcia\":null,\"dovod\":\"d\",\"istota\":0.95}"))).toBe(false);
  });

  it('zhodné hlasy verdikt potvrdia a vezmú vyššiu istotu', () => {
    const a = JSON.parse("{\"verdikt\":\"nesuhlasi\",\"odporucaneClenenieKod\":\"UN\",\"odporucanaKvSekcia\":null,\"dovod\":\"d\",\"istota\":0.7}");
    const b = JSON.parse("{\"verdikt\":\"nesuhlasi\",\"odporucaneClenenieKod\":\"UN\",\"odporucanaKvSekcia\":null,\"dovod\":\"d\",\"istota\":0.85}");
    expect(zluc(a, b)).toMatchObject({ verdikt: 'nesuhlasi', odporucaneClenenieKod: 'UN', istota: 0.85 });
  });

  // Dva modely, ktoré si protirečia, nie sú dôvod meniť zaúčtovanie —
  // sú dôvod, aby sa na doklad pozrel človek.
  it('nezhodné hlasy skončia ako neistý verdikt bez odporúčania', () => {
    const a = JSON.parse("{\"verdikt\":\"nesuhlasi\",\"odporucaneClenenieKod\":\"UN\",\"odporucanaKvSekcia\":null,\"dovod\":\"d\",\"istota\":0.8}");
    const b = JSON.parse("{\"verdikt\":\"nesuhlasi\",\"odporucaneClenenieKod\":\"UD\",\"odporucanaKvSekcia\":null,\"dovod\":\"d\",\"istota\":0.6}");
    const spolu = zluc(a, b);
    expect(spolu.verdikt).toBe('neisty');
    // Kandidat sa uz nezahadzuje — uctovnik potrebuje s cim pracovat,
    // ponukne sa navrh istejsieho hlasu a dovod pomenuje oba.
    expect(spolu.odporucaneClenenieKod).toBe('UN');
    expect(spolu.dovod).toContain('nezhodli');
  });

  // Audit R5: rovnaké členenie, iná sekcia KV. Zlúčenie to bralo ako zhodu,
  // vrátilo sekciu prvého hlasu a istotu druhého — výkaz tak mohol dostať
  // riadok, na ktorom sa dva hlasy nezhodli, s istotou 0,9.
  it('rozchod v sekcii KV nie je zhoda a istotu nezvýši', () => {
    const a = JSON.parse("{\"verdikt\":\"suhlasi\",\"odporucaneClenenieKod\":\"PD\",\"odporucanaKvSekcia\":\"B2\",\"dovod\":\"a\",\"istota\":0.6}");
    const b = { ...a, odporucanaKvSekcia: 'KN', istota: 0.9, dovod: 'b' };
    const spolu = zluc(a, b);
    expect(spolu.verdikt).toBe('neisty');
    expect(spolu.istota).toBe(0.6);
    expect(spolu.dovod).toContain('B2');
    expect(spolu.dovod).toContain('KN');
  });
});

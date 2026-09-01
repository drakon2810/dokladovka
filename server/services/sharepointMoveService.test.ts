import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import type { Database } from '../db/database.js';
import { createTestDatabase, seedTestUser } from '../testHelpers.js';
import { najdiNaPresun, nazovPoPresune, presunVybavene } from './sharepointMoveService.js';
import type { SharePointClient } from './sharepointService.js';

function fakeClient(zlyhaj = false) {
  const presuny: Array<{ itemId: string; ciel: string; nazov: string }> = [];
  const client: SharePointClient = {
    list: async () => [],
    download: async () => Buffer.alloc(0),
    move: async (_d, itemId, ciel, nazov) => {
      if (zlyhaj) throw new Error('Graph nedostupný');
      presuny.push({ itemId, ciel, nazov });
    },
    resolveFolderUrl: async () => { throw new Error('presun priečinky nehľadá'); },
  };
  return { client, presuny };
}

interface Prostredie {
  database: Database;
  tenantId: string;
  organizationId: string;
  scope: { tenantId: string; organizationId: string };
  /** Založí prílohu zo SharePointu s dokladom v danom stave. */
  pridaj(stav: string, options?: { pohodaNumber?: string }): Promise<{ attachmentId: string; documentId: string }>;
  rozdel(documentId: string, stav: string): Promise<string>;
}

async function pripravDb(): Promise<Prostredie> {
  const database = await createTestDatabase();
  const seeded = await seedTestUser(database);
  await database.query(
    `INSERT INTO sharepoint_folders
      (id,tenant_id,organization_id,site_id,drive_id,nespracovane_folder_id,spracovane_folder_id,chybne_folder_id)
     VALUES ($1,$2,$3,'site','drive-1','nespracovane','spracovane','chybne')`,
    [randomUUID(), seeded.tenantId, seeded.organizationId],
  );

  async function vlozDoklad(id: string, stav: string, pohodaNumber?: string, splitFrom?: string) {
    await database.query(
      `INSERT INTO documents
        (id,tenant_id,organization_id,document_type,status,processing_status,extracted,accounting,
         total_amount,currency,pohoda_number,split_from_document_id)
       VALUES ($1,$2,$3,'FP',$4,'ready_for_review','{}'::jsonb,'{}'::jsonb,100,'EUR',$5,$6)`,
      [id, seeded.tenantId, seeded.organizationId, stav, pohodaNumber ?? null, splitFrom ?? null],
    );
  }

  return {
    database,
    tenantId: seeded.tenantId,
    organizationId: seeded.organizationId,
    scope: { tenantId: seeded.tenantId, organizationId: seeded.organizationId },
    async pridaj(stav, options) {
      const emailId = randomUUID();
      const attachmentId = randomUUID();
      const documentId = randomUUID();
      await database.query(
        `INSERT INTO inbound_emails
          (id,tenant_id,organization_id,provider,provider_message_id,envelope_recipients,subject,
           received_at,status,attachment_count,correlation_id)
         VALUES ($1,$2,$3,'sharepoint',$4,'[]'::jsonb,'x',now(),'queued',1,$5)`,
        [emailId, seeded.tenantId, seeded.organizationId, randomUUID(), randomUUID()],
      );
      await vlozDoklad(documentId, stav, options?.pohodaNumber);
      await database.query(
        `INSERT INTO inbound_attachments
          (id,tenant_id,inbound_email_id,organization_id,original_file_name,safe_file_name,
           byte_size,sha256,status,document_id,sharepoint_drive_id,sharepoint_item_id)
         VALUES ($1,$2,$3,$4,'faktura.pdf','faktura.pdf',10,$5,'document_created',$6,'drive-1',$7)`,
        [attachmentId, seeded.tenantId, emailId, seeded.organizationId, randomUUID(), documentId, `item-${attachmentId.slice(0, 8)}`],
      );
      return { attachmentId, documentId };
    },
    async rozdel(documentId, stav) {
      const id = randomUUID();
      await vlozDoklad(id, stav, undefined, documentId);
      return id;
    },
  };
}

describe('názov po presune', () => {
  it('dátum zaúčtovania vpredu, aby sa priečinok zoradil podľa neho', () => {
    expect(nazovPoPresune('faktura.pdf', new Date('2026-09-01T10:00:00Z'), 'FP2600123'))
      .toBe('2026-09-01_FP2600123_faktura.pdf');
  });

  it('bez čísla z POHODY stačí dátum', () => {
    expect(nazovPoPresune('faktura.pdf', new Date('2026-09-01T10:00:00Z'), null))
      .toBe('2026-09-01_faktura.pdf');
  });

  it('bez dátumu (všetko zamietnuté) názov nemení', () => {
    expect(nazovPoPresune('faktura.pdf', null, null)).toBe('faktura.pdf');
  });

  it('lomky v čísle by rozbili názov súboru', () => {
    expect(nazovPoPresune('f.pdf', new Date('2026-09-01T00:00:00Z'), 'FP/26/0012'))
      .toBe('2026-09-01_FP-26-0012_f.pdf');
  });
});

describe('výber súborov na presun', { timeout: 60_000 }, () => {
  it('prenesený doklad presunie do „spracované" s dátumom a číslom', async () => {
    const p = await pripravDb();
    await p.pridaj('exportovany', { pohodaNumber: 'FP2600123' });
    const { client, presuny } = fakeClient();

    const polozky = await najdiNaPresun(p.database, p.scope);
    expect(await presunVybavene(p.database, client, polozky)).toMatchObject({ presunute: 1 });
    expect(presuny[0].ciel).toBe('spracovane');
    expect(presuny[0].nazov).toMatch(/^\d{4}-\d{2}-\d{2}_FP2600123_faktura\.pdf$/);
  });

  it('rozrobený doklad nechá súbor na mieste', async () => {
    const p = await pripravDb();
    await p.pridaj('na_kontrole');
    expect(await najdiNaPresun(p.database, p.scope)).toHaveLength(0);
  });

  it('rozdelené PDF čaká na VŠETKY časti — inak odíde s dvoma rozrobenými', async () => {
    const p = await pripravDb();
    const { documentId } = await p.pridaj('exportovany', { pohodaNumber: 'FP1' });
    const castId = await p.rozdel(documentId, 'na_kontrole');
    expect(await najdiNaPresun(p.database, p.scope)).toHaveLength(0);

    await p.database.query("UPDATE documents SET status='exportovany' WHERE id=$1", [castId]);
    expect(await najdiNaPresun(p.database, p.scope)).toHaveLength(1);
  });

  it('zamietnutá časť presunu nebráni — už sa s ňou nič nestane', async () => {
    const p = await pripravDb();
    const { documentId } = await p.pridaj('exportovany', { pohodaNumber: 'FP1' });
    await p.rozdel(documentId, 'zamietnuty');
    expect(await najdiNaPresun(p.database, p.scope)).toHaveLength(1);
  });

  it('úplne zamietnutý súbor ide medzi chybné, nie medzi spracované', async () => {
    const p = await pripravDb();
    await p.pridaj('zamietnuty');
    const { client, presuny } = fakeClient();
    await presunVybavene(p.database, client, await najdiNaPresun(p.database, p.scope));
    expect(presuny[0]).toMatchObject({ ciel: 'chybne', nazov: 'faktura.pdf' });
  });

  it('chyba, karanténa a duplicita ešte nie sú vybavenie', async () => {
    for (const stav of ['chyba', 'karantena', 'duplicita']) {
      const p = await pripravDb();
      await p.pridaj(stav);
      expect(await najdiNaPresun(p.database, p.scope)).toHaveLength(0);
      await p.database.close();
    }
  });

  it('presunutý súbor sa druhýkrát neponúkne', async () => {
    const p = await pripravDb();
    await p.pridaj('exportovany');
    const { client } = fakeClient();
    await presunVybavene(p.database, client, await najdiNaPresun(p.database, p.scope));
    expect(await najdiNaPresun(p.database, p.scope)).toHaveLength(0);
  });

  it('keď Graph zlyhá, značka sa nenastaví a ďalší cyklus to skúsi znova', async () => {
    const p = await pripravDb();
    await p.pridaj('exportovany');
    const zlyhavajuci = fakeClient(true);
    expect(await presunVybavene(p.database, zlyhavajuci.client, await najdiNaPresun(p.database, p.scope)))
      .toMatchObject({ presunute: 0, chyby: 1 });

    const druhy = fakeClient();
    expect(await presunVybavene(p.database, druhy.client, await najdiNaPresun(p.database, p.scope)))
      .toMatchObject({ presunute: 1 });
  });

  it('doklad z e-mailu sa nepresúva — nemá odkiaľ', async () => {
    const p = await pripravDb();
    await p.pridaj('exportovany');
    await p.database.query('UPDATE inbound_attachments SET sharepoint_item_id=NULL, sharepoint_drive_id=NULL');
    expect(await najdiNaPresun(p.database, p.scope)).toHaveLength(0);
  });
});

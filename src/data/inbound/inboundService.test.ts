// Testy mock routingu a inbound pipeline — SPEC §11.7, §11.8, §11.11, §11.20
// a Definition of Done §13 (Fáza 1 mock).
import { beforeEach, describe, expect, it } from 'vitest';
import { simulateInboundEmail, normalizeRecipient, sha256Hex } from './inboundService';
import { buildSeedState } from '../mock/seed';
import type { AppDataState } from '../store';
import type { SimulateInboundEmailInput } from '../types';

let state: AppDataState;
const deps = {
  getState: () => state,
  setState: (partial: Partial<AppDataState>) => {
    state = { ...state, ...partial };
  },
};

const ALFA_ALIAS = 'alfa-trade-k7m4q2@doklady.dokladorpro.sk';
const BETA_ALIAS = 'beta-gastro-p9x2vd@doklady.dokladorpro.sk';

function input(overrides: Partial<SimulateInboundEmailInput> = {}): SimulateInboundEmailInput {
  return {
    recipientAlias: ALFA_ALIAS,
    sender: 'fakturacia@dodavatel.sk',
    subject: 'Faktúra 2026001',
    attachments: [{ fileName: 'faktura.pdf', mimeType: 'application/pdf', contentSeed: 'obsah-1' }],
    scenario: 'uspech',
    ...overrides,
  };
}

beforeEach(() => {
  state = buildSeedState();
});

describe('normalizeRecipient', () => {
  it('normalizuje na lowercase a oreže medzery (SPEC §11.7)', () => {
    expect(normalizeRecipient('  Alfa-Trade-K7M4Q2@Doklady.DokladorPro.SK ')).toBe(ALFA_ALIAS);
  });
});

describe('sha256Hex', () => {
  it('vracia deterministický SHA-256 hex', async () => {
    const a = await sha256Hex('obsah');
    const b = await sha256Hex('obsah');
    expect(a).toBe(b);
    expect(a).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe('routing podľa envelope recipienta (SPEC §11.7)', () => {
  it('e-mail na alias AGS vytvorí doklady iba v tej organizácii (DoD §13.5)', async () => {
    const before = state.documents.length;
    const res = await simulateInboundEmail(input(), deps);
    expect(res.inboundEmail.organizationId).toBe('org-alfa');
    expect(res.createdDocumentIds).toHaveLength(1);
    const doc = state.documents.find((d) => d.id === res.createdDocumentIds[0])!;
    expect(doc.orgId).toBe('org-alfa');
    expect(state.documents.length).toBe(before + 1);
  });

  it('recipient sa porovnáva case-insensitive', async () => {
    const res = await simulateInboundEmail(
      input({ recipientAlias: ALFA_ALIAS.toUpperCase() }),
      deps,
    );
    expect(res.inboundEmail.organizationId).toBe('org-alfa');
  });

  it('neznámy alias → quarantine, žiadny doklad, žiadne hádanie organizácie (DoD §13.7)', async () => {
    const before = state.documents.length;
    const res = await simulateInboundEmail(
      input({ recipientAlias: 'neexistuje-abc123@doklady.dokladorpro.sk' }),
      deps,
    );
    expect(res.inboundEmail.status).toBe('quarantine');
    expect(res.inboundEmail.quarantineReason).toBe('unknown_alias');
    expect(res.inboundEmail.organizationId).toBeUndefined();
    expect(res.createdDocumentIds).toHaveLength(0);
    expect(state.documents.length).toBe(before);
  });

  it('vypnutý alias → quarantine alias_disabled (edge case §11.26)', async () => {
    state.aliases = state.aliases.map((a) =>
      a.address === ALFA_ALIAS ? { ...a, status: 'disabled' as const } : a,
    );
    const res = await simulateInboundEmail(input(), deps);
    expect(res.inboundEmail.status).toBe('quarantine');
    expect(res.inboundEmail.quarantineReason).toBe('alias_disabled');
    expect(res.createdDocumentIds).toHaveLength(0);
  });

  it('alias v grace období stále doručuje (SPEC §11.3)', async () => {
    state.aliases = state.aliases.map((a) =>
      a.address === ALFA_ALIAS ? { ...a, status: 'grace_period' as const } : a,
    );
    const res = await simulateInboundEmail(input(), deps);
    expect(res.inboundEmail.organizationId).toBe('org-alfa');
    expect(res.createdDocumentIds).toHaveLength(1);
  });

  it('alias po uplynutí grace obdobia už nedoručuje', async () => {
    state.aliases = state.aliases.map((a) =>
      a.address === ALFA_ALIAS
        ? { ...a, status: 'grace_period' as const, graceUntil: '2000-01-01T00:00:00.000Z' }
        : a,
    );
    const res = await simulateInboundEmail(input(), deps);
    expect(res.inboundEmail.status).toBe('quarantine');
    expect(res.inboundEmail.quarantineReason).toBe('alias_disabled');
    expect(res.createdDocumentIds).toHaveLength(0);
  });

  it('archivovaná organizácia → quarantine organization_archived (SPEC §11.3)', async () => {
    state.organizations = state.organizations.map((o) =>
      o.id === 'org-alfa' ? { ...o, archived: true } : o,
    );
    const res = await simulateInboundEmail(input(), deps);
    expect(res.inboundEmail.status).toBe('quarantine');
    expect(res.inboundEmail.quarantineReason).toBe('organization_archived');
    expect(res.createdDocumentIds).toHaveLength(0);
  });

  it('aliasy dvoch organizácií v jednom envelope → ambiguous_recipient bez dokladu', async () => {
    const res = await simulateInboundEmail(
      input({ additionalRecipientAliases: [BETA_ALIAS], scenario: 'ambiguous_recipient' }),
      deps,
    );
    expect(res.inboundEmail.status).toBe('quarantine');
    expect(res.inboundEmail.quarantineReason).toBe('ambiguous_recipient');
    expect(res.inboundEmail.organizationId).toBeUndefined();
    expect(res.createdDocumentIds).toHaveLength(0);
  });
});

describe('prílohy (SPEC §11.8)', () => {
  it('jeden e-mail s tromi PDF vytvorí tri doklady so spoločným inboundEmailId (DoD §13.6)', async () => {
    const res = await simulateInboundEmail(
      input({
        attachments: [
          { fileName: 'f1.pdf', mimeType: 'application/pdf', contentSeed: 'a' },
          { fileName: 'f2.pdf', mimeType: 'application/pdf', contentSeed: 'b' },
          { fileName: 'f3.pdf', mimeType: 'application/pdf', contentSeed: 'c' },
        ],
      }),
      deps,
    );
    expect(res.createdDocumentIds).toHaveLength(3);
    const docs = state.documents.filter((d) => res.createdDocumentIds.includes(d.id));
    for (const doc of docs) {
      expect(doc.zdroj.inboundEmailId).toBe(res.inboundEmail.id);
      expect(doc.zdroj.typ).toBe('email');
    }
    expect(res.inboundEmail.status).toBe('processed');
  });

  it('e-mail bez príloh → quarantine no_supported_attachment', async () => {
    const res = await simulateInboundEmail(input({ attachments: [] }), deps);
    expect(res.inboundEmail.status).toBe('quarantine');
    expect(res.inboundEmail.quarantineReason).toBe('no_supported_attachment');
  });

  it('nepodporovaný MIME → príloha v karanténe, doklad nevzniká', async () => {
    const res = await simulateInboundEmail(
      input({
        scenario: 'nepodporovany_typ',
        attachments: [{ fileName: 'archiv.zip', mimeType: 'application/zip', contentSeed: 'z' }],
      }),
      deps,
    );
    expect(res.createdDocumentIds).toHaveLength(0);
    expect(res.attachments[0].status).toBe('quarantine');
    expect(res.attachments[0].quarantineReason).toBe('unsupported_type');
    expect(res.inboundEmail.status).toBe('quarantine');
  });

  it('poškodený súbor → príloha quarantine/corrupted_file bez extraction run', async () => {
    const res = await simulateInboundEmail(input({ scenario: 'poskodeny_subor' }), deps);
    expect(res.createdDocumentIds).toHaveLength(0);
    expect(res.attachments[0].status).toBe('quarantine');
    expect(res.attachments[0].quarantineReason).toBe('corrupted_file');
    expect(state.extractionRuns).toHaveLength(0);
  });

  it('PDF chránené heslom → quarantine/password_protected_pdf', async () => {
    const res = await simulateInboundEmail(
      input({ scenario: 'password_protected_pdf' }),
      deps,
    );
    expect(res.createdDocumentIds).toHaveLength(0);
    expect(res.attachments[0].quarantineReason).toBe('password_protected_pdf');
    expect(state.extractionRuns).toHaveLength(0);
  });

  it('zmiešané prílohy → partially_processed', async () => {
    const res = await simulateInboundEmail(
      input({
        attachments: [
          { fileName: 'ok.pdf', mimeType: 'application/pdf', contentSeed: 'ok' },
          { fileName: 'zly.zip', mimeType: 'application/zip', contentSeed: 'zly' },
        ],
      }),
      deps,
    );
    expect(res.createdDocumentIds).toHaveLength(1);
    expect(res.inboundEmail.status).toBe('partially_processed');
  });
});

describe('duplicity (SPEC §11.11)', () => {
  it('rovnaká príloha druhýkrát = technická duplicita bez nového dokladu (DoD §13.9)', async () => {
    const first = await simulateInboundEmail(input({ attachments: [{ fileName: 'f.pdf', mimeType: 'application/pdf', contentSeed: 'rovnaky-obsah' }] }), deps);
    expect(first.createdDocumentIds).toHaveLength(1);
    const before = state.documents.length;

    const second = await simulateInboundEmail(
      input({ attachments: [{ fileName: 'f-kopia.pdf', mimeType: 'application/pdf', contentSeed: 'rovnaky-obsah' }] }),
      deps,
    );
    expect(second.createdDocumentIds).toHaveLength(0);
    expect(second.attachments[0].status).toBe('duplicate');
    expect(state.documents.length).toBe(before);
  });

  it('rovnaký obsah v INEJ organizácii nie je technická duplicita (dedupe scope — §11.11)', async () => {
    await simulateInboundEmail(
      input({ attachments: [{ fileName: 'f.pdf', mimeType: 'application/pdf', contentSeed: 'zdielany' }] }),
      deps,
    );
    const res = await simulateInboundEmail(
      input({
        recipientAlias: BETA_ALIAS,
        attachments: [{ fileName: 'f.pdf', mimeType: 'application/pdf', contentSeed: 'zdielany' }],
      }),
      deps,
    );
    expect(res.createdDocumentIds).toHaveLength(1);
    expect(state.documents.find((d) => d.id === res.createdDocumentIds[0])!.orgId).toBe('org-beta');
  });

  it('účtovná duplicita → doklad so stavom duplicita a odkazom na pôvodný', async () => {
    const res = await simulateInboundEmail(input({ scenario: 'duplicita' }), deps);
    expect(res.createdDocumentIds).toHaveLength(1);
    const doc = state.documents.find((d) => d.id === res.createdDocumentIds[0])!;
    expect(doc.status).toBe('duplicita');
    expect(doc.duplicateOfDocumentId).toBeTruthy();
    const original = state.documents.find((d) => d.id === doc.duplicateOfDocumentId)!;
    expect(original.orgId).toBe('org-alfa');
    expect(original.extracted.cisloFaktury).toBe(doc.extracted.cisloFaktury);
  });
});

describe('IČO mismatch (SPEC §11.7 bod 6)', () => {
  it('buyer IČO inej organizácie → karantena buyer_ico_mismatch, bez presunu (DoD §13.8)', async () => {
    const res = await simulateInboundEmail(input({ scenario: 'ico_mismatch' }), deps);
    expect(res.inboundEmail.status).toBe('quarantine');
    expect(res.inboundEmail.quarantineReason).toBe('buyer_ico_mismatch');
    expect(res.createdDocumentIds).toHaveLength(1);
    const doc = state.documents.find((d) => d.id === res.createdDocumentIds[0])!;
    expect(doc.status).toBe('karantena');
    expect(doc.quarantineReason).toBe('buyer_ico_mismatch');
    // doklad zostáva v organizácii aliasu — NIKDY sa automaticky nepresúva
    expect(doc.orgId).toBe('org-alfa');
  });
});

describe('nekompatibilný typ extrakcie a fronty', () => {
  it('ponechá doklad vo fronte aliasu, ale doklad aj prílohu dá do karantény na manuálnu kontrolu', async () => {
    const issuedQueue = state.queues.find(
      (queue) => queue.organizationId === 'org-alfa' && queue.kind === 'issued_invoices',
    )!;
    const issuedAlias = state.aliases.find((alias) => alias.queueId === issuedQueue.id)!;

    // Demo extractor bezpečne vracia FP. Alias fronty vydaných faktúr povoľuje
    // iba FV, takže výsledok sa nesmie potichu zaradiť ani schváliť.
    const res = await simulateInboundEmail(
      input({
        recipientAlias: issuedAlias.address,
        attachments: [
          {
            fileName: 'prijata-do-vydanych.pdf',
            mimeType: 'application/pdf',
            contentSeed: 'queue-type-mismatch',
          },
        ],
      }),
      deps,
    );

    expect(res.createdDocumentIds).toHaveLength(1);
    expect(res.inboundEmail.status).toBe('quarantine');
    expect(res.inboundEmail.quarantineReason).toBe('queue_type_mismatch');
    expect(res.attachments[0]).toMatchObject({
      status: 'quarantine',
      quarantineReason: 'queue_type_mismatch',
      documentId: res.createdDocumentIds[0],
    });
    const doc = state.documents.find((candidate) => candidate.id === res.createdDocumentIds[0])!;
    expect(doc).toMatchObject({
      orgId: 'org-alfa',
      queueId: issuedQueue.id,
      typ: 'FP',
      status: 'karantena',
      processingStatus: 'ready_for_review',
      quarantineReason: 'queue_type_mismatch',
    });
    expect(doc.history.some((entry) => /manuálnu kontrolu/.test(entry.akcia))).toBe(true);
  });
});

describe('nízka istota (SPEC §11.20, DoD §13.10)', () => {
  it('scenár nízkej istoty → nízke field confidence a chýbajúce polia', async () => {
    const res = await simulateInboundEmail(input({ scenario: 'nizka_istota' }), deps);
    const doc = state.documents.find((d) => d.id === res.createdDocumentIds[0])!;
    expect(doc.confidence).toBeLessThan(0.7);
    expect(doc.extracted.variabilnySymbol).toBeUndefined();
    expect(doc.extracted.datumDodania).toBeUndefined();
    expect(Object.values(doc.fieldConfidence ?? {}).some((v) => v < 0.7)).toBe(true);
  });
});

describe('extraction runs a suggestions', () => {
  it('úspešná extrakcia vytvorí ExtractionRun so succeeded a návrh zaúčtovania', async () => {
    const res = await simulateInboundEmail(input(), deps);
    const run = state.extractionRuns.find((r) => r.documentId === res.createdDocumentIds[0])!;
    expect(run.status).toBe('succeeded');
    expect(run.provider).toBe('mock');
    expect(run.result).toBeTruthy();
    const suggestion = state.suggestions.find((s) => s.documentId === res.createdDocumentIds[0]);
    expect(suggestion).toBeTruthy();
    expect(suggestion!.source).toBeTruthy();
  });
});

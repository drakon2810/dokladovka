import { beforeEach, describe, expect, it } from 'vitest';
import type { Role } from './types';
import {
  addCodeListItem,
  addComment,
  archiveOrganization,
  archiveQueue,
  createBankAccount,
  createDocument,
  createOrganization,
  createQueue,
  disableBankAccount,
  generateExport,
  getDataSnapshot,
  recordPaymentQrGenerated,
  reprocessDocument,
  resetDemoData,
  saveDocument,
  setRole,
  simulateInboundEmail,
  updateUserRole,
} from './api';
import { MOCK_TENANT_ID } from './config';
import { storeApi } from './store';

beforeEach(async () => {
  await setRole('admin');
  await resetDemoData();
  await setRole('admin');
});

describe('service capability boundary', () => {
  it.each([
    ['create document', () => createDocument({} as never)],
    ['edit document', () => saveDocument('doc-001', {})],
    ['change payment', () => recordPaymentQrGenerated('doc-001', 'a'.repeat(64), 1)],
    ['reprocess document', () => reprocessDocument('doc-001')],
    ['manage organization', () => archiveOrganization('org-alfa')],
    [
      'manage bank account',
      () =>
        createBankAccount({
          organizationId: 'org-alfa',
          label: 'Test',
          iban: 'SK9611000000002918599669',
          currency: 'EUR',
          isDefault: false,
        }),
    ],
    [
      'manage queue',
      () =>
        createQueue({
          organizationId: 'org-alfa',
          name: 'Test',
          kind: 'other',
          documentTypes: ['PD'],
        }),
    ],
    ['manage code lists', () => addCodeListItem('strediska', 'org-alfa', 'X', 'X')],
    ['manage users', () => updateUserRole('user-1', 'admin')],
    [
      'simulate inbound',
      () =>
        simulateInboundEmail({
          recipientAlias: 'missing@example.test',
          sender: 'sender@example.test',
          subject: 'Test',
          attachments: [],
          scenario: 'uspech',
        }),
    ],
    ['reset demo', () => resetDemoData()],
  ])('schvaľovateľ cannot bypass UI to %s', async (_name, operation) => {
    await setRole('schvalovatel');
    await expect(operation()).rejects.toThrow();
  });

  it.each([
    ['manage organization', () => createOrganization({} as never)],
    ['manage code lists', () => addCodeListItem('strediska', 'org-alfa', 'X', 'X')],
    ['manage users', () => updateUserRole('user-1', 'admin')],
    ['reset demo', () => resetDemoData()],
  ])('účtovník cannot bypass admin UI to %s', async (_name, operation) => {
    await setRole('uctovnik');
    await expect(operation()).rejects.toThrow(/admin/);
  });

  it('comments remain available to every authenticated legacy role', async () => {
    for (const role of ['admin', 'uctovnik', 'schvalovatel'] as const) {
      await setRole(role);
      const updated = await addComment('doc-001', `Komentár ${role}`);
      expect(updated.comments.at(-1)?.text).toBe(`Komentár ${role}`);
    }
  });

  it('unknown roles fail closed even after malformed state injection', async () => {
    await expect(setRole('owner' as Role)).rejects.toThrow(/Nepodporovaná/);

    storeApi.set({ role: 'owner' as Role });
    await expect(getDataSnapshot()).rejects.toThrow(/oprávnenie/);
    await expect(addComment('doc-001', 'Neoprávnený komentár')).rejects.toThrow(
      /oprávnenie/,
    );
    expect(storeApi.get().documents.find((item) => item.id === 'doc-001')?.comments).toEqual(
      [],
    );
  });
});

describe('tenant isolation at the service boundary', () => {
  it('filters every tenant-owned collection, including queues and bank accounts', async () => {
    const state = storeApi.get();
    const foreignTenantId = 'tenant-foreign';
    const foreignOrgId = 'org-foreign';
    const foreign = <T extends { tenantId?: string }>(item: T, patch: Partial<T> = {}): T => ({
      ...structuredClone(item),
      ...patch,
      tenantId: foreignTenantId,
    });

    storeApi.set({
      currentOrgId: foreignOrgId,
      organizations: [
        ...state.organizations,
        foreign(state.organizations[0], { id: foreignOrgId } as never),
      ],
      queues: [...state.queues, foreign(state.queues[0])],
      bankAccounts: [...state.bankAccounts, foreign(state.bankAccounts[0])],
      aliases: [...state.aliases, foreign(state.aliases[0])],
      documents: [...state.documents, foreign(state.documents[0])],
      inboundEmails: [...state.inboundEmails, foreign(state.inboundEmails[0])],
      inboundAttachments: [
        ...state.inboundAttachments,
        foreign(state.inboundAttachments[0]),
      ],
      extractionRuns: [...state.extractionRuns, foreign(state.extractionRuns[0])],
      suggestions: [...state.suggestions, foreign(state.suggestions[0])],
      codeLists: {
        predkontacie: [
          ...state.codeLists.predkontacie,
          foreign(state.codeLists.predkontacie[0]),
        ],
        cleneniaDph: [
          ...state.codeLists.cleneniaDph,
          foreign(state.codeLists.cleneniaDph[0]),
        ],
        ciselneRady: [
          ...state.codeLists.ciselneRady,
          foreign(state.codeLists.ciselneRady[0]),
        ],
        strediska: [...state.codeLists.strediska, foreign(state.codeLists.strediska[0])],
        zakazky: [...state.codeLists.zakazky, foreign(state.codeLists.zakazky[0])],
        cinnosti: [...state.codeLists.cinnosti, foreign(state.codeLists.cinnosti[0])],
        projekty: [...state.codeLists.projekty, foreign(state.codeLists.projekty[0])],
      },
      users: [...state.users, foreign(state.users[0])],
      exportBatches: [...state.exportBatches, foreign(state.exportBatches[0])],
    });

    const snapshot = await getDataSnapshot();
    const collections = [
      snapshot.organizations,
      snapshot.queues,
      snapshot.bankAccounts,
      snapshot.aliases,
      snapshot.documents,
      snapshot.inboundEmails,
      snapshot.inboundAttachments,
      snapshot.extractionRuns,
      snapshot.suggestions,
      snapshot.codeLists.predkontacie,
      snapshot.codeLists.cleneniaDph,
      snapshot.codeLists.ciselneRady,
      snapshot.codeLists.strediska,
      snapshot.users,
      snapshot.exportBatches,
    ];
    for (const collection of collections) {
      expect(collection.every((item) => item.tenantId === MOCK_TENANT_ID)).toBe(true);
    }
    expect(snapshot.currentOrgId).toBe('all');
  });

  it('does not mutate a foreign document with the same id during export', async () => {
    const approved = storeApi.get().documents.find((item) => item.id === 'doc-004')!;
    const foreign = { ...structuredClone(approved), tenantId: 'tenant-foreign' };
    storeApi.set({ documents: [...storeApi.get().documents, foreign] });

    await generateExport('org-alfa', [approved.id]);

    expect(
      storeApi
        .get()
        .documents.find(
          (item) => item.id === approved.id && item.tenantId === 'tenant-foreign',
        )?.status,
    ).toBe(foreign.status);
  });

  it('does not mutate same-id bank accounts, queues or aliases from another tenant', async () => {
    const account = storeApi.get().bankAccounts[0];
    const foreignAccount = {
      ...structuredClone(account),
      tenantId: 'tenant-foreign',
    };
    storeApi.set({ bankAccounts: [...storeApi.get().bankAccounts, foreignAccount] });
    await disableBankAccount(account.id);
    expect(
      storeApi
        .get()
        .bankAccounts.find((item) => item.id === account.id && item.tenantId === 'tenant-foreign'),
    ).toMatchObject({ active: true, isDefault: account.isDefault });

    const queue = await createQueue({
      organizationId: 'org-alfa',
      name: 'Prázdna bezpečnostná fronta',
      kind: 'other',
      documentTypes: ['PD'],
    });
    const queueAlias = storeApi.get().aliases.find((item) => item.queueId === queue.id)!;
    storeApi.set({
      queues: [
        ...storeApi.get().queues,
        { ...structuredClone(queue), tenantId: 'tenant-foreign' },
      ],
      aliases: [
        ...storeApi.get().aliases,
        { ...structuredClone(queueAlias), id: 'foreign-alias', tenantId: 'tenant-foreign' },
      ],
    });
    await archiveQueue(queue.id);

    expect(
      storeApi
        .get()
        .queues.find((item) => item.id === queue.id && item.tenantId === 'tenant-foreign')
        ?.active,
    ).toBe(true);
    expect(
      storeApi.get().aliases.find((item) => item.id === 'foreign-alias')?.status,
    ).toBe('active');
  });
});

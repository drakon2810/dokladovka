import { beforeEach, describe, expect, it } from 'vitest';
import {
  archiveQueue,
  createDocument,
  createOrganization,
  createQueue,
  listAliases,
  listQueues,
  resetDemoData,
  setRole,
  simulateInboundEmail,
  updateQueue,
} from './api';
import { MOCK_TENANT_ID } from './config';
import { storeApi } from './store';

const ORGANIZATION_INPUT = {
  nazov: 'Queue Test s.r.o.',
  ico: '87654321',
  dic: '2098765432',
  icDph: 'SK2098765432',
  farba: '#2563EB',
};

const DOCUMENT_INPUT = {
  organizationId: 'org-alfa',
  typ: 'FP' as const,
  mode: 'manual' as const,
  supplierName: 'Fronta Test Dodávateľ s.r.o.',
  invoiceNumber: 'QUEUE-TEST-001',
  issueDate: '2026-07-12',
  taxDate: '2026-07-12',
  dueDate: '2026-07-26',
  currency: 'EUR' as const,
  totalAmount: 123,
  vatRate: 23 as const,
};

beforeEach(async () => {
  await setRole('admin');
  await resetDemoData();
  await setRole('admin');
});

describe('fronta vytvorená spolu s organizáciou', () => {
  it('vytvorí tri aktívne fronty s unikátnymi aliasmi a pokryje každý typ dokladu', async () => {
    const { organization, primaryEmailAlias } = await createOrganization(
      ORGANIZATION_INPUT,
    );

    const queues = await listQueues(organization.id);
    const aliases = await listAliases(organization.id);

    expect(queues).toHaveLength(3);
    expect(aliases).toHaveLength(3);
    expect(new Set(aliases.map((alias) => alias.addressNormalized)).size).toBe(3);
    expect(aliases.every((alias) => alias.status === 'active')).toBe(true);
    expect(new Set(queues.flatMap((queue) => queue.documentTypes))).toEqual(
      new Set(['FP', 'FV', 'BV', 'MZDY', 'OZ', 'PD']),
    );
    const received = queues.find((queue) => queue.kind === 'received_invoices');
    expect(received).toMatchObject({
      tenantId: MOCK_TENANT_ID,
      organizationId: organization.id,
      kind: 'received_invoices',
      documentTypes: ['FP', 'OZ'],
      importAlias: primaryEmailAlias.address,
      active: true,
    });
    expect(primaryEmailAlias.queueId).toBe(received?.id);
    expect(primaryEmailAlias.isPrimary).toBe(true);
    expect(organization.emailAlias).toBe(primaryEmailAlias.address);
    for (const queue of queues) {
      expect(aliases.find((alias) => alias.queueId === queue.id)?.address).toBe(
        queue.importAlias,
      );
    }
  });
});

describe('vytvorenie fronty', () => {
  it('rešpektuje rolu a tenant/org hranicu a generuje unikátny alias', async () => {
    await setRole('uctovnik');
    await expect(
      createQueue({
        organizationId: 'org-alfa',
        name: 'Dodatočné faktúry',
        kind: 'received_invoices',
        documentTypes: ['FP'],
      }),
    ).rejects.toThrow(/admin/);

    await setRole('admin');
    const first = await createQueue({
      organizationId: 'org-alfa',
      name: 'Dodatočné faktúry',
      kind: 'received_invoices',
      documentTypes: ['FP'],
    });
    const second = await createQueue({
      organizationId: 'org-alfa',
      name: 'Dodatočné faktúry',
      kind: 'received_invoices',
      documentTypes: ['FP'],
    });
    const aliases = await listAliases('org-alfa');
    const firstAlias = aliases.find((alias) => alias.queueId === first.id);
    const secondAlias = aliases.find((alias) => alias.queueId === second.id);

    expect(first).toMatchObject({
      tenantId: MOCK_TENANT_ID,
      organizationId: 'org-alfa',
      active: true,
    });
    expect(firstAlias).toMatchObject({
      tenantId: MOCK_TENANT_ID,
      organizationId: 'org-alfa',
      queueId: first.id,
      status: 'active',
      isPrimary: false,
      address: first.importAlias,
    });
    expect(firstAlias?.address).not.toBe(secondAlias?.address);

    storeApi.set({
      organizations: [
        ...storeApi.get().organizations,
        {
          ...storeApi.get().organizations[0],
          id: 'org-foreign-queue',
          tenantId: 'tenant-foreign',
          archived: false,
        },
      ],
    });
    await expect(
      createQueue({
        organizationId: 'org-foreign-queue',
        name: 'Cudzia fronta',
        kind: 'other',
        documentTypes: ['PD'],
      }),
    ).rejects.toThrow(/dostupná/);
  });
});

describe('ručné vloženie dokladu do fronty', () => {
  it('prijme kompatibilnú frontu a odmietne frontu inej organizácie alebo archivovanú frontu', async () => {
    const compatibleQueue = await createQueue({
      organizationId: 'org-alfa',
      name: 'Prijaté faktúry na spracovanie',
      kind: 'received_invoices',
      documentTypes: ['FP'],
    });
    const archivedQueue = await createQueue({
      organizationId: 'org-alfa',
      name: 'Dočasná fronta',
      kind: 'received_invoices',
      documentTypes: ['FP'],
    });
    await archiveQueue(archivedQueue.id);

    const document = await createDocument({
      ...DOCUMENT_INPUT,
      queueId: compatibleQueue.id,
    });
    expect(document.queueId).toBe(compatibleQueue.id);
    expect(compatibleQueue.documentTypes).toContain(document.typ);

    await expect(
      createDocument({
        ...DOCUMENT_INPUT,
        invoiceNumber: 'QUEUE-TEST-CROSS-ORG',
        queueId: 'queue-org-beta-received',
      }),
    ).rejects.toThrow(/vhodná fronta/);

    const incompatibleQueue = await createQueue({
      organizationId: 'org-alfa',
      name: 'Len pokladničné doklady',
      kind: 'cash_documents',
      documentTypes: ['PD'],
    });
    await expect(
      createDocument({
        ...DOCUMENT_INPUT,
        invoiceNumber: 'QUEUE-TEST-WRONG-TYPE',
        queueId: incompatibleQueue.id,
      }),
    ).rejects.toThrow(/vhodná fronta/);
    await expect(
      createDocument({
        ...DOCUMENT_INPUT,
        invoiceNumber: 'QUEUE-TEST-ARCHIVED',
        queueId: archivedQueue.id,
      }),
    ).rejects.toThrow(/vhodná fronta/);
  });
});

describe('inbound routing do fronty', () => {
  it('vloží dokument presne do fronty priradenej import aliasu', async () => {
    const queue = await createQueue({
      organizationId: 'org-alfa',
      name: 'E-mailové faktúry',
      kind: 'received_invoices',
      documentTypes: ['FP'],
    });
    const alias = (await listAliases('org-alfa')).find(
      (candidate) => candidate.queueId === queue.id,
    );
    expect(alias).toBeDefined();

    const result = await simulateInboundEmail({
      recipientAlias: alias!.address,
      sender: 'queue-test@dodavatel.sk',
      subject: 'Faktúra do konkrétnej fronty',
      attachments: [
        {
          fileName: 'queue-routing.pdf',
          mimeType: 'application/pdf',
          contentSeed: 'queue-routing-exact-alias',
        },
      ],
      scenario: 'uspech',
    });
    const document = storeApi
      .get()
      .documents.find((candidate) => candidate.id === result.createdDocumentIds[0]);

    expect(result.createdDocumentIds).toHaveLength(1);
    expect(result.inboundEmail.aliasId).toBe(alias!.id);
    expect(document).toMatchObject({
      tenantId: MOCK_TENANT_ID,
      orgId: 'org-alfa',
      queueId: queue.id,
    });
  });
});

describe('úprava a archivácia fronty', () => {
  it('uloží feature flags, warning threshold a automatizáciu', async () => {
    const queue = await createQueue({
      organizationId: 'org-alfa',
      name: 'Konfigurovateľná fronta',
      kind: 'received_invoices',
      documentTypes: ['FP'],
    });

    const updated = await updateQueue(queue.id, {
      warningThreshold: 0.91,
      features: {
        ...queue.features,
        extraction: false,
        requireApprovalNote: true,
      },
      automation: {
        minConfidence: 0.95,
        action: 'move_to_validation',
      },
    });

    expect(updated.warningThreshold).toBe(0.91);
    expect(updated.features).toMatchObject({
      extraction: false,
      approval: true,
      requireApprovalNote: true,
    });
    expect(updated.automation).toEqual({
      minConfidence: 0.95,
      action: 'move_to_validation',
    });
  });

  it('nedovolí odobrať typ používaný dokladom vo fronte', async () => {
    const queue = await createQueue({
      organizationId: 'org-alfa',
      name: 'Fronta s dokladom',
      kind: 'received_invoices',
      documentTypes: ['FP', 'OZ'],
    });
    await createDocument({
      ...DOCUMENT_INPUT,
      invoiceNumber: 'QUEUE-TYPE-IN-USE',
      queueId: queue.id,
    });

    await expect(
      updateQueue(queue.id, { documentTypes: ['OZ'] }),
    ).rejects.toThrow(/používa existujúci doklad/);
    expect((await listQueues('org-alfa')).find((item) => item.id === queue.id)?.documentTypes).toEqual([
      'FP',
      'OZ',
    ]);
  });

  it('validuje automatizáciu a odmietne nefunkčné odoslanie do ERP', async () => {
    const queue = await createQueue({
      organizationId: 'org-alfa',
      name: 'Validácia automatizácie',
      kind: 'received_invoices',
      documentTypes: ['FP'],
    });

    await expect(
      updateQueue(queue.id, { automation: { action: 'move_to_validation' } }),
    ).rejects.toThrow(/minimálnu istotu/);
    await expect(
      updateQueue(queue.id, { automation: { minConfidence: 0.8 } }),
    ).rejects.toThrow(/automatizačnú akciu/);
    await expect(
      updateQueue(queue.id, {
        automation: { action: 'move_to_validation', minConfidence: 1.01 },
      }),
    ).rejects.toThrow(/medzi 0 a 1/);
    await expect(
      updateQueue(queue.id, {
        automation: { action: 'send_to_erp', minConfidence: 0.95 },
      }),
    ).rejects.toThrow(/ERP.*demo režime/);
    await expect(
      updateQueue(queue.id, {
        automation: {
          action: 'delete_document' as never,
          minConfidence: 0.95,
        },
      }),
    ).rejects.toThrow(/Nepodporovaná/);

    // Legacy send_to_erp sa pri nesúvisiacej úprave nezmaže ani nespustí.
    storeApi.set({
      queues: storeApi.get().queues.map((item) =>
        item.id === queue.id
          ? { ...item, automation: { action: 'send_to_erp', minConfidence: 0.9 } }
          : item,
      ),
    });
    const renamed = await updateQueue(queue.id, { name: 'Premenovaná fronta' });
    expect(renamed.automation).toEqual({
      action: 'send_to_erp',
      minConfidence: 0.9,
    });
  });

  it('odmietne neprázdnu frontu a pri prázdnej vypne aj jej alias', async () => {
    const nonEmptyQueueId = storeApi.get().documents[0].queueId;
    await expect(archiveQueue(nonEmptyQueueId)).rejects.toThrow(/s dokladmi/);

    const emptyQueue = await createQueue({
      organizationId: 'org-alfa',
      name: 'Prázdna fronta',
      kind: 'other',
      documentTypes: ['PD'],
    });
    const queueAlias = (await listAliases('org-alfa')).find(
      (alias) => alias.queueId === emptyQueue.id,
    );

    await archiveQueue(emptyQueue.id);

    expect((await listQueues('org-alfa')).find((queue) => queue.id === emptyQueue.id)?.active).toBe(
      false,
    );
    expect(
      (await listAliases('org-alfa')).find((alias) => alias.id === queueAlias?.id),
    ).toMatchObject({
      status: 'disabled',
      queueId: emptyQueue.id,
    });
    expect(
      (await listAliases('org-alfa')).find((alias) => alias.id === queueAlias?.id)?.disabledAt,
    ).toBeTruthy();
  });
});

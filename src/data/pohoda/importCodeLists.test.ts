import { beforeEach, describe, expect, it } from 'vitest';
import {
  addCodeListItem,
  deleteCodeListItem,
  importPohodaCodeLists,
  resetDemoData,
  setRole,
  updateCodeListItem,
} from '../api';
import { MOCK_TENANT_ID } from '../config';
import { storeApi } from '../store';
import type { CodeListItem } from '../types';
import type { CodeListImportPreview } from './parseCodeListResponse';

function emptyPreview(orgId = 'org-alfa'): CodeListImportPreview {
  const emptyKind = () => ({ nove: [], aktualizovane: [], bezZmeny: 0, vyradene: [] });
  return {
    orgId,
    perKind: {
      predkontacie: emptyKind(),
      cleneniaDph: emptyKind(),
      ciselneRady: emptyKind(),
      strediska: emptyKind(),
      zakazky: emptyKind(),
      cinnosti: emptyKind(),
      projekty: emptyKind(),
    },
    warnings: [],
  };
}

function item(
  id: string,
  kod: string,
  source: CodeListItem['source'],
  active = true,
  patch: Partial<CodeListItem> = {},
): CodeListItem {
  return {
    id,
    tenantId: MOCK_TENANT_ID,
    orgId: 'org-alfa',
    kod,
    nazov: `Položka ${kod}`,
    source,
    active,
    ...patch,
  };
}

beforeEach(async () => {
  await setRole('admin');
  await resetDemoData();
});

describe('POHODA code-list import', () => {
  it('atomicky upsertne, adoptuje, reaktivuje a iba POHODA položky deaktivuje', async () => {
    const state = storeApi.get();
    const adopted = item('manual-adopt', 'ADOPT', 'manual');
    const removed = item('pohoda-removed', 'REMOVED', 'pohoda', true, {
      syncedAt: '2026-01-01T00:00:00.000Z',
    });
    const reactivated = item('pohoda-reactivate', 'REACT', 'pohoda', false, {
      nazov: 'Starý názov',
      syncedAt: '2026-01-01T00:00:00.000Z',
    });
    const manualMissing = item('manual-missing', 'MANUAL', 'manual');
    const beta = item('beta-pohoda', 'BETA', 'pohoda', true, { orgId: 'org-beta' });
    const foreignSameId = item(removed.id, removed.kod, 'pohoda', true, {
      tenantId: 'tenant-foreign',
    });
    const approved = state.documents.find((document) => document.id === 'doc-004')!;
    const approvedWithAdoptedId = {
      ...approved,
      ucto: { ...approved.ucto, predkontaciaId: adopted.id },
      approvedVersion: approved.version,
      approvedSnapshot: {
        version: approved.version,
        approvedAt: '2026-07-01T00:00:00.000Z',
        typ: approved.typ,
        extracted: structuredClone(approved.extracted),
        ucto: { ...approved.ucto, predkontaciaId: adopted.id },
      },
    };
    storeApi.set({
      codeLists: {
        ...state.codeLists,
        predkontacie: [
          ...state.codeLists.predkontacie,
          adopted,
          removed,
          reactivated,
          manualMissing,
          beta,
          foreignSameId,
        ],
      },
      documents: state.documents.map((document) =>
        document.id === approved.id ? approvedWithAdoptedId : document,
      ),
    });
    const documentsBefore = structuredClone(storeApi.get().documents);
    const batchesBefore = structuredClone(storeApi.get().exportBatches);

    const preview = emptyPreview();
    preview.perKind.predkontacie.nove.push({
      kod: 'NEW',
      nazov: 'Nová predkontácia',
      externalId: '900',
    });
    preview.perKind.predkontacie.aktualizovane.push(
      { kod: adopted.kod, nazov: 'Adoptovaná z POHODY', externalId: '901' },
      { kod: reactivated.kod, nazov: 'Aktuálny názov', agenda: 'FP' },
    );
    preview.perKind.predkontacie.vyradene.push(removed, manualMissing);

    const first = await importPohodaCodeLists('org-alfa', preview);
    expect(first).toMatchObject({
      nove: 1,
      aktualizovane: 2,
      vyradene: 1,
      bezZmeny: 0,
      totalChanges: 4,
    });

    const after = storeApi.get();
    const target = after.codeLists.predkontacie;
    expect(target.find((candidate) => candidate.kod === 'NEW')).toMatchObject({
      source: 'pohoda',
      active: true,
      externalId: '900',
    });
    expect(target.find((candidate) => candidate.kod === adopted.kod)).toMatchObject({
      id: adopted.id,
      source: 'pohoda',
      active: true,
      nazov: 'Adoptovaná z POHODY',
      externalId: '901',
    });
    expect(target.find((candidate) => candidate.id === reactivated.id)).toMatchObject({
      active: true,
      nazov: 'Aktuálny názov',
      agenda: 'FP',
    });
    expect(
      target.find(
        (candidate) => candidate.id === removed.id && candidate.tenantId === MOCK_TENANT_ID,
      ),
    ).toMatchObject({
      active: false,
      source: 'pohoda',
      syncedAt: expect.not.stringMatching(/^2026-01-01/),
    });
    expect(target.find((candidate) => candidate.id === manualMissing.id)).toMatchObject({
      active: true,
      source: 'manual',
    });
    expect(target.find((candidate) => candidate.id === beta.id)).toMatchObject({ active: true });
    expect(
      target.find(
        (candidate) => candidate.id === removed.id && candidate.tenantId === 'tenant-foreign',
      ),
    ).toMatchObject({ active: true });
    expect(after.documents).toEqual(documentsBefore);
    expect(after.exportBatches).toEqual(batchesBefore);
    expect(
      after.documents.find((document) => document.id === approved.id)?.approvedSnapshot?.ucto
        .predkontaciaId,
    ).toBe(adopted.id);

    const listsAfterFirstImport = structuredClone(after.codeLists);
    const second = await importPohodaCodeLists('org-alfa', preview);
    expect(second).toMatchObject({
      nove: 0,
      aktualizovane: 0,
      vyradene: 0,
      bezZmeny: 3,
      totalChanges: 0,
    });
    expect(storeApi.get().codeLists).toEqual(listsAfterFirstImport);
  });

  it('pri neplatnom preview nezapíše ani čiastočnú zmenu', async () => {
    const before = structuredClone(storeApi.get().codeLists);
    const preview = emptyPreview();
    preview.perKind.strediska.nove.push({ kod: 'DUP', nazov: 'Prvé' });
    preview.perKind.strediska.aktualizovane.push({ kod: 'DUP', nazov: 'Druhé' });

    await expect(importPohodaCodeLists('org-alfa', preview)).rejects.toThrow(/viackrát/);
    expect(storeApi.get().codeLists).toEqual(before);
  });

  it('vyžaduje admin oprávnenie', async () => {
    await setRole('uctovnik');
    await expect(importPohodaCodeLists('org-alfa', emptyPreview())).rejects.toThrow(/admin/);
  });
});

describe('manual code-list CRUD', () => {
  it('vytvorí manual/active položku a deaktivácia ju fyzicky neodstráni', async () => {
    const created = await addCodeListItem('strediska', 'org-alfa', '  TEST  ', '  Test  ');
    expect(created).toMatchObject({
      kod: 'TEST',
      nazov: 'Test',
      source: 'manual',
      active: true,
    });

    await deleteCodeListItem('strediska', created.id);
    expect(storeApi.get().codeLists.strediska.find((candidate) => candidate.id === created.id)).toMatchObject({
      active: false,
    });
  });

  it('nedovolí ručne prepísať synchronizovanú položku', async () => {
    const synced = item('pohoda-read-only', 'SYNC', 'pohoda');
    storeApi.set({
      codeLists: {
        ...storeApi.get().codeLists,
        strediska: [...storeApi.get().codeLists.strediska, synced],
      },
    });

    await expect(
      updateCodeListItem('strediska', synced.id, { nazov: 'Prepísané' }),
    ).rejects.toThrow(/synchronizovaná/);
  });
});

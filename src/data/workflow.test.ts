import { beforeEach, describe, expect, it } from 'vitest';
import {
  addComment,
  approveDocument,
  approveDocuments,
  applyExtractionRun,
  checkApprovable,
  deleteCodeListItem,
  generateExport,
  getBatchXml,
  getDataSnapshot,
  getDocument,
  getSuggestion,
  resetDemoData,
  reprocessDocument,
  rejectDocument,
  rejectDocuments,
  saveDocument,
  setCurrentOrg,
  setRole,
  simulateInboundEmail,
} from './api';
import { parseDecimalString, isValidIsoDate } from './validation/documentValidation';

beforeEach(async () => {
  await setRole('admin');
  await resetDemoData();
  await setRole('uctovnik');
});

describe('mock e-mail → kontrola → schválenie → XML export', () => {
  it('prejde celý service workflow a uloží nemenný XML snapshot', async () => {
    await setRole('admin');
    const inbound = await simulateInboundEmail({
      recipientAlias: 'alfa-trade-k7m4q2@doklady.dokladorpro.sk',
      sender: 'fakturacia@novy-dodavatel.sk',
      subject: 'Faktúra na spracovanie',
      attachments: [
        {
          fileName: 'workflow.pdf',
          mimeType: 'application/pdf',
          contentSeed: 'workflow-unikatny-obsah',
        },
      ],
      scenario: 'uspech',
    });
    expect(inbound.createdDocumentIds).toHaveLength(1);
    await setRole('uctovnik');
    const id = inbound.createdDocumentIds[0];
    const extracted = await getDocument(id);
    expect(extracted?.status).toBe('extrahovany');

    const suggestion = await getSuggestion(id);
    expect(suggestion?.organizationId).toBe('org-alfa');
    expect(suggestion?.predkontaciaId).toBeTruthy();
    expect(suggestion?.clenenieDphId).toBeTruthy();
    expect(suggestion?.ciselnyRadId).toBeTruthy();

    const saved = await saveDocument(id, {
      ucto: {
        predkontaciaId: suggestion?.predkontaciaId,
        clenenieDphId: suggestion?.clenenieDphId,
        ciselnyRadId: suggestion?.ciselnyRadId,
        strediskoId: suggestion?.strediskoId,
      },
    });
    const approved = await approveDocument(id, saved.version);
    expect(approved.status).toBe('schvaleny');
    expect(approved.approvedSnapshot?.version).toBe(approved.version);

    const exported = await generateExport('org-alfa', [id]);
    expect(exported.batch.xmlSnapshot).toBe(exported.xml);
    expect(exported.xml).toContain(`<dat:dataPackItem id="${id}"`);
    expect((await getDocument(id))?.status).toBe('exportovany');
    expect(await getBatchXml(exported.batch.id)).toEqual({
      xml: exported.xml,
      fileName: exported.batch.xmlFileName,
    });
  });
});

describe('role a deterministic boundaries', () => {
  it('schvaľovateľ nemôže meniť extrahované údaje', async () => {
    await setRole('schvalovatel');
    await expect(
      saveDocument('doc-001', { ucto: { predkontaciaId: 'x' } }),
    ).rejects.toThrow(/Schvaľovateľ/);
  });

  it('normalizuje desatinnú čiarku a odmietne neexistujúci dátum', () => {
    expect(parseDecimalString('123,45')).toBe(123.45);
    expect(isValidIsoDate('2026-02-29')).toBe(false);
    expect(isValidIsoDate('2028-02-29')).toBe(true);
  });

  it('odmietne code-list ID z inej organizácie', async () => {
    const saved = await saveDocument('doc-001', {
      ucto: {
        predkontaciaId: 'org-beta-pk-518/321',
        clenenieDphId: 'org-beta-cd-PD',
        ciselnyRadId: 'org-beta-cr-26FP',
      },
    });
    await expect(approveDocument('doc-001', saved.version)).rejects.toThrow(/zaúčtovanie/);
  });

  it('schvaľovateľ schváli iba doklad už prevzatý na kontrolu', async () => {
    const saved = await saveDocument('doc-001', {
      ucto: {
        predkontaciaId: 'org-alfa-pk-518/321',
        clenenieDphId: 'org-alfa-cd-PD',
        ciselnyRadId: 'org-alfa-cr-26FP',
      },
    });
    await setRole('schvalovatel');
    await expect(approveDocument('doc-001', saved.version)).resolves.toMatchObject({ status: 'schvaleny' });
    const extracted = await getDocument('doc-012');
    await expect(approveDocument('doc-012', extracted!.version)).rejects.toThrow(/na kontrole/);
  });

  it('neumožní zvoliť organizáciu mimo aktuálneho tenant snapshotu', async () => {
    await expect(setCurrentOrg('org-cudzi-tenant')).rejects.toThrow(/dostupná/);
  });

  it('zastaví uloženie zo zastaranej verzie dokladu', async () => {
    const original = await getDocument('doc-001');
    expect(original).toBeTruthy();
    await saveDocument(
      'doc-001',
      { ucto: { ...original!.ucto, poznamka: 'Prvá zmena' } },
      original!.version,
    );
    await expect(
      saveDocument(
        'doc-001',
        { ucto: { ...original!.ucto, poznamka: 'Stará zmena' } },
        original!.version,
      ),
    ).rejects.toThrow(/medzitým zmenený/);
  });

  it('neexportuje schválený doklad po deaktivácii jeho code-list položky', async () => {
    await setRole('admin');
    await deleteCodeListItem('predkontacie', 'org-alfa-pk-501/321');
    expect(
      (await getDataSnapshot()).codeLists.predkontacie.find(
        (item) => item.id === 'org-alfa-pk-501/321',
      ),
    ).toMatchObject({ active: false });
    await expect(generateExport('org-alfa', ['doc-004'])).rejects.toThrow(/validačné/);
  });

  it('pri schválení uzná iba aktívne položky rovnakého tenant-a', async () => {
    const snapshot = await getDataSnapshot();
    const document = structuredClone(snapshot.documents.find((item) => item.id === 'doc-001')!);
    document.ucto = {
      predkontaciaId: 'org-alfa-pk-518/321',
      clenenieDphId: 'org-alfa-cd-PD',
      ciselnyRadId: 'org-alfa-cr-26FP',
      strediskoId: 'org-alfa-st-HLAVNE',
    };
    const inactiveLists = structuredClone(snapshot.codeLists);
    inactiveLists.predkontacie = inactiveLists.predkontacie.map((item) =>
      item.id === document.ucto.predkontaciaId ? { ...item, active: false } : item,
    );
    inactiveLists.predkontacie.push({
      ...inactiveLists.predkontacie.find(
        (item) => item.id === document.ucto.predkontaciaId,
      )!,
      tenantId: 'tenant-foreign',
      active: true,
    });
    expect(checkApprovable(document, inactiveLists, snapshot.organizations).ok).toBe(false);

    const invalidCentreLists = structuredClone(snapshot.codeLists);
    invalidCentreLists.strediska = invalidCentreLists.strediska.map((item) =>
      item.id === document.ucto.strediskoId ? { ...item, active: false } : item,
    );
    expect(checkApprovable(document, invalidCentreLists, snapshot.organizations).ok).toBe(false);
  });

  it('nová extrakcia neprepíše dáta bez explicitného použitia', async () => {
    const before = await getDocument('doc-001');
    const run = await reprocessDocument('doc-001');
    const afterRun = await getDocument('doc-001');
    expect(afterRun?.extracted).toEqual(before?.extracted);
    expect(afterRun?.version).toBe(before?.version);

    const applied = await applyExtractionRun('doc-001', run.id, before?.version);
    expect(applied.version).toBe((before?.version ?? 0) + 1);
    expect(applied.status).toBe('na_kontrole');
    expect(applied.history.at(-1)?.akcia).toContain(run.id);
  });

  it('povinný DUZP a nesúlad položiek blokujú schválenie', async () => {
    const snapshot = await getDataSnapshot();
    const missingTaxDate = snapshot.documents.find((item) => item.id === 'doc-003')!;
    const missingTaxCheck = checkApprovable(
      missingTaxDate,
      snapshot.codeLists,
      snapshot.organizations,
    );
    expect(missingTaxCheck.issues.map((issue) => issue.code)).toContain('tax_date_required');

    const lineMismatch = structuredClone(
      snapshot.documents.find((item) => item.id === 'doc-004')!,
    );
    lineMismatch.extracted.polozky![0].sumaSpolu = 1;
    const lineCheck = checkApprovable(
      lineMismatch,
      snapshot.codeLists,
      snapshot.organizations,
    );
    expect(lineCheck.issues.map((issue) => issue.code)).toContain('invalid_line_item');
  });

  it('návrh dodávateľa nikdy nepoužije históriu inej organizácie', async () => {
    const suggestion = await getSuggestion('doc-001');
    expect(suggestion?.organizationId).toBe('org-alfa');
    expect(suggestion?.basedOnDocumentId).toBe('doc-005');
  });

  it('historický export sa sťahuje z immutable snapshotu', async () => {
    const before = await getBatchXml('exp-1');
    await setRole('admin');
    await deleteCodeListItem('predkontacie', 'org-alfa-pk-518/321');
    const after = await getBatchXml('exp-1');
    expect(after).toEqual(before);
    expect(after.xml).toContain('<typ:ids>518/321</typ:ids>');
  });
});

describe('integrita schválenia, zamietnutia a komentárov', () => {
  const alfaUcto = {
    predkontaciaId: 'org-alfa-pk-518/321',
    clenenieDphId: 'org-alfa-cd-PD',
    ciselnyRadId: 'org-alfa-cr-26FP',
  };

  it('rozhodnutia zvyšujú verziu a zastavia zastaraného recenzenta', async () => {
    const original = await getDocument('doc-001');
    const saved = await saveDocument('doc-001', { ucto: alfaUcto }, original!.version);
    const approved = await approveDocument('doc-001', saved.version);

    expect(approved.version).toBe(saved.version + 1);
    expect(approved.approvedVersion).toBe(approved.version);
    expect(approved.approvedSnapshot?.version).toBe(approved.version);
    await expect(
      rejectDocument('doc-001', saved.version, 'Rozhodnutie zo starej obrazovky'),
    ).rejects.toThrow(/medzitým zmenený/);

    const rejected = await rejectDocument(
      'doc-001',
      approved.version,
      '  Chýba objednávka od klienta.  ',
    );
    expect(rejected).toMatchObject({
      status: 'zamietnuty',
      version: approved.version + 1,
      approvedVersion: undefined,
      approvedSnapshot: undefined,
    });
    expect(rejected.history.at(-1)?.akcia).toContain('Chýba objednávka od klienta.');
    await expect(generateExport('org-alfa', ['doc-001'])).rejects.toThrow(/schválené/);
  });

  it('vyžaduje stručný ľudský dôvod a odmietne exportovaný doklad', async () => {
    const document = await getDocument('doc-001');
    await expect(rejectDocument('doc-001', document!.version, '   ')).rejects.toThrow(
      /povinný/,
    );
    await expect(
      rejectDocument('doc-001', document!.version, 'x'.repeat(1001)),
    ).rejects.toThrow(/1000/);

    const exported = await getDocument('doc-006');
    await expect(
      rejectDocument('doc-006', exported!.version, 'Nesprávny doklad'),
    ).rejects.toThrow(/Exportovaný/);
  });

  it('hromadné zamietnutie je atomické pri jednej neplatnej položke', async () => {
    const review = await getDocument('doc-001');
    const exported = await getDocument('doc-006');
    await expect(
      rejectDocuments(
        [
          { id: review!.id, expectedVersion: review!.version },
          { id: exported!.id, expectedVersion: exported!.version },
        ],
        'Spoločný dôvod',
      ),
    ).rejects.toThrow(/Exportovaný/);

    expect(await getDocument('doc-001')).toMatchObject({
      status: review!.status,
      version: review!.version,
    });
  });

  it('hromadné schválenie je atomické pri zastaranej verzii', async () => {
    const first = await getDocument('doc-001');
    const second = await getDocument('doc-002');
    const savedFirst = await saveDocument('doc-001', { ucto: alfaUcto }, first!.version);
    const savedSecond = await saveDocument('doc-002', { ucto: alfaUcto }, second!.version);

    await expect(
      approveDocuments([
        { id: savedFirst.id, expectedVersion: savedFirst.version },
        { id: savedSecond.id, expectedVersion: savedSecond.version - 1 },
      ]),
    ).rejects.toThrow(/medzitým zmenený/);
    expect((await getDocument(savedFirst.id))?.status).toBe('na_kontrole');
    expect((await getDocument(savedSecond.id))?.status).toBe('na_kontrole');
  });

  it('komentár oreže, validuje a do auditu nezapisuje jeho obsah', async () => {
    const sensitiveText = 'Interná poznámka iba pre účtovníka';
    await expect(addComment('doc-001', ' \n\t ')).rejects.toThrow(/prázdny/);
    await expect(addComment('doc-001', 'x'.repeat(4001))).rejects.toThrow(/4000/);

    const updated = await addComment('doc-001', `  ${sensitiveText}  `);
    expect(updated.comments.at(-1)?.text).toBe(sensitiveText);
    expect(updated.history.at(-1)?.akcia).toBe('Komentár pridaný');
    expect(updated.history.at(-1)?.akcia).not.toContain(sensitiveText);
  });
});

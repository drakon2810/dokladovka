// @vitest-environment happy-dom
import { beforeEach, describe, expect, it } from 'vitest';
import {
  approveDocument,
  generateExport,
  getDataSnapshot,
  getDocument,
  importPohodaCodeLists,
  resetDemoData,
  saveDocument,
  setRole,
} from '../api';
import responseFixture from './__fixtures__/code-lists-response-synthetic.xml?raw';
import { decodePohodaXml } from './encoding';
import { parseCodeListResponse } from './parseCodeListResponse';
import { buildCodeListRequestXml } from './requestTemplates';

beforeEach(async () => {
  await setRole('admin');
  await resetDemoData();
});

describe('POHODA výmena XML bez agenta', () => {
  it('prejde request → response preview → import → schválenie → dataPack', async () => {
    const before = await getDataSnapshot();
    const organization = before.organizations.find((item) => item.id === 'org-alfa')!;
    const request = buildCodeListRequestXml(organization, new Date(2026, 6, 13));
    expect(request.match(/<dat:dataPackItem /g)).toHaveLength(4);

    const responseBuffer = new TextEncoder().encode(responseFixture).buffer;
    const response = decodePohodaXml(responseBuffer);
    const preview = parseCodeListResponse(response, organization.id, before.codeLists);
    const imported = await importPohodaCodeLists(organization.id, preview);
    expect(imported).toMatchObject({ nove: 4, aktualizovane: 0, vyradene: 0 });

    const afterImport = await getDataSnapshot();
    const predkontacia = afterImport.codeLists.predkontacie.find(
      (item) => item.orgId === organization.id && item.kod === '022200',
    )!;
    const clenenieDph = afterImport.codeLists.cleneniaDph.find(
      (item) => item.orgId === organization.id && item.kod === 'DD2odb',
    )!;
    const ciselnyRad = afterImport.codeLists.ciselneRady.find(
      (item) => item.orgId === organization.id && item.kod === '2025',
    )!;
    const stredisko = afterImport.codeLists.strediska.find(
      (item) => item.orgId === organization.id && item.kod === '1',
    )!;
    expect(
      [predkontacia, clenenieDph, ciselnyRad, stredisko].every(
        (item) => item.source === 'pohoda' && item.active,
      ),
    ).toBe(true);

    const document = (await getDocument('doc-001'))!;
    const saved = await saveDocument(
      document.id,
      {
        ucto: {
          ...document.ucto,
          predkontaciaId: predkontacia.id,
          clenenieDphId: clenenieDph.id,
          ciselnyRadId: ciselnyRad.id,
          strediskoId: stredisko.id,
        },
      },
      document.version,
    );
    await approveDocument(saved.id, saved.version);
    const exported = await generateExport(organization.id, [saved.id]);

    expect(exported.xml).toContain('<inv:accounting><typ:ids>022200</typ:ids>');
    expect(exported.xml).toContain(
      '<inv:classificationVAT><typ:ids>DD2odb</typ:ids>',
    );
    expect(exported.xml).toContain('<typ:numberRequested>20250001</typ:numberRequested>');
  });
});

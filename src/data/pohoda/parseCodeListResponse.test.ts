// @vitest-environment happy-dom
import { describe, expect, it } from 'vitest';
import mdbFixture from './__fixtures__/mdb-extract-35761571.json';
import responseFixture from './__fixtures__/code-lists-response-synthetic.xml?raw';
import type { CodeListItem, CodeListKind } from '../types';
import { parseCodeListResponse } from './parseCodeListResponse';

const emptyLists = (): Record<CodeListKind, CodeListItem[]> => ({
  predkontacie: [],
  cleneniaDph: [],
  ciselneRady: [],
  strediska: [],
  zakazky: [],
  cinnosti: [],
  projekty: [],
});

describe('parseCodeListResponse', () => {
  it('načíta všetky štyri podporované zoznamy a zachová diakritiku', () => {
    const preview = parseCodeListResponse(responseFixture, 'org-1', emptyLists());
    expect(preview.perKind.predkontacie.nove).toEqual([
      {
        kod: '022200',
        nazov: 'Zaradenie HIM do užívania',
        externalId: '101',
        agenda: 'internalDocument',
      },
    ]);
    expect(preview.perKind.cleneniaDph.nove[0]).toMatchObject({
      kod: 'DD2odb',
      nazov: 'Tovary, pri ktorých daň platí druhý odberateľ',
      externalId: '202',
    });
    expect(preview.perKind.ciselneRady.nove[0]).toEqual({
      kod: '2025',
      nazov: 'Prijaté faktúry',
      externalId: '303',
      agenda: 'prijate_faktury',
      uctovnyRok: '2025',
    });
    expect(preview.perKind.strediska.nove[0]).toMatchObject({
      kod: '1',
      nazov: 's',
      externalId: '404',
    });
    expect(preview.warnings).toHaveLength(1);
    expect(preview.warnings[0]).toContain('Duplicitný kód');
  });

  it('rozlíši nové, aktualizované, nezmenené a vyradené položky', () => {
    const current = emptyLists();
    current.predkontacie = [
      {
        id: 'same',
        tenantId: 'tenant-demo',
        orgId: 'org-1',
        kod: '022200',
        nazov: 'Zaradenie HIM do užívania',
        source: 'pohoda',
        active: true,
        externalId: '101',
        agenda: 'internalDocument',
      },
      {
        id: 'missing',
        tenantId: 'tenant-demo',
        orgId: 'org-1',
        kod: 'OLD',
        nazov: 'Stará položka',
        source: 'pohoda',
        active: true,
      },
      {
        id: 'manual',
        tenantId: 'tenant-demo',
        orgId: 'org-1',
        kod: 'MAN',
        nazov: 'Ručná položka',
        source: 'manual',
        active: true,
      },
    ];
    current.cleneniaDph = [
      {
        id: 'adopt',
        tenantId: 'tenant-demo',
        orgId: 'org-1',
        kod: 'DD2odb',
        nazov: 'Starý názov',
        source: 'manual',
        active: true,
      },
    ];

    const preview = parseCodeListResponse(responseFixture, 'org-1', current);
    expect(preview.perKind.predkontacie.bezZmeny).toBe(1);
    expect(preview.perKind.predkontacie.vyradene.map((item) => item.id)).toEqual([
      'missing',
    ]);
    expect(preview.perKind.cleneniaDph.aktualizovane[0].kod).toBe('DD2odb');
    expect(preview.perKind.predkontacie.vyradene).not.toContainEqual(
      expect.objectContaining({ id: 'manual' }),
    );
  });

  it('ignoruje neznáme elementy a elementy mimo namespace STORMWARE', () => {
    const xml = responseFixture.replace(
      '</rsp:responsePack>',
      '<foreign:listCentre xmlns:foreign="https://example.invalid"><foreign:itemCentre code="X" name="X"/></foreign:listCentre></rsp:responsePack>',
    );
    const preview = parseCodeListResponse(xml, 'org-1', emptyLists());
    expect(preview.perKind.strediska.nove).toHaveLength(1);
  });

  it('spracuje ľubovoľné XML prefixy podľa localName a namespace URI', () => {
    const xml = `<?xml version="1.0" encoding="UTF-8"?>
      <answer:responsePack state="ok" xmlns:answer="http://www.stormware.cz/schema/version_2/response.xsd" xmlns:any="http://www.stormware.cz/schema/version_2/list.xsd">
        <answer:responsePackItem state="ok">
          <any:listAccountingDoubleEntry version="1.1" state="ok">
            <any:itemAccounting id="1" code="022200" accounting="Zaradenie HIM do užívania" agenda="internalDocument"/>
          </any:listAccountingDoubleEntry>
        </answer:responsePackItem>
      </answer:responsePack>`;
    const preview = parseCodeListResponse(xml, 'org-1', emptyLists());
    expect(preview.perKind.predkontacie.nove[0].kod).toBe('022200');
  });

  it('odmietne poškodené XML a súbor bez podporovaného zoznamu', () => {
    expect(() => parseCodeListResponse('<rsp:responsePack>', 'org-1', emptyLists())).toThrow(
      /XML súbor nie je platný/,
    );
    expect(() =>
      parseCodeListResponse(
        '<?xml version="1.0"?><rsp:responsePack state="ok" xmlns:rsp="http://www.stormware.cz/schema/version_2/response.xsd"/>',
        'org-1',
        emptyLists(),
      ),
    ).toThrow(/nenašiel žiadny podporovaný číselník/);
  });

  it('odmietne responsePack so stavom error', () => {
    const xml = '<?xml version="1.0"?><rsp:responsePack state="error" xmlns:rsp="http://www.stormware.cz/schema/version_2/response.xsd"><rsp:note>Firma sa nenašla</rsp:note></rsp:responsePack>';
    expect(() => parseCodeListResponse(xml, 'org-1', emptyLists())).toThrow(
      /Firma sa nenašla/,
    );
  });

  it('načíta topNumber ako posledné číslo a agendu číselného radu', () => {
    const xml = `<?xml version="1.0" encoding="UTF-8"?>
      <rsp:responsePack state="ok" xmlns:rsp="http://www.stormware.cz/schema/version_2/response.xsd" xmlns:lst="http://www.stormware.cz/schema/version_2/list.xsd" xmlns:nms="http://www.stormware.cz/schema/version_2/numericalSeries.xsd">
        <rsp:responsePackItem state="ok">
          <lst:listNumericalSeries version="2.0" state="ok">
            <lst:numericalSeries version="2.0">
              <nms:numericalSeriesHeader>
                <nms:id>500</nms:id>
                <nms:prefix>26PK</nms:prefix>
                <nms:number>0001</nms:number>
                <nms:topNumber>0042</nms:topNumber>
                <nms:name>Pokladňa príjem</nms:name>
                <nms:agenda>pokladna</nms:agenda>
                <nms:year>2026</nms:year>
              </nms:numericalSeriesHeader>
            </lst:numericalSeries>
          </lst:listNumericalSeries>
        </rsp:responsePackItem>
      </rsp:responsePack>`;
    const preview = parseCodeListResponse(xml, 'org-1', emptyLists());
    expect(preview.perKind.ciselneRady.nove[0]).toEqual({
      kod: '26PK',
      nazov: 'Pokladňa príjem',
      externalId: '500',
      agenda: 'pokladna',
      uctovnyRok: '2026',
      posledneCislo: '0042',
    });
  });

  it('načíta sekciu KV DPH z členenia DPH (sectionInVATLedgerStatement)', () => {
    const xml = `<?xml version="1.0" encoding="UTF-8"?>
      <rsp:responsePack state="ok" xmlns:rsp="http://www.stormware.cz/schema/version_2/response.xsd" xmlns:lst="http://www.stormware.cz/schema/version_2/list.xsd" xmlns:vat="http://www.stormware.cz/schema/version_2/classificationVAT.xsd">
        <rsp:responsePackItem state="ok">
          <lst:listClassificationVAT version="2.0" state="ok">
            <lst:classificationVAT version="2.0">
              <vat:classificationVATHeader>
                <vat:id>210</vat:id>
                <vat:code>B2odp</vat:code>
                <vat:name>Prijaté faktúry — odpočet DPH</vat:name>
                <vat:sectionInVATLedgerStatement>B2</vat:sectionInVATLedgerStatement>
              </vat:classificationVATHeader>
            </lst:classificationVAT>
          </lst:listClassificationVAT>
        </rsp:responsePackItem>
      </rsp:responsePack>`;
    const preview = parseCodeListResponse(xml, 'org-1', emptyLists());
    expect(preview.perKind.cleneniaDph.nove[0]).toMatchObject({
      kod: 'B2odp',
      kvSekcia: 'B2',
    });
  });

  it('rozpozná omylom načítaný dataPack (náš export) namiesto odpovede z POHODY', () => {
    const xml = `<?xml version="1.0" encoding="Windows-1250"?>
      <dat:dataPack version="2.0" xmlns:dat="http://www.stormware.cz/schema/version_2/data.xsd" xmlns:inv="http://www.stormware.cz/schema/version_2/invoice.xsd">
        <dat:dataPackItem version="2.0">
          <inv:invoice version="2.0"><inv:invoiceHeader/></inv:invoice>
        </dat:dataPackItem>
      </dat:dataPack>`;
    expect(() => parseCodeListResponse(xml, 'org-1', emptyLists())).toThrow(/dataPack/);
  });

  it('syntetické kódy sú podmnožinou bezpečného MDB fixture', () => {
    const preview = parseCodeListResponse(responseFixture, 'org-1', emptyLists());
    const fixtureByKind = mdbFixture as Record<
      CodeListKind,
      Array<{ kod: string; nazov: string; rok?: string }>
    >;
    (Object.keys(preview.perKind) as CodeListKind[]).forEach((kind) => {
      // Fixture pokrýva len číselníky importované z POHODY; nové druhy
      // (zákazky, činnosti, projekty) sa zatiaľ spravujú ručne.
      const knownCodes = new Set((fixtureByKind[kind] ?? []).map((item) => item.kod));
      preview.perKind[kind].nove.forEach((item) => {
        expect(knownCodes.has(item.kod), `${kind}:${item.kod}`).toBe(true);
      });
    });
  });
});

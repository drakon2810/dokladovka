import type { CodeListItem, CodeListKind } from '../types';

const STORMWARE_NAMESPACE_PART = 'stormware.cz/schema/version_2/';

export interface ParsedItem {
  kod: string;
  nazov: string;
  externalId?: string;
  agenda?: string;
  uctovnyRok?: string;
}

export interface CodeListImportPreview {
  orgId: string;
  perKind: Record<
    CodeListKind,
    {
      nove: ParsedItem[];
      aktualizovane: ParsedItem[];
      bezZmeny: number;
      vyradene: CodeListItem[];
    }
  >;
  warnings: string[];
}

type CurrentCodeLists = Record<CodeListKind, CodeListItem[]>;

const KINDS: CodeListKind[] = [
  'predkontacie',
  'cleneniaDph',
  'ciselneRady',
  'strediska',
];

function stormwareElement(element: Element): boolean {
  return element.namespaceURI?.includes(STORMWARE_NAMESPACE_PART) ?? false;
}

function descendants(element: ParentNode, localName: string): Element[] {
  return Array.from(element.querySelectorAll('*')).filter(
    (candidate) => candidate.localName === localName && stormwareElement(candidate),
  );
}

function firstText(element: ParentNode, localName: string): string | undefined {
  const value = descendants(element, localName)[0]?.textContent?.trim();
  return value || undefined;
}

function clean(value: string | null | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed || undefined;
}

function itemFromAttributes(element: Element): ParsedItem | undefined {
  const kod = clean(element.getAttribute('code'));
  const nazov = clean(element.getAttribute('accounting') ?? element.getAttribute('name'));
  if (!kod || !nazov) return undefined;
  return {
    kod,
    nazov,
    externalId: clean(element.getAttribute('id')),
    agenda: clean(element.getAttribute('agenda')),
    uctovnyRok: clean(element.getAttribute('year')),
  };
}

function itemFromElements(
  element: Element,
  codeElement: 'code' | 'prefix',
): ParsedItem | undefined {
  const kod = firstText(element, codeElement);
  const nazov = firstText(element, 'name');
  if (!kod || !nazov) return undefined;
  return {
    kod,
    nazov,
    externalId: firstText(element, 'id'),
    agenda: firstText(element, 'agenda'),
    uctovnyRok: firstText(element, 'year'),
  };
}

function emptyPreview(orgId: string): CodeListImportPreview {
  return {
    orgId,
    perKind: {
      predkontacie: { nove: [], aktualizovane: [], bezZmeny: 0, vyradene: [] },
      cleneniaDph: { nove: [], aktualizovane: [], bezZmeny: 0, vyradene: [] },
      ciselneRady: { nove: [], aktualizovane: [], bezZmeny: 0, vyradene: [] },
      strediska: { nove: [], aktualizovane: [], bezZmeny: 0, vyradene: [] },
      zakazky: { nove: [], aktualizovane: [], bezZmeny: 0, vyradene: [] },
      cinnosti: { nove: [], aktualizovane: [], bezZmeny: 0, vyradene: [] },
      projekty: { nove: [], aktualizovane: [], bezZmeny: 0, vyradene: [] },
    },
    warnings: [],
  };
}

function sameOptional(left: string | undefined, right: string | undefined): boolean {
  return clean(left) === clean(right);
}

function sameImportedData(current: CodeListItem, parsed: ParsedItem): boolean {
  return (
    current.source === 'pohoda' &&
    current.active &&
    current.nazov === parsed.nazov &&
    sameOptional(current.externalId, parsed.externalId) &&
    sameOptional(current.agenda, parsed.agenda) &&
    sameOptional(current.uctovnyRok, parsed.uctovnyRok)
  );
}

function responseError(document: Document): string | undefined {
  const root = document.documentElement;
  if (root?.localName === 'responsePack' && root.getAttribute('state') === 'error') {
    return firstText(root, 'note') ?? 'POHODA vrátila chybu bez popisu.';
  }
  return undefined;
}

/**
 * Čistý parser responsePacku. Prefixy XML sa ignorujú, ale každý spracovaný
 * element musí patriť do namespace-u schém STORMWARE verzie 2.
 */
export function parseCodeListResponse(
  xml: string,
  orgId: string,
  currentCodeLists: CurrentCodeLists,
): CodeListImportPreview {
  const document = new DOMParser().parseFromString(xml, 'text/xml');
  const parserError = Array.from(document.getElementsByTagName('*')).find(
    (element) => element.localName === 'parsererror',
  );
  if (parserError) {
    throw new Error('XML súbor nie je platný. Skontrolujte response vytvorený v POHODE.');
  }
  const rootError = responseError(document);
  if (rootError) throw new Error(`POHODA vrátila chybu: ${rootError}`);

  const preview = emptyPreview(orgId);
  const foundKinds = new Set<CodeListKind>();
  const parsedByKind: Record<CodeListKind, ParsedItem[]> = {
    predkontacie: [],
    cleneniaDph: [],
    ciselneRady: [],
    strediska: [],
    zakazky: [],
    cinnosti: [],
    projekty: [],
  };

  for (const item of Array.from(document.getElementsByTagName('*')).filter(
    (element) => element.localName === 'responsePackItem' && stormwareElement(element),
  )) {
    if (item.getAttribute('state') === 'error') {
      const note = firstText(item, 'note') ?? item.getAttribute('note') ?? 'bez popisu';
      preview.warnings.push(`POHODA nevrátila jednu časť číselníkov: ${note}`);
    }
  }

  for (const container of Array.from(document.getElementsByTagName('*')).filter(
    stormwareElement,
  )) {
    if (container.localName === 'listAccountingDoubleEntry') {
      foundKinds.add('predkontacie');
      parsedByKind.predkontacie.push(
        ...descendants(container, 'itemAccounting')
          .map(itemFromAttributes)
          .filter((item): item is ParsedItem => Boolean(item)),
      );
    } else if (container.localName === 'listClassificationVAT') {
      foundKinds.add('cleneniaDph');
      parsedByKind.cleneniaDph.push(
        ...descendants(container, 'classificationVAT')
          .map((item) => itemFromElements(item, 'code'))
          .filter((item): item is ParsedItem => Boolean(item)),
      );
    } else if (container.localName === 'listNumericalSeries') {
      foundKinds.add('ciselneRady');
      parsedByKind.ciselneRady.push(
        ...descendants(container, 'numericalSeries')
          .map((item) => itemFromElements(item, 'prefix'))
          .filter((item): item is ParsedItem => Boolean(item)),
      );
    } else if (container.localName === 'listNumericSeries') {
      // Starší response 1.1; nové requesty používajú listNumericalSeries 2.0.
      foundKinds.add('ciselneRady');
      parsedByKind.ciselneRady.push(
        ...descendants(container, 'itemNumericSeries')
          .map(itemFromAttributes)
          .filter((item): item is ParsedItem => Boolean(item)),
      );
    } else if (container.localName === 'listCentre') {
      foundKinds.add('strediska');
      const modern = descendants(container, 'centre')
        .map((item) => itemFromElements(item, 'code'))
        .filter((item): item is ParsedItem => Boolean(item));
      const legacy = descendants(container, 'itemCentre')
        .map(itemFromAttributes)
        .filter((item): item is ParsedItem => Boolean(item));
      parsedByKind.strediska.push(...modern, ...legacy);
    }
  }

  if (foundKinds.size === 0) {
    throw new Error(
      'V XML súbore sa nenašiel žiadny podporovaný číselník z POHODY.',
    );
  }

  for (const kind of KINDS) {
    if (!foundKinds.has(kind)) continue;
    const unique = new Map<string, ParsedItem>();
    for (const item of parsedByKind[kind]) {
      if (unique.has(item.kod)) {
        preview.warnings.push(
          `Duplicitný kód „${item.kod}“ v číselníku ${kind}; použila sa prvá položka.`,
        );
        continue;
      }
      unique.set(item.kod, item);
    }

    const current = currentCodeLists[kind].filter((item) => item.orgId === orgId);
    const currentByCode = new Map(current.map((item) => [item.kod, item]));
    for (const item of unique.values()) {
      const existing = currentByCode.get(item.kod);
      if (!existing) preview.perKind[kind].nove.push(item);
      else if (sameImportedData(existing, item)) preview.perKind[kind].bezZmeny += 1;
      else preview.perKind[kind].aktualizovane.push(item);
    }
    preview.perKind[kind].vyradene = current.filter(
      (item) => item.source === 'pohoda' && item.active && !unique.has(item.kod),
    );
  }

  return preview;
}

import type { AppDataState } from '../store';
import type { CodeListItem, CodeListKind } from '../types';
import type { CodeListImportPreview, ParsedItem } from './parseCodeListResponse';

export const CODE_LIST_KINDS: CodeListKind[] = [
  'predkontacie',
  'cleneniaDph',
  'ciselneRady',
  'strediska',
];

export interface CodeListImportKindResult {
  nove: number;
  aktualizovane: number;
  vyradene: number;
  bezZmeny: number;
}

export interface CodeListImportResult {
  perKind: Record<CodeListKind, CodeListImportKindResult>;
  nove: number;
  aktualizovane: number;
  vyradene: number;
  bezZmeny: number;
  totalChanges: number;
}

export interface ApplyCodeListImportOptions {
  tenantId: string;
  orgId: string;
  syncedAt: string;
  createId: () => string;
}

export interface AppliedCodeListImport {
  codeLists: AppDataState['codeLists'];
  result: CodeListImportResult;
}

function emptyKindResult(bezZmeny = 0): CodeListImportKindResult {
  return { nove: 0, aktualizovane: 0, vyradene: 0, bezZmeny };
}

function normalizedItem(item: ParsedItem): ParsedItem {
  const optional = (value: string | undefined) => value?.trim() || undefined;
  const kod = item.kod.trim();
  const nazov = item.nazov.trim();
  if (!kod || !nazov) throw new Error('Kód a názov položky z POHODY sú povinné');
  return {
    kod,
    nazov,
    externalId: optional(item.externalId),
    agenda: optional(item.agenda),
    uctovnyRok: optional(item.uctovnyRok),
    posledneCislo: optional(item.posledneCislo),
    kvSekcia: optional(item.kvSekcia),
  };
}

function equalsImportedValues(current: CodeListItem, imported: ParsedItem): boolean {
  return (
    current.source === 'pohoda' &&
    current.active &&
    current.nazov === imported.nazov &&
    current.externalId === imported.externalId &&
    current.agenda === imported.agenda &&
    current.uctovnyRok === imported.uctovnyRok &&
    current.posledneCislo === imported.posledneCislo &&
    current.kvSekcia === imported.kvSekcia
  );
}

function importedItem(
  current: CodeListItem | undefined,
  parsed: ParsedItem,
  options: ApplyCodeListImportOptions,
): CodeListItem {
  const {
    externalId: _externalId,
    agenda: _agenda,
    uctovnyRok: _uctovnyRok,
    posledneCislo: _posledneCislo,
    kvSekcia: _kvSekcia,
    syncedAt: _syncedAt,
    ...preserved
  } = current ?? {
    id: options.createId(),
    tenantId: options.tenantId,
    orgId: options.orgId,
    kod: parsed.kod,
    nazov: parsed.nazov,
    source: 'pohoda' as const,
    active: true,
  };
  return {
    ...preserved,
    tenantId: options.tenantId,
    orgId: options.orgId,
    kod: parsed.kod,
    nazov: parsed.nazov,
    source: 'pohoda',
    active: true,
    ...(parsed.externalId ? { externalId: parsed.externalId } : {}),
    ...(parsed.agenda ? { agenda: parsed.agenda } : {}),
    ...(parsed.uctovnyRok ? { uctovnyRok: parsed.uctovnyRok } : {}),
    ...(parsed.posledneCislo ? { posledneCislo: parsed.posledneCislo } : {}),
    ...(parsed.kvSekcia ? { kvSekcia: parsed.kvSekcia } : {}),
    syncedAt: options.syncedAt,
  };
}

/**
 * Čistá aplikácia preview. Volajúci zapíše výsledok jediným store.set.
 * Existujúce ID sa zachováva, aby odkazy v dokladoch a approved snapshot-och
 * zostali nemenné.
 */
export function applyPohodaCodeListImport(
  currentCodeLists: AppDataState['codeLists'],
  preview: CodeListImportPreview,
  options: ApplyCodeListImportOptions,
): AppliedCodeListImport {
  if (preview.orgId !== options.orgId) {
    throw new Error('Import nepatrí vybranej organizácii');
  }

  const nextCodeLists: AppDataState['codeLists'] = {
    predkontacie: [...currentCodeLists.predkontacie],
    cleneniaDph: [...currentCodeLists.cleneniaDph],
    ciselneRady: [...currentCodeLists.ciselneRady],
    strediska: [...currentCodeLists.strediska],
    zakazky: [...(currentCodeLists.zakazky ?? [])],
    cinnosti: [...(currentCodeLists.cinnosti ?? [])],
    projekty: [...(currentCodeLists.projekty ?? [])],
  };
  const perKind = Object.fromEntries(
    CODE_LIST_KINDS.map((kind) => [kind, emptyKindResult(preview.perKind[kind].bezZmeny)]),
  ) as CodeListImportResult['perKind'];

  let totalChanges = 0;
  for (const kind of CODE_LIST_KINDS) {
    const incoming = [
      ...preview.perKind[kind].nove,
      ...preview.perKind[kind].aktualizovane,
    ].map(normalizedItem);
    const incomingCodes = new Set<string>();
    for (const item of incoming) {
      if (incomingCodes.has(item.kod)) {
        throw new Error(`Kód ${item.kod} je v importe číselníka uvedený viackrát`);
      }
      incomingCodes.add(item.kod);

      const matches = nextCodeLists[kind]
        .map((candidate, index) => ({ candidate, index }))
        .filter(
          ({ candidate }) =>
            candidate.tenantId === options.tenantId &&
            candidate.orgId === options.orgId &&
            candidate.kod === item.kod,
        );
      if (matches.length > 1) {
        throw new Error(`Kód ${item.kod} je v organizácii uložený viackrát`);
      }

      const match = matches[0];
      if (!match) {
        nextCodeLists[kind].push(importedItem(undefined, item, options));
        perKind[kind].nove += 1;
        totalChanges += 1;
      } else if (equalsImportedValues(match.candidate, item)) {
        perKind[kind].bezZmeny += 1;
      } else {
        nextCodeLists[kind][match.index] = importedItem(match.candidate, item, options);
        perKind[kind].aktualizovane += 1;
        totalChanges += 1;
      }
    }

    const deactivatedIds = new Set<string>();
    for (const removed of preview.perKind[kind].vyradene) {
      if (deactivatedIds.has(removed.id) || incomingCodes.has(removed.kod)) continue;
      const index = nextCodeLists[kind].findIndex(
        (candidate) =>
          candidate.id === removed.id &&
          candidate.tenantId === options.tenantId &&
          candidate.orgId === options.orgId &&
          candidate.source === 'pohoda' &&
          candidate.active,
      );
      if (index === -1) continue;
      nextCodeLists[kind][index] = {
        ...nextCodeLists[kind][index],
        active: false,
        syncedAt: options.syncedAt,
      };
      deactivatedIds.add(removed.id);
      perKind[kind].vyradene += 1;
      totalChanges += 1;
    }
  }

  return {
    codeLists: totalChanges === 0 ? currentCodeLists : nextCodeLists,
    result: {
      perKind,
      nove: CODE_LIST_KINDS.reduce((sum, kind) => sum + perKind[kind].nove, 0),
      aktualizovane: CODE_LIST_KINDS.reduce(
        (sum, kind) => sum + perKind[kind].aktualizovane,
        0,
      ),
      vyradene: CODE_LIST_KINDS.reduce((sum, kind) => sum + perKind[kind].vyradene, 0),
      bezZmeny: CODE_LIST_KINDS.reduce((sum, kind) => sum + perKind[kind].bezZmeny, 0),
      totalChanges,
    },
  };
}

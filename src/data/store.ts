// Zustand store s persist na localStorage (SPEC §3).
// Store je reaktívna cache mock dát. Komponenty z neho ČÍTAJÚ cez hooky,
// ale všetky operácie (mutácie) idú výhradne cez src/data/api.ts —
// pri prechode na REST vo Fáze 2 sa komponenty nemenia.
import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import type {
  AccountingSuggestion,
  DocumentPayment,
  AgentInstallation,
  AppUser,
  CodeListItem,
  CodeListKind,
  DocumentItem,
  DocumentQueue,
  ExportBatch,
  ExportJob,
  ExtractionRun,
  InboundAttachment,
  InboundEmail,
  Organization,
  OrganizationBankAccount,
  OrganizationEmailAlias,
  PohodaCompanyLink,
  Role,
} from './types';
import {
  buildSeedState,
  queueIdForDocumentType,
  seedBankAccounts,
  seedQueues,
} from './mock/seed';
import { MOCK_TENANT_ID } from './config';

export interface AppDataState {
  role: Role;
  /** 'all' = Všetky organizácie */
  currentOrgId: string;
  organizations: Organization[];
  queues: DocumentQueue[];
  bankAccounts: OrganizationBankAccount[];
  aliases: OrganizationEmailAlias[];
  documents: DocumentItem[];
  inboundEmails: InboundEmail[];
  inboundAttachments: InboundAttachment[];
  extractionRuns: ExtractionRun[];
  suggestions: AccountingSuggestion[];
  payments: DocumentPayment[];
  codeLists: Record<CodeListKind, CodeListItem[]>;
  users: AppUser[];
  exportBatches: ExportBatch[];
  mostikEnabled: boolean;
  agentInstallations: AgentInstallation[];
  pohodaCompanyLinks: PohodaCompanyLink[];
  exportJobs: ExportJob[];
}

export const APP_STORE_PERSIST_VERSION = 7;

export function migratePersistedState(persisted: unknown, version: number): AppDataState {
  const state = persisted as AppDataState;
  if (version >= 7) return state;

  const tenantMigrated: AppDataState = version >= 2
    ? state
    : {
        ...state,
        organizations: state.organizations.map((item) => ({
          ...item,
          tenantId: item.tenantId ?? MOCK_TENANT_ID,
        })),
        documents: state.documents.map((item) => ({
          ...item,
          tenantId: item.tenantId ?? MOCK_TENANT_ID,
          version: item.version ?? 1,
        })),
        inboundAttachments: state.inboundAttachments.map((item) => ({
          ...item,
          tenantId: item.tenantId ?? MOCK_TENANT_ID,
        })),
        extractionRuns: state.extractionRuns.map((item) => ({
          ...item,
          tenantId: item.tenantId ?? MOCK_TENANT_ID,
          organizationId:
            item.organizationId ??
            state.documents.find((doc) => doc.id === item.documentId)?.orgId ??
            '',
          provider: item.provider === 'mock' ? 'mock' : 'openai',
        })),
        suggestions: state.suggestions.map((item) => ({
          ...item,
          tenantId: item.tenantId ?? MOCK_TENANT_ID,
          organizationId:
            item.organizationId ??
            state.documents.find((doc) => doc.id === item.documentId)?.orgId ??
            '',
        })),
        codeLists: Object.fromEntries(
          Object.entries(state.codeLists).map(([kind, items]) => [
            kind,
            items.map((item) => ({
              ...item,
              tenantId: item.tenantId ?? MOCK_TENANT_ID,
            })),
          ]),
        ) as AppDataState['codeLists'],
        users: state.users.map((item) => ({
          ...item,
          tenantId: item.tenantId ?? MOCK_TENANT_ID,
        })),
        exportBatches: state.exportBatches.map((item) => ({
          ...item,
          tenantId: item.tenantId ?? MOCK_TENANT_ID,
        })),
      };
  const paymentMigrated: AppDataState = version >= 3
    ? tenantMigrated
    : {
        ...tenantMigrated,
        bankAccounts: seedBankAccounts.map((account) => ({ ...account })),
      };
  const queueMigrated: AppDataState = version >= 4
    ? paymentMigrated
    : {
        ...paymentMigrated,
        queues: seedQueues.map((queue) => structuredClone(queue)),
        documents: paymentMigrated.documents.map((document) => ({
          ...document,
          queueId: document.queueId ?? queueIdForDocumentType(document.orgId, document.typ),
        })),
        aliases: paymentMigrated.aliases.map((alias) => ({
          ...alias,
          queueId:
            alias.queueId ??
            (alias.isPrimary ? `queue-${alias.organizationId}-received` : undefined),
        })),
      };
  const preferencesMigrated: AppDataState = {
    ...queueMigrated,
    users: queueMigrated.users.map((user) => ({
      ...user,
      jazyk: user.jazyk ?? 'sk',
      notifikacie: user.notifikacie ?? {
        email: true,
        inApp: true,
        comments: true,
        mentions: true,
      },
    })),
  };

  const codeListMigrated: AppDataState = {
    ...preferencesMigrated,
    codeLists: Object.fromEntries(
      Object.entries(preferencesMigrated.codeLists).map(([kind, items]) => [
        kind,
        items.map((item) => ({
          ...item,
          source: item.source ?? 'manual',
          active: item.active ?? true,
        })),
      ]),
    ) as AppDataState['codeLists'],
  };
  if (version >= 7) return codeListMigrated;
  return {
    ...codeListMigrated,
    documents: codeListMigrated.documents.map((document) =>
      ['schvaleny', 'exportovany'].includes(document.status) && !document.approvedSnapshot
        ? {
            ...document,
            approvedVersion: document.version,
            approvedSnapshot: {
              version: document.version,
              approvedAt: document.history.find((item) => item.akcia === 'Doklad schválený')?.ts ?? document.prijateDna,
              typ: document.typ,
              extracted: structuredClone(document.extracted),
              ucto: structuredClone(document.ucto),
            },
          }
        : document,
    ),
    mostikEnabled: state.mostikEnabled ?? false,
    agentInstallations: state.agentInstallations ?? [],
    pohodaCompanyLinks: state.pohodaCompanyLinks ?? codeListMigrated.organizations.map((organization) => ({
      tenantId: organization.tenantId,
      organizationId: organization.id,
      ico: organization.ico,
      preferredYear: 'latest',
    })),
    exportJobs: state.exportJobs ?? [],
    payments: state.payments ?? [],
  };
}

export const useAppStore = create<AppDataState>()(
  persist<AppDataState>(() => buildSeedState(), {
    name: 'dokladovka-store',
    version: APP_STORE_PERSIST_VERSION,
    migrate: migratePersistedState,
  }),
);

/** Interné gettery/settery pre servisnú vrstvu (api.ts). Nepoužívať v komponentoch. */
export const storeApi = {
  get: useAppStore.getState,
  set: useAppStore.setState,
};

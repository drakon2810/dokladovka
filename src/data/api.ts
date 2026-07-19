// Servisná vrstva (SPEC §3, §11.20): VŠETKY operácie komponentov idú cez
// tieto async funkcie. Vo Fáze 2 sa telá nahradia REST volaniami —
// signatúry a komponenty sa nemenia.
// TODO: integration point — REST API (SPEC §11.18), auth/tenant kontrola
// na backende; organizationId sa neberie na dôveru z browser payloadu.
import { storeApi, useAppStore, type AppDataState } from './store';
import type {
  AccountingSuggestion,
  CodeListItem,
  CodeListKind,
  DocumentItem,
  DocumentQueue,
  DocumentStatus,
  DocumentType,
  DphPosudok,
  DphProfil,
  ExportBatch,
  ExtractionRun,
  InboundEmail,
  Organization,
  OrganizationBankAccount,
  OrganizationEmailAlias,
  PaymentStatus,
  Role,
  SimulateInboundEmailInput,
  SimulateInboundEmailResult,
  UserLanguage,
  UserNotificationPreferences,
  VatRate,
} from './types';
import {
  createDocumentInputSchema,
  bankAccountInputSchema,
  organizationInputSchema,
  type BankAccountInput,
  type OrganizationInput,
} from './schemas';
import { generateUniqueAlias } from './alias/aliasGenerator';
import {
  EMAIL_ALIAS_GRACE_DAYS,
  MOCK_TENANT_ID,
  PUBLIC_MAIL_RECEIVING_DOMAIN,
} from './config';
import { newId, nowIso } from '../lib/id';
import { isTotalConsistent, isVatRowConsistent, round2 } from '../lib/validate';
import { buildSeedState } from './mock/seed';
import { simulateInboundEmail as runSimulation } from './inbound/inboundService';
import {
  buildSuggestionForDocument,
  lastUsedForSupplier,
} from './suggestions/accountingSuggestionService';
import {
  EXTRACTION_PROMPT_VERSION,
  EXTRACTION_SCHEMA_VERSION,
  MockDocumentExtractionProvider,
} from './extraction/extractionProvider';
import { buildDataPack, buildExportFileName } from './xml/pohodaDataPack';
import {
  validateDocument,
  type DocumentValidationIssue,
} from './validation/documentValidation';
import { normalizeExtractionResult } from './extraction/normalizeExtraction';
import {
  clearLocalDocumentFiles,
  deleteLocalDocumentFile,
  inspectDocumentFile,
  saveLocalDocumentFile,
} from './files/localDocumentFileStore';
import { assertCapability, isKnownRole } from '../auth/access';
import {
  applyPohodaCodeListImport,
  type CodeListImportResult,
} from './pohoda/importCodeLists';
import type { CodeListImportPreview } from './pohoda/parseCodeListResponse';

const REST_DATA_MODE = import.meta.env.VITE_DATA_MODE === 'rest';

async function restRequest<T>(path: string, init?: RequestInit): Promise<T> {
  let csrfToken: string | undefined;
  const method = init?.method?.toUpperCase() ?? 'GET';
  if (!['GET', 'HEAD', 'OPTIONS'].includes(method)) {
    const sessionResponse = await fetch('/api/auth/session', { credentials: 'include' });
    if (!sessionResponse.ok) throw new Error('Prihlásenie vypršalo');
    const session = await sessionResponse.json() as { csrfToken?: string };
    csrfToken = session.csrfToken;
  }
  const response = await fetch(path, {
    credentials: 'include',
    ...init,
    headers: {
      ...(init?.body ? { 'Content-Type': 'application/json' } : {}),
      ...(csrfToken ? { 'X-CSRF-Token': csrfToken } : {}),
      ...init?.headers,
    },
  });
  if (!response.ok) {
    const body = await response.json().catch(() => undefined) as { message?: string } | undefined;
    throw new Error(body?.message || 'Backend nie je dostupný');
  }
  if (response.status === 204) return undefined as T;
  return response.json() as Promise<T>;
}

async function refreshRestSnapshot(): Promise<AppDataState> {
  return getDataSnapshot();
}

function currentUserName(): string {
  const s = storeApi.get();
  return s.users.find((u) => u.tenantId === MOCK_TENANT_ID && u.rola === s.role)?.meno ?? 'Používateľ';
}

function historyEntry(akcia: string) {
  return { ts: nowIso(), user: currentUserName(), akcia };
}

function updateDoc(id: string, updater: (doc: DocumentItem) => DocumentItem): DocumentItem {
  const s = storeApi.get();
  let updated: DocumentItem | undefined;
  const documents = s.documents.map((d) => {
    if (d.id !== id || d.tenantId !== MOCK_TENANT_ID) return d;
    updated = updater(d);
    return updated;
  });
  if (!updated) throw new Error('Doklad neexistuje');
  storeApi.set({ documents });
  return updated;
}

// ===== Rola / kontext =====

export async function setRole(role: Role): Promise<void> {
  if (!isKnownRole(role)) throw new Error('Nepodporovaná používateľská rola');
  storeApi.set({ role });
}

export async function setCurrentOrg(orgId: string): Promise<void> {
  assertCapability(storeApi.get().role, 'tenant.read');
  if (
    orgId !== 'all' &&
    !storeApi.get().organizations.some((o) => o.id === orgId && o.tenantId === MOCK_TENANT_ID)
  ) {
    throw new Error('Organizácia nie je dostupná');
  }
  storeApi.set({ currentOrgId: orgId });
}

// ===== Organizácie (SPEC §11.1, §11.19) =====

export async function listOrganizations(): Promise<Organization[]> {
  assertCapability(storeApi.get().role, 'tenant.read');
  if (REST_DATA_MODE) {
    return restRequest<Organization[]>('/api/organizations');
  }
  return storeApi.get().organizations.filter((o) => o.tenantId === MOCK_TENANT_ID);
}

export interface CreateOrganizationResult {
  organization: Organization;
  primaryEmailAlias: OrganizationEmailAlias;
}

export async function createOrganization(
  input: OrganizationInput,
): Promise<CreateOrganizationResult> {
  assertCapability(
    storeApi.get().role,
    'organization.manage',
    'Organizáciu môže vytvoriť iba admin',
  );
  const parsed = organizationInputSchema.parse(input);
  if (REST_DATA_MODE) {
    const created = await restRequest<CreateOrganizationResult>('/api/organizations', {
      method: 'POST',
      body: JSON.stringify({
        nazov: parsed.nazov,
        ico: parsed.ico,
        dic: parsed.dic,
        icDph: parsed.icDph,
        farba: parsed.farba,
      }),
    });
    await refreshRestSnapshot();
    return created;
  }
  const s = storeApi.get();

  // Alias vzniká až PO úspešnom vytvorení organizácie a generuje ho systém —
  // klient nikdy neposiela celú adresu (SPEC §11.3, §11.18).
  const org: Organization = {
    id: newId('org'),
    tenantId: MOCK_TENANT_ID,
    nazov: parsed.nazov,
    ico: parsed.ico,
    dic: parsed.dic,
    icDph: parsed.icDph,
    farba: parsed.farba,
    emailAlias: '', // doplní sa po vygenerovaní aliasu
  };
  // Každý typ dokladu musí mať hneď po vytvorení organizácie bezpečnú
  // cieľovú frontu. Každá fronta má vlastný alias; iba received je primárny.
  const definitions: Array<{
    id: string;
    name: string;
    kind: DocumentQueue['kind'];
    documentTypes: DocumentType[];
    slugSuggestion?: string;
    isPrimary: boolean;
  }> = [
    {
      id: newId('queue'),
      name: 'Prijaté faktúry',
      kind: 'received_invoices',
      documentTypes: ['FP', 'OZ'],
      slugSuggestion: parsed.slugSuggestion,
      isPrimary: true,
    },
    {
      id: newId('queue'),
      name: 'Vystavené faktúry',
      kind: 'issued_invoices',
      documentTypes: ['FV'],
      slugSuggestion: `${parsed.nazov}-vydane`,
      isPrimary: false,
    },
    {
      id: newId('queue'),
      name: 'Ostatné doklady',
      kind: 'other',
      documentTypes: ['BV', 'MZDY', 'PD'],
      slugSuggestion: `${parsed.nazov}-ine`,
      isPrimary: false,
    },
  ];
  const aliases: OrganizationEmailAlias[] = [];
  const queues: DocumentQueue[] = [];
  for (const definition of definitions) {
    const generated = generateUniqueAlias({
      nazov: parsed.nazov,
      slugSuggestion: definition.slugSuggestion,
      domain: PUBLIC_MAIL_RECEIVING_DOMAIN,
      isTaken: (addr) =>
        [...s.aliases, ...aliases].some(
          (candidate) =>
            candidate.tenantId === MOCK_TENANT_ID &&
            candidate.addressNormalized === addr,
        ),
    });
    const alias: OrganizationEmailAlias = {
      id: newId('alias'),
      tenantId: MOCK_TENANT_ID,
      organizationId: org.id,
      queueId: definition.id,
      address: generated.address,
      addressNormalized: generated.addressNormalized,
      localPart: generated.localPart,
      domain: generated.domain,
      slugAtCreation: generated.slug,
      token: generated.token,
      status: 'active',
      isPrimary: definition.isPrimary,
      createdAt: nowIso(),
    };
    aliases.push(alias);
    queues.push({
      id: definition.id,
      tenantId: MOCK_TENANT_ID,
      organizationId: org.id,
      name: definition.name,
      kind: definition.kind,
      documentTypes: definition.documentTypes,
      importAlias: alias.address,
      active: true,
      features: {
        extraction: definition.kind !== 'other',
        approval: true,
        validation: true,
        spamDetection: true,
        requireApprovalNote: false,
        autoAttachEmailAttachments: true,
      },
      warningThreshold: 0.8,
      automation: {},
    });
  }
  const primaryAlias = aliases.find((candidate) => candidate.isPrimary)!;
  org.emailAlias = primaryAlias.address;

  storeApi.set({
    organizations: [...s.organizations, org],
    queues: [...s.queues, ...queues],
    aliases: [...s.aliases, ...aliases],
  });
  return { organization: org, primaryEmailAlias: primaryAlias };
}

export async function updateOrganization(
  id: string,
  patch: Partial<Pick<Organization, 'nazov' | 'ico' | 'dic' | 'icDph' | 'farba'>>,
): Promise<Organization> {
  assertCapability(
    storeApi.get().role,
    'organization.manage',
    'Organizáciu môže upraviť iba admin',
  );
  if (REST_DATA_MODE) {
    const updated = await restRequest<Organization>(`/api/organizations/${encodeURIComponent(id)}`, {
      method: 'PATCH',
      body: JSON.stringify(patch),
    });
    await refreshRestSnapshot();
    return updated;
  }
  const s = storeApi.get();
  const existing = s.organizations.find(
    (o) => o.id === id && o.tenantId === MOCK_TENANT_ID,
  );
  if (!existing) throw new Error('Organizácia neexistuje');
  const parsed = organizationInputSchema.parse({
    nazov: patch.nazov ?? existing.nazov,
    ico: patch.ico ?? existing.ico,
    dic: patch.dic ?? existing.dic,
    icDph: Object.prototype.hasOwnProperty.call(patch, 'icDph')
      ? patch.icDph
      : existing.icDph,
    farba: patch.farba ?? existing.farba,
  });
  let updated: Organization | undefined;
  // Premenovanie organizácie NIKDY nemení už vydaný alias (SPEC §11.3).
  const organizations = s.organizations.map((o) => {
    if (o.id !== id || o.tenantId !== MOCK_TENANT_ID) return o;
    updated = {
      ...o,
      nazov: parsed.nazov,
      ico: parsed.ico,
      dic: parsed.dic,
      icDph: parsed.icDph,
      farba: parsed.farba,
    };
    return updated;
  });
  if (!updated) throw new Error('Organizácia neexistuje');
  storeApi.set({ organizations });
  return updated;
}

export async function archiveOrganization(id: string): Promise<void> {
  assertCapability(
    storeApi.get().role,
    'organization.manage',
    'Organizáciu môže archivovať iba admin',
  );
  if (REST_DATA_MODE) {
    await restRequest(`/api/organizations/${encodeURIComponent(id)}/archive`, { method: 'POST' });
    await refreshRestSnapshot();
    return;
  }
  const s = storeApi.get();
  storeApi.set({
    organizations: s.organizations.map((o) =>
      o.id === id && o.tenantId === MOCK_TENANT_ID ? { ...o, archived: true } : o,
    ),
  });
}

// ===== Bankové účty organizácií =====

export async function listBankAccounts(orgId?: string): Promise<OrganizationBankAccount[]> {
  assertCapability(storeApi.get().role, 'tenant.read');
  const accounts = storeApi.get().bankAccounts.filter(
    (account) => account.tenantId === MOCK_TENANT_ID,
  );
  return orgId ? accounts.filter((account) => account.organizationId === orgId) : accounts;
}

export async function createBankAccount(input: BankAccountInput): Promise<OrganizationBankAccount> {
  const s = storeApi.get();
  assertCapability(s.role, 'bank-account.manage', 'Bankový účet môže pridať iba admin');
  const parsed = bankAccountInputSchema.parse(input);
  const organization = s.organizations.find(
    (item) => item.id === parsed.organizationId && item.tenantId === MOCK_TENANT_ID,
  );
  if (!organization || organization.archived) throw new Error('Organizácia nie je dostupná');
  if (
    s.bankAccounts.some(
      (item) =>
        item.tenantId === MOCK_TENANT_ID &&
        item.organizationId === organization.id &&
        item.iban === parsed.iban &&
        item.active,
    )
  ) {
    throw new Error('Bankový účet už existuje');
  }
  const peers = s.bankAccounts.filter(
    (item) =>
      item.tenantId === MOCK_TENANT_ID &&
      item.organizationId === organization.id &&
      item.currency === parsed.currency &&
      item.active,
  );
  const account: OrganizationBankAccount = {
    id: newId('bank'),
    tenantId: MOCK_TENANT_ID,
    organizationId: organization.id,
    label: parsed.label,
    iban: parsed.iban,
    bic: parsed.bic,
    currency: parsed.currency,
    isDefault: parsed.isDefault || peers.length === 0,
    active: true,
  };
  storeApi.set({
    bankAccounts: [
      ...s.bankAccounts.map((item) =>
        account.isDefault &&
        item.tenantId === MOCK_TENANT_ID &&
        item.organizationId === organization.id &&
        item.currency === account.currency
          ? { ...item, isDefault: false }
          : item,
      ),
      account,
    ],
  });
  return account;
}

export async function updateBankAccount(
  id: string,
  patch: Partial<Omit<BankAccountInput, 'organizationId'>>,
): Promise<OrganizationBankAccount> {
  const s = storeApi.get();
  assertCapability(s.role, 'bank-account.manage', 'Bankový účet môže upraviť iba admin');
  const existing = s.bankAccounts.find(
    (item) => item.id === id && item.tenantId === MOCK_TENANT_ID && item.active,
  );
  if (!existing) throw new Error('Bankový účet neexistuje');
  const parsed = bankAccountInputSchema.parse({
    organizationId: existing.organizationId,
    label: patch.label ?? existing.label,
    iban: patch.iban ?? existing.iban,
    bic: Object.prototype.hasOwnProperty.call(patch, 'bic') ? patch.bic : existing.bic,
    currency: patch.currency ?? existing.currency,
    isDefault: patch.isDefault ?? existing.isDefault,
  });
  const duplicate = s.bankAccounts.some(
    (item) =>
      item.id !== id &&
      item.tenantId === MOCK_TENANT_ID &&
      item.organizationId === existing.organizationId &&
      item.iban === parsed.iban &&
      item.active,
  );
  if (duplicate) throw new Error('Bankový účet už existuje');
  let updated: OrganizationBankAccount | undefined;
  const bankAccounts = s.bankAccounts.map((item) => {
    if (
      parsed.isDefault &&
      item.id !== id &&
      item.tenantId === MOCK_TENANT_ID &&
      item.organizationId === existing.organizationId &&
      item.currency === parsed.currency
    ) {
      return { ...item, isDefault: false };
    }
    if (item.id !== id || item.tenantId !== MOCK_TENANT_ID) return item;
    updated = { ...item, ...parsed, organizationId: existing.organizationId };
    return updated;
  });
  if (!updated) throw new Error('Bankový účet neexistuje');
  if (!bankAccounts.some((item) => item.organizationId === existing.organizationId && item.currency === parsed.currency && item.active && item.isDefault)) {
    updated.isDefault = true;
    const index = bankAccounts.findIndex((item) => item.id === id);
    bankAccounts[index] = updated;
  }
  storeApi.set({ bankAccounts });
  return updated;
}

export async function disableBankAccount(id: string): Promise<void> {
  const s = storeApi.get();
  assertCapability(s.role, 'bank-account.manage', 'Bankový účet môže vypnúť iba admin');
  const existing = s.bankAccounts.find(
    (item) => item.id === id && item.tenantId === MOCK_TENANT_ID && item.active,
  );
  if (!existing) throw new Error('Bankový účet neexistuje');
  const nextDefault = s.bankAccounts.find(
    (item) =>
      item.id !== id &&
      item.tenantId === MOCK_TENANT_ID &&
      item.organizationId === existing.organizationId &&
      item.currency === existing.currency &&
      item.active,
  );
  storeApi.set({
    bankAccounts: s.bankAccounts.map((item) =>
      item.id === id && item.tenantId === MOCK_TENANT_ID
        ? { ...item, active: false, isDefault: false }
        : existing.isDefault &&
            item.tenantId === MOCK_TENANT_ID &&
            nextDefault?.id === item.id
          ? { ...item, isDefault: true }
          : item,
    ),
  });
}

// ===== Fronty dokumentov =====

export async function listQueues(orgId?: string): Promise<DocumentQueue[]> {
  assertCapability(storeApi.get().role, 'tenant.read');
  const queues = storeApi.get().queues.filter((queue) => queue.tenantId === MOCK_TENANT_ID);
  return orgId ? queues.filter((queue) => queue.organizationId === orgId) : queues;
}

export interface CreateQueueInput {
  organizationId: string;
  name: string;
  kind: DocumentQueue['kind'];
  documentTypes: DocumentType[];
}

export async function createQueue(input: CreateQueueInput): Promise<DocumentQueue> {
  const s = storeApi.get();
  assertCapability(s.role, 'queue.manage', 'Frontu môže vytvoriť iba admin');
  const organization = s.organizations.find(
    (item) =>
      item.id === input.organizationId &&
      item.tenantId === MOCK_TENANT_ID &&
      !item.archived,
  );
  if (!organization) throw new Error('Organizácia nie je dostupná');
  const name = input.name.trim();
  if (!name) throw new Error('Názov fronty je povinný');
  const documentTypes = [...new Set(input.documentTypes)];
  if (documentTypes.length === 0) throw new Error('Fronta musí podporovať aspoň jeden typ dokladu');
  const id = newId('queue');
  const generated = generateUniqueAlias({
    nazov: organization.nazov,
    slugSuggestion: `${organization.nazov}-${name}`,
    domain: PUBLIC_MAIL_RECEIVING_DOMAIN,
    isTaken: (address) =>
      s.aliases.some(
        (alias) =>
          alias.tenantId === MOCK_TENANT_ID && alias.addressNormalized === address,
      ),
  });
  const alias: OrganizationEmailAlias = {
    id: newId('alias'),
    tenantId: MOCK_TENANT_ID,
    organizationId: organization.id,
    queueId: id,
    address: generated.address,
    addressNormalized: generated.addressNormalized,
    localPart: generated.localPart,
    domain: generated.domain,
    slugAtCreation: generated.slug,
    token: generated.token,
    status: 'active',
    isPrimary: false,
    createdAt: nowIso(),
  };
  const queue: DocumentQueue = {
    id,
    tenantId: MOCK_TENANT_ID,
    organizationId: organization.id,
    name,
    kind: input.kind,
    documentTypes,
    importAlias: alias.address,
    active: true,
    features: {
      extraction: !['other', 'bank_statements'].includes(input.kind),
      approval: true,
      validation: true,
      spamDetection: true,
      requireApprovalNote: false,
      autoAttachEmailAttachments: true,
    },
    warningThreshold: 0.8,
    automation: {},
  };
  storeApi.set({ queues: [...s.queues, queue], aliases: [...s.aliases, alias] });
  return queue;
}

export async function updateQueue(
  id: string,
  patch: Partial<Pick<DocumentQueue, 'name' | 'documentTypes' | 'features' | 'warningThreshold' | 'automation'>>,
): Promise<DocumentQueue> {
  const s = storeApi.get();
  assertCapability(s.role, 'queue.manage', 'Frontu môže upraviť iba admin');
  const existing = s.queues.find(
    (queue) => queue.id === id && queue.tenantId === MOCK_TENANT_ID && queue.active,
  );
  if (!existing) throw new Error('Fronta neexistuje');
  if (patch.warningThreshold !== undefined && (patch.warningThreshold < 0 || patch.warningThreshold > 1)) {
    throw new Error('Confidence threshold musí byť medzi 0 a 1');
  }
  if (patch.name !== undefined && !patch.name.trim()) throw new Error('Názov fronty je povinný');
  if (patch.documentTypes !== undefined && patch.documentTypes.length === 0) {
    throw new Error('Fronta musí podporovať aspoň jeden typ dokladu');
  }
  const nextDocumentTypes = patch.documentTypes
    ? [...new Set(patch.documentTypes)]
    : existing.documentTypes;
  const incompatibleDocument = s.documents.find(
    (document) =>
      document.tenantId === MOCK_TENANT_ID &&
      document.orgId === existing.organizationId &&
      document.queueId === existing.id &&
      !nextDocumentTypes.includes(document.typ),
  );
  if (incompatibleDocument) {
    throw new Error(
      `Typ ${incompatibleDocument.typ} nemožno odobrať, pretože ho používa existujúci doklad`,
    );
  }
  if (patch.automation !== undefined) {
    const { action, minConfidence } = patch.automation;
    if (action === 'send_to_erp') {
      // Frontend mock nemá bezpečný backendový ERP job, idempotency ani
      // server-side credentials. Legacy hodnotu v existujúcej fronte nemeníme,
      // ale novú/aktualizovanú akciu tu nepovolíme.
      throw new Error('Automatické odoslanie do ERP nie je v demo režime dostupné');
    }
    if (action !== undefined && action !== 'move_to_validation') {
      throw new Error('Nepodporovaná automatizačná akcia');
    }
    if (
      minConfidence !== undefined &&
      (!Number.isFinite(minConfidence) || minConfidence < 0 || minConfidence > 1)
    ) {
      throw new Error('Minimálna istota musí byť medzi 0 a 1');
    }
    if (action !== undefined && minConfidence === undefined) {
      throw new Error('Automatizačná akcia vyžaduje minimálnu istotu');
    }
    if (minConfidence !== undefined && action === undefined) {
      throw new Error('Minimálna istota vyžaduje automatizačnú akciu');
    }
  }
  let updated: DocumentQueue | undefined;
  const queues = s.queues.map((queue) => {
    if (queue.id !== id || queue.tenantId !== MOCK_TENANT_ID) return queue;
    updated = {
      ...queue,
      ...patch,
      name: patch.name?.trim() ?? queue.name,
      documentTypes: nextDocumentTypes,
      features: patch.features ? { ...patch.features } : queue.features,
      automation: patch.automation ? { ...patch.automation } : queue.automation,
    };
    return updated;
  });
  if (!updated) throw new Error('Fronta neexistuje');
  storeApi.set({ queues });
  return updated;
}

export async function archiveQueue(id: string): Promise<void> {
  const s = storeApi.get();
  assertCapability(s.role, 'queue.manage', 'Frontu môže archivovať iba admin');
  const queue = s.queues.find(
    (item) => item.id === id && item.tenantId === MOCK_TENANT_ID && item.active,
  );
  if (!queue) throw new Error('Fronta neexistuje');
  if (
    s.documents.some(
      (document) => document.tenantId === MOCK_TENANT_ID && document.queueId === id,
    )
  ) {
    throw new Error('Frontu s dokladmi nie je možné archivovať');
  }
  storeApi.set({
    queues: s.queues.map((item) =>
      item.id === id && item.tenantId === MOCK_TENANT_ID
        ? { ...item, active: false }
        : item,
    ),
    aliases: s.aliases.map((alias) =>
      alias.tenantId === MOCK_TENANT_ID && alias.queueId === id
        ? { ...alias, status: 'disabled' as const, disabledAt: nowIso() }
        : alias,
    ),
  });
}

// ===== Aliasy (SPEC §11.3) =====

function expireGraceAliases(): void {
  const s = storeApi.get();
  const now = Date.now();
  let changed = false;
  const aliases = s.aliases.map((alias) => {
    if (
      alias.tenantId === MOCK_TENANT_ID &&
      alias.status === 'grace_period' &&
      alias.graceUntil &&
      Date.parse(alias.graceUntil) <= now
    ) {
      changed = true;
      return {
        ...alias,
        status: 'disabled' as const,
        disabledAt: nowIso(),
      };
    }
    return alias;
  });
  if (changed) storeApi.set({ aliases });
}

export async function listAliases(orgId?: string): Promise<OrganizationEmailAlias[]> {
  assertCapability(storeApi.get().role, 'tenant.read');
  if (REST_DATA_MODE) {
    if (orgId) {
      return restRequest<OrganizationEmailAlias[]>(`/api/organizations/${encodeURIComponent(orgId)}/email-aliases`);
    }
    return (await refreshRestSnapshot()).aliases;
  }
  expireGraceAliases();
  const all = storeApi.get().aliases.filter((a) => a.tenantId === MOCK_TENANT_ID);
  return orgId ? all.filter((a) => a.organizationId === orgId) : all;
}

export async function disableAlias(aliasId: string): Promise<void> {
  const s = storeApi.get();
  assertCapability(s.role, 'alias.manage', 'Alias môže vypnúť iba admin');
  if (REST_DATA_MODE) {
    const alias = s.aliases.find((item) => item.id === aliasId);
    if (!alias) throw new Error('Alias neexistuje');
    await restRequest(
      `/api/organizations/${encodeURIComponent(alias.organizationId)}/email-aliases/${encodeURIComponent(aliasId)}/disable`,
      { method: 'POST' },
    );
    await refreshRestSnapshot();
    return;
  }
  const alias = s.aliases.find(
    (item) => item.id === aliasId && item.tenantId === MOCK_TENANT_ID,
  );
  if (!alias) throw new Error('Alias neexistuje');
  if (alias.isPrimary) {
    throw new Error('Primárny alias najprv nahraďte novým aliasom');
  }
  storeApi.set({
    aliases: s.aliases.map((item) =>
      item.id === aliasId && item.tenantId === MOCK_TENANT_ID
        ? {
            ...item,
            status: 'disabled' as const,
            disabledAt: nowIso(),
            graceUntil: undefined,
          }
        : item,
    ),
  });
}

/** Admin akcia „Vygenerovať nový alias" — starý ostáva v grace období (SPEC §11.3). */
export async function regenerateAlias(orgId: string): Promise<OrganizationEmailAlias> {
  const s = storeApi.get();
  assertCapability(s.role, 'alias.manage', 'Nový alias môže vygenerovať iba admin');
  if (REST_DATA_MODE) {
    const alias = await restRequest<OrganizationEmailAlias>(
      `/api/organizations/${encodeURIComponent(orgId)}/email-aliases/regenerate`,
      { method: 'POST' },
    );
    await refreshRestSnapshot();
    return alias;
  }
  const org = s.organizations.find(
    (o) => o.id === orgId && o.tenantId === MOCK_TENANT_ID,
  );
  if (!org) throw new Error('Organizácia neexistuje');

  const generated = generateUniqueAlias({
    nazov: org.nazov,
    domain: PUBLIC_MAIL_RECEIVING_DOMAIN,
    // Vypnutý alias sa nikdy nepoužije znova pre inú organizáciu —
    // obsadenosť sa kontroluje voči VŠETKÝM aliasom vrátane disabled.
    isTaken: (addr) =>
      s.aliases.some(
        (a) => a.tenantId === MOCK_TENANT_ID && a.addressNormalized === addr,
      ),
  });
  const graceUntil = new Date();
  graceUntil.setDate(graceUntil.getDate() + EMAIL_ALIAS_GRACE_DAYS);

  const receivedQueue = s.queues.find(
    (queue) =>
      queue.organizationId === orgId &&
      queue.tenantId === MOCK_TENANT_ID &&
      queue.kind === 'received_invoices' &&
      queue.active,
  );
  if (!receivedQueue) throw new Error('Organizácia nemá aktívnu frontu prijatých faktúr');
  const oldPrimaryAlias = s.aliases.find(
    (candidate) =>
      candidate.tenantId === MOCK_TENANT_ID &&
      candidate.organizationId === orgId &&
      candidate.queueId === receivedQueue.id &&
      candidate.isPrimary &&
      candidate.status === 'active',
  );

  const newAlias: OrganizationEmailAlias = {
    id: newId('alias'),
    tenantId: MOCK_TENANT_ID,
    organizationId: orgId,
    queueId: receivedQueue.id,
    address: generated.address,
    addressNormalized: generated.addressNormalized,
    localPart: generated.localPart,
    domain: generated.domain,
    slugAtCreation: generated.slug,
    token: generated.token,
    status: 'active',
    isPrimary: true,
    createdAt: nowIso(),
  };

  storeApi.set({
    aliases: [
      newAlias,
      ...s.aliases.map((a) =>
        a.id === oldPrimaryAlias?.id
          ? { ...a, status: 'grace_period' as const, isPrimary: false, graceUntil: graceUntil.toISOString() }
          : a,
      ),
    ],
    organizations: s.organizations.map((o) =>
      o.id === orgId && o.tenantId === MOCK_TENANT_ID
        ? { ...o, emailAlias: newAlias.address }
        : o,
    ),
    queues: s.queues.map((queue) =>
      queue.tenantId === MOCK_TENANT_ID && queue.id === receivedQueue.id
        ? { ...queue, importAlias: newAlias.address }
        : queue,
    ),
  });
  return newAlias;
}

// ===== Doklady =====

export async function getDocument(id: string): Promise<DocumentItem | undefined> {
  assertCapability(storeApi.get().role, 'tenant.read');
  if (REST_DATA_MODE) {
    return (await refreshRestSnapshot()).documents.find((document) => document.id === id);
  }
  return storeApi
    .get()
    .documents.find((d) => d.id === id && d.tenantId === MOCK_TENANT_ID);
}

export async function listDocuments(): Promise<DocumentItem[]> {
  assertCapability(storeApi.get().role, 'tenant.read');
  if (REST_DATA_MODE) return (await refreshRestSnapshot()).documents;
  return storeApi.get().documents.filter((d) => d.tenantId === MOCK_TENANT_ID);
}

export interface CreateDocumentInput {
  organizationId: string;
  queueId?: string;
  typ: DocumentType;
  mode: 'manual' | 'upload';
  supplierName?: string;
  invoiceNumber?: string;
  issueDate: string;
  taxDate?: string;
  dueDate?: string;
  currency: 'EUR' | 'CZK' | 'USD';
  totalAmount: number;
  vatRate: VatRate;
  file?: File;
}

/**
 * Ručný intake bez falošného InboundEmail. Tenant sa vždy berie zo session
 * kontextu; organizácia z payloadu sa overí voči aktuálnemu tenantu.
 */
export async function createDocument(input: CreateDocumentInput): Promise<DocumentItem> {
  const s = storeApi.get();
  assertCapability(
    s.role,
    'document.create',
    'Schvaľovateľ nemôže vytvárať doklady',
  );
  const parsed = createDocumentInputSchema.parse({
    organizationId: input.organizationId,
    queueId: input.queueId,
    typ: input.typ,
    mode: input.mode,
    supplierName: input.supplierName ?? '',
    invoiceNumber: input.invoiceNumber ?? '',
    issueDate: input.issueDate,
    taxDate: input.taxDate || undefined,
    dueDate: input.dueDate || undefined,
    currency: input.currency,
    totalAmount: input.totalAmount,
    vatRate: input.vatRate,
  });
  const organization = s.organizations.find(
    (item) =>
      item.id === parsed.organizationId && item.tenantId === MOCK_TENANT_ID,
  );
  if (!organization) throw new Error('Organizácia nie je dostupná');
  if (organization.archived) throw new Error('Do archivovanej organizácie nemožno pridať doklad');
  const queue = s.queues.find(
    (item) =>
      item.tenantId === MOCK_TENANT_ID &&
      item.organizationId === organization.id &&
      item.active &&
      (!parsed.queueId || item.id === parsed.queueId) &&
      item.documentTypes.includes(parsed.typ),
  );
  if (!queue) throw new Error('Pre organizáciu nie je dostupná vhodná fronta');
  if (parsed.mode === 'upload' && !input.file) throw new Error('Súbor je povinný');

  const id = newId('doc');
  const mimeType = input.file ? await inspectDocumentFile(input.file) : undefined;
  const total = round2(parsed.totalAmount);
  const base = parsed.vatRate === 0
    ? total
    : round2(total / (1 + parsed.vatRate / 100));
  const vat = round2(total - base);
  const normalizedSupplier = parsed.supplierName.toLocaleLowerCase('sk');
  const duplicate = parsed.invoiceNumber && normalizedSupplier
    ? s.documents.find(
        (document) =>
          document.tenantId === MOCK_TENANT_ID &&
          document.orgId === organization.id &&
          document.extracted.cisloFaktury === parsed.invoiceNumber &&
          document.extracted.dodavatel.nazov.toLocaleLowerCase('sk') === normalizedSupplier,
      )
    : undefined;

  const document: DocumentItem = {
    id,
    tenantId: MOCK_TENANT_ID,
    orgId: organization.id,
    queueId: queue.id,
    typ: parsed.typ,
    status: duplicate ? 'duplicita' : 'na_kontrole',
    processingStatus: 'ready_for_review',
    pdfUrl: '',
    prijateDna: nowIso(),
    zdroj: {
      typ: parsed.mode,
      localFileKey: input.file ? id : undefined,
      mimeType,
      byteSize: input.file?.size,
      povodnyNazovSuboru: input.file?.name,
    },
    confidence: 0,
    extracted: {
      dodavatel: { nazov: parsed.supplierName },
      odberatel: {
        nazov: organization.nazov,
        ico: organization.ico,
        dic: organization.dic,
        icDph: organization.icDph,
      },
      cisloFaktury: parsed.invoiceNumber,
      datumVystavenia: parsed.issueDate,
      datumDodania: parsed.taxDate,
      datumSplatnosti: parsed.dueDate,
      mena: parsed.currency,
      rozpisDph: [{ sadzba: parsed.vatRate, zaklad: base, dph: vat }],
      sumaSpolu: total,
      polozky: [],
    },
    ucto: {},
    history: [
      historyEntry(
        input.file
          ? `Doklad nahraný používateľom: ${input.file.name}`
          : 'Doklad vytvorený manuálne',
      ),
    ],
    comments: [],
    duplicateOfDocumentId: duplicate?.id,
    version: 1,
  };
  const suggestion = buildSuggestionForDocument(s, document);

  if (input.file && mimeType) {
    await saveLocalDocumentFile(id, input.file, mimeType);
  }
  try {
    storeApi.set({
      documents: [document, ...s.documents],
      suggestions: [suggestion, ...s.suggestions],
    });
  } catch (cause) {
    if (input.file) await deleteLocalDocumentFile(id);
    throw cause;
  }
  return document;
}

export async function updatePaymentStatus(
  id: string,
  status: PaymentStatus,
  options: { amountPaid?: number; executionDate?: string } = {},
): Promise<DocumentItem> {
  assertCapability(
    storeApi.get().role,
    'document.payment.manage',
    'Schvaľovateľ nemôže meniť stav platby',
  );
  return updateDoc(id, (document) => {
    const total = document.extracted.sumaSpolu;
    let amountPaid = options.amountPaid ?? document.payment?.amountPaid ?? 0;
    if (status === 'paid') amountPaid = total;
    if (status === 'unpaid' || status === 'to_pay' || status === 'payment_order') {
      amountPaid = 0;
    }
    if (!Number.isFinite(amountPaid) || amountPaid < 0 || amountPaid > total) {
      throw new Error('Neplatná uhradená suma');
    }
    if (status === 'partially_paid' && (amountPaid <= 0 || amountPaid >= total)) {
      throw new Error('Čiastočná úhrada musí byť medzi 0 a celkovou sumou');
    }
    const paidAt = status === 'paid' ? nowIso() : undefined;
    return {
      ...document,
      payment: {
        ...document.payment,
        status,
        amountPaid: round2(amountPaid),
        executionDate: options.executionDate ?? document.payment?.executionDate,
        paidAt,
        markedBy: currentUserName(),
      },
      history: [
        ...document.history,
        historyEntry(
          status === 'paid'
            ? 'Platba označená ako uhradená'
            : status === 'partially_paid'
              ? `Zaevidovaná čiastočná úhrada ${round2(amountPaid)}`
              : `Stav platby zmenený na ${status}`,
        ),
      ],
    };
  });
}

export async function recordPaymentQrGenerated(
  id: string,
  payloadHash: string,
  documentVersion: number,
  executionDate?: string,
): Promise<DocumentItem> {
  assertCapability(
    storeApi.get().role,
    'document.payment-qr.generate',
    'Schvaľovateľ nemôže vytvárať platobný QR kód',
  );
  return updateDoc(id, (document) => {
    if (document.version !== documentVersion) {
      throw new Error('Doklad bol zmenený; QR kód je potrebné vytvoriť znova');
    }
    return {
      ...document,
      payment: {
        status: 'payment_order',
        amountPaid: document.payment?.amountPaid ?? 0,
        executionDate: executionDate ?? document.extracted.datumSplatnosti,
        markedBy: currentUserName(),
        qrPayloadHash: payloadHash,
        qrDocumentVersion: documentVersion,
      },
      history: [...document.history, historyEntry('Vytvorený PAY by square QR kód')],
    };
  });
}

/**
 * Uloženie úprav formulára. Úprava schváleného dokladu ho vracia do
 * `na_kontrole` a vylučuje z exportu do nového schválenia (SPEC §11.24).
 */
export async function saveDocument(
  id: string,
  patch: Partial<Pick<DocumentItem, 'typ' | 'extracted' | 'ucto'>>,
  expectedVersion?: number,
): Promise<DocumentItem> {
  assertCapability(
    storeApi.get().role,
    'document.edit',
    'Schvaľovateľ nemôže upravovať údaje dokladu',
  );
  if (REST_DATA_MODE) {
    const current = storeApi.get().documents.find((document) => document.id === id);
    if (!current) throw new Error('Doklad neexistuje');
    await restRequest(`/api/documents/${encodeURIComponent(id)}`, {
      method: 'PATCH',
      body: JSON.stringify({
        documentType: patch.typ,
        extracted: patch.extracted,
        accounting: patch.ucto,
        expectedVersion: expectedVersion ?? current.version,
      }),
    });
    const updated = (await refreshRestSnapshot()).documents.find((document) => document.id === id);
    if (!updated) throw new Error('Doklad neexistuje');
    return updated;
  }
  return updateDoc(id, (doc) => {
    if (expectedVersion !== undefined && doc.version !== expectedVersion) {
      throw new Error('Doklad bol medzitým zmenený; načítajte aktuálnu verziu');
    }
    if (doc.status === 'exportovany') {
      throw new Error('Exportovaný doklad nie je možné upravovať');
    }
    const demoted = doc.status === 'schvaleny';
    const nextStatus: DocumentStatus =
      demoted || doc.status === 'extrahovany' ? 'na_kontrole' : doc.status;
    return {
      ...doc,
      ...patch,
      status: nextStatus,
      version: doc.version + 1,
      approvedVersion: undefined,
      approvedSnapshot: undefined,
      history: [
        ...doc.history,
        historyEntry(demoted ? 'Upravené po schválení — vrátené na kontrolu' : 'Doklad upravený'),
      ],
    };
  });
}

export interface ApprovalCheck {
  ok: boolean;
  missingUcto: boolean;
  vatInconsistent: boolean;
  totalMismatch: boolean;
  issues: DocumentValidationIssue[];
}

/** Podmienky schválenia (SPEC §6.4, §11.14) — kontroluje aj UI pre disabled stav. */
export function checkApprovable(
  doc: DocumentItem,
  codeLists: AppDataState['codeLists'],
  organizations: Organization[] = [],
): ApprovalCheck {
  const inOrg = (list: CodeListItem[], id?: string) =>
    !!id &&
    list.some(
      (c) =>
        c.id === id &&
        c.tenantId === doc.tenantId &&
        c.orgId === doc.orgId &&
        c.active,
    );
  const missingUcto =
    !inOrg(codeLists.predkontacie, doc.ucto.predkontaciaId) ||
    !inOrg(codeLists.cleneniaDph, doc.ucto.clenenieDphId) ||
    !inOrg(codeLists.ciselneRady, doc.ucto.ciselnyRadId) ||
    (!!doc.ucto.strediskoId && !inOrg(codeLists.strediska, doc.ucto.strediskoId)) ||
    (doc.typ === 'PD' && (!doc.ucto.pokladnaKod?.trim() || !doc.ucto.pokladnaTyp));
  const vatInconsistent = doc.extracted.rozpisDph.some((r) => !isVatRowConsistent(r));
  const totalMismatch = !isTotalConsistent(doc.extracted.rozpisDph, doc.extracted.sumaSpolu);
  const organization = organizations.find(
    (org) => org.id === doc.orgId && org.tenantId === doc.tenantId,
  );
  const issues = validateDocument(doc, organization);
  return {
    ok: !missingUcto && issues.length === 0,
    missingUcto,
    vatInconsistent,
    totalMismatch,
    issues,
  };
}

export interface DocumentVersionRequest {
  id: string;
  expectedVersion: number;
}

function approvedDocument(
  s: AppDataState,
  doc: DocumentItem,
  expectedVersion: number,
): DocumentItem {
  if (doc.version !== expectedVersion) {
    throw new Error('Doklad bol medzitým zmenený; schválenie bolo zastavené');
  }
  const permittedStatus =
    s.role === 'schvalovatel'
      ? doc.status === 'na_kontrole'
      : s.role === 'uctovnik' || s.role === 'admin'
        ? ['na_kontrole', 'extrahovany'].includes(doc.status)
        : false;
  if (!permittedStatus) {
    throw new Error('Schváliť možno iba doklad na kontrole');
  }
  const check = checkApprovable(doc, s.codeLists, s.organizations);
  if (!check.ok) {
    throw new Error('Doklad nespĺňa podmienky schválenia (zaúčtovanie / DPH)');
  }
  // Workflow decisions are entity revisions too. Incrementing the version here
  // prevents a stale reviewer from rejecting a document after another reviewer
  // has approved the same content revision.
  const approvedVersion = doc.version + 1;
  return {
    ...doc,
    status: 'schvaleny',
    version: approvedVersion,
    approvedVersion,
    approvedSnapshot: {
      version: approvedVersion,
      approvedAt: nowIso(),
      typ: doc.typ,
      extracted: structuredClone(doc.extracted),
      ucto: structuredClone(doc.ucto),
    },
    history: [...doc.history, historyEntry('Doklad schválený')],
  };
}

export async function approveDocument(
  id: string,
  expectedVersion: number,
): Promise<DocumentItem> {
  const s = storeApi.get();
  assertCapability(s.role, 'document.approve', 'Doklad nemôžete schváliť');
  if (REST_DATA_MODE) {
    await restRequest(`/api/documents/${encodeURIComponent(id)}/approve`, {
      method: 'POST',
      body: JSON.stringify({ expectedVersion }),
    });
    const updated = (await refreshRestSnapshot()).documents.find((document) => document.id === id);
    if (!updated) throw new Error('Doklad neexistuje');
    return updated;
  }
  return updateDoc(id, (doc) => approvedDocument(s, doc, expectedVersion));
}

/**
 * Atomické hromadné schválenie: všetky verzie a podmienky sa overia pred
 * jediným zápisom. Pri jednej chybe sa nezmení žiadny z vybraných dokladov.
 */
export async function approveDocuments(
  requests: DocumentVersionRequest[],
): Promise<DocumentItem[]> {
  const s = storeApi.get();
  assertCapability(s.role, 'document.approve', 'Doklady nemôžete schváliť');
  if (requests.length === 0) throw new Error('Nie sú vybrané žiadne doklady');
  if (REST_DATA_MODE) {
    for (const request of requests) await approveDocument(request.id, request.expectedVersion);
    const snapshot = await refreshRestSnapshot();
    return requests.map((request) => {
      const document = snapshot.documents.find((item) => item.id === request.id);
      if (!document) throw new Error('Doklad neexistuje');
      return document;
    });
  }
  const requestMap = new Map(requests.map((request) => [request.id, request.expectedVersion]));
  if (requestMap.size !== requests.length) throw new Error('Doklad je vybraný viackrát');

  const updated = requests.map((request) => {
    const doc = s.documents.find(
      (item) => item.id === request.id && item.tenantId === MOCK_TENANT_ID,
    );
    if (!doc) throw new Error('Doklad neexistuje');
    return approvedDocument(s, doc, request.expectedVersion);
  });
  const updatedMap = new Map(updated.map((doc) => [doc.id, doc]));
  storeApi.set({
    documents: s.documents.map((doc) =>
      doc.tenantId === MOCK_TENANT_ID ? (updatedMap.get(doc.id) ?? doc) : doc,
    ),
  });
  return updated;
}

function normalizedRejectionReason(reason: string): string {
  const normalized = reason.trim();
  if (!normalized) throw new Error('Dôvod zamietnutia je povinný');
  if (normalized.length > 1000) {
    throw new Error('Dôvod zamietnutia môže mať najviac 1000 znakov');
  }
  return normalized;
}

function rejectedDocument(
  doc: DocumentItem,
  expectedVersion: number,
  reason: string,
): DocumentItem {
  if (doc.version !== expectedVersion) {
    throw new Error('Doklad bol medzitým zmenený; zamietnutie bolo zastavené');
  }
  if (doc.status === 'exportovany') {
    throw new Error('Exportovaný doklad nie je možné zamietnuť');
  }
  if (doc.status === 'zamietnuty') {
    throw new Error('Doklad už bol zamietnutý');
  }
  return {
    ...doc,
    status: 'zamietnuty',
    version: doc.version + 1,
    // Zamietnutím predtým schváleného dokladu sa ruší exportná spôsobilosť.
    // Samotný dôvod zostáva v histórii rozhodnutí.
    approvedVersion: undefined,
    approvedSnapshot: undefined,
    history: [...doc.history, historyEntry(`Doklad zamietnutý — dôvod: ${reason}`)],
  };
}

export async function rejectDocument(
  id: string,
  expectedVersion: number,
  reason: string,
): Promise<DocumentItem> {
  assertCapability(
    storeApi.get().role,
    'document.reject',
    'Doklad nemôžete zamietnuť',
  );
  const normalizedReason = normalizedRejectionReason(reason);
  if (REST_DATA_MODE) {
    await restRequest(`/api/documents/${encodeURIComponent(id)}/reject`, {
      method: 'POST',
      body: JSON.stringify({ expectedVersion, reason: normalizedReason }),
    });
    const updated = (await refreshRestSnapshot()).documents.find((document) => document.id === id);
    if (!updated) throw new Error('Doklad neexistuje');
    return updated;
  }
  return updateDoc(id, (doc) => rejectedDocument(doc, expectedVersion, normalizedReason));
}

/** Atomické hromadné zamietnutie s jedným explicitným ľudským dôvodom. */
export async function rejectDocuments(
  requests: DocumentVersionRequest[],
  reason: string,
): Promise<DocumentItem[]> {
  const s = storeApi.get();
  assertCapability(s.role, 'document.reject', 'Doklady nemôžete zamietnuť');
  if (requests.length === 0) throw new Error('Nie sú vybrané žiadne doklady');
  const normalizedReason = normalizedRejectionReason(reason);
  if (REST_DATA_MODE) {
    for (const request of requests) await rejectDocument(request.id, request.expectedVersion, normalizedReason);
    const snapshot = await refreshRestSnapshot();
    return requests.map((request) => {
      const document = snapshot.documents.find((item) => item.id === request.id);
      if (!document) throw new Error('Doklad neexistuje');
      return document;
    });
  }
  const requestMap = new Map(requests.map((request) => [request.id, request.expectedVersion]));
  if (requestMap.size !== requests.length) throw new Error('Doklad je vybraný viackrát');

  const updated = requests.map((request) => {
    const doc = s.documents.find(
      (item) => item.id === request.id && item.tenantId === MOCK_TENANT_ID,
    );
    if (!doc) throw new Error('Doklad neexistuje');
    return rejectedDocument(doc, request.expectedVersion, normalizedReason);
  });
  const updatedMap = new Map(updated.map((doc) => [doc.id, doc]));
  storeApi.set({
    documents: s.documents.map((doc) =>
      doc.tenantId === MOCK_TENANT_ID ? (updatedMap.get(doc.id) ?? doc) : doc,
    ),
  });
  return updated;
}

export async function quarantineDocument(id: string): Promise<DocumentItem> {
  assertCapability(
    storeApi.get().role,
    'document.workflow.manage',
    'Schvaľovateľ nemôže meniť zaradenie dokladu',
  );
  if (REST_DATA_MODE) {
    await restRequest(`/api/documents/${encodeURIComponent(id)}/quarantine`, { method: 'POST' });
    const updated = (await refreshRestSnapshot()).documents.find((document) => document.id === id);
    if (!updated) throw new Error('Doklad neexistuje');
    return updated;
  }
  return updateDoc(id, (doc) => ({
    ...doc,
    status: 'karantena',
    quarantineReason: doc.quarantineReason ?? 'manual',
    history: [...doc.history, historyEntry('Doklad presunutý do karantény')],
  }));
}

/** „Spracovať ručne" — z chyba/karantena/duplicita späť na kontrolu (SPEC §4). */
export async function processManually(id: string): Promise<DocumentItem> {
  assertCapability(
    storeApi.get().role,
    'document.workflow.manage',
    'Schvaľovateľ nemôže prevziať doklad na spracovanie',
  );
  return updateDoc(id, (doc) => {
    if (!['chyba', 'karantena', 'duplicita'].includes(doc.status)) {
      throw new Error('Ručné spracovanie je dostupné iba pre problémové doklady');
    }
    return {
      ...doc,
      status: 'na_kontrole',
      history: [...doc.history, historyEntry('Prevzaté na ručné spracovanie')],
    };
  });
}

/** Bulk presun do pracovnej fronty; exportované/schválené doklady nemení. */
export async function moveDocumentToReview(id: string): Promise<DocumentItem> {
  assertCapability(
    storeApi.get().role,
    'document.workflow.manage',
    'Schvaľovateľ nemôže meniť zaradenie dokladu',
  );
  return updateDoc(id, (doc) => {
    if (['schvaleny', 'exportovany'].includes(doc.status)) {
      throw new Error('Schválený alebo exportovaný doklad nie je možné presunúť');
    }
    return {
      ...doc,
      status: 'na_kontrole',
      history: [...doc.history, historyEntry('Doklad presunutý na kontrolu')],
    };
  });
}

/** Rozhodnutie „Nie je duplicita" sa ukladá (SPEC §11.11). */
export async function markNotDuplicate(id: string): Promise<DocumentItem> {
  assertCapability(
    storeApi.get().role,
    'document.workflow.manage',
    'Schvaľovateľ nemôže rozhodnúť o technickej duplicite',
  );
  return updateDoc(id, (doc) => ({
    ...doc,
    status: 'na_kontrole',
    notDuplicate: true,
    history: [...doc.history, historyEntry('Rozhodnutie: nie je duplicita')],
  }));
}

export async function addComment(id: string, text: string): Promise<DocumentItem> {
  assertCapability(storeApi.get().role, 'document.comment');
  const normalized = text.trim();
  if (!normalized) throw new Error('Komentár nemôže byť prázdny');
  if (normalized.length > 4000) throw new Error('Komentár môže mať najviac 4000 znakov');
  return updateDoc(id, (doc) => ({
    ...doc,
    comments: [...doc.comments, { ts: nowIso(), user: currentUserName(), text: normalized }],
    // Audit eviduje iba udalosť. Obsah komentára zostáva v komentároch a
    // nekopíruje sa do všeobecného auditného záznamu.
    history: [...doc.history, historyEntry('Komentár pridaný')],
  }));
}

/**
 * „Spustiť extrakciu znova" — vytvorí NOVÝ ExtractionRun; históriu neprepisuje
 * a ručné úpravy nechá nedotknuté bez explicitného použitia (SPEC §11.13).
 */
export async function reprocessDocument(id: string): Promise<ExtractionRun> {
  const s = storeApi.get();
  assertCapability(
    s.role,
    'document.reprocess',
    'Schvaľovateľ nemôže spustiť novú extrakciu',
  );
  if (REST_DATA_MODE) {
    const document = s.documents.find((item) => item.id === id);
    if (!document) throw new Error('Doklad neexistuje');
    await restRequest(`/api/documents/${encodeURIComponent(id)}/reprocess`, { method: 'POST' });
    return {
      id: crypto.randomUUID(),
      tenantId: document.tenantId,
      organizationId: document.orgId,
      documentId: id,
      provider: 'mock',
      promptVersion: EXTRACTION_PROMPT_VERSION,
      schemaVersion: EXTRACTION_SCHEMA_VERSION,
      status: 'queued',
      createdAt: nowIso(),
    };
  }
  const doc = s.documents.find(
    (d) => d.id === id && d.tenantId === MOCK_TENANT_ID,
  );
  if (!doc) throw new Error('Doklad neexistuje');
  const org = s.organizations.find(
    (item) => item.id === doc.orgId && item.tenantId === MOCK_TENANT_ID,
  );
  if (!org) throw new Error('Organizácia neexistuje');
  if (!doc.zdroj.localFileKey && !doc.pdfUrl) {
    throw new Error('Doklad nemá priložený súbor na extrakciu');
  }
  const run: ExtractionRun = {
    id: newId('run'),
    tenantId: MOCK_TENANT_ID,
    organizationId: doc.orgId,
    documentId: id,
    provider: 'mock',
    promptVersion: EXTRACTION_PROMPT_VERSION,
    schemaVersion: EXTRACTION_SCHEMA_VERSION,
    status: 'running',
    startedAt: nowIso(),
    createdAt: nowIso(),
  };
  const provider = new MockDocumentExtractionProvider({
    scenario: 'uspech',
    seed: Array.from(doc.id).reduce((sum, char) => sum + char.charCodeAt(0), 0),
    fileName: doc.zdroj.povodnyNazovSuboru ?? 'doklad.pdf',
  });
  try {
    run.result = await provider.extract({
      documentId: doc.id,
      mimeType: doc.zdroj.mimeType ?? 'application/pdf',
      storageKey: doc.zdroj.localFileKey ?? doc.zdroj.attachmentId ?? doc.pdfUrl,
      organizationContext: {
        nazov: org.nazov,
        ico: org.ico,
        dic: org.dic,
        icDph: org.icDph,
      },
      promptVersion: EXTRACTION_PROMPT_VERSION,
      schemaVersion: EXTRACTION_SCHEMA_VERSION,
    });
    run.status = 'succeeded';
  } catch (cause) {
    run.status = 'failed';
    run.errorCode = 'extraction_failed';
    run.errorMessage = cause instanceof Error ? cause.message : String(cause);
  }
  run.completedAt = nowIso();
  run.latencyMs = Math.max(0, Date.parse(run.completedAt) - Date.parse(run.startedAt!));
  storeApi.set({ extractionRuns: [run, ...s.extractionRuns] });
  updateDoc(id, (d) => ({
    ...d,
    processingStatus: run.status === 'succeeded' ? 'ready_for_review' : 'failed_retryable',
    history: [...d.history, historyEntry('Spustená nová extrakcia (mock)')],
  }));
  return run;
}

export async function listExtractionRuns(documentId: string): Promise<ExtractionRun[]> {
  assertCapability(storeApi.get().role, 'tenant.read');
  if (REST_DATA_MODE) {
    return (await refreshRestSnapshot()).extractionRuns.filter((run) => run.documentId === documentId);
  }
  return storeApi
    .get()
    .extractionRuns.filter(
      (r) => r.tenantId === MOCK_TENANT_ID && r.documentId === documentId,
    );
}

/** Ručné použitie nového AI výsledku; nikdy sa neaplikuje automaticky. */
export async function applyExtractionRun(
  documentId: string,
  runId: string,
  expectedVersion?: number,
): Promise<DocumentItem> {
  const s = storeApi.get();
  assertCapability(
    s.role,
    'document.reprocess',
    'Schvaľovateľ nemôže použiť výsledok extrakcie',
  );
  if (REST_DATA_MODE) {
    const document = s.documents.find((item) => item.id === documentId);
    const version = expectedVersion ?? document?.version;
    if (!version) throw new Error('Doklad neexistuje');
    await restRequest(`/api/documents/${encodeURIComponent(documentId)}/extraction-runs/${encodeURIComponent(runId)}/apply`, {
      method: 'POST',
      body: JSON.stringify({ expectedVersion: version }),
    });
    const updated = (await refreshRestSnapshot()).documents.find((item) => item.id === documentId);
    if (!updated) throw new Error('Doklad neexistuje');
    return updated;
  }
  const run = s.extractionRuns.find(
    (item) =>
      item.id === runId &&
      item.documentId === documentId &&
      item.tenantId === MOCK_TENANT_ID &&
      item.status === 'succeeded' &&
      item.result,
  );
  if (!run?.result) throw new Error('Úspešný výsledok extrakcie neexistuje');

  const updated = updateDoc(documentId, (doc) => {
    if (expectedVersion !== undefined && doc.version !== expectedVersion) {
      throw new Error('Doklad bol medzitým zmenený; extrakcia sa nepoužila');
    }
    if (doc.status === 'exportovany') {
      throw new Error('Exportovaný doklad nie je možné meniť');
    }
    const normalized = normalizeExtractionResult(
      run.result!,
      doc.id,
      doc.prijateDna.slice(0, 10),
    );
    const organization = s.organizations.find(
      (item) => item.id === doc.orgId && item.tenantId === doc.tenantId,
    );
    const buyerMismatch =
      Boolean(normalized.extracted.odberatel?.ico) &&
      normalized.extracted.odberatel?.ico !== organization?.ico;
    return {
      ...doc,
      ...normalized,
      status: buyerMismatch ? 'karantena' : 'na_kontrole',
      quarantineReason: buyerMismatch ? 'buyer_ico_mismatch' : undefined,
      processingStatus: 'ready_for_review',
      version: doc.version + 1,
      approvedVersion: undefined,
      approvedSnapshot: undefined,
      history: [...doc.history, historyEntry(`Použitá extrakcia ${run.id}`)],
    };
  });

  const latest = storeApi.get();
  const suggestion = buildSuggestionForDocument(latest, updated);
  storeApi.set({
    suggestions: [
      suggestion,
      ...latest.suggestions.filter(
        (item) =>
          item.tenantId !== MOCK_TENANT_ID || item.documentId !== documentId,
      ),
    ],
  });
  return updated;
}

// ===== Návrhy zaúčtovania (SPEC §11.15) =====

export async function getSuggestion(documentId: string): Promise<AccountingSuggestion | undefined> {
  const s = storeApi.get();
  assertCapability(s.role, 'tenant.read');
  if (REST_DATA_MODE) {
    return (await refreshRestSnapshot()).suggestions.find((item) => item.documentId === documentId);
  }
  const stored = s.suggestions.find(
    (x) => x.tenantId === MOCK_TENANT_ID && x.documentId === documentId,
  );
  if (stored) return stored;
  const doc = s.documents.find(
    (d) => d.id === documentId && d.tenantId === MOCK_TENANT_ID,
  );
  if (!doc) return undefined;
  return buildSuggestionForDocument(s, doc);
}

export async function getLastUsedForSupplier(
  documentId: string,
): Promise<{ label: string; ucto: DocumentItem['ucto'] } | undefined> {
  const s = storeApi.get();
  assertCapability(s.role, 'tenant.read');
  const doc = s.documents.find(
    (d) => d.id === documentId && d.tenantId === MOCK_TENANT_ID,
  );
  if (!doc) return undefined;
  return lastUsedForSupplier(s, doc);
}

// ===== Číselníky =====

export async function addCodeListItem(
  kind: CodeListKind,
  orgId: string,
  kod: string,
  nazov: string,
): Promise<CodeListItem> {
  const s = storeApi.get();
  assertCapability(s.role, 'code-list.manage', 'Číselníky môže upravovať iba admin');
  if (
    !s.organizations.some(
      (o) => o.id === orgId && o.tenantId === MOCK_TENANT_ID && !o.archived,
    )
  ) {
    throw new Error('Organizácia nie je dostupná');
  }
  const normalizedKod = kod.trim();
  const normalizedNazov = nazov.trim();
  if (!normalizedKod || !normalizedNazov) {
    throw new Error('Kód a názov položky sú povinné');
  }
  if (
    s.codeLists[kind].some(
      (candidate) =>
        candidate.tenantId === MOCK_TENANT_ID &&
        candidate.orgId === orgId &&
        candidate.kod === normalizedKod,
    )
  ) {
    throw new Error('Položka s týmto kódom už v organizácii existuje');
  }
  const item: CodeListItem = {
    id: newId('cl'),
    tenantId: MOCK_TENANT_ID,
    kod: normalizedKod,
    nazov: normalizedNazov,
    orgId,
    source: 'manual',
    active: true,
  };
  storeApi.set({ codeLists: { ...s.codeLists, [kind]: [...s.codeLists[kind], item] } });
  return item;
}

export async function updateCodeListItem(
  kind: CodeListKind,
  id: string,
  patch: Partial<Pick<CodeListItem, 'kod' | 'nazov'>>,
): Promise<void> {
  const s = storeApi.get();
  assertCapability(s.role, 'code-list.manage', 'Číselníky môže upravovať iba admin');
  const current = s.codeLists[kind].find(
    (item) => item.id === id && item.tenantId === MOCK_TENANT_ID,
  );
  if (!current) throw new Error('Položka číselníka neexistuje');
  if (current.source === 'pohoda') {
    throw new Error('Položka je synchronizovaná z POHODY a nemožno ju ručne upraviť');
  }
  const normalizedPatch: Partial<Pick<CodeListItem, 'kod' | 'nazov'>> = {};
  if (patch.kod !== undefined) {
    normalizedPatch.kod = patch.kod.trim();
    if (!normalizedPatch.kod) throw new Error('Kód položky je povinný');
  }
  if (patch.nazov !== undefined) {
    normalizedPatch.nazov = patch.nazov.trim();
    if (!normalizedPatch.nazov) throw new Error('Názov položky je povinný');
  }
  const nextKod = normalizedPatch.kod ?? current.kod;
  if (
    s.codeLists[kind].some(
      (candidate) =>
        candidate.id !== id &&
        candidate.tenantId === MOCK_TENANT_ID &&
        candidate.orgId === current.orgId &&
        candidate.kod === nextKod,
    )
  ) {
    throw new Error('Položka s týmto kódom už v organizácii existuje');
  }
  storeApi.set({
    codeLists: {
      ...s.codeLists,
      [kind]: s.codeLists[kind].map((c) =>
        c.id === id && c.tenantId === MOCK_TENANT_ID ? { ...c, ...normalizedPatch } : c,
      ),
    },
  });
}

export async function deactivateCodeListItem(kind: CodeListKind, id: string): Promise<void> {
  const s = storeApi.get();
  assertCapability(s.role, 'code-list.manage', 'Číselníky môže upravovať iba admin');
  if (!s.codeLists[kind].some((item) => item.id === id && item.tenantId === MOCK_TENANT_ID)) {
    throw new Error('Položka číselníka neexistuje');
  }
  storeApi.set({
    codeLists: {
      ...s.codeLists,
      [kind]: s.codeLists[kind].map(
        (c) =>
          c.id === id && c.tenantId === MOCK_TENANT_ID ? { ...c, active: false } : c,
      ),
    },
  });
}

/** @deprecated Použiť deactivateCodeListItem; položky číselníkov sa fyzicky nemažú. */
export async function deleteCodeListItem(kind: CodeListKind, id: string): Promise<void> {
  return deactivateCodeListItem(kind, id);
}

export async function importPohodaCodeLists(
  orgId: string,
  preview: CodeListImportPreview,
): Promise<CodeListImportResult> {
  const initial = storeApi.get();
  assertCapability(
    initial.role,
    'code-list.manage',
    'Číselníky môže importovať iba admin',
  );
  if (REST_DATA_MODE) {
    const result = await restRequest<CodeListImportResult>(
      `/api/organizations/${encodeURIComponent(orgId)}/code-lists/import`,
      { method: 'PUT', body: JSON.stringify(preview) },
    );
    await refreshRestSnapshot();
    return result;
  }
  if (
    !initial.organizations.some(
      (organization) =>
        organization.id === orgId &&
        organization.tenantId === MOCK_TENANT_ID &&
        !organization.archived,
    )
  ) {
    throw new Error('Organizácia nie je dostupná');
  }

  const syncedAt = nowIso();
  let result: CodeListImportResult | undefined;
  storeApi.set((state) => {
    const applied = applyPohodaCodeListImport(state.codeLists, preview, {
      tenantId: MOCK_TENANT_ID,
      orgId,
      syncedAt,
      createId: () => newId('cl'),
    });
    result = applied.result;
    return applied.codeLists === state.codeLists
      ? state
      : { ...state, codeLists: applied.codeLists };
  });
  if (!result) throw new Error('Import číselníkov sa nepodarilo dokončiť');
  return result;
}

// ===== Používatelia =====

export async function updateUserRole(userId: string, rola: Role): Promise<void> {
  const s = storeApi.get();
  assertCapability(s.role, 'user.manage', 'Roly používateľov môže meniť iba admin');
  if (!isKnownRole(rola)) throw new Error('Nepodporovaná používateľská rola');
  storeApi.set({
    users: s.users.map((u) =>
      u.id === userId && u.tenantId === MOCK_TENANT_ID ? { ...u, rola } : u,
    ),
  });
}

export interface UpdateOwnUserProfileInput {
  meno: string;
  jazyk: UserLanguage;
  notifikacie: UserNotificationPreferences;
}

/**
 * Demo adaptér profilu. Produkčný endpoint identitu vždy odvodí zo serverovej
 * session; userId ani tenantId sa v produkčnom profile neposielajú v payload-e.
 */
export async function updateOwnUserProfile(
  userId: string,
  tenantId: string,
  input: UpdateOwnUserProfileInput,
) {
  assertCapability(storeApi.get().role, 'profile.update');
  const meno = input.meno.trim();
  if (tenantId !== MOCK_TENANT_ID) throw new Error('Používateľ nie je dostupný');
  if (meno.length === 0 || meno.length > 100) throw new Error('Neplatné meno');
  if (input.jazyk !== 'sk') throw new Error('Nepodporovaný jazyk');

  const s = storeApi.get();
  const existing = s.users.find(
    (user) => user.id === userId && user.tenantId === tenantId,
  );
  if (!existing) throw new Error('Používateľ neexistuje');

  const updated = {
    ...existing,
    meno,
    jazyk: input.jazyk,
    notifikacie: { ...input.notifikacie },
  };
  storeApi.set({
    users: s.users.map((user) =>
      user.id === userId && user.tenantId === tenantId ? updated : user,
    ),
  });
  return updated;
}

// ===== Export (SPEC §6.5, §7, §11.24) =====

export interface GenerateExportResult {
  batch: ExportBatch;
  xml: string;
}

export async function generateExport(
  orgId: string,
  documentIds: string[],
): Promise<GenerateExportResult> {
  const s = storeApi.get();
  assertCapability(
    s.role,
    'export.manage',
    'Schvaľovateľ nemá oprávnenie exportovať doklady',
  );
  if (REST_DATA_MODE) {
    const result = await restRequest<GenerateExportResult>('/api/exports/pohoda/xml', {
      method: 'POST',
      body: JSON.stringify({ organizationId: orgId, documentIds: [...new Set(documentIds)] }),
    });
    await refreshRestSnapshot();
    return result;
  }
  const org = s.organizations.find(
    (o) => o.id === orgId && o.tenantId === MOCK_TENANT_ID,
  );
  if (!org) throw new Error('Organizácia neexistuje');
  const uniqueDocumentIds = [...new Set(documentIds)];
  const docs = s.documents.filter(
    (d) => d.tenantId === MOCK_TENANT_ID && uniqueDocumentIds.includes(d.id),
  );
  if (docs.length === 0) throw new Error('Žiadne doklady na export');
  if (docs.some((d) => d.status !== 'schvaleny')) {
    throw new Error('Exportovať možno iba schválené doklady');
  }
  if (docs.some((d) => d.orgId !== orgId)) {
    throw new Error('Export nesmie miešať organizácie');
  }
  if (docs.some((doc) => !checkApprovable(doc, s.codeLists, s.organizations).ok)) {
    throw new Error('Schválený doklad už nespĺňa validačné podmienky exportu');
  }

  const batchId = newId('exp');
  const approvedDocs = docs.map((doc) => {
    const snapshot = doc.approvedSnapshot;
    if (!snapshot) return doc;
    if (doc.approvedVersion !== snapshot.version) {
      throw new Error('Schválená verzia dokladu už nie je aktuálna');
    }
    return {
      ...doc,
      typ: snapshot.typ,
      extracted: structuredClone(snapshot.extracted),
      ucto: structuredClone(snapshot.ucto),
    };
  });
  const xml = buildDataPack(org, approvedDocs, s.codeLists, batchId);
  const batch: ExportBatch = {
    id: batchId,
    tenantId: MOCK_TENANT_ID,
    orgId,
    createdAt: nowIso(),
    user: currentUserName(),
    documentIds: uniqueDocumentIds,
    xmlFileName: buildExportFileName(org),
    xmlSnapshot: xml,
  };

  storeApi.set({
    exportBatches: [batch, ...s.exportBatches],
    documents: s.documents.map((d) =>
      d.tenantId === MOCK_TENANT_ID && uniqueDocumentIds.includes(d.id)
        ? {
            ...d,
            status: 'exportovany' as const,
            exportId: batchId,
            history: [...d.history, historyEntry(`Exportované do ${batch.xmlFileName}`)],
          }
        : d,
    ),
  });
  return { batch, xml };
}

export async function getBatchXml(batchId: string): Promise<{ xml: string; fileName: string }> {
  const s = storeApi.get();
  assertCapability(
    s.role,
    'export.manage',
    'Schvaľovateľ nemá oprávnenie sťahovať exporty',
  );
  if (REST_DATA_MODE) {
    const batch = s.exportBatches.find((item) => item.id === batchId);
    if (!batch) throw new Error('Export neexistuje');
    const response = await fetch(`/api/exports/${encodeURIComponent(batchId)}/download`, { credentials: 'include' });
    if (!response.ok) throw new Error('Export nie je dostupný');
    return { xml: await response.text(), fileName: batch.xmlFileName };
  }
  const batch = s.exportBatches.find(
    (b) => b.id === batchId && b.tenantId === MOCK_TENANT_ID,
  );
  if (!batch) throw new Error('Export neexistuje');
  if (batch.xmlSnapshot) {
    return { xml: batch.xmlSnapshot, fileName: batch.xmlFileName };
  }
  // Staršie seed batche bez snapshotu: XML sa zostaví nanovo z dát dokladov.
  const org = s.organizations.find(
    (o) => o.id === batch.orgId && o.tenantId === MOCK_TENANT_ID,
  );
  if (!org) throw new Error('Organizácia neexistuje');
  const docs = s.documents.filter(
    (d) => d.tenantId === MOCK_TENANT_ID && batch.documentIds.includes(d.id),
  );
  return { xml: buildDataPack(org, docs, s.codeLists, batch.id), fileName: batch.xmlFileName };
}

export async function listExportBatches(): Promise<ExportBatch[]> {
  assertCapability(
    storeApi.get().role,
    'export.manage',
    'Schvaľovateľ nemá oprávnenie zobrazovať exporty',
  );
  if (REST_DATA_MODE) return restRequest<ExportBatch[]>('/api/exports');
  return storeApi
    .get()
    .exportBatches.filter((b) => b.tenantId === MOCK_TENANT_ID);
}

// ===== Inbound e-maily (SPEC §11.20) =====

export async function simulateInboundEmail(
  input: SimulateInboundEmailInput,
): Promise<SimulateInboundEmailResult> {
  assertCapability(
    storeApi.get().role,
    'inbound.simulate',
    'Prijatý e-mail môže simulovať iba admin',
  );
  return runSimulation(input, { getState: storeApi.get, setState: storeApi.set });
}

export async function listInboundEmails(orgId?: string): Promise<InboundEmail[]> {
  assertCapability(storeApi.get().role, 'tenant.read');
  if (REST_DATA_MODE) {
    const query = orgId ? `?organizationId=${encodeURIComponent(orgId)}` : '';
    return restRequest<InboundEmail[]>(`/api/inbound-emails${query}`);
  }
  const all = storeApi
    .get()
    .inboundEmails.filter((e) => e.tenantId === MOCK_TENANT_ID);
  return orgId ? all.filter((e) => e.organizationId === orgId) : all;
}

/** Admin: ručné priradenie e-mailu z karantény organizácii — audit v histórii (SPEC §11.7). */
export async function assignInboundEmailToOrg(emailId: string, orgId: string): Promise<void> {
  const s = storeApi.get();
  assertCapability(s.role, 'inbound.assign', 'Priradiť e-mail môže iba admin');
  if (REST_DATA_MODE) {
    await restRequest(`/api/inbound-emails/${encodeURIComponent(emailId)}/assign-organization`, {
      method: 'POST',
      body: JSON.stringify({ organizationId: orgId }),
    });
    await refreshRestSnapshot();
    return;
  }
  const email = s.inboundEmails.find(
    (e) => e.id === emailId && e.tenantId === MOCK_TENANT_ID,
  );
  const org = s.organizations.find(
    (o) => o.id === orgId && o.tenantId === MOCK_TENANT_ID,
  );
  if (!email || !org) throw new Error('E-mail alebo organizácia neexistuje');
  storeApi.set({
    inboundEmails: s.inboundEmails.map((e) =>
      e.id === emailId && e.tenantId === MOCK_TENANT_ID
        ? {
            ...e,
            organizationId: orgId,
            status: 'queued',
            quarantineReason: undefined,
            processingErrorMessage: `Ručne priradené organizácii ${org.nazov} (${currentUserName()})`,
          }
        : e,
    ),
  });
}

// ===== Reset demo dát (SPEC §10 bod 6) =====

export async function resetDemoData(): Promise<void> {
  const role = storeApi.get().role;
  assertCapability(role, 'demo.reset', 'Demo dáta môže obnoviť iba admin');
  await clearLocalDocumentFiles();
  storeApi.set({ ...buildSeedState(), role });
}

// ===== Query boundary pre React komponenty =====

/**
 * Asynchrónny snapshot dát dostupných aktuálnemu mock tenantovi. React nikdy
 * neimportuje Zustand ani localStorage; REST adaptér vo Fáze 2 nahradí iba
 * túto query/subscription hranicu a telá servisných funkcií.
 */
export async function getDataSnapshot(): Promise<AppDataState> {
  if (REST_DATA_MODE) {
    const response = await fetch('/api/data/snapshot', { credentials: 'include' });
    if (!response.ok) throw new Error('Backend dáta nie sú dostupné');
    const snapshot = await response.json() as AppDataState;
    const previousOrgId = storeApi.get().currentOrgId;
    snapshot.currentOrgId = previousOrgId === 'all' || snapshot.organizations.some((organization) => organization.id === previousOrgId)
      ? previousOrgId
      : 'all';
    storeApi.set(snapshot);
    return structuredClone(snapshot);
  }
  assertCapability(storeApi.get().role, 'tenant.read');
  expireGraceAliases();
  const s = storeApi.get();
  const belongsToTenant = (item: { tenantId?: string }) =>
    item.tenantId === MOCK_TENANT_ID;
  return {
    ...s,
    currentOrgId:
      s.currentOrgId === 'all' ||
      s.organizations.some(
        (organization) =>
          organization.id === s.currentOrgId && organization.tenantId === MOCK_TENANT_ID,
      )
        ? s.currentOrgId
        : 'all',
    organizations: s.organizations.filter(belongsToTenant),
    queues: s.queues.filter(belongsToTenant),
    bankAccounts: s.bankAccounts.filter(belongsToTenant),
    aliases: s.aliases.filter(belongsToTenant),
    documents: s.documents.filter(belongsToTenant),
    inboundEmails: s.inboundEmails.filter(belongsToTenant),
    inboundAttachments: s.inboundAttachments.filter(belongsToTenant),
    extractionRuns: s.extractionRuns.filter(belongsToTenant),
    suggestions: s.suggestions.filter(belongsToTenant),
    codeLists: {
      predkontacie: s.codeLists.predkontacie.filter(belongsToTenant),
      cleneniaDph: s.codeLists.cleneniaDph.filter(belongsToTenant),
      ciselneRady: s.codeLists.ciselneRady.filter(belongsToTenant),
      strediska: s.codeLists.strediska.filter(belongsToTenant),
    },
    users: s.users.filter(belongsToTenant),
    exportBatches: s.exportBatches.filter(belongsToTenant),
    payments: (s.payments ?? []).filter(belongsToTenant),
    approvalRules: (s.approvalRules ?? []).filter(belongsToTenant),
    dphProfiles: (s.dphProfiles ?? []).filter(belongsToTenant),
  };
}

/** Uloženie pravidla schvaľovania podľa sumy (iba admin, jedno na organizáciu). */
export async function saveApprovalRule(
  organizationId: string,
  input: { minAmount: number; requiredRole: 'admin' | 'schvalovatel'; active: boolean },
): Promise<void> {
  if (!REST_DATA_MODE) throw new Error('Pravidlá schvaľovania vyžadujú spustený backend');
  await restRequest(`/api/organizations/${organizationId}/approval-rule`, {
    method: 'PUT',
    body: JSON.stringify(input),
  });
  await refreshRestSnapshot();
}

/** Uloženie DPH profilu klienta (iba admin, jeden profil na organizáciu). */
export async function saveDphProfile(
  organizationId: string,
  input: Omit<DphProfil, 'organizationId' | 'tenantId' | 'updatedAt'>,
): Promise<void> {
  if (!REST_DATA_MODE) throw new Error('DPH profil klienta vyžaduje spustený backend');
  await restRequest(`/api/organizations/${encodeURIComponent(organizationId)}/dph-profile`, {
    method: 'PUT',
    body: JSON.stringify(input),
  });
  await refreshRestSnapshot();
}

/** Posúdenie dokladu DPH poradcom podľa profilu klienta (počíta server). */
export async function getDphAdvice(documentId: string): Promise<DphPosudok> {
  if (!REST_DATA_MODE) return { navrhy: [], varovania: [], blokacie: [] };
  return await restRequest<DphPosudok>(`/api/documents/${encodeURIComponent(documentId)}/dph-advisor`)
    ?? { navrhy: [], varovania: [], blokacie: [] };
}

/** Úhrada dokladu (bez sumy = celý zvyšok). Reálna funkcia backendu; mock režim ju nemá. */
export async function addDocumentPayment(
  documentId: string,
  input: { amount?: number; paidOn?: string; note?: string } = {},
): Promise<void> {
  if (!REST_DATA_MODE) throw new Error('Úhrady vyžadujú spustený backend');
  await restRequest(`/api/documents/${documentId}/payments`, {
    method: 'POST',
    body: JSON.stringify(input),
  });
  await refreshRestSnapshot();
}

/** Obnovenie zamietnutého dokladu z koša (späť na kontrolu / do stavu chyba). */
export async function restoreDocument(documentId: string): Promise<void> {
  if (!REST_DATA_MODE) throw new Error('Obnovenie z koša vyžaduje spustený backend');
  await restRequest(`/api/documents/${documentId}/restore`, { method: 'POST' });
  await refreshRestSnapshot();
}

export async function removeDocumentPayment(documentId: string, paymentId: string): Promise<void> {
  if (!REST_DATA_MODE) throw new Error('Úhrady vyžadujú spustený backend');
  await restRequest(`/api/documents/${documentId}/payments/${paymentId}`, { method: 'DELETE' });
  await refreshRestSnapshot();
}

export function subscribeDataChanges(listener: () => void): () => void {
  if (REST_DATA_MODE) {
    if (typeof window === 'undefined') return () => undefined;
    const interval = window.setInterval(listener, 5_000);
    return () => window.clearInterval(interval);
  }
  assertCapability(storeApi.get().role, 'tenant.read');
  return useAppStore.subscribe(listener);
}

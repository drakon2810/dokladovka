import { storeApi } from '../store';
import type {
  AgentInstallation,
  AgentPairingCode,
  AgentRelease,
  CodeListItem,
  CodeListKind,
  DocumentItem,
  ExportJob,
  ExportJobDocumentResult,
  PohodaCompanyLink,
} from '../types';
import { buildDataPack } from '../xml/pohodaDataPack';
import { newId, nowIso } from '../../lib/id';
import { MOCK_TENANT_ID } from '../config';

export const MOSTIK_DATA_MODE: 'mock' | 'rest' =
  import.meta.env.VITE_DATA_MODE === 'rest' ? 'rest' : 'mock';

export interface MostikOverview {
  enabled: boolean;
  latestRelease?: AgentRelease;
  installations: AgentInstallation[];
  links: PohodaCompanyLink[];
  exportJobs: ExportJob[];
  health?: MostikHealth;
}

export interface MostikHealth {
  installations: { id: string; hostname: string; lastSeenAt?: string; online: boolean }[];
  latestSyncs: { organizationId: string; kind: string; state: 'ok' | 'error'; itemCount: number; durationMs: number; createdAt: string }[];
  exports24h: { total: number; failed: number };
  alerts: { id: string; eventType: 'agent_offline' | 'export_failure_rate'; createdAt: string }[];
}

export interface OrganizationMostikStatus {
  enabled: boolean;
  connected: boolean;
  matched: boolean;
  available: boolean;
}

const pairingCodes = new Map<string, number>();

function requireAdmin(): void {
  if (storeApi.get().role !== 'admin') throw new Error('Na túto operáciu nemáte oprávnenie');
}

function requireExporter(): void {
  if (!['admin', 'uctovnik'].includes(storeApi.get().role)) {
    throw new Error('Na túto operáciu nemáte oprávnenie');
  }
}

async function restRequest<T>(path: string, init?: RequestInit, csrfToken?: string): Promise<T> {
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
    throw new Error(body?.message || 'Mostík API nie je dostupné');
  }
  if (response.status === 204) return undefined as T;
  return response.json() as Promise<T>;
}

function isConnected(installation: AgentInstallation, at = Date.now()): boolean {
  return installation.status === 'connected' && Boolean(
    installation.lastSeenAt && at - Date.parse(installation.lastSeenAt) < 5 * 60 * 1000,
  );
}

function normalizeInstallation(value: Record<string, unknown>): AgentInstallation {
  return {
    id: String(value.id),
    tenantId: String(value.tenantId ?? ''),
    name: String(value.name ?? value.hostname ?? ''),
    hostname: String(value.hostname ?? ''),
    createdAt: new Date(String(value.createdAt)).toISOString(),
    lastSeenAt: value.lastSeenAt ? new Date(String(value.lastSeenAt)).toISOString() : undefined,
    agentVersion: String(value.agentVersion ?? ''),
    status: value.status === 'revoked' ? 'revoked' : 'connected',
  };
}

function normalizeLink(value: Record<string, unknown>): PohodaCompanyLink {
  return {
    tenantId: String(value.tenantId ?? ''),
    organizationId: String(value.organizationId),
    ico: String(value.ico),
    dbName: value.dbName ? String(value.dbName) : undefined,
    uctovnyRok: value.uctovnyRok ? String(value.uctovnyRok) : undefined,
    preferredYear: value.preferredYear ? String(value.preferredYear) : 'latest',
    matchedAt: value.matchedAt ? new Date(String(value.matchedAt)).toISOString() : undefined,
    matchRule: value.matchRule === 'manual' ? 'manual' : value.matchRule === 'auto_ico' ? 'auto_ico' : undefined,
  };
}

export async function getMostikOverview(): Promise<MostikOverview> {
  if (MOSTIK_DATA_MODE === 'rest') {
    const [settings, installations, links, exportJobs, release, health] = await Promise.all([
      restRequest<{ enabled: boolean }>('/api/mostik/settings'),
      restRequest<Record<string, unknown>[]>('/api/mostik/installations'),
      restRequest<Record<string, unknown>[]>('/api/mostik/organization-links'),
      restRequest<ExportJob[]>('/api/mostik/export-jobs'),
      restRequest<AgentRelease>('/api/agent/latest').catch(() => undefined),
      restRequest<MostikHealth>('/api/mostik/health'),
    ]);
    return {
      enabled: settings.enabled,
      latestRelease: release,
      installations: installations.map(normalizeInstallation),
      links: links.map(normalizeLink),
      exportJobs,
      health,
    };
  }
  const state = storeApi.get();
  return {
    enabled: state.mostikEnabled,
    installations: state.agentInstallations.map((item) => ({ ...item })),
    links: state.pohodaCompanyLinks.map((item) => ({ ...item })),
    exportJobs: state.exportJobs.map((item) => structuredClone(item)),
    health: {
      installations: state.agentInstallations.map((item) => ({ id: item.id, hostname: item.hostname, lastSeenAt: item.lastSeenAt, online: isConnected(item) })),
      latestSyncs: [],
      exports24h: {
        total: state.exportJobs.filter((item) => Date.now() - Date.parse(item.createdAt) < 24 * 60 * 60 * 1000).length,
        failed: state.exportJobs.filter((item) => item.status === 'failed' && Date.now() - Date.parse(item.createdAt) < 24 * 60 * 60 * 1000).length,
      },
      alerts: [],
    },
  };
}

export async function getOrganizationMostikStatus(organizationId: string): Promise<OrganizationMostikStatus> {
  const overview = await getMostikOverview();
  const connected = overview.installations.some((installation) => isConnected(installation));
  const matched = overview.links.some((link) => link.organizationId === organizationId && Boolean(link.matchedAt));
  return { enabled: overview.enabled, connected, matched, available: overview.enabled && connected && matched };
}

export async function setMostikEnabled(enabled: boolean, csrfToken?: string): Promise<void> {
  if (MOSTIK_DATA_MODE === 'rest') {
    await restRequest('/api/mostik/settings', { method: 'PUT', body: JSON.stringify({ enabled }) }, csrfToken);
    return;
  }
  requireAdmin();
  storeApi.set({ mostikEnabled: enabled });
}

export async function generateMostikPairingCode(csrfToken?: string): Promise<AgentPairingCode> {
  if (MOSTIK_DATA_MODE === 'rest') {
    return restRequest('/api/mostik/pairing-codes', { method: 'POST' }, csrfToken);
  }
  requireAdmin();
  if (!storeApi.get().mostikEnabled) throw new Error('Mostík nie je povolený');
  const alphabet = '23456789ABCDEFGHJKLMNPQRSTUVWXYZ';
  const bytes = crypto.getRandomValues(new Uint8Array(8));
  const raw = Array.from(bytes, (value) => alphabet[value % alphabet.length]).join('');
  const code = `${raw.slice(0, 4)}-${raw.slice(4)}`;
  const expiresAt = Date.now() + 15 * 60 * 1000;
  pairingCodes.set(code, expiresAt);
  return { code, expiresAt: new Date(expiresAt).toISOString() };
}

export async function disconnectMostikInstallation(id: string, csrfToken?: string): Promise<void> {
  if (MOSTIK_DATA_MODE === 'rest') {
    await restRequest(`/api/mostik/installations/${encodeURIComponent(id)}`, { method: 'DELETE' }, csrfToken);
    return;
  }
  requireAdmin();
  const state = storeApi.get();
  storeApi.set({
    agentInstallations: state.agentInstallations.map((item) =>
      item.id === id ? { ...item, status: 'revoked' as const } : item,
    ),
  });
}

export async function updateMostikOrganizationLink(
  organizationId: string,
  input: { dbName: string; uctovnyRok: string; preferredYear: string },
  csrfToken?: string,
): Promise<void> {
  if (MOSTIK_DATA_MODE === 'rest') {
    await restRequest(`/api/mostik/organization-links/${encodeURIComponent(organizationId)}`, {
      method: 'PATCH',
      body: JSON.stringify(input),
    }, csrfToken);
    return;
  }
  requireAdmin();
  const state = storeApi.get();
  storeApi.set({
    pohodaCompanyLinks: state.pohodaCompanyLinks.map((link) =>
      link.organizationId === organizationId
        ? { ...link, ...input, preferredYear: input.preferredYear, matchedAt: nowIso(), matchRule: 'manual' as const }
        : link,
    ),
  });
}

function currentUserName(): string {
  const state = storeApi.get();
  return state.users.find((user) => user.tenantId === MOCK_TENANT_ID && user.rola === state.role)?.meno ?? 'Používateľ';
}

async function sha256Hex(value: string): Promise<string> {
  const bytes = new TextEncoder().encode(value);
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

function approvedDocument(document: DocumentItem): DocumentItem {
  if (!document.approvedSnapshot || document.approvedVersion !== document.approvedSnapshot.version) {
    throw new Error('Doklad nemá aktuálnu schválenú verziu');
  }
  return {
    ...document,
    typ: document.approvedSnapshot.typ,
    extracted: structuredClone(document.approvedSnapshot.extracted),
    ucto: structuredClone(document.approvedSnapshot.ucto),
  };
}

export async function createMostikExportJob(
  organizationId: string,
  documentIds: string[],
  csrfToken?: string,
): Promise<ExportJob> {
  if (MOSTIK_DATA_MODE === 'rest') {
    return restRequest('/api/mostik/export-jobs', {
      method: 'POST',
      body: JSON.stringify({ organizationId, documentIds, idempotencyKey: crypto.randomUUID() }),
    }, csrfToken);
  }
  requireExporter();
  const state = storeApi.get();
  const connected = state.agentInstallations.some((installation) => isConnected(installation));
  const matched = state.pohodaCompanyLinks.some((link) => link.organizationId === organizationId && link.matchedAt);
  if (!state.mostikEnabled || !connected || !matched) throw new Error('Mostík nie je pripojený k organizácii');
  const uniqueIds = [...new Set(documentIds)];
  const documents = state.documents.filter((document) => uniqueIds.includes(document.id));
  if (documents.length !== uniqueIds.length || documents.some((document) => document.orgId !== organizationId || document.status !== 'schvaleny')) {
    throw new Error('Odoslať možno iba schválené doklady jednej organizácie');
  }
  const organization = state.organizations.find((item) => item.id === organizationId && item.tenantId === MOCK_TENANT_ID);
  if (!organization) throw new Error('Organizácia neexistuje');
  const id = newId('mostik');
  const xml = buildDataPack(organization, documents.map(approvedDocument), state.codeLists, id);
  const job: ExportJob = {
    id,
    tenantId: MOCK_TENANT_ID,
    organizationId,
    documentIds: uniqueIds,
    status: 'pending',
    idempotencyKey: crypto.randomUUID(),
    requestXmlHash: await sha256Hex(xml),
    attempt: 1,
    createdAt: nowIso(),
    createdBy: currentUserName(),
  };
  storeApi.set({ exportJobs: [job, ...state.exportJobs] });
  return structuredClone(job);
}

export async function retryMostikExportJob(id: string, csrfToken?: string): Promise<ExportJob> {
  if (MOSTIK_DATA_MODE === 'rest') {
    return restRequest(`/api/mostik/export-jobs/${encodeURIComponent(id)}/retry`, { method: 'POST' }, csrfToken);
  }
  requireExporter();
  const state = storeApi.get();
  const existing = state.exportJobs.find((job) => job.id === id && job.status === 'failed');
  if (!existing) throw new Error('Prenos nie je možné zopakovať');
  const next: ExportJob = {
    ...structuredClone(existing),
    id: newId('mostik'),
    status: 'pending',
    idempotencyKey: crypto.randomUUID(),
    responseMeta: undefined,
    attempt: existing.attempt + 1,
    createdAt: nowIso(),
    createdBy: currentUserName(),
    sentAt: undefined,
    completedAt: undefined,
    retryOfJobId: existing.id,
  };
  storeApi.set({ exportJobs: [next, ...state.exportJobs] });
  return structuredClone(next);
}

export async function simulateMostikAgentConnection(code: string): Promise<AgentInstallation> {
  if (MOSTIK_DATA_MODE !== 'mock') throw new Error('Simulátor je dostupný iba v demo režime');
  requireAdmin();
  const expiresAt = pairingCodes.get(code);
  if (!expiresAt || expiresAt <= Date.now()) throw new Error('Párovací kód je neplatný alebo vypršal');
  pairingCodes.delete(code);
  const state = storeApi.get();
  const heartbeatAt = nowIso();
  const installation: AgentInstallation = {
    id: newId('agent'),
    tenantId: MOCK_TENANT_ID,
    name: 'Dokladovka Agent',
    hostname: 'POHODA-DEMO',
    createdAt: heartbeatAt,
    lastSeenAt: heartbeatAt,
    agentVersion: '0.1.0-demo',
    status: 'connected',
  };
  storeApi.set({
    agentInstallations: [installation, ...state.agentInstallations],
    pohodaCompanyLinks: state.pohodaCompanyLinks.map((link) => ({
      ...link,
      dbName: `StwPh_${link.ico}_2026`,
      uctovnyRok: '2026',
      matchedAt: heartbeatAt,
      matchRule: 'auto_ico' as const,
    })),
  });
  return installation;
}

const SYNC_ITEMS: Record<CodeListKind, Array<Pick<CodeListItem, 'kod' | 'nazov'>>> = {
  predkontacie: [
    { kod: '518/321', nazov: 'Služby' },
    { kod: '501/321', nazov: 'Spotreba materiálu' },
  ],
  cleneniaDph: [
    { kod: 'PD', nazov: 'Tuzemské plnenie, odpočet 100 %' },
    { kod: 'BEZ', nazov: 'Bez vplyvu na DPH' },
  ],
  ciselneRady: [{ kod: '26FP', nazov: 'Prijaté faktúry 2026' }],
  strediska: [{ kod: 'HLAVNE', nazov: 'Hlavné stredisko' }],
};

export async function simulateMostikCodeListSync(organizationId?: string): Promise<void> {
  if (MOSTIK_DATA_MODE !== 'mock') throw new Error('Simulátor je dostupný iba v demo režime');
  requireAdmin();
  const state = storeApi.get();
  if (!state.agentInstallations.some((installation) => isConnected(installation))) throw new Error('Agent nie je pripojený');
  const organizationIds = organizationId ? [organizationId] : state.organizations.filter((item) => !item.archived).map((item) => item.id);
  const syncedAt = nowIso();
  const nextCodeLists = structuredClone(state.codeLists);
  for (const orgId of organizationIds) {
    for (const kind of Object.keys(SYNC_ITEMS) as CodeListKind[]) {
      const incoming = new Map(SYNC_ITEMS[kind].map((item) => [item.kod, item]));
      nextCodeLists[kind] = nextCodeLists[kind].map((item) =>
        item.orgId === orgId && incoming.has(item.kod)
          ? { ...item, ...incoming.get(item.kod)!, source: 'pohoda' as const, active: true, syncedAt }
          : item.orgId === orgId && item.source === 'pohoda' && !incoming.has(item.kod)
            ? { ...item, active: false }
            : item,
      );
      for (const incomingItem of incoming.values()) {
        if (!nextCodeLists[kind].some((item) => item.orgId === orgId && item.kod === incomingItem.kod)) {
          nextCodeLists[kind].push({
            id: newId(`pohoda-${kind}`),
            tenantId: MOCK_TENANT_ID,
            orgId,
            ...incomingItem,
            source: 'pohoda',
            active: true,
            syncedAt,
          });
        }
      }
    }
  }
  storeApi.set({ codeLists: nextCodeLists });
}

export async function simulateMostikAgentResult(
  jobId: string,
  outcome: 'ok' | 'error' | 'mixed',
): Promise<ExportJob> {
  if (MOSTIK_DATA_MODE !== 'mock') throw new Error('Simulátor je dostupný iba v demo režime');
  requireAdmin();
  const state = storeApi.get();
  const job = state.exportJobs.find((item) => item.id === jobId);
  if (!job) throw new Error('Prenos neexistuje');
  if (job.status === 'confirmed' || job.status === 'failed') return structuredClone(job);
  const completedAt = nowIso();
  const results: ExportJobDocumentResult[] = job.documentIds.map((documentId, index) => {
    const document = state.documents.find((item) => item.id === documentId);
    const resultState = outcome === 'ok' ? 'ok' : outcome === 'error' ? 'error' : index === 0 ? 'ok' : 'error';
    return resultState === 'ok'
      ? { documentId, state: 'ok', pohodaNumber: `FP${documentId.replace(/\D/g, '').slice(-6).padStart(6, '0')}` }
      : { documentId, state: 'error', message: `POHODA odmietla doklad ${document?.extracted.cisloFaktury ?? documentId}` };
  });
  const ok = results.filter((item) => item.state === 'ok').length;
  const error = results.filter((item) => item.state === 'error').length;
  const updated: ExportJob = {
    ...job,
    status: error === 0 ? 'confirmed' : 'failed',
    sentAt: job.sentAt ?? completedAt,
    completedAt,
    responseMeta: { perDocument: results, summary: { ok, warning: 0, error } },
  };
  storeApi.set({
    exportJobs: state.exportJobs.map((item) => item.id === job.id ? updated : item),
    documents: state.documents.map((document) => {
      const result = results.find((item) => item.documentId === document.id);
      if (!result) return document;
      return result.state === 'ok'
        ? {
            ...document,
            status: 'exportovany' as const,
            exportId: job.id,
            history: [...document.history, { ts: completedAt, user: 'POHODA', akcia: `Prenos potvrdený${result.pohodaNumber ? ` č. ${result.pohodaNumber}` : ''}` }],
          }
        : result.state === 'error'
          ? {
              ...document,
              status: 'chyba' as const,
              history: [...document.history, { ts: completedAt, user: 'POHODA', akcia: `Chyba prenosu: ${result.message}` }],
            }
          : document;
    }),
  });
  return structuredClone(updated);
}

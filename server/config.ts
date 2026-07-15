import { resolve } from 'node:path';

export interface ServerConfig {
  nodeEnv: 'development' | 'test' | 'production';
  port: number;
  appBaseUrl: string;
  databaseUrl?: string;
  pgliteDataDir: string;
  mailReceivingDomain: string;
  webhookSecret?: string;
  sessionCookieSecure: boolean;
  sessionTtlHours: number;
  extractionProvider: 'mock' | 'openai';
  workerPollIntervalMs: number;
  objectStorage: {
    mode: 'memory' | 'filesystem' | 's3';
    endpoint?: string;
    region: string;
    bucket: string;
    accessKey?: string;
    secretKey?: string;
    forcePathStyle: boolean;
    filesystemRoot: string;
  };
  agentInstallerPublicBaseUrl: string;
  agentOfflineAlertHours: number;
  exportFailureAlertPercent: number;
  monitorIntervalMs: number;
}

function positiveInteger(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function validDomain(value: string | undefined): string {
  const normalized = value?.trim().toLowerCase();
  if (!normalized || !/^[a-z0-9.-]+\.[a-z]{2,}$/.test(normalized)) {
    throw new Error('MAIL_RECEIVING_DOMAIN musí obsahovať platnú doménu');
  }
  return normalized;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): ServerConfig {
  const nodeEnv = env.NODE_ENV === 'production' ? 'production' : env.NODE_ENV === 'test' ? 'test' : 'development';
  const defaultPgliteDataDir = env.LOCALAPPDATA
    ? resolve(env.LOCALAPPDATA, 'Dokladovka', 'pglite')
    : resolve('.local/pglite');
  const storageMode = env.OBJECT_STORAGE_MODE === 's3'
    ? 's3'
    : env.OBJECT_STORAGE_MODE === 'memory'
      ? 'memory'
      : 'filesystem';

  if (nodeEnv === 'production' && !env.DATABASE_URL) {
    throw new Error('DATABASE_URL je v produkcii povinné');
  }
  if (nodeEnv === 'production' && storageMode !== 's3') {
    throw new Error('OBJECT_STORAGE_MODE=s3 je v produkcii povinné');
  }

  return {
    nodeEnv,
    port: positiveInteger(env.PORT, 3001),
    appBaseUrl: env.APP_BASE_URL?.trim() || 'http://localhost:5173',
    databaseUrl: env.DATABASE_URL?.trim() || undefined,
    pgliteDataDir: resolve(env.PGLITE_DATA_DIR?.trim() || defaultPgliteDataDir),
    mailReceivingDomain: validDomain(env.MAIL_RECEIVING_DOMAIN || 'doklady.localhost.test'),
    webhookSecret: env.INBOUND_WEBHOOK_SECRET?.trim() || undefined,
    sessionCookieSecure: env.SESSION_COOKIE_SECURE === 'true' || nodeEnv === 'production',
    sessionTtlHours: positiveInteger(env.SESSION_TTL_HOURS, 8),
    extractionProvider: env.DOCUMENT_EXTRACTION_PROVIDER === 'openai' ? 'openai' : 'mock',
    workerPollIntervalMs: positiveInteger(env.WORKER_POLL_INTERVAL_MS, 1500),
    objectStorage: {
      mode: storageMode,
      endpoint: env.OBJECT_STORAGE_ENDPOINT?.trim() || undefined,
      region: env.OBJECT_STORAGE_REGION?.trim() || 'eu-central-1',
      bucket: env.OBJECT_STORAGE_BUCKET?.trim() || 'dokladovka-private',
      accessKey: env.OBJECT_STORAGE_ACCESS_KEY?.trim() || undefined,
      secretKey: env.OBJECT_STORAGE_SECRET_KEY?.trim() || undefined,
      forcePathStyle: env.OBJECT_STORAGE_FORCE_PATH_STYLE !== 'false',
      filesystemRoot: resolve(env.OBJECT_STORAGE_FILESYSTEM_ROOT?.trim() || '.local/objects'),
    },
    agentInstallerPublicBaseUrl:
      env.AGENT_INSTALLER_PUBLIC_BASE_URL?.replace(/\/$/, '') || 'http://localhost:3001/downloads',
    agentOfflineAlertHours: positiveInteger(env.AGENT_OFFLINE_ALERT_HOURS, 2),
    exportFailureAlertPercent: Math.min(100, positiveInteger(env.EXPORT_FAILURE_ALERT_PERCENT, 20)),
    monitorIntervalMs: positiveInteger(env.MONITOR_INTERVAL_MS, 60_000),
  };
}

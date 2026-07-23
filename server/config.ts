import { resolve } from 'node:path';

export interface ServerConfig {
  nodeEnv: 'development' | 'test' | 'production';
  port: number;
  appBaseUrl: string;
  apiBaseUrl: string;
  databaseUrl?: string;
  pgliteDataDir: string;
  mailReceivingDomain: string;
  webhookSecret?: string;
  sessionCookieSecure: boolean;
  sessionTtlHours: number;
  extractionProvider: 'mock' | 'openai';
  imap: {
    host?: string;
    port: number;
    user?: string;
    password?: string;
    pollIntervalSeconds: number;
    mailbox: string;
  };
  openai: {
    apiKey?: string;
    // Rozdelené role modelov: extrakcia (lacný, každý doklad), fallback
    // zaúčtovania (len neznáme prípady) a analýza pravidiel (zriedka, silný).
    model: string;
    accountingModel: string;
    ruleAnalysisModel: string;
    storeResponses: boolean;
    timeoutMs: number;
    maxRetries: number;
  };
  extractionMaxFileBytes: number;
  extractionMaxPdfPages: number;
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
  agentInstallerDirectory: string;
  allowSelfSignedAgentReleases: boolean;
  agentReleasePublishToken?: string;
  agentOfflineAlertHours: number;
  exportFailureAlertPercent: number;
  monitorIntervalMs: number;
}

function positiveInteger(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function nonNegativeInteger(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed >= 0 ? parsed : fallback;
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
  if (nodeEnv === 'production' && storageMode === 'memory') {
    // memory = neperzistentné (po reštarte sa dáta stratia). filesystem (na
    // perzistentnom volume) aj s3 sú v produkcii v poriadku.
    throw new Error('OBJECT_STORAGE_MODE nesmie byť "memory" v produkcii');
  }

  const extractionProvider = env.DOCUMENT_EXTRACTION_PROVIDER === 'openai' ? 'openai' : 'mock';
  const openaiApiKey = env.OPENAI_API_KEY?.trim() || undefined;

  return {
    nodeEnv,
    port: positiveInteger(env.PORT, 3001),
    appBaseUrl: env.APP_BASE_URL?.trim() || 'http://localhost:5173',
    // 127.0.0.1 namiesto localhost: node fetch skúša najprv IPv6 ::1,
    // ale Fastify počúva na IPv4 — na Windows by spojenie zlyhalo.
    apiBaseUrl:
      env.API_BASE_URL?.trim().replace(/\/$/, '') || `http://127.0.0.1:${positiveInteger(env.PORT, 3001)}`,
    databaseUrl: env.DATABASE_URL?.trim() || undefined,
    pgliteDataDir: resolve(env.PGLITE_DATA_DIR?.trim() || defaultPgliteDataDir),
    mailReceivingDomain: validDomain(env.MAIL_RECEIVING_DOMAIN || 'doklady.localhost.test'),
    webhookSecret: env.INBOUND_WEBHOOK_SECRET?.trim() || undefined,
    sessionCookieSecure: env.SESSION_COOKIE_SECURE === 'true' || nodeEnv === 'production',
    sessionTtlHours: positiveInteger(env.SESSION_TTL_HOURS, 8),
    extractionProvider,
    imap: {
      host: env.IMAP_HOST?.trim() || undefined,
      port: positiveInteger(env.IMAP_PORT, 993),
      user: env.IMAP_USER?.trim() || undefined,
      // App password: Google ho zobrazuje s medzerami — odstránime ich.
      password: env.IMAP_PASSWORD?.replace(/\s+/g, '') || undefined,
      pollIntervalSeconds: positiveInteger(env.IMAP_POLL_INTERVAL, 30),
      mailbox: env.IMAP_MAILBOX?.trim() || 'INBOX',
    },
    // Fallback aj analýza defaultne bežia na overenom extrakčnom modeli
    // (gpt-5-mini) — silnejšie modely sú OPT-IN cez env, až keď účet potvrdí
    // prístup k nim (inak volanie na neznámy model spadne na timeout).
    openai: (() => {
      const extractionModel = env.OPENAI_MODEL?.trim() || 'gpt-5-mini';
      return {
        apiKey: openaiApiKey,
        model: extractionModel,
        accountingModel: env.OPENAI_ACCOUNTING_FALLBACK_MODEL?.trim() || extractionModel,
        ruleAnalysisModel: env.OPENAI_RULE_ANALYSIS_MODEL?.trim() || extractionModel,
        storeResponses: env.OPENAI_STORE_RESPONSES === 'true',
        timeoutMs: positiveInteger(env.OPENAI_API_TIMEOUT_MS || env.OPENAI_TIMEOUT_MS, 120_000),
        // Počet pokusov spracovania = maxRetries + 1. Prechodné chyby (429/5xx/
        // timeout) pri dávke dokladov potrebujú viac pokusov v dlhšom okne, inak
        // sa z dočasného výpadku stane trvalá chyba. Riadi len durable job retry;
        // samotné OpenAI SDK beží s maxRetries: 0.
        maxRetries: nonNegativeInteger(env.OPENAI_MAX_RETRIES, 5),
      };
    })(),
    extractionMaxFileBytes: positiveInteger(env.EXTRACTION_MAX_FILE_BYTES, 20 * 1024 * 1024),
    extractionMaxPdfPages: positiveInteger(env.EXTRACTION_MAX_PDF_PAGES, 50),
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
    agentInstallerDirectory: resolve(env.AGENT_INSTALLER_DIRECTORY?.trim() || 'agent/artifacts'),
    allowSelfSignedAgentReleases: env.AGENT_ALLOW_SELF_SIGNED_RELEASES === 'true' || nodeEnv !== 'production',
    agentReleasePublishToken: env.AGENT_RELEASE_PUBLISH_TOKEN?.trim() || undefined,
    agentOfflineAlertHours: positiveInteger(env.AGENT_OFFLINE_ALERT_HOURS, 2),
    exportFailureAlertPercent: Math.min(100, positiveInteger(env.EXPORT_FAILURE_ALERT_PERCENT, 20)),
    monitorIntervalMs: positiveInteger(env.MONITOR_INTERVAL_MS, 60_000),
  };
}

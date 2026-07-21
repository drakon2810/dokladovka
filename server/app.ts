import cookie from '@fastify/cookie';
import rateLimit from '@fastify/rate-limit';
import Fastify, { type FastifyInstance } from 'fastify';
import { ZodError } from 'zod';
import type { ServerConfig } from './config.js';
import type { Database } from './db/database.js';
import { HttpError } from './http.js';
import { registerAuthRoutes } from './routes/authRoutes.js';
import { registerDocumentRoutes } from './routes/documentRoutes.js';
import { registerInboundRoutes } from './routes/inboundRoutes.js';
import { registerOrganizationRoutes } from './routes/organizationRoutes.js';
import { registerAgentRoutes } from './routes/agentRoutes.js';
import { registerDataSnapshotRoutes } from './routes/dataSnapshotRoutes.js';
import { registerCodeListRoutes } from './routes/codeListRoutes.js';
import { registerOrgDocumentRoutes } from './routes/orgDocumentRoutes.js';
import { registerPaymentRoutes } from './routes/paymentRoutes.js';
import { registerPartnerRoutes } from './routes/partnerRoutes.js';
import type { ObjectStorage } from './storage.js';

export async function buildApp(input: {
  database: Database;
  storage: ObjectStorage;
  config: ServerConfig;
  logger?: boolean;
}): Promise<FastifyInstance> {
  const app = Fastify({
    logger: input.logger ?? input.config.nodeEnv !== 'test',
    requestIdHeader: 'x-correlation-id',
    genReqId: (request) => {
      const header = request.headers['x-correlation-id'];
      return typeof header === 'string' && /^[a-zA-Z0-9._:-]{1,100}$/.test(header)
        ? header
        : crypto.randomUUID();
    },
    trustProxy: input.config.nodeEnv === 'production',
  });
  await app.register(cookie);
  await app.register(rateLimit, { global: false, max: 300, timeWindow: '1 minute' });

  app.addHook('onSend', async (request, reply) => {
    reply.header('X-Content-Type-Options', 'nosniff');
    reply.header('Referrer-Policy', 'same-origin');
    if (request.url.startsWith('/api/agent/latest')) {
      if (!reply.hasHeader('Cache-Control')) reply.header('Cache-Control', 'public, max-age=60');
    } else if (request.url.startsWith('/downloads/')) {
      if (!reply.hasHeader('Cache-Control')) reply.header('Cache-Control', 'public, max-age=31536000, immutable');
    } else {
      reply.header('Cache-Control', 'no-store');
    }
    reply.header('Content-Security-Policy', "default-src 'none'; frame-ancestors 'none'");
  });

  app.get('/api/health', async () => {
    const started = performance.now();
    await input.database.query('SELECT 1');
    return {
      status: 'ok',
      database: 'ok',
      databaseKind: input.database.kind,
      version: process.env.npm_package_version ?? '0.1.0',
      timestamp: new Date().toISOString(),
      latencyMs: Math.round(performance.now() - started),
    };
  });

  app.get('/api/config/public', async () => ({
    mailReceivingDomain: input.config.mailReceivingDomain,
    inboundEmailProvider: process.env.INBOUND_EMAIL_PROVIDER ?? 'mock',
  }));

  registerAuthRoutes(app, input.database, input.config);
  registerOrganizationRoutes(app, input.database, input.config);
  registerInboundRoutes(app, input.database, input.storage, input.config);
  registerDocumentRoutes(app, input.database, input.storage, input.config);
  registerAgentRoutes(app, input.database, input.config);
  registerDataSnapshotRoutes(app, input.database);
  registerCodeListRoutes(app, input.database);
  registerOrgDocumentRoutes(app, input.database, input.storage, input.config);
  registerPaymentRoutes(app, input.database);
  registerPartnerRoutes(app, input.database);

  app.setErrorHandler((error, request, reply) => {
    if (error instanceof ZodError) {
      request.log.warn({ code: 'validation_error', url: request.url, issues: error.issues }, 'request_rejected');
      return reply.code(400).send({ code: 'validation_error', message: 'Požiadavka obsahuje neplatné údaje', details: error.issues });
    }
    if (error instanceof HttpError) {
      // Dôvod 4xx logujeme — inak sa v prevádzke nedá zistiť, ktorá kontrola
      // (napr. pri schválení) požiadavku zastavila.
      request.log.warn({ code: error.code, statusCode: error.statusCode, message: error.message, url: request.url }, 'request_rejected');
      return reply.code(error.statusCode).send(
        error.details === undefined
          ? { code: error.code, message: error.message }
          : { code: error.code, message: error.message, details: error.details },
      );
    }
    request.log.error({ err: error, correlationId: request.id }, 'request_failed');
    return reply.code(500).send({ code: 'internal_error', message: 'Nastala neočakávaná chyba', correlationId: request.id });
  });
  return app;
}

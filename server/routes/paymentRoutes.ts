// Úhrady dokladov: pridanie (aj čiastočnej) úhrady a jej odstránenie.
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { writeAudit } from '../audit.js';
import { requireBrowserAuth, requireCsrf, requireOrganizationAccess, requireRole } from '../auth.js';
import type { Database } from '../db/database.js';
import { HttpError } from '../http.js';
import { insertPayment, paidTotalFor } from '../services/paymentService.js';

const paymentSchema = z.object({
  /** Bez sumy = uhradiť celý zvyšok („Označiť ako uhradenú"). */
  amount: z.number().positive().max(100_000_000).optional(),
  paidOn: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  note: z.string().max(300).optional(),
}).strict();

interface DocumentRow extends Record<string, unknown> {
  id: string;
  organization_id: string;
  total_amount: string | number | null;
  currency: string | null;
  document_type: string;
  status: string;
}

export function registerPaymentRoutes(app: FastifyInstance, database: Database): void {
  app.post('/api/documents/:id/payments', async (request, reply) => {
    const auth = await requireBrowserAuth(request, database);
    requireCsrf(request, auth);
    requireRole(auth, ['admin', 'uctovnik']);
    const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
    const body = paymentSchema.parse(request.body ?? {});

    const documents = await database.query<DocumentRow>(
      `SELECT id, organization_id, total_amount, currency, document_type, status
         FROM documents WHERE id=$1 AND tenant_id=$2`,
      [id, auth.tenantId],
    );
    const document = documents.rows[0];
    if (!document) throw new HttpError(404, 'document_not_found', 'Doklad neexistuje');
    await requireOrganizationAccess(database, auth, document.organization_id);
    if (document.document_type === 'BV') {
      throw new HttpError(422, 'not_payable', 'Bankový výpis nie je uhrádzateľný doklad');
    }

    const total = Math.round(Number(document.total_amount ?? 0) * 100) / 100;
    const paid = await paidTotalFor(database, auth.tenantId, id);
    const remaining = Math.round((total - paid) * 100) / 100;
    if (remaining <= 0) throw new HttpError(422, 'already_paid', 'Doklad je už uhradený');
    const amount = body.amount !== undefined ? Math.round(body.amount * 100) / 100 : remaining;
    if (amount > remaining + 0.005) {
      throw new HttpError(422, 'amount_exceeds_remaining', 'Suma úhrady presahuje zvyšok k úhrade');
    }

    const paidOn = body.paidOn ?? new Date().toISOString().slice(0, 10);
    let paymentId = '';
    await database.transaction(async (tx) => {
      paymentId = await insertPayment(tx, {
        tenantId: auth.tenantId,
        organizationId: document.organization_id,
        documentId: id,
        amount,
        currency: document.currency ?? 'EUR',
        paidOn,
        source: 'manual',
        note: body.note,
        createdBy: auth.userId,
      });
      await tx.query(
        `UPDATE documents SET history=history || $1::jsonb, updated_at=now() WHERE id=$2 AND tenant_id=$3`,
        [JSON.stringify([{
          ts: new Date().toISOString(),
          user: auth.name,
          akcia: `Zaevidovaná úhrada ${amount.toFixed(2)} ${document.currency ?? 'EUR'} (${paidOn})`,
        }]), id, auth.tenantId],
      );
    });
    await writeAudit(database, {
      tenantId: auth.tenantId,
      organizationId: document.organization_id,
      actorType: 'user',
      actorId: auth.userId,
      action: 'document.payment_added',
      entityType: 'document',
      entityId: id,
      correlationId: request.id,
      metadata: { paymentId, amount, paidOn },
    });
    return reply.code(201).send({ id: paymentId, amount, paidOn, remaining: Math.round((remaining - amount) * 100) / 100 });
  });

  app.delete('/api/documents/:id/payments/:paymentId', async (request, reply) => {
    const auth = await requireBrowserAuth(request, database);
    requireCsrf(request, auth);
    requireRole(auth, ['admin', 'uctovnik']);
    const { id, paymentId } = z.object({ id: z.string().uuid(), paymentId: z.string().uuid() }).parse(request.params);
    const payments = await database.query<{ organization_id: string; amount: string | number } & Record<string, unknown>>(
      'SELECT organization_id, amount FROM document_payments WHERE id=$1 AND tenant_id=$2 AND document_id=$3',
      [paymentId, auth.tenantId, id],
    );
    const payment = payments.rows[0];
    if (!payment) throw new HttpError(404, 'payment_not_found', 'Úhrada neexistuje');
    await requireOrganizationAccess(database, auth, payment.organization_id);
    await database.transaction(async (tx) => {
      await tx.query('DELETE FROM document_payments WHERE id=$1 AND tenant_id=$2', [paymentId, auth.tenantId]);
      await tx.query(
        `UPDATE documents SET history=history || $1::jsonb, updated_at=now() WHERE id=$2 AND tenant_id=$3`,
        [JSON.stringify([{
          ts: new Date().toISOString(),
          user: auth.name,
          akcia: `Úhrada ${Number(payment.amount).toFixed(2)} bola odstránená`,
        }]), id, auth.tenantId],
      );
    });
    await writeAudit(database, {
      tenantId: auth.tenantId,
      organizationId: payment.organization_id,
      actorType: 'user',
      actorId: auth.userId,
      action: 'document.payment_removed',
      entityType: 'document',
      entityId: id,
      correlationId: request.id,
      metadata: { paymentId },
    });
    return reply.code(204).send();
  });
}

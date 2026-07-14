import { encode, PaymentOptions } from 'bysquare/pay';
import type {
  DocumentItem,
  Organization,
  OrganizationBankAccount,
  PaymentInstruction,
} from '../types';
import { validateIBAN } from '../../lib/validate';
import { isValidIsoDate } from '../validation/documentValidation';

export type PaymentValidationCode =
  | 'unsupported_document_type'
  | 'missing_beneficiary'
  | 'missing_bank_account'
  | 'invalid_iban'
  | 'invalid_amount'
  | 'invalid_variable_symbol'
  | 'invalid_constant_symbol'
  | 'invalid_specific_symbol'
  | 'invalid_due_date';

export interface PaymentInstructionResult {
  instruction?: PaymentInstruction;
  issues: PaymentValidationCode[];
}

function normalizedSymbol(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed || undefined;
}

export function buildPaymentInstruction(
  document: DocumentItem,
  organization: Organization,
  bankAccounts: OrganizationBankAccount[],
): PaymentInstructionResult {
  const issues: PaymentValidationCode[] = [];
  const payable = document.typ === 'FP' || document.typ === 'OZ';
  const receivable = document.typ === 'FV';
  if (!payable && !receivable) issues.push('unsupported_document_type');

  const organizationAccount = bankAccounts.find(
    (account) =>
      account.tenantId === document.tenantId &&
      account.organizationId === document.orgId &&
      account.active &&
      account.currency === document.extracted.mena &&
      account.isDefault,
  );
  const beneficiaryName = payable
    ? document.extracted.dodavatel.nazov.trim()
    : organization.nazov.trim();
  const iban = (payable
    ? document.extracted.dodavatel.iban
    : organizationAccount?.iban
  )?.replace(/\s/g, '').toUpperCase();
  const bic = payable ? undefined : organizationAccount?.bic;
  const amountPaid = document.payment?.amountPaid ?? 0;
  const amount = Math.round((document.extracted.sumaSpolu - amountPaid) * 100) / 100;
  const variableSymbol = normalizedSymbol(document.extracted.variabilnySymbol);
  const constantSymbol = normalizedSymbol(document.extracted.konstantnySymbol);
  const specificSymbol = normalizedSymbol(document.extracted.specifickySymbol);
  const dueDate = document.extracted.datumSplatnosti;

  if (!beneficiaryName) issues.push('missing_beneficiary');
  if (!iban) issues.push('missing_bank_account');
  else if (!validateIBAN(iban)) issues.push('invalid_iban');
  if (!Number.isFinite(amount) || amount <= 0) issues.push('invalid_amount');
  if (variableSymbol && !/^\d{1,10}$/.test(variableSymbol)) {
    issues.push('invalid_variable_symbol');
  }
  if (constantSymbol && !/^\d{1,4}$/.test(constantSymbol)) {
    issues.push('invalid_constant_symbol');
  }
  if (specificSymbol && !/^\d{1,10}$/.test(specificSymbol)) {
    issues.push('invalid_specific_symbol');
  }
  if (dueDate && !isValidIsoDate(dueDate)) issues.push('invalid_due_date');
  if (issues.length > 0 || !iban) return { issues };

  return {
    issues,
    instruction: {
      documentId: document.id,
      documentVersion: document.version,
      direction: payable ? 'payable' : 'receivable',
      beneficiaryName,
      iban,
      bic,
      amount,
      currency: document.extracted.mena,
      variableSymbol,
      constantSymbol,
      specificSymbol,
      dueDate,
      paymentNote: document.extracted.cisloFaktury
        ? `Doklad ${document.extracted.cisloFaktury}`
        : undefined,
    },
  };
}

export function encodePayBySquare(
  instruction: PaymentInstruction,
  executionDate?: string,
): string {
  const paymentDueDate = executionDate || instruction.dueDate;
  if (paymentDueDate && !isValidIsoDate(paymentDueDate)) {
    throw new Error('invalid_due_date');
  }
  return encode({
    invoiceId: instruction.documentId.slice(0, 10),
    payments: [
      {
        type: PaymentOptions.PaymentOrder,
        amount: instruction.amount,
        currencyCode: instruction.currency,
        paymentDueDate: paymentDueDate?.replaceAll('-', ''),
        variableSymbol: instruction.variableSymbol,
        constantSymbol: instruction.constantSymbol,
        specificSymbol: instruction.specificSymbol,
        paymentNote: instruction.paymentNote,
        beneficiary: { name: instruction.beneficiaryName.slice(0, 70) },
        bankAccounts: [{ iban: instruction.iban, bic: instruction.bic }],
      },
    ],
  });
}

export async function hashQrPayload(payload: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(payload));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

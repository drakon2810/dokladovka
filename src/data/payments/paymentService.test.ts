import { decode } from 'bysquare/pay';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  createBankAccount,
  getDataSnapshot,
  recordPaymentQrGenerated,
  resetDemoData,
  setRole,
  updatePaymentStatus,
} from '../api';
import {
  buildPaymentInstruction,
  encodePayBySquare,
  hashQrPayload,
} from './paymentService';

beforeEach(async () => {
  await setRole('admin');
  await resetDemoData();
  await setRole('uctovnik');
});

describe('PAY by square', () => {
  it('vytvorí príkaz pre prijatú faktúru na účet dodávateľa', async () => {
    const state = await getDataSnapshot();
    const document = state.documents.find((item) => item.id === 'doc-001')!;
    const organization = state.organizations.find((item) => item.id === document.orgId)!;
    const result = buildPaymentInstruction(document, organization, state.bankAccounts);

    expect(result.issues).toEqual([]);
    expect(result.instruction?.direction).toBe('payable');
    expect(result.instruction?.iban).toBe(document.extracted.dodavatel.iban);
    expect(result.instruction?.amount).toBe(document.extracted.sumaSpolu);
  });

  it('pre vydanú faktúru použije predvolený účet vlastnej organizácie', async () => {
    const state = await getDataSnapshot();
    const document = state.documents.find((item) => item.typ === 'FV')!;
    const organization = state.organizations.find((item) => item.id === document.orgId)!;
    const account = state.bankAccounts.find(
      (item) => item.organizationId === document.orgId && item.isDefault,
    )!;
    const result = buildPaymentInstruction(document, organization, state.bankAccounts);

    expect(result.instruction?.direction).toBe('receivable');
    expect(result.instruction?.iban).toBe(account.iban);
    expect(result.instruction?.beneficiaryName).toBe(organization.nazov);
  });

  it('zakóduje a spätne dekóduje validný PAY by square payload', async () => {
    const state = await getDataSnapshot();
    const document = state.documents.find((item) => item.id === 'doc-001')!;
    const organization = state.organizations.find((item) => item.id === document.orgId)!;
    const instruction = buildPaymentInstruction(document, organization, state.bankAccounts).instruction!;
    const payload = encodePayBySquare(instruction, '2026-07-26');
    const decoded = decode(payload);

    expect(decoded.payments[0].amount).toBe(instruction.amount);
    expect(decoded.payments[0].bankAccounts[0].iban).toBe(instruction.iban);
    expect(await hashQrPayload(payload)).toMatch(/^[a-f0-9]{64}$/);
  });

  it('odmietne nepodporovaný dokument a neplatné platobné údaje', async () => {
    const state = await getDataSnapshot();
    const unsupported = structuredClone(state.documents.find((item) => item.typ === 'BV')!);
    unsupported.extracted.sumaSpolu = 0;
    const unsupportedOrganization = state.organizations.find((item) => item.id === unsupported.orgId)!;
    const result = buildPaymentInstruction(unsupported, unsupportedOrganization, state.bankAccounts);

    const invalidAccount = structuredClone(state.documents.find((item) => item.id === 'doc-001')!);
    invalidAccount.extracted.dodavatel.iban = 'SK00INVALID';
    const organization = state.organizations.find((item) => item.id === invalidAccount.orgId)!;
    const accountResult = buildPaymentInstruction(invalidAccount, organization, state.bankAccounts);

    expect(result.instruction).toBeUndefined();
    expect(result.issues).toEqual(expect.arrayContaining(['unsupported_document_type', 'invalid_amount']));
    expect(accountResult.issues).toContain('invalid_iban');
  });
});

describe('payment workflow a bankové účty', () => {
  it('eviduje QR iba pre nezmenenú verziu a následne manuálnu úhradu', async () => {
    const generated = await recordPaymentQrGenerated('doc-001', 'a'.repeat(64), 1, '2026-07-26');
    expect(generated.payment).toMatchObject({
      status: 'payment_order',
      qrDocumentVersion: 1,
      qrPayloadHash: 'a'.repeat(64),
    });

    const paid = await updatePaymentStatus('doc-001', 'paid');
    expect(paid.payment?.status).toBe('paid');
    expect(paid.payment?.amountPaid).toBe(paid.extracted.sumaSpolu);
    expect(paid.payment?.paidAt).toBeTruthy();
  });

  it('bankový účet môže pridať iba admin a nový default nahradí starý', async () => {
    await expect(
      createBankAccount({
        organizationId: 'org-alfa',
        label: 'Nový účet',
        iban: 'SK9611000000002918599669',
        bic: 'TATRSKBX',
        currency: 'EUR',
        isDefault: true,
      }),
    ).rejects.toThrow(/admin/);

    await setRole('admin');
    const created = await createBankAccount({
      organizationId: 'org-alfa',
      label: 'Nový účet',
      iban: 'SK9611000000002918599669',
      bic: 'TATRSKBX',
      currency: 'EUR',
      isDefault: true,
    });
    const accounts = (await getDataSnapshot()).bankAccounts.filter(
      (item) => item.organizationId === 'org-alfa' && item.currency === 'EUR' && item.active,
    );

    expect(created.isDefault).toBe(true);
    expect(accounts.filter((item) => item.isDefault)).toHaveLength(1);
    expect(accounts.find((item) => item.isDefault)?.id).toBe(created.id);
  });
});

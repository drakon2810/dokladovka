import { beforeEach, describe, expect, it } from 'vitest';
import { createDocument, resetDemoData, setRole } from './api';
import { getLocalDocumentFile } from './files/localDocumentFileStore';
import { storeApi } from './store';
import { MOCK_TENANT_ID } from './config';

const BASE_INPUT = {
  organizationId: 'org-alfa',
  typ: 'FP' as const,
  mode: 'manual' as const,
  supplierName: 'Nový dodávateľ s.r.o.',
  invoiceNumber: 'MAN-2026-001',
  issueDate: '2026-07-12',
  taxDate: '2026-07-12',
  dueDate: '2026-07-26',
  currency: 'EUR' as const,
  totalAmount: 123,
  vatRate: 23 as const,
};

beforeEach(async () => {
  await setRole('admin');
  await resetDemoData();
  await setRole('uctovnik');
});

describe('ručné vytvorenie dokladu', () => {
  it('vytvorí tenant/org scoped koncept pripravený na kontrolu', async () => {
    const document = await createDocument(BASE_INPUT);

    expect(document.tenantId).toBe(MOCK_TENANT_ID);
    expect(document.orgId).toBe('org-alfa');
    expect(document.status).toBe('na_kontrole');
    expect(document.processingStatus).toBe('ready_for_review');
    expect(document.zdroj.typ).toBe('manual');
    expect(document.zdroj.localFileKey).toBeUndefined();
    expect(document.pdfUrl).toBe('');
    expect(document.extracted.odberatel?.ico).toBe(
      storeApi.get().organizations.find((item) => item.id === 'org-alfa')?.ico,
    );
    expect(document.extracted.rozpisDph[0]).toEqual({ sadzba: 23, zaklad: 100, dph: 23 });
  });

  it('označí účtovnú duplicitu iba v rovnakej organizácii', async () => {
    const first = await createDocument(BASE_INPUT);
    const duplicate = await createDocument(BASE_INPUT);
    const otherOrganization = await createDocument({
      ...BASE_INPUT,
      organizationId: 'org-beta',
    });

    expect(first.status).toBe('na_kontrole');
    expect(duplicate.status).toBe('duplicita');
    expect(duplicate.duplicateOfDocumentId).toBe(first.id);
    expect(otherOrganization.status).toBe('na_kontrole');
  });

  it('zamietne schvaľovateľa, archivovanú a cudziu organizáciu', async () => {
    await setRole('schvalovatel');
    await expect(createDocument(BASE_INPUT)).rejects.toThrow(/Schvaľovateľ/);

    await setRole('uctovnik');
    storeApi.set({
      organizations: storeApi.get().organizations.map((organization) =>
        organization.id === 'org-alfa' ? { ...organization, archived: true } : organization,
      ),
    });
    await expect(createDocument(BASE_INPUT)).rejects.toThrow(/archivovanej/);

    storeApi.set({
      organizations: [
        ...storeApi.get().organizations,
        {
          ...storeApi.get().organizations[0],
          id: 'org-foreign',
          tenantId: 'tenant-foreign',
        },
      ],
    });
    await expect(
      createDocument({ ...BASE_INPUT, organizationId: 'org-foreign' }),
    ).rejects.toThrow(/dostupná/);
  });
});

describe('ručné nahratie súboru', () => {
  it('overí magic bytes a uloží PDF mimo localStorage dátového store', async () => {
    const file = new File(
      [new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x37])],
      'faktura.pdf',
      { type: 'text/plain' },
    );
    const document = await createDocument({
      ...BASE_INPUT,
      mode: 'upload',
      invoiceNumber: 'UPLOAD-001',
      file,
    });
    const stored = await getLocalDocumentFile(document.id);

    expect(document.zdroj.typ).toBe('upload');
    expect(document.zdroj.mimeType).toBe('application/pdf');
    expect(document.zdroj.localFileKey).toBe(document.id);
    expect(document.zdroj.povodnyNazovSuboru).toBe('faktura.pdf');
    expect(stored?.name).toBe('faktura.pdf');
    expect(stored?.blob.size).toBe(file.size);
  });

  it('zamietne prázdny súbor a falošné PDF podľa obsahu', async () => {
    await expect(
      createDocument({
        ...BASE_INPUT,
        mode: 'upload',
        file: new File([], 'prazdny.pdf', { type: 'application/pdf' }),
      }),
    ).rejects.toThrow('invalid_file_size');
    await expect(
      createDocument({
        ...BASE_INPUT,
        mode: 'upload',
        file: new File(['not a pdf'], 'falošny.pdf', { type: 'application/pdf' }),
      }),
    ).rejects.toThrow('unsupported_file_type');
  });
});

import { beforeEach, describe, expect, it } from 'vitest';
import { getDataSnapshot, resetDemoData, setRole } from '../api';
import {
  createMostikExportJob,
  generateMostikPairingCode,
  retryMostikExportJob,
  setMostikEnabled,
  simulateMostikAgentConnection,
  simulateMostikAgentResult,
  simulateMostikCodeListSync,
} from './mostikService';

beforeEach(async () => {
  await setRole('admin');
  await resetDemoData();
  await setRole('admin');
  await setMostikEnabled(true);
  const pairing = await generateMostikPairingCode();
  await simulateMostikAgentConnection(pairing.code);
  await simulateMostikCodeListSync();
});

function firstApprovedDocument(data: Awaited<ReturnType<typeof getDataSnapshot>>) {
  const document = data.documents.find((item) => item.status === 'schvaleny' && item.approvedSnapshot);
  if (!document) throw new Error('Seed neobsahuje schválený doklad');
  return document;
}

describe('Mostík mock service', () => {
  it('does not mark a document exported before POHODA confirms it', async () => {
    const before = await getDataSnapshot();
    const document = firstApprovedDocument(before);
    const job = await createMostikExportJob(document.orgId, [document.id]);
    expect(job.status).toBe('pending');
    expect((await getDataSnapshot()).documents.find((item) => item.id === document.id)?.status).toBe('schvaleny');

    const confirmed = await simulateMostikAgentResult(job.id, 'ok');
    expect(confirmed.status).toBe('confirmed');
    expect((await getDataSnapshot()).documents.find((item) => item.id === document.id)?.status).toBe('exportovany');

    const repeated = await simulateMostikAgentResult(job.id, 'error');
    expect(repeated.status).toBe('confirmed');
    expect((await getDataSnapshot()).documents.find((item) => item.id === document.id)?.status).toBe('exportovany');
  });

  it('records a failed transfer and creates an explicit retry job', async () => {
    const before = await getDataSnapshot();
    const document = firstApprovedDocument(before);
    const job = await createMostikExportJob(document.orgId, [document.id]);
    const failed = await simulateMostikAgentResult(job.id, 'error');
    expect(failed.status).toBe('failed');
    expect((await getDataSnapshot()).documents.find((item) => item.id === document.id)?.status).toBe('chyba');

    const retry = await retryMostikExportJob(job.id);
    expect(retry).toMatchObject({ status: 'pending', retryOfJobId: job.id, attempt: 2 });
    expect(retry.id).not.toBe(job.id);
  });
});

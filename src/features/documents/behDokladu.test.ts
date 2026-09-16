import { describe, expect, it } from 'vitest';
import type { ExtractionRun } from '../../data/types';
import { popisBehu } from './behDokladu';

// Beh návrhu zaúčtovania nemá výsledok extrakcie a jeho zdržanie je „succeeded"
// s kódom dôvodu. Zelená fajka „Extrakcia" pri ňom klamala o tom, čo sa stalo.
const beh = (promptVersion: string, status: ExtractionRun['status'], errorCode?: string): ExtractionRun => ({
  id: 'r1', tenantId: 't', organizationId: 'o', documentId: 'd', provider: 'openai',
  promptVersion, schemaVersion: '1', status, errorCode,
} as ExtractionRun);

describe('popisBehu', () => {
  it('rozlíši etapu podľa verzie promptu', () => {
    expect(popisBehu(beh('invoice-sk-cz-v8', 'succeeded')).etapa).toBe('extrakcia');
    expect(popisBehu(beh('navrh-zauctovania-v1', 'succeeded')).etapa).toBe('zauctovanie');
    expect(popisBehu(beh('preco-vysvetlenie-predkontacia-v1', 'succeeded')).etapa).toBe('vysvetlenie');
  });

  it('zdržanie AI nie je úspech ani chyba', () => {
    expect(popisBehu(beh('navrh-zauctovania-v1', 'succeeded', 'posudok_dph')).vysledok).toBe('zdrzanie');
    expect(popisBehu(beh('navrh-zauctovania-v1', 'succeeded')).vysledok).toBe('uspech');
    expect(popisBehu(beh('navrh-zauctovania-v1', 'failed', 'navrh_zlyhal')).vysledok).toBe('chyba');
    expect(popisBehu(beh('invoice-sk-cz-v8', 'running')).vysledok).toBe('prebieha');
  });
});

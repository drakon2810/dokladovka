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
  it('klasifikácia a kontrola DPH majú vlastnú etapu', () => {
    expect(popisBehu(beh('klasifikacia-v1', 'succeeded'))).toEqual({ etapa: 'klasifikacia', vysledok: 'uspech' });
    expect(popisBehu(beh('dph-kontrola-v1', 'failed', 'openai_500'))).toEqual({ etapa: 'dph_kontrola', vysledok: 'chyba' });
  });

  it('rozlíši etapu podľa verzie promptu', () => {
    expect(popisBehu(beh('invoice-sk-cz-v8', 'succeeded')).etapa).toBe('extrakcia');
    expect(popisBehu(beh('navrh-zauctovania-v1', 'succeeded')).etapa).toBe('zauctovanie');
    expect(popisBehu(beh('preco-vysvetlenie-predkontacia-v1', 'succeeded')).etapa).toBe('vysvetlenie');
  });

  // Zlyhaný vektor ukazovala karta ako zlyhanú extrakciu a účtovník spúšťal
  // platenú extrakciu znova; dávky výpisu pribúdali ako zelené „Extrakcie".
  it('vektory a návrh pohybov výpisu nie sú extrakcia', () => {
    expect(popisBehu(beh('embeddings-v1', 'failed', 'openai_429'))).toEqual({ etapa: 'vektory', vysledok: 'chyba' });
    expect(popisBehu(beh('embeddings-v1', 'succeeded', 'neuplna_odpoved'))).toEqual({ etapa: 'vektory', vysledok: 'zdrzanie' });
    expect(popisBehu(beh('bankovy-navrh-v1', 'succeeded'))).toEqual({ etapa: 'zauctovanie', vysledok: 'uspech' });
  });

  it('zdržanie AI nie je úspech ani chyba', () => {
    expect(popisBehu(beh('navrh-zauctovania-v1', 'succeeded', 'posudok_dph')).vysledok).toBe('zdrzanie');
    expect(popisBehu(beh('navrh-zauctovania-v1', 'succeeded')).vysledok).toBe('uspech');
    expect(popisBehu(beh('navrh-zauctovania-v1', 'failed', 'navrh_zlyhal')).vysledok).toBe('chyba');
    expect(popisBehu(beh('invoice-sk-cz-v8', 'running')).vysledok).toBe('prebieha');
  });
});

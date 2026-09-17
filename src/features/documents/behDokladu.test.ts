import { describe, expect, it } from 'vitest';
import type { DocumentItem, ExtractionRun } from '../../data/types';
import { jeNeklasifikovany, popisBehu, prebiehaSpracovanie } from './behDokladu';

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

// Vlastník otvoril doklad, kým na ňom ešte bežala AI: polia boli poloprázdne,
// návrh zaúčtovania prázdny a TYP hlásil FP na doklade, ktorý nikto
// neklasifikoval — a všetko sa mu to potom menilo pod rukami.
const doklad = (o: Partial<DocumentItem>): DocumentItem => ({
  processingStatus: 'ready_for_review', status: 'na_kontrole', ...o,
} as DocumentItem);

describe('prebiehaSpracovanie', () => {
  it('rozrobený doklad sa otvoriť nedá', () => {
    // Pred extrakciou aj počas nej — samotný stav spracovania stačí.
    expect(prebiehaSpracovanie(doklad({ processingStatus: 'received' }))).toBe('extrakcia');
    expect(prebiehaSpracovanie(doklad({ processingStatus: 'queued' }))).toBe('extrakcia');
    expect(prebiehaSpracovanie(doklad({ processingStatus: 'extracting' }))).toBe('extrakcia');
    expect(prebiehaSpracovanie(doklad({ processingStatus: 'normalizing' }))).toBe('extrakcia');
    // Dočasná chyba nie je koniec: job ostáva vo fronte a doklad sa ešte prepíše.
    expect(prebiehaSpracovanie(doklad({ processingStatus: 'failed_retryable' }))).toBe('extrakcia');
    // Hotová extrakcia s čakajúcim návrhom zaúčtovania (zmena druhu dokladu) —
    // stav spracovania o ňom nevie, vie o ňom len bežiaci job.
    expect(prebiehaSpracovanie(doklad({ prebiehajuciKrok: 'zauctovanie' }))).toBe('zauctovanie');
    expect(prebiehaSpracovanie(doklad({ prebiehajuciKrok: 'extrakcia' }))).toBe('extrakcia');
  });

  // Pripravenosť je „systém na ňom dorobil", NIE „systém uspel". Keby bola
  // podmienkou úspešná extrakcia či použiteľný návrh (canAi), tieto doklady by
  // v zozname ostali zamknuté navždy a účtovník ich nemá ako opraviť.
  it('doklad bez návrhu, po zlyhaní, v karanténe aj ručný sa otvoriť dajú', () => {
    // Dokončená pipeline, ktorá nenašla návrh (suggestion.source === 'none').
    expect(prebiehaSpracovanie(doklad({ status: 'extrahovany' }))).toBeUndefined();
    // Trvalo zlyhaná extrakcia — koncový verdikt, nie beh.
    expect(prebiehaSpracovanie(doklad({ processingStatus: 'failed_permanent', status: 'chyba' }))).toBeUndefined();
    expect(prebiehaSpracovanie(doklad({ status: 'karantena' }))).toBeUndefined();
    expect(prebiehaSpracovanie(doklad({ status: 'duplicita' }))).toBeUndefined();
    // Ručne vytvorený koncept nikdy nemal job ani extrakciu.
    expect(prebiehaSpracovanie(doklad({ zdroj: { typ: 'manual' } as DocumentItem['zdroj'] }))).toBeUndefined();
  });
});

describe('jeNeklasifikovany', () => {
  it('odlíši zástupné FP od dokladu, ktorý je naozaj prijatá faktúra', () => {
    // Zakladajúci INSERT je jediné miesto so statusom 'novy' — po extrakcii má
    // doklad vždy iný status, aj keď typ ostal FP.
    expect(jeNeklasifikovany(doklad({ status: 'novy', typ: 'FP' }))).toBe(true);
    expect(jeNeklasifikovany(doklad({ status: 'extrahovany', typ: 'FP' }))).toBe(false);
    expect(jeNeklasifikovany(doklad({ status: 'chyba', typ: 'FP' }))).toBe(false);
    expect(jeNeklasifikovany(doklad({ status: 'karantena', typ: 'FP' }))).toBe(false);
  });
});

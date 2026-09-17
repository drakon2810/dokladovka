import type { ExtractionRun } from '../../data/types';

export type EtapaBehu = 'extrakcia' | 'klasifikacia' | 'zauctovanie' | 'dph_kontrola' | 'vysvetlenie' | 'vektory';
export type VysledokBehu = 'uspech' | 'zdrzanie' | 'chyba' | 'prebieha';

/**
 * Čo beh AI na doklade robil a ako dopadol. Do extraction_runs sa zapisuje aj
 * návrh zaúčtovania (bez výsledku extrakcie) a vysvetlenie „Prečo" — bez
 * rozlíšenia vyzeralo všetko ako zelená extrakcia. Zdržanie AI je „succeeded"
 * s kódom dôvodu: nie je to chyba, ale ani úspech, ktorý by niečo vyplnil.
 */
export function popisBehu(run: Pick<ExtractionRun, 'promptVersion' | 'status' | 'errorCode'>): {
  etapa: EtapaBehu;
  vysledok: VysledokBehu;
} {
  // Návrh pohybov výpisu je tiež návrh zaúčtovania; vektory textov idú k návrhu dokladu.
  const etapa: EtapaBehu = run.promptVersion.startsWith('navrh-zauctovania') ? 'zauctovanie'
    : run.promptVersion.startsWith('bankovy-navrh') ? 'zauctovanie'
    : run.promptVersion.startsWith('embeddings') ? 'vektory'
    : run.promptVersion.startsWith('preco-vysvetlenie') ? 'vysvetlenie'
    : run.promptVersion.startsWith('klasifikacia') ? 'klasifikacia'
    : run.promptVersion.startsWith('dph-kontrola') ? 'dph_kontrola'
    : 'extrakcia';
  const vysledok: VysledokBehu = run.status === 'failed' ? 'chyba'
    : run.status !== 'succeeded' ? 'prebieha'
    : run.errorCode ? 'zdrzanie'
    : 'uspech';
  return { etapa, vysledok };
}

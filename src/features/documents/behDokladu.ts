import type { DocumentItem, ExtractionRun, ProcessingStatus } from '../../data/types';

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

/**
 * Stavy spracovania, za ktorými už nikto nič nerobí. `failed_retryable` medzi
 * ne nepatrí: job po ňom ostáva vo fronte a za pár desiatok sekúnd sa doklad
 * prepíše znova. `failed_permanent` áno — je to konečný verdikt a doklad musí
 * ostať otvoriteľný, inak ho účtovník nemá ako opraviť.
 */
const KONCOVE_STAVY: readonly ProcessingStatus[] = ['ready_for_review', 'failed_permanent'];

/**
 * Čo na doklade ešte beží; `undefined` = systém na ňom skončil a dá sa otvoriť.
 *
 * Vlastník otvoril doklad, kým na ňom ešte bežala AI: polia boli poloprázdne,
 * návrh zaúčtovania prázdny, „Automatické účtovanie" sa nedalo stlačiť a TYP
 * hlásil FP na doklade, ktorý nikto neklasifikoval — a všetko sa mu to potom
 * menilo pod rukami. Pokiaľ teda niečo beží, doklad sa neotvára vôbec.
 *
 * Pripravenosť znamená „systém na ňom dorobil", NIE „systém uspel": doklad bez
 * návrhu, po zlyhanej extrakcii, v karanténe aj ručne vytvorený sú pripravené,
 * lebo inak by v zozname ostali zamknuté navždy.
 *
 * ponytail: kontrola DPH a AI návrh zaúčtovania bežia v CHVOSTE toho istého
 *   extrakčného jobu, ale až za transakciou, ktorá job označí za 'succeeded'
 *   (workerService.completeRun). Tých pár sekúnd až minútu teda doklad vyzerá
 *   pripravený a AI návrh ešte môže prepísať deterministický. Zavrieť sa to dá
 *   presunutím toho zápisu na koniec processNextJob — za cenu toho, že pád či
 *   reštart workera v chvoste zopakuje (a znova zaplatí) celú extrakciu.
 *   To je rozhodnutie vlastníka, nie vedľajší efekt tejto zmeny.
 */
export function prebiehaSpracovanie(
  doklad: Pick<DocumentItem, 'processingStatus' | 'prebiehajuciKrok'>,
): DocumentItem['prebiehajuciKrok'] {
  if (doklad.prebiehajuciKrok) return doklad.prebiehajuciKrok;
  return KONCOVE_STAVY.includes(doklad.processingStatus) ? undefined : 'extrakcia';
}

/**
 * Doklad, ktorý ešte nikto neklasifikoval — jeho TYP je len zástupná hodnota.
 *
 * Stĺpec document_type je NOT NULL s CHECK na FP/FV/BV/MZDY/OZ/PD, takže nový
 * doklad vzniká s 'FP' a pravý typ doplní až extrakcia. Jediné miesto, ktoré
 * zapisuje status 'novy', je práve ten zakladajúci INSERT — po extrakcii má
 * doklad vždy iný status (extrahovany/karantena/duplicita/chyba). Status je
 * preto poctivý príznak „typ ešte nikto neurčil" a netreba naň nový stĺpec.
 */
export function jeNeklasifikovany(doklad: Pick<DocumentItem, 'status'>): boolean {
  return doklad.status === 'novy';
}

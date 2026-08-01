import type { Queryable } from '../db/database.js';

/**
 * Daňový pomer: P = % základu ako daňový náklad, D = % DPH s nárokom na odpočet,
 * K = % základu do Kontrolného výkazu. Konštantný katalóg (vychádza zo zákona,
 * nie z dát firmy) — org-špecifické pomery zatiaľ nikto nepotreboval.
 * ponytail: konštanty v kóde; DB tabuľka až keď vznikne prvý org-špecifický pomer.
 */
export interface TaxRatio {
  kod: string;
  nazov: string;
  pNaklad: number;
  dDph: number;
  kKv: number;
}

export const TAX_RATIOS: Record<string, TaxRatio> = {
  VSEOB: { kod: 'VSEOB', nazov: 'Bežná položka', pNaklad: 100, dDph: 100, kKv: 100 },
  // § 19 ods. 2 písm. l) ZDP: 80 % paušál bez knihy jázd; DPH plný odpočet.
  PHM80: { kod: 'PHM80', nazov: 'PHM 80 % paušál', pNaklad: 80, dDph: 80, kKv: 100 },
  // § 49 ods. 5 zákona o DPH: 50 % odpočet pri zmiešanom používaní vozidla.
  PHM50: { kod: 'PHM50', nazov: 'PHM 80 % / DPH 50 %', pNaklad: 80, dDph: 50, kKv: 100 },
  // Daňový náklad bez nároku na odpočet DPH (neuplatnená DPH ide do nákladu).
  BEZN: { kod: 'BEZN', nazov: 'Bez nároku na odpočet DPH', pNaklad: 100, dDph: 0, kKv: 100 },
  // Nedaňový náklad bez odpočtu (repre 513, dary 543, pokuty 545, NEDAŇOVÁ analytika).
  NEDAN: { kod: 'NEDAN', nazov: 'Nedaňový náklad', pNaklad: 0, dDph: 0, kKv: 100 },
};

const round2 = (value: number): number => Math.round((value + Number.EPSILON) * 100) / 100;

export interface RozpisZapis {
  /** Prípona k popisu položky, napr. „uplatnené 80 %“. */
  popisSuffix: string;
  suma: number;
  druh: 'zaklad_uplatneny' | 'zaklad_neuplatneny' | 'dph_uplatnena' | 'dph_neuplatnena';
  /** Daňový náklad (true) vs. nedaňový — určuje analytiku/predkontáciu cieľa. */
  danovy: boolean;
  /** Zaradenie do Kontrolného výkazu (neuplatnená DPH doň nejde). */
  doKv: boolean;
}

/**
 * Deterministický rozklad položky podľa daňového pomeru — vzor Elektronický
 * účtovník (PHM 52 €: 33,82 + 8,46 + 4,86 + 4,86). Neuplatnená časť sumy sa
 * počíta ako zvyšok (nie druhé percento), takže bilancia sedí na cent.
 * Vráti null pre plný pomer (VSEOB) — vtedy netreba nič rozkladať.
 */
export function rozpisPolozku(
  polozka: { sumaBezDph: number; sumaDph: number },
  ratio: TaxRatio,
): RozpisZapis[] | null {
  if (ratio.pNaklad === 100 && ratio.dDph === 100) return null;
  const zakladUplatneny = round2((polozka.sumaBezDph * ratio.pNaklad) / 100);
  const dphUplatnena = round2((polozka.sumaDph * ratio.dDph) / 100);
  const zapisy: RozpisZapis[] = [
    { popisSuffix: `uplatnené ${ratio.pNaklad} %`, suma: zakladUplatneny, druh: 'zaklad_uplatneny', danovy: true, doKv: true },
    { popisSuffix: `neuplatnené ${100 - ratio.pNaklad} %`, suma: round2(polozka.sumaBezDph - zakladUplatneny), druh: 'zaklad_neuplatneny', danovy: false, doKv: true },
    { popisSuffix: `DPH uplatnené ${ratio.dDph} %`, suma: dphUplatnena, druh: 'dph_uplatnena', danovy: true, doKv: true },
    // Neuplatnená DPH je nákladom a do KV sa nezaraďuje (v KV je len uplatnená daň).
    { popisSuffix: `DPH neuplatnené ${100 - ratio.dDph} %`, suma: round2(polozka.sumaDph - dphUplatnena), druh: 'dph_neuplatnena', danovy: ratio.pNaklad > 0, doKv: false },
  ];
  return zapisy.filter((zapis) => zapis.suma !== 0);
}

/**
 * Idempotentný seed po importe číselníkov z POHODY:
 *  - ucet_md fallback z prefixu kódu predkontácie (účtovníci často kódujú
 *    „501199 PHM NEDANOVA“) — len keď POHODA neposlala atribút debit;
 *  - tax_ratio_kod z názvu/analytiky. Guard IS NULL: ručná úprava sa nikdy neprepíše,
 *    nové riadky z ďalšieho syncu sa doplnia.
 * Účty 513/543/545 sú nedaňové zo zákona; „nedaň/NED/NN“ je konvencia v názvoch.
 */
export async function seedTaxRatioDefaults(tx: Queryable, tenantId: string, organizationId: string): Promise<void> {
  await tx.query(
    `UPDATE code_list_items
        SET ucet_md = COALESCE(ucet_md, substring(code from '^[0-9]{3,6}'))
      WHERE tenant_id=$1 AND organization_id=$2 AND kind='predkontacie' AND ucet_md IS NULL`,
    [tenantId, organizationId],
  );
  await tx.query(
    `UPDATE code_list_items
        SET tax_ratio_kod = CASE
          -- „nedaň/nedan“ hocijako; skratky NE/NED/NN len VEĽKÝMI (konvencia
          -- účtovníkov: „Auto NED“, „nájom Au NE“, „tuz-NN“) — malé „ne“ je bežné slovo.
          WHEN name ~* 'nedaň|nedan' OR name ~ '\\mNED?\\M|-NN\\M' THEN 'NEDAN'
          WHEN substring(COALESCE(ucet_md, code) from '^[0-9]{3}') IN ('513','543','545') THEN 'NEDAN'
          WHEN name ~* 'phm|nafta|benz[ií]n|pohonn' THEN 'PHM80'
          ELSE 'VSEOB'
        END
      WHERE tenant_id=$1 AND organization_id=$2 AND kind='predkontacie' AND tax_ratio_kod IS NULL`,
    [tenantId, organizationId],
  );
}

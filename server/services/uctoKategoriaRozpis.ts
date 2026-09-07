import type { Database, Queryable } from '../db/database.js';
import { pocetZhodSlov } from './accountingSuggestionService.js';
import { odvodRozpis, MIN_DOKLADOV, type PravidloRiadok, type RozpisRiadok } from './uctoPravidlaService.js';

/**
 * Tvar rozpisu pre KATEGÓRIE plnení.
 *
 * Pravidlo protistrany platí len pre dodávateľa, ktorého firma už mala.
 * Kategória hovorí o DRUHU plnenia, takže platí aj pre celkom nového — a práve
 * to na pravidle protistrany chýba.
 *
 * Kategória „Leasing - splátka (istina a úrok)" mala doteraz v názve dve veci
 * a v poli jednu: účet pre istinu. Úrok sa nemal kam zapísať. Rovnako PHM
 * tvrdilo PN/KN pre celé palivo, hoci nedaňová je len pätina.
 *
 * Doklad sa ku kategórii priradí ROVNAKO, ako to robí návrh zaúčtovania: podľa
 * zhody slovníka s textom hlavičky, najviac zhodných slov vyhráva. Dva rôzne
 * spôsoby priradenia by znamenali, že kategória sľubuje jedno a pri doklade
 * platí druhé.
 */
export async function doplnRozpisKategorii(
  database: Database,
  input: { tenantId: string; organizationId: string },
): Promise<{ kategoriiSRozpisom: number }> {
  const kategorie = (await database.query<Record<string, any>>(
    'SELECT id, slovnik FROM ucto_kategorie WHERE tenant_id=$1 AND organization_id=$2 AND active=true',
    [input.tenantId, input.organizationId],
  )).rows.map((row) => ({ id: row.id as string, slovnik: row.slovnik }));
  if (kategorie.length === 0) return { kategoriiSRozpisom: 0 };

  const rows = (await database.query<Record<string, any>>(
    `SELECT agenda, doklad_cislo, coalesce(riadok_index, 0) AS riadok_index, line_text_normalized,
            suma, predkontacia_kod, clenenie_dph_kod, clenenie_kv_kod
       FROM ucto_historia
      WHERE tenant_id=$1 AND organization_id=$2 AND doklad_cislo IS NOT NULL
      ORDER BY agenda, doklad_cislo, coalesce(riadok_index, 0)`,
    [input.tenantId, input.organizationId],
  )).rows;

  const doklady = new Map<string, RozpisRiadok[]>();
  for (const row of rows) {
    const kluc = `${row.agenda}|${row.doklad_cislo}`;
    const zoznam = doklady.get(kluc) ?? [];
    zoznam.push({
      riadokIndex: Number(row.riadok_index),
      text: row.line_text_normalized ?? '',
      suma: row.suma === null ? undefined : Number(row.suma),
      predkontaciaKod: row.predkontacia_kod ?? undefined,
      clenenieDphKod: row.clenenie_dph_kod ?? undefined,
      clenenieKvKod: row.clenenie_kv_kod ?? undefined,
    });
    doklady.set(kluc, zoznam);
  }

  // Hlavička rozhoduje, do ktorej kategórie doklad patrí; rozpis sa berie z jeho položiek.
  const podlaKategorie = new Map<string, RozpisRiadok[][]>();
  for (const riadky of doklady.values()) {
    const hlavicka = riadky.find((riadok) => riadok.riadokIndex === 0);
    const polozky = riadky.filter((riadok) => riadok.riadokIndex > 0);
    if (!hlavicka || polozky.length === 0) continue;
    // Tvar rozpisu smú učiť LEN doklady, ktoré účtovník naozaj rozúčtoval.
    // Odkedy korpus drží aj položky dokladov účtovaných na jeden účet (kvôli
    // ich textom), tvoria väčšinu — a odvodRozpis potom vidí prevažne rovnaké
    // riadky, zahodí ich ako „nič sa nedelí" a kategórii neostane nič. AGS tak
    // prišlo z piatich kategórií s rozpisom na nulu. Doklad na jeden účet
    // o DELENÍ nehovorí nič; do korpusu patrí pre svoj text, nie pre tvar.
    if (new Set(polozky.map((polozka) => polozka.predkontaciaKod ?? '')).size < 2) continue;
    let najlepsia: { id: string; zhoda: number } | undefined;
    for (const kategoria of kategorie) {
      const zhoda = pocetZhodSlov(kategoria.slovnik, hlavicka.text);
      if (zhoda > 0 && (!najlepsia || zhoda > najlepsia.zhoda)) najlepsia = { id: kategoria.id, zhoda };
    }
    if (!najlepsia) continue;
    const zoznam = podlaKategorie.get(najlepsia.id) ?? [];
    zoznam.push(polozky);
    podlaKategorie.set(najlepsia.id, zoznam);
  }

  let sRozpisom = 0;
  await database.transaction(async (tx: Queryable) => {
    for (const kategoria of kategorie) {
      const jejDoklady = podlaKategorie.get(kategoria.id) ?? [];
      const rozpis: PravidloRiadok[] = jejDoklady.length >= MIN_DOKLADOV ? odvodRozpis(jejDoklady) : [];
      if (rozpis.length > 0) sRozpisom += 1;
      await tx.query('UPDATE ucto_kategorie SET rozpis=$1::jsonb WHERE id=$2',
        [JSON.stringify(rozpis), kategoria.id]);
    }
  });
  return { kategoriiSRozpisom: sRozpisom };
}

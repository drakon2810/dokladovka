import { loadConfig } from '../config.js';
import { createDatabase } from '../db/database.js';
import { rebuildAccountingSuggestion } from '../services/accountingSuggestionService.js';

/**
 * Deterministický prepočet návrhov zaúčtovania rozpracovaných dokladov — bez AI
 * a bez opakovanej extrakcie (tú by účtovník platil znova).
 *
 * Načo: návrh vzniká pri extrakcii, takže zmena v odvodení praxe sa na už
 * nahratých dokladoch neprejaví. Po nasadení rozpisu po položkách tak paleta
 * BRICOLu ostala na účte tovaru na každom doklade, ktorý prišiel predtým.
 *
 * Berie len doklady, o ktorých ešte nikto nerozhodol (extrahovany, na_kontrole):
 * schválený ani exportovaný doklad sa nediktuje spätne. Návrh nie je zápis do
 * dokladu — účtovníkovi sa ukáže ako bledá predloha, kým ju nepoužije.
 *
 * Produkcia (obraz má len skompilovaný JS):
 *   docker compose exec -T api node build/server/scripts/prepocitajNavrhy.js [--firma časť_názvu] [--dry-run]
 */
const naSkusku = process.argv.includes('--dry-run');
const filter = process.argv[process.argv.indexOf('--firma') + 1];
const firmaFilter = process.argv.includes('--firma') && filter && !filter.startsWith('--') ? filter : undefined;
class NaSkusku extends Error {}

const database = await createDatabase(loadConfig());
try {
  const doklady = (await database.query<{
    id: string; tenant_id: string; organization_id: string; firma: string; document_type: string;
    extracted: { dodavatel?: { nazov?: string; ico?: string; icDph?: string; iban?: string } } | null;
  } & Record<string, unknown>>(
    `SELECT d.id, d.tenant_id, d.organization_id, o.name AS firma, d.document_type, d.extracted
       FROM documents d JOIN organizations o ON o.id=d.organization_id
      WHERE d.status IN ('extrahovany','na_kontrole') AND o.archived=false
        AND ($1::text IS NULL OR o.name ILIKE '%' || $1 || '%')
      ORDER BY o.name, d.created_at`,
    [firmaFilter ?? null],
  )).rows;

  const podlaFirmy = new Map<string, { hotovo: number; zlyhalo: number }>();
  for (const doklad of doklady) {
    const pocty = podlaFirmy.get(doklad.firma) ?? { hotovo: 0, zlyhalo: 0 };
    podlaFirmy.set(doklad.firma, pocty);
    const dodavatel = doklad.extracted?.dodavatel ?? {};
    try {
      await database.transaction(async (tx) => {
        await rebuildAccountingSuggestion(tx, {
          tenantId: doklad.tenant_id,
          organizationId: doklad.organization_id,
          documentId: doklad.id,
          supplierName: dodavatel.nazov,
          supplierIco: dodavatel.ico,
          supplierIcDph: dodavatel.icDph,
          supplierIban: dodavatel.iban,
        });
        if (naSkusku) throw new NaSkusku();
      });
      pocty.hotovo += 1;
    } catch (chyba) {
      if (chyba instanceof NaSkusku) {
        pocty.hotovo += 1;
        continue;
      }
      // Chyba jedného dokladu nezastaví ostatné; skript skončí nenulovým kódom.
      console.error(`${doklad.firma} ${doklad.id}: ${chyba instanceof Error ? chyba.message : String(chyba)}`);
      pocty.zlyhalo += 1;
      process.exitCode = 1;
    }
  }

  const sRozpisom = (await database.query<{ firma: string; dokladov: string } & Record<string, unknown>>(
    `SELECT o.name AS firma, count(*) AS dokladov
       FROM accounting_suggestions s JOIN organizations o ON o.id=s.organization_id
      WHERE s.riadky IS NOT NULL AND jsonb_array_length(s.riadky) > 0
      GROUP BY 1`,
  )).rows;
  const rozpisy = new Map(sRozpisom.map((row) => [row.firma, Number(row.dokladov)]));
  for (const [firma, pocty] of [...podlaFirmy].sort(([a], [b]) => a.localeCompare(b, 'sk'))) {
    console.log(`${firma}: prepočítaných ${pocty.hotovo}${pocty.zlyhalo ? `, zlyhalo ${pocty.zlyhalo}` : ''}`
      + `, s rozpisom po položkách ${rozpisy.get(firma) ?? 0}`);
  }
  if (naSkusku) console.log('--dry-run: nič sa nezapísalo');
} finally {
  await database.close();
}

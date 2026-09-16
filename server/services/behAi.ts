import { randomUUID } from 'node:crypto';
import type { Queryable } from '../db/database.js';

/**
 * Volanie modelu mimo extrakcie v logu behov dokladu (extraction_runs):
 * klasifikácia, návrh zaúčtovania, kontrola DPH. Kým sa nezapisovali, cena
 * dokladu zahŕňala len extrakciu a výpadok nebolo nikde vidieť. Zapisujú sa len
 * čísla a kódy — riadky behov idú každému prehliadaču v dátovom snapshote.
 * `result` ostáva prázdny: výsledok extrakcie hľadá beh s výsledkom.
 */
export async function zapisBehAi(database: Queryable, beh: {
  tenantId: string;
  organizationId: string;
  documentId: string;
  model: string;
  promptVersion: string;
  /** Date.now() pred volaním modelu. */
  zaciatok: number;
  usage?: unknown;
  /** Model odpovedal, ale nič nevrátil alebo sa zdržal — kód dôvodu. */
  zdrzanie?: string;
  chyba?: unknown;
  /** Kód chyby bez HTTP statusu a správa pre kartu dokladu. */
  kodChyby: string;
  spravaChyby: string;
}): Promise<void> {
  const usage = beh.usage as {
    input_tokens?: number; output_tokens?: number; web_search_calls?: number;
    input_tokens_details?: { cached_tokens?: number }; output_tokens_details?: { reasoning_tokens?: number };
  } | undefined;
  const zlyhal = beh.chyba !== undefined;
  const status = (beh.chyba as { status?: number } | undefined)?.status;
  await database.query(
    `INSERT INTO extraction_runs
      (id,tenant_id,organization_id,document_id,provider,model,prompt_version,schema_version,status,
       error_code,error_message,latency_ms,usage,started_at,completed_at)
     VALUES ($1,$2,$3,$4,'openai',$5,$6,'1',$7,$8,$9,$10,$11::jsonb,to_timestamp($12/1000.0),now())`,
    [randomUUID(), beh.tenantId, beh.organizationId, beh.documentId, beh.model, beh.promptVersion,
      zlyhal ? 'failed' : 'succeeded',
      zlyhal ? (status ? `openai_${status}` : beh.kodChyby) : beh.zdrzanie ?? null,
      zlyhal ? beh.spravaChyby : null,
      Date.now() - beh.zaciatok,
      usage ? JSON.stringify({
        inputTokens: usage.input_tokens ?? null,
        cachedTokens: usage.input_tokens_details?.cached_tokens ?? null,
        outputTokens: usage.output_tokens ?? null,
        reasoningTokens: usage.output_tokens_details?.reasoning_tokens ?? null,
        webSearchCalls: usage.web_search_calls ?? 0,
      }) : null,
      beh.zaciatok],
  );
}

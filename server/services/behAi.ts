import { randomUUID } from 'node:crypto';
import type { Queryable } from '../db/database.js';

/**
 * Volanie modelu mimo extrakcie v logu behov (extraction_runs): klasifikácia,
 * návrh zaúčtovania, kontrola DPH, návrh pohybov výpisu, embeddingy, analýza
 * a právna kontrola profilu. Kým sa nezapisovali, cena dokladu zahŕňala len
 * extrakciu a výpadok nebolo nikde vidieť. Volanie nad firmou (profil) nemá
 * doklad — documentId je prázdne. Zapisujú sa len čísla a kódy — riadky behov
 * idú každému prehliadaču v dátovom snapshote.
 * `result` ostáva prázdny: výsledok extrakcie hľadá beh s výsledkom.
 */
export async function zapisBehAi(database: Queryable, beh: {
  tenantId: string;
  organizationId: string;
  documentId: string | null;
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
    /** Embeddings API volá vstupné tokeny inak. */
    prompt_tokens?: number;
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
        inputTokens: usage.input_tokens ?? usage.prompt_tokens ?? null,
        cachedTokens: usage.input_tokens_details?.cached_tokens ?? null,
        outputTokens: usage.output_tokens ?? null,
        reasoningTokens: usage.output_tokens_details?.reasoning_tokens ?? null,
        webSearchCalls: usage.web_search_calls ?? 0,
      }) : null,
      beh.zaciatok],
  );
}

type BehAi = Parameters<typeof zapisBehAi>[1];

/**
 * Volanie modelu so zápisom behu: úspešné so spotrebou, zlyhané s chybou, ktorú
 * pustí ďalej volajúcemu. Beh sa zapíše, len keď sa model naozaj volal — príprava
 * pred `volanie` do behu nepatrí. Zlyhaný zápis logu volanie nezhodí: odpoveď
 * je už zaplatená.
 */
export async function sBehomAi<T extends { usage?: unknown; output?: unknown }>(
  database: Queryable,
  beh: Omit<BehAi, 'zaciatok' | 'usage' | 'zdrzanie' | 'chyba'>,
  volanie: () => Promise<T>,
  /** Kód zdržania z odpovede, keď model odpovedal, ale nič použiteľné nevrátil. */
  zdrzanie?: (odpoved: T) => string | undefined,
): Promise<T> {
  const zaciatok = Date.now();
  const zapis = (navyse: Pick<BehAi, 'usage' | 'zdrzanie' | 'chyba'>) => zapisBehAi(database, { ...beh, zaciatok, ...navyse })
    .catch((chyba) => console.warn(`[${beh.promptVersion}] zápis behu zlyhal`, chyba instanceof Error ? chyba.message : chyba));
  let odpoved: T;
  try {
    odpoved = await volanie();
  } catch (chyba) {
    await zapis({ chyba });
    throw chyba;
  }
  // Web search sa platí za volanie, nie za tokeny — bez počtu by cena klamala.
  const hladani = Array.isArray(odpoved.output)
    ? odpoved.output.filter((item) => (item as { type?: string } | null)?.type === 'web_search_call').length : 0;
  await zapis({
    usage: odpoved.usage && hladani > 0 ? { ...(odpoved.usage as object), web_search_calls: hladani } : odpoved.usage,
    zdrzanie: zdrzanie?.(odpoved),
  });
  return odpoved;
}

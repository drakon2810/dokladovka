import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { writeAudit } from '../audit.js';
import type { Database, Queryable } from '../db/database.js';
import { HttpError } from '../http.js';
import { ulozTreningoveRiadky, type trainingRowSchema } from '../routes/aiTrainingRoutes.js';
import { ulozDennik, type DennikRiadok } from './uctoDennikService.js';
import { importUctoHistory, ulozRadyZDokladov, type HistoryRow } from './uctoHistoryService.js';
import { PREPOCET_PRAXE_KIND } from '../workerService.js';

/**
 * Prenos histórie z Mostíka po dávkach do stagingu a jedna publikácia.
 *
 * Doteraz prvá dávka zmazala živé dáta a ďalšie ich postupne plnili — výpadok
 * uprostred nechal návrhom zaúčtovania zlomok histórie. Dávky teraz ležia
 * v pohoda_import_davky a živé tabuľky sa vymenia až pri publikácii, v jednej
 * transakcii a len keď manifest sedí. Čitatelia sa nemenia: PostgreSQL každému
 * príkazu ukáže buď starý, alebo nový stav, nikdy polovicu.
 *
 * ponytail: opustený staging (agent sa už neozve) ostáva do ďalšieho prenosu
 *   toho istého druhu, ktorý ho nahradí — najviac jedna kópia na firmu a druh.
 *   TTL upratovanie pridať, keby staging rástol.
 */

export type DruhImportu = 'historia' | 'pamat' | 'dennik';

// Beh na serveri ide do telemetrie pod kindom, ktorý pre ten druh posiela agent.
const KIND_BEHU: Record<DruhImportu, string> = {
  historia: 'uctovnyProfil', pamat: 'treningAi', dennik: 'uctovnyDennik',
};

export const publikaciaSchema = z.object({
  druh: z.enum(['historia', 'pamat', 'dennik']),
  davok: z.number().int().min(1),
  pocet: z.number().int().min(0),
  manifest: z.object({
    databaza: z.string().trim().min(1).max(255),
    rok: z.number().int().min(1990).max(2100).optional(),
    programVersion: z.string().max(100).optional(),
    kluc: z.string().max(100).optional(),
    agendy: z.array(z.object({
      poziadavka: z.string().max(50),
      agenda: z.string().max(50).optional(),
      stav: z.string().max(50),
      poznamka: z.string().max(1000).optional(),
      dokladov: z.number().int().min(0),
      poloziek: z.number().int().min(0),
      riadkov: z.number().int().min(0),
      preskocene: z.record(z.string().max(50), z.number().int().min(0)),
    }).strict()).max(100),
  }).strict(),
}).strict().refine((body) => body.druh !== 'dennik' || body.manifest.rok !== undefined, {
  // Denník sa vymieňa po rokoch — bez roka by publikácia nevedela, čo zmazať.
  message: 'Denník potrebuje rok databázy', path: ['manifest', 'rok'],
});

type Publikacia = z.infer<typeof publikaciaSchema>;

/** Dávka prenosu do stagingu. Živých tabuliek sa nedotkne. */
export async function ulozDavku(
  database: Database,
  input: {
    tenantId: string; organizationId: string; druh: DruhImportu; importId: string; davka: number;
    obsah: unknown; pocet: number; agentVersion: string;
  },
): Promise<{ importId: string; davka: number; prijatych: number }> {
  const { tenantId, organizationId, druh, importId } = input;
  return database.transaction(async (tx) => {
    const zalozeny = await tx.query(
      `INSERT INTO pohoda_importy (id, tenant_id, organization_id, druh, agent_version)
       VALUES ($1,$2,$3,$4,$5) ON CONFLICT (id) DO NOTHING RETURNING id`,
      [importId, tenantId, organizationId, druh, input.agentVersion],
    );
    const beh = (await tx.query<{ tenant_id: string; organization_id: string; druh: string; stav: string } & Record<string, unknown>>(
      'SELECT tenant_id, organization_id, druh, stav FROM pohoda_importy WHERE id=$1 FOR UPDATE', [importId],
    )).rows[0];
    if (!beh || beh.tenant_id !== tenantId || beh.organization_id !== organizationId || beh.druh !== druh) {
      throw new HttpError(404, 'import_neexistuje', 'Prenos neexistuje');
    }
    if (beh.stav !== 'prijima') throw new HttpError(409, 'import_uzavrety', 'Prenos je už uzavretý');
    if (zalozeny.rows.length > 0) {
      // Nový prenos ruší starší nedokončený toho istého druhu — jeho dávky by
      // sa už nikdy nepublikovali a staging drží najviac jednu kópiu.
      const nahradene = await tx.query<{ id: string } & Record<string, unknown>>(
        `UPDATE pohoda_importy SET stav='zamietnuty', chyba='nahradeny'
          WHERE tenant_id=$1 AND organization_id=$2 AND druh=$3 AND stav='prijima' AND id<>$4 RETURNING id`,
        [tenantId, organizationId, druh, importId],
      );
      if (nahradene.rows.length > 0) {
        await tx.query('DELETE FROM pohoda_import_davky WHERE import_id = ANY($1::text[])', [nahradene.rows.map((row) => row.id)]);
      }
    }
    // Zopakovaná dávka (agent po timeoute) prepíše tú istú, nezdvojí sa.
    await tx.query(
      `INSERT INTO pohoda_import_davky (import_id, davka, obsah, pocet) VALUES ($1,$2,$3::jsonb,$4)
       ON CONFLICT (import_id, davka) DO UPDATE SET obsah=excluded.obsah, pocet=excluded.pocet`,
      [importId, input.davka, JSON.stringify(input.obsah), input.pocet],
    );
    return { importId, davka: input.davka, prijatych: input.pocet };
  });
}

function chybaManifestu(body: Publikacia, davky: Array<{ davka: number; pocet: number }>): string | undefined {
  if (davky.length !== body.davok || davky.some((row, index) => row.davka !== index)) {
    return `prišlo ${davky.length} z ${body.davok} dávok`;
  }
  const spolu = davky.reduce((sucet, row) => sucet + row.pocet, 0);
  if (spolu !== body.pocet) return `prišlo ${spolu} z ${body.pocet} riadkov`;
  // Stav agendy je jediný dôkaz úplnosti, aký POHODA dáva — celkový počet
  // záznamov v odpovedi nie je. Chyba položky alebo delenie na časti (parts)
  // znamená, že časť agendy chýba.
  const agenda = body.manifest.agendy.find((item) => item.stav !== 'ok');
  if (agenda) return `agenda ${agenda.agenda ?? agenda.poziadavka}: ${agenda.stav}${agenda.poznamka ? ` (${agenda.poznamka})` : ''}`;
  return undefined;
}

/**
 * Publikácia prenosu. Zamietnutie (neúplný manifest) sa zapíše a potvrdí —
 * živé dáta ostanú nedotknuté — a až potom sa ohlási ako 422.
 */
export async function publikujImport(
  database: Database,
  input: { tenantId: string; organizationId: string; importId: string; agentId: string; correlationId: string; body: Publikacia },
): Promise<unknown> {
  const { tenantId, organizationId, importId, body } = input;
  const zaciatok = Date.now();
  const zapisBeh = (tx: Queryable, state: 'ok' | 'error', errorCode?: string) => tx.query(
    `INSERT INTO agent_sync_runs
      (id,tenant_id,organization_id,agent_installation_id,kind,state,item_count,duration_ms,error_code)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
    [randomUUID(), tenantId, organizationId, input.agentId, KIND_BEHU[body.druh], state, body.pocet,
      Date.now() - zaciatok, errorCode?.slice(0, 200) ?? null],
  );

  const vystup = await database.transaction(async (tx): Promise<{ vysledok: unknown } | { zamietnute: string }> => {
    // Zámok na prenosy druhu firmy: dve publikácie — aj zopakovaná po timeoute,
    // kým prvá ešte beží — idú za sebou a druhá už vidí výsledok prvej.
    const behy = (await tx.query<{ id: string; stav: string; chyba: string | null; vysledok: unknown; created_at: string | Date } & Record<string, unknown>>(
      `SELECT id, stav, chyba, vysledok, created_at FROM pohoda_importy
        WHERE tenant_id=$1 AND organization_id=$2 AND druh=$3 FOR UPDATE`,
      [tenantId, organizationId, body.druh],
    )).rows;
    const beh = behy.find((row) => row.id === importId);
    if (!beh) throw new HttpError(404, 'import_neexistuje', 'Prenos neexistuje');
    if (beh.stav === 'publikovany') return { vysledok: beh.vysledok };
    const novsiPublikovany = behy.some((row) => row.stav === 'publikovany' && new Date(row.created_at) > new Date(beh.created_at));
    if (beh.chyba === 'nahradeny' || novsiPublikovany) {
      throw new HttpError(409, 'import_nahradeny', 'Prenos nahradil novší prenos');
    }
    if (beh.stav === 'zamietnuty') return { zamietnute: beh.chyba ?? 'zamietnutý' };

    const davky = (await tx.query<{ davka: number; pocet: number } & Record<string, unknown>>(
      'SELECT davka, pocet FROM pohoda_import_davky WHERE import_id=$1 ORDER BY davka', [importId],
    )).rows;
    const chyba = chybaManifestu(body, davky);
    if (chyba) {
      await tx.query(
        `UPDATE pohoda_importy SET stav='zamietnuty', chyba=$2, manifest=$3::jsonb WHERE id=$1`,
        [importId, chyba, JSON.stringify(body.manifest)],
      );
      await tx.query('DELETE FROM pohoda_import_davky WHERE import_id=$1', [importId]);
      await zapisBeh(tx, 'error', chyba);
      return { zamietnute: chyba };
    }

    const obsahy = (await tx.query<{ obsah: any } & Record<string, unknown>>(
      'SELECT obsah FROM pohoda_import_davky WHERE import_id=$1 ORDER BY davka', [importId],
    )).rows.map((row) => row.obsah);
    const scope = { tenantId, organizationId };
    let vysledok: Record<string, unknown>;
    if (body.druh === 'historia') {
      // Vymení sa len databáza tohto prenosu: po prechode na databázu nového
      // roka minulý rok ostane. NULL sú riadky spred rozlíšenia databázy a ručné
      // nahratia — tie nahrádzal aj doterajší reset. Meno bez ohľadu na veľkosť
      // písmen: mServer a nastavenie POHODA CLI ho píšu rôzne (ako MatchEndpoint).
      await tx.query(
        `DELETE FROM ucto_historia
          WHERE tenant_id=$1 AND organization_id=$2 AND (lower(zdroj_databaza)=lower($3) OR zdroj_databaza IS NULL)`,
        [tenantId, organizationId, body.manifest.databaza],
      );
      const historia = await importUctoHistory(tx, {
        ...scope, rows: obsahy.flatMap((obsah) => obsah.rows as HistoryRow[]), source: 'mdb',
        zdrojDatabaza: body.manifest.databaza,
      });
      // Rady až po korpuse: rok radu sa dopĺňa z dokladu s jeho posledným číslom.
      const rady = await ulozRadyZDokladov(tx, { ...scope, series: obsahy.flatMap((obsah) => obsah.series ?? []) });
      const preskocene: Record<string, number> = {};
      for (const agenda of body.manifest.agendy) {
        for (const [dovod, pocet] of Object.entries(agenda.preskocene)) preskocene[dovod] = (preskocene[dovod] ?? 0) + pocet;
      }
      vysledok = { ...historia, preskocene, rady };
    } else if (body.druh === 'pamat') {
      // „Neučiť sa z dodávateľa" žije len na riadkoch pamäte. Výmena importovaných
      // riadkov by rozhodnutie účtovníka potichu zrušila, preto sa zapamätá.
      const vylucene = (await tx.query<{ ico: string; nazov: string | null } & Record<string, unknown>>(
        `SELECT DISTINCT COALESCE(supplier_ico,'') AS ico, supplier_name_normalized AS nazov
           FROM ucto_decisions WHERE tenant_id=$1 AND organization_id=$2 AND excluded`,
        [tenantId, organizationId],
      )).rows;
      // Schválené rozhodnutia (source='approved') ostávajú — sú to tie cennejšie.
      await tx.query(`DELETE FROM ucto_decisions WHERE tenant_id=$1 AND organization_id=$2 AND source='import'`, [tenantId, organizationId]);
      const pamat = await ulozTreningoveRiadky(tx, {
        ...scope, rows: obsahy.flatMap((obsah) => obsah.rows as Array<z.infer<typeof trainingRowSchema>>),
        actor: { type: 'agent', id: input.agentId }, correlationId: input.correlationId,
      });
      // Tá istá identita ako POST ai-training/exclude: IČO, inak názov bez IČO.
      await tx.query(
        `UPDATE ucto_decisions SET excluded=true
          WHERE tenant_id=$1 AND organization_id=$2 AND source='import'
            AND (supplier_ico = ANY($3::text[])
              OR (COALESCE(supplier_ico,'')='' AND supplier_name_normalized = ANY($4::text[])))`,
        [tenantId, organizationId, vylucene.filter((row) => row.ico).map((row) => row.ico),
          vylucene.filter((row) => !row.ico && row.nazov).map((row) => row.nazov)],
      );
      vysledok = { imported: pamat.imported, duplicates: pamat.duplicates, rejected: pamat.rejected.length };
    } else {
      // Denník POHODA vracia za rok databázy (dateFrom/dateTill), preto sa mení
      // len ten rok. Id proviozky (act:id) je jedinečné iba v databáze — dva
      // ročníky ho môžu mať rovnaké, preto nesie jej meno.
      const rok = body.manifest.rok!;
      await tx.query(
        `DELETE FROM ucto_dennik WHERE tenant_id=$1 AND organization_id=$2
            AND datum >= make_date($3::int, 1, 1) AND datum < make_date($3::int + 1, 1, 1)`,
        [tenantId, organizationId, rok],
      );
      const dennik = await ulozDennik(tx, {
        ...scope,
        riadky: obsahy.flatMap((obsah) => (obsah.riadky as DennikRiadok[])
          .map((riadok) => ({ ...riadok, externalnyId: `${body.manifest.databaza}:${riadok.externalnyId}` }))),
      });
      vysledok = { ...dennik, preskocene: obsahy.reduce((sucet, obsah) => sucet + (obsah.preskocene ?? 0), 0) };
    }

    await tx.query(
      `UPDATE pohoda_importy SET stav='publikovany', published_at=now(), manifest=$2::jsonb, vysledok=$3::jsonb WHERE id=$1`,
      [importId, JSON.stringify(body.manifest), JSON.stringify(vysledok)],
    );
    await tx.query('DELETE FROM pohoda_import_davky WHERE import_id=$1', [importId]);
    await zapisBeh(tx, 'ok');
    await writeAudit(tx, {
      tenantId, organizationId, actorType: 'agent', actorId: input.agentId, action: 'pohoda_import.published',
      entityType: 'organization', entityId: organizationId, correlationId: input.correlationId,
      metadata: { importId, druh: body.druh, databaza: body.manifest.databaza, pocet: body.pocet, ...vysledok },
    });
    return { vysledok };
  });
  if ('zamietnute' in vystup) throw new HttpError(422, 'import_neuplny', `Prenos je neúplný: ${vystup.zamietnute}`);
  // Prax firmy (pravidlá, kódy kategórií, rozpis) sa prepočíta z novej histórie
  // až po COMMIT-e — worker by inak čítal starý korpus. Aj pri zopakovanej
  // publikácii: ak zápis jobu minule zlyhal, agent to skúsi znova. Čakajúci
  // job stačí jeden, prepočíta to isté.
  if (body.druh === 'historia') {
    await database.query(
      `INSERT INTO processing_jobs (id,tenant_id,organization_id,kind,status,max_attempts,correlation_id,payload)
       SELECT $1::text, $2::text, $3::text, $4::text, 'queued', 1, $5::text, '{}'::jsonb
        WHERE NOT EXISTS (SELECT 1 FROM processing_jobs
                           WHERE tenant_id=$2 AND organization_id=$3 AND kind=$4 AND status='queued')`,
      [randomUUID(), tenantId, organizationId, PREPOCET_PRAXE_KIND, input.correlationId],
    );
  }
  return vystup.vysledok;
}

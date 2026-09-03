import { randomUUID } from 'node:crypto';
import type { Queryable } from '../db/database.js';
import type { ParovacieKriterium } from './accountingProfileService.js';

// Partneri (kontrahenti) — automatické zakladanie z dokladov a párovanie
// dodávateľa podľa priority z účtovného profilu (IČO → IČ DPH → IBAN → názov).

export interface PartnerZaznam {
  id: string;
  tenantId: string;
  organizationId: string;
  nazov: string;
  ico?: string;
  dic?: string;
  icDph?: string;
  iban?: string;
  adresa?: string;
  email?: string;
  telefon?: string;
  predvolenaPredkontaciaId?: string;
  predvoleneClenenieDphId?: string;
  predvoleneStrediskoId?: string;
  poznamka?: string;
  source: 'auto' | 'manual';
  active: boolean;
  createdAt?: string;
  updatedAt?: string;
}

export interface DodavatelNaDoklade {
  nazov?: string;
  ico?: string;
  dic?: string;
  icDph?: string;
  iban?: string;
  adresa?: string;
}

export function normalizovanyNazov(value: string | undefined): string {
  return value?.trim().toLocaleLowerCase('sk').replace(/\s+/g, ' ') ?? '';
}

/**
 * Názov na porovnanie: bez medzier a interpunkcie.
 *
 * POHODA má v adresári „B.R.Pneumatici S.p.A.", na faktúre je „B.R. Pneumatici
 * S.p.A." — jediná medzera za bodkou. Prísne porovnanie ich nespojilo a
 * vznikli dve karty: stará prázdna z extrakcie a nová z adresára s IČ DPH.
 * Ďalšia faktúra by trafila tú prázdnu a nedoplnilo by sa nič.
 *
 * Dve firmy, ktoré sa líšia len interpunkciou, prakticky neexistujú; dve
 * karty tej istej firmy vznikajú stále.
 */
function kluceNazvu(value: string | undefined): string {
  return normalizovanyNazov(value).replace(/[^\p{L}\p{N}]/gu, '');
}

/** Koľko údajov karta nesie — pri zhode mien vyhráva vyplnenejšia. */
function vyplnenost(partner: PartnerZaznam): number {
  return [partner.ico, partner.dic, partner.icDph, partner.iban, partner.adresa]
    .filter((hodnota) => Boolean(hodnota?.trim())).length;
}

function cistyKod(value: string | undefined): string {
  return value?.replace(/\s+/g, '').toUpperCase() ?? '';
}

function cisteIco(value: string | undefined): string {
  return value?.replace(/\D/g, '') ?? '';
}

export function mapPartnerRow(row: Record<string, unknown>): PartnerZaznam {
  return {
    id: String(row.id),
    tenantId: String(row.tenant_id),
    organizationId: String(row.organization_id),
    nazov: String(row.name),
    ico: (row.ico as string | null) ?? undefined,
    dic: (row.dic as string | null) ?? undefined,
    icDph: (row.ic_dph as string | null) ?? undefined,
    iban: (row.iban as string | null) ?? undefined,
    adresa: (row.address as string | null) ?? undefined,
    email: (row.email as string | null) ?? undefined,
    telefon: (row.phone as string | null) ?? undefined,
    predvolenaPredkontaciaId: (row.default_predkontacia_id as string | null) ?? undefined,
    predvoleneClenenieDphId: (row.default_clenenie_dph_id as string | null) ?? undefined,
    predvoleneStrediskoId: (row.default_stredisko_id as string | null) ?? undefined,
    poznamka: (row.note as string | null) ?? undefined,
    source: row.source as PartnerZaznam['source'],
    active: row.active === true,
    createdAt: row.created_at ? new Date(String(row.created_at)).toISOString() : undefined,
    updatedAt: row.updated_at ? new Date(String(row.updated_at)).toISOString() : undefined,
  };
}

const PREDVOLENA_PRIORITA: ParovacieKriterium[] = ['ico', 'ic_dph', 'iban', 'nazov'];

async function prioritaParovania(
  tx: Queryable,
  tenantId: string,
  organizationId: string,
): Promise<ParovacieKriterium[]> {
  const profile = await tx.query<{ parovanie_dodavatelov?: ParovacieKriterium[] } & Record<string, unknown>>(
    'SELECT parovanie_dodavatelov FROM organization_accounting_profiles WHERE organization_id=$1 AND tenant_id=$2',
    [organizationId, tenantId],
  );
  const priorita = profile.rows[0]?.parovanie_dodavatelov;
  return Array.isArray(priorita) && priorita.length > 0 ? priorita : PREDVOLENA_PRIORITA;
}

/** Nájde aktívneho partnera podľa priority párovania z účtovného profilu. */
export async function najdiPartnera(
  tx: Queryable,
  tenantId: string,
  organizationId: string,
  dodavatel: DodavatelNaDoklade,
): Promise<PartnerZaznam | undefined> {
  const partneri = await tx.query<Record<string, unknown>>(
    'SELECT * FROM partners WHERE tenant_id=$1 AND organization_id=$2 AND active=true',
    [tenantId, organizationId],
  );
  if (partneri.rows.length === 0) return undefined;
  const zoznam = partneri.rows.map(mapPartnerRow);
  const priorita = await prioritaParovania(tx, tenantId, organizationId);
  for (const kriterium of priorita) {
    const zhody = zoznam.filter((partner) => {
      switch (kriterium) {
        case 'ico':
          return Boolean(cisteIco(dodavatel.ico)) && cisteIco(partner.ico) === cisteIco(dodavatel.ico);
        case 'ic_dph':
          return Boolean(cistyKod(dodavatel.icDph)) && cistyKod(partner.icDph) === cistyKod(dodavatel.icDph);
        case 'iban':
          return Boolean(cistyKod(dodavatel.iban)) && cistyKod(partner.iban) === cistyKod(dodavatel.iban);
        case 'nazov':
          return Boolean(kluceNazvu(dodavatel.nazov)) && kluceNazvu(partner.nazov) === kluceNazvu(dodavatel.nazov);
        default:
          return false;
      }
    });
    // Keď sedí viac kariet, vyhráva vyplnenejšia — prázdny duplikát z
    // extrakcie by inak prebil kartu z adresára a nedoplnilo by sa nič.
    if (zhody.length > 0) {
      return zhody.reduce((najlepsi, partner) => vyplnenost(partner) > vyplnenost(najlepsi) ? partner : najlepsi);
    }
  }
  return undefined;
}

/**
 * Založí partnera z dodávateľa na doklade, alebo doplní chýbajúce polia
 * existujúceho partnera (nikdy neprepisuje ručne vyplnené hodnoty).
 */
export async function upsertPartnerZDokladu(
  tx: Queryable,
  input: { tenantId: string; organizationId: string; dodavatel: DodavatelNaDoklade },
): Promise<PartnerZaznam | undefined> {
  const nazov = input.dodavatel.nazov?.trim();
  if (!nazov) return undefined;
  const existujuci = await najdiPartnera(tx, input.tenantId, input.organizationId, input.dodavatel);
  if (existujuci) {
    await tx.query(
      `UPDATE partners SET
         ico=COALESCE(ico, $1), dic=COALESCE(dic, $2), ic_dph=COALESCE(ic_dph, $3),
         iban=COALESCE(iban, $4), address=COALESCE(address, $5), updated_at=now()
       WHERE id=$6 AND tenant_id=$7`,
      [input.dodavatel.ico ?? null, input.dodavatel.dic ?? null, input.dodavatel.icDph ?? null,
        input.dodavatel.iban ?? null, input.dodavatel.adresa ?? null, existujuci.id, input.tenantId],
    );
    return existujuci;
  }
  const id = randomUUID();
  await tx.query(
    `INSERT INTO partners
      (id, tenant_id, organization_id, name, name_normalized, ico, dic, ic_dph, iban, address, source)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'auto')`,
    [id, input.tenantId, input.organizationId, nazov, normalizovanyNazov(nazov),
      input.dodavatel.ico ?? null, input.dodavatel.dic ?? null, input.dodavatel.icDph ?? null,
      input.dodavatel.iban ?? null, input.dodavatel.adresa ?? null],
  );
  const created = await tx.query<Record<string, unknown>>(
    'SELECT * FROM partners WHERE id=$1 AND tenant_id=$2', [id, input.tenantId],
  );
  return created.rows[0] ? mapPartnerRow(created.rows[0]) : undefined;
}

/** Jeden riadok adresára POHODY tak, ako ho pošle Mostík. */
export interface AdresarRiadok {
  nazov: string;
  ico?: string;
  dic?: string;
  icDph?: string;
  ulica?: string;
  mesto?: string;
  psc?: string;
  krajina?: string;
}

function adresaZRiadku(riadok: AdresarRiadok): string | undefined {
  const casti = [riadok.ulica, [riadok.psc, riadok.mesto].filter(Boolean).join(' '), riadok.krajina]
    .map((cast) => cast?.trim()).filter(Boolean);
  return casti.length > 0 ? casti.join(', ') : undefined;
}

/**
 * Adresár POHODY do kariet partnerov.
 *
 * Na rozdiel od `upsertPartnerZDokladu` sa tu údaje PREPISUJÚ, nie dopĺňajú:
 * adresár je to, čo účtovník o firme sám zadal, a je autorita. Karta vzniknutá
 * z extrakcie môže mať IČ DPH prečítané z nezvyklého blanketu nesprávne alebo
 * (ako pri talianskej faktúre) vôbec.
 *
 * Predvoľby zaúčtovania sa netýkajú — tie patria Dokladovke, nie POHODE.
 */
export async function importujAdresar(
  tx: Queryable,
  scope: { tenantId: string; organizationId: string },
  riadky: AdresarRiadok[],
): Promise<{ vytvorene: number; aktualizovane: number; preskocene: number }> {
  const vysledok = { vytvorene: 0, aktualizovane: 0, preskocene: 0 };
  for (const riadok of riadky) {
    const nazov = riadok.nazov?.trim();
    if (!nazov) { vysledok.preskocene += 1; continue; }
    const existujuci = await najdiPartnera(tx, scope.tenantId, scope.organizationId, {
      nazov, ico: riadok.ico, icDph: riadok.icDph,
    });
    const hodnoty = [riadok.ico ?? null, riadok.dic ?? null, riadok.icDph ?? null, adresaZRiadku(riadok) ?? null];
    if (existujuci) {
      await tx.query(
        `UPDATE partners SET
           ico=COALESCE($1, ico), dic=COALESCE($2, dic), ic_dph=COALESCE($3, ic_dph),
           address=COALESCE($4, address), updated_at=now()
         WHERE id=$5 AND tenant_id=$6`,
        [...hodnoty, existujuci.id, scope.tenantId],
      );
      vysledok.aktualizovane += 1;
      continue;
    }
    await tx.query(
      `INSERT INTO partners
        (id, tenant_id, organization_id, name, name_normalized, ico, dic, ic_dph, address, source)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'auto')`,
      [randomUUID(), scope.tenantId, scope.organizationId, nazov, normalizovanyNazov(nazov), ...hodnoty],
    );
    vysledok.vytvorene += 1;
  }
  return vysledok;
}

/**
 * Doplní o dodávateľovi to, čo sa z dokladu nedalo prečítať.
 *
 * Karta partnera nesie údaje z adresára POHODY — teda to, čo účtovník o firme
 * sám zadal. Talianska faktúra tlačí v poli „Partita IVA" číslo ODBERATEĽA
 * a dodávateľovo má v drobnej hlavičke medzi Cap Soc. a REA; model radšej
 * nechal prázdno, než by priradil cudzie. Hádať z blanketu netreba, keď je
 * odpoveď v adresári.
 *
 * Dopĺňa sa LEN to, čo chýba: čo je na doklade, má prednosť — firma mohla
 * medzitým zmeniť adresu a faktúra je novšia ako karta.
 */
export async function doplnZKartyPartnera(
  tx: Queryable,
  scope: { tenantId: string; organizationId: string },
  dodavatel: { nazov?: string; ico?: string; dic?: string; icDph?: string; iban?: string; adresa?: string },
): Promise<Partial<Record<'ico' | 'dic' | 'icDph' | 'adresa', string>> | undefined> {
  if (!dodavatel.nazov?.trim()) return undefined;
  if (dodavatel.ico && dodavatel.dic && dodavatel.icDph && dodavatel.adresa) return undefined;
  const partner = await najdiPartnera(tx, scope.tenantId, scope.organizationId, dodavatel);
  if (!partner) return undefined;
  const doplnene: Partial<Record<'ico' | 'dic' | 'icDph' | 'adresa', string>> = {};
  if (!dodavatel.ico && partner.ico) doplnene.ico = partner.ico;
  if (!dodavatel.dic && partner.dic) doplnene.dic = partner.dic;
  if (!dodavatel.icDph && partner.icDph) doplnene.icDph = partner.icDph;
  if (!dodavatel.adresa && partner.adresa) doplnene.adresa = partner.adresa;
  return Object.keys(doplnene).length > 0 ? doplnene : undefined;
}

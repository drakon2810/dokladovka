-- Hlavičky a väzby dokladov histórie z Mostíka (protokol 3).
--
-- Riadok korpusu (ucto_historia) nesie len dátum vystavenia a sumy položiek.
-- Dátum dane, účtovania, dodania a KV, číslo dokladu dodávateľa, opravovaný
-- doklad, symboly, mena s kurzom a súhrn podľa sadzieb patria dokladu — bez
-- nich sa samozdanenie, opravy ani párovanie nedajú overiť na skutočných
-- väzbách, len na zhode súm. Väzby (linkedDocuments) a likvidácie POHODA dáva
-- iba exportom, preto sa čítajú odtiaľ.
--
-- Natívne id je jedinečné v tabuľke agendy (faktúra/pokladňa/interný doklad)
-- jednej databázy POHODY, tá je jeden účtovný rok. Publikácia prenosu vymení
-- hlavičky a väzby svojej databázy celé, takže opakovaný prenos nič nezdvojí.
CREATE TABLE ucto_historia_doklady (
  tenant_id text NOT NULL REFERENCES tenants(id),
  organization_id text NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  zdroj_databaza text NOT NULL,
  rok integer NOT NULL,
  tabulka text NOT NULL CHECK (tabulka IN ('invoice', 'voucher', 'intDoc')),
  pohoda_doklad_id bigint NOT NULL,
  agenda text NOT NULL,
  doklad_cislo text,
  datum date,
  datum_dane date,
  datum_uctovania date,
  datum_dodania date,
  datum_kv_dph date,
  datum_uplatnenia_dph date,
  -- originalDocument: číslo dokladu dodávateľa (paragón). Nie je to VS.
  externe_cislo text,
  -- originalDocumentNumber: doklad, ktorý dobropis/interný doklad opravuje.
  opravovany_doklad text,
  var_symbol text,
  par_symbol text,
  -- NULL = domáca mena. Kurz je za kurz_mnozstvo jednotiek meny.
  mena text,
  kurz numeric,
  kurz_mnozstvo integer,
  suma_mena numeric,
  -- Súhrn v domácej mene podľa sadzieb POHODY (priceNone/Low/High/3).
  zaklad_nulova numeric,
  zaklad_znizena numeric,
  dph_znizena numeric,
  sadzba_znizena numeric,
  zaklad_zakladna numeric,
  dph_zakladna numeric,
  sadzba_zakladna numeric,
  zaklad_3 numeric,
  dph_3 numeric,
  sadzba_3 numeric,
  zaokruhlenie numeric,
  PRIMARY KEY (tenant_id, organization_id, zdroj_databaza, rok, tabulka, pohoda_doklad_id)
);

-- typ: link (doklad vznikol prenosom), manualLink (ručná väzba), liquidation
-- (likvidácia so sumou). Druhý doklad podľa POHODY: agenda, id a číslo.
CREATE TABLE ucto_historia_vazby (
  tenant_id text NOT NULL,
  organization_id text NOT NULL,
  zdroj_databaza text NOT NULL,
  rok integer NOT NULL,
  tabulka text NOT NULL,
  pohoda_doklad_id bigint NOT NULL,
  poradie integer NOT NULL,
  typ text NOT NULL CHECK (typ IN ('link', 'manualLink', 'liquidation')),
  druha_agenda text,
  druhy_doklad_id bigint,
  druhy_doklad_cislo text,
  likvidacia_id bigint,
  datum date,
  suma numeric,
  suma_mena numeric,
  PRIMARY KEY (tenant_id, organization_id, zdroj_databaza, rok, tabulka, pohoda_doklad_id, poradie),
  FOREIGN KEY (tenant_id, organization_id, zdroj_databaza, rok, tabulka, pohoda_doklad_id)
    REFERENCES ucto_historia_doklady ON DELETE CASCADE
);

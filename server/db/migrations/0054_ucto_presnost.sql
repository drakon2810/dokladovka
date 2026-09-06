-- Meranie presnosti: čo by AI navrhla na dokladoch, ktoré účtovník už zaúčtoval.
--
-- Doteraz sme presnosť posudzovali po jednom doklade — Print-Office, Up
-- Déjeuner. To sú dva doklady z troch tisíc a opravovalo sa to, čo padlo do
-- oka. Bez čísla za celú firmu sa nedá povedať ani to, či je zmena zlepšením.
--
-- Beh drží vzorku a výsledok po agendách: presnosť predkontácie, členenia DPH,
-- sekcie KV, číselného radu a rozpisu na položky ZVLÁŠŤ. Jedno súhrnné číslo
-- klame — 99 % na predkontácii a 20 % na rozpise dá „priemer 87 %", ktorý
-- nehovorí nič o tom, kde je práca.
CREATE TABLE ucto_presnost (
  id text PRIMARY KEY,
  tenant_id text NOT NULL REFERENCES tenants(id),
  organization_id text NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  -- Doklady sa berú od tohto dátumu, história len spred neho. Delenie časom,
  -- nie náhodou: presne tak sa doklad spracúva aj v praxi — s tým, čo firma
  -- vedela PREDTÝM.
  delici_datum date NOT NULL,
  vzorka integer NOT NULL,
  -- Po agendách: {FP: {dokladov, predkontacia, clenenieDph, kv, rad, rozpis}}
  vysledok jsonb NOT NULL,
  -- Doklady, kde sa návrh rozišiel so skutočnosťou — to je pracovný zoznam.
  rozdiely jsonb NOT NULL DEFAULT '[]'::jsonb,
  trvanie_ms integer,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ucto_presnost_org_idx ON ucto_presnost (tenant_id, organization_id, created_at DESC);

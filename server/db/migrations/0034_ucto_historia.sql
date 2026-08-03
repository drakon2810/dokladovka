-- Účtovný profil firmy, časť 1: surový korpus histórie zaúčtovaní.
--
-- ucto_decisions je PAMÄŤ podľa dodávateľa (kľúč = dodávateľ + text) a používa
-- sa pri návrhu na doklade. Táto tabuľka je niečo iné: úplná história POHODY
-- po RIADKOCH a cez všetky agendy, ktorá slúži ako korpus pre jednorazovú
-- analýzu (kategórie plnení). Preto samostatná tabuľka — nemieša sa do cesty,
-- ktorá beží pri každom doklade.
--
-- Kódy sa ukladajú AJ nerozpoznané (predkontacia_id je NULL, kód ostáva):
-- pri tréningovom importe sa riadok s neznámym kódom zahadzuje, čo je pre
-- pamäť správne, ale pre analýzu by ticho zmizla časť praxe firmy.
CREATE TABLE ucto_historia (
  id text PRIMARY KEY,
  tenant_id text NOT NULL REFERENCES tenants(id),
  organization_id text NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  agenda text NOT NULL,
  doklad_cislo text,
  datum date,
  supplier_ico text,
  supplier_name_normalized text,
  line_text_normalized text NOT NULL,
  suma numeric(18,2),
  sadzba_dph numeric(6,2),
  predkontacia_kod text,
  predkontacia_id text,
  clenenie_dph_kod text,
  clenenie_dph_id text,
  clenenie_kv_kod text,
  stredisko_kod text,
  stredisko_id text,
  source text NOT NULL CHECK (source IN ('mdb', 'agent', 'decisions')),
  riadok_hash text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
-- Opakovaný import tej istej histórie nezakladá duplicity.
CREATE UNIQUE INDEX ucto_historia_dedup ON ucto_historia (organization_id, riadok_hash);
CREATE INDEX ucto_historia_org_agenda ON ucto_historia (organization_id, agenda);
CREATE INDEX ucto_historia_org_dodavatel ON ucto_historia (organization_id, supplier_ico);

-- Časť 2: kategórie plnení — výsledok jednorazovej analýzy korpusu.
-- Toto je to, čo sa z histórie „naučí": nie „dodávateľ X → účet Y" (to sa na
-- nového dodávateľa nezovšeobecní), ale „tento druh plnenia → takto ho firma
-- účtuje", vrátane slovníka, výnimiek a DPH podľa situácie.
CREATE TABLE ucto_kategorie (
  id text PRIMARY KEY,
  tenant_id text NOT NULL REFERENCES tenants(id),
  organization_id text NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  nazov text NOT NULL,
  popis text,
  slovnik jsonb NOT NULL DEFAULT '[]'::jsonb,
  predkontacia_kod text,
  predkontacia_id text,
  clenenie_dph_kod text,
  clenenie_dph_id text,
  clenenie_kv_kod text,
  vynimky jsonb NOT NULL DEFAULT '[]'::jsonb,
  agendy jsonb NOT NULL DEFAULT '[]'::jsonb,
  pocet integer NOT NULL DEFAULT 0,
  konflikt text,
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ucto_kategorie_org ON ucto_kategorie (organization_id) WHERE active;

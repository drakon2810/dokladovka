-- Prax banky z účtovného denníka: partner (IČO, inak meno) alebo opakované
-- slová textu + smer → protiúčet a banková predkontácia firmy. Prepočet praxe
-- prepisuje len navrhnuté; potvrdené a zamietnuté dostanú iba čerstvý dôkaz.
-- Kód predkontácie sa ukladá ako KÓD (id sa pri importe číselníkov mení).
CREATE TABLE banka_prax (
  id text PRIMARY KEY,
  organization_id text NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  tenant_id text NOT NULL REFERENCES tenants(id),
  -- 'ico:<ičo>:<smer>', 'meno:<meno>:<smer>' alebo 'text:<slová>:<smer>'.
  kluc text NOT NULL,
  smer text NOT NULL CHECK (smer IN ('prijem', 'vydaj')),
  partner_ico text,
  -- Normalizované mená partnera, najčastejšie prvé — pohyb výpisu IČO nenesie.
  partner_mena text[] NOT NULL DEFAULT '{}',
  slova text[] NOT NULL DEFAULT '{}',
  stav text NOT NULL CHECK (stav IN ('navrhnute', 'potvrdene', 'zamietnute')),
  protiucet text NOT NULL,
  -- NULL = viac kandidátov alebo žiadny; automaticky sa nevyberá.
  predkontacia_kod text,
  -- { riadkov, podiel, od, do, protiucet, kandidati[] } z posledného prepočtu; NULL = história prax už nedrží.
  dokaz jsonb,
  potvrdil text REFERENCES users(id),
  potvrdene_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (organization_id, kluc)
);
CREATE INDEX banka_prax_tenant ON banka_prax (tenant_id);

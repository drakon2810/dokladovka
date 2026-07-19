-- Účtovný profil klienta (2. časť profilu): obdobie účtovania, zaokrúhľovanie,
-- priorita párovania dodávateľov a účtovný rozvrh s analytikami. Jeden profil
-- na organizáciu, rovnaký vzor ako organization_dph_profiles.
CREATE TABLE organization_accounting_profiles (
  organization_id text PRIMARY KEY REFERENCES organizations(id),
  tenant_id text NOT NULL REFERENCES tenants(id),
  obdobie_uctovania text NOT NULL DEFAULT 'mesacne'
    CHECK (obdobie_uctovania IN ('mesacne', 'stvrtrocne')),
  -- Zaokrúhľovanie celkovej sumy dokladu a DPH.
  zaokruhlovanie_celkom text NOT NULL DEFAULT 'centy'
    CHECK (zaokruhlovanie_celkom IN ('centy', 'pat_centov', 'eura')),
  zaokruhlovanie_dph text NOT NULL DEFAULT 'matematicky'
    CHECK (zaokruhlovanie_dph IN ('matematicky', 'nahor', 'nadol')),
  -- Priorita polí pri párovaní dodávateľa: ["ico","ic_dph","iban","nazov"].
  parovanie_dodavatelov jsonb NOT NULL DEFAULT '["ico","ic_dph","iban","nazov"]'::jsonb,
  -- Účtovný rozvrh: [{ucet, nazov, analytiky: ["01","02",...]}].
  uctovny_rozvrh jsonb NOT NULL DEFAULT '[]'::jsonb,
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by text REFERENCES users(id)
);

CREATE INDEX organization_accounting_profiles_tenant_idx
  ON organization_accounting_profiles (tenant_id);

-- DPH profil klienta (na organizáciu): platiteľstvo, obdobie DPH, koeficient,
-- pomerné odpočítanie, režim, pravidlá pre autá, kategórie bez nároku na
-- odpočet a samozdanenie. Jeden profil na organizáciu. Pravidlá s kľúčovými
-- slovami vyhodnocuje server (dphAdvisor) pri extrakcii aj pri schvaľovaní.
CREATE TABLE organization_dph_profiles (
  organization_id text PRIMARY KEY REFERENCES organizations(id),
  tenant_id text NOT NULL REFERENCES tenants(id),
  platitel_dph text NOT NULL DEFAULT 'platitel'
    CHECK (platitel_dph IN ('platitel', 'neplatitel', 'registracia_7a')),
  obdobie_dph text NOT NULL DEFAULT 'mesacne'
    CHECK (obdobie_dph IN ('mesacne', 'stvrtrocne')),
  -- Posledné už podané DPH obdobie (koniec obdobia) — DUZP pred týmto dátumom
  -- znamená kandidáta na dodatočné priznanie.
  uzavrete_do date,
  -- História koeficientov: [{rok, typ: 'zalohovy'|'rocny', hodnota, platnostOd?, platnostDo?}]
  koeficient jsonb NOT NULL DEFAULT '[]'::jsonb,
  -- Pravidlá pomerného odpočítania: [{kategoria, percento, klucoveSlova: []}]
  pomerne_odpocitanie jsonb NOT NULL DEFAULT '[]'::jsonb,
  rezim text NOT NULL DEFAULT 'tuzemsky' CHECK (rezim IN ('tuzemsky', 'zahranicny')),
  nakupy_z_eu boolean NOT NULL DEFAULT false,
  sluzby_z_eu boolean NOT NULL DEFAULT false,
  -- Tuzemské prenesenie daňovej povinnosti (§69).
  prenesenie_dp boolean NOT NULL DEFAULT false,
  -- Pravidlá pre vozidlá: [{kategoria, percento, klucoveSlova: []}], napr. PHM 80 %.
  pravidla_aut jsonb NOT NULL DEFAULT '[]'::jsonb,
  -- Kategórie bez nároku na odpočet: [{kategoria, klucoveSlova: []}].
  bez_naroku jsonb NOT NULL DEFAULT '[]'::jsonb,
  samozdanenie_aktivne boolean NOT NULL DEFAULT false,
  -- Predvolené členenie DPH a sekcia KV pre samozdanenie (id/kód z číselníkov;
  -- bez FK — položky číselníkov sa pri importe z POHODY menia, platnosť
  -- overuje server pri zápise aj pri použití).
  samozdanenie_clenenie_dph_id text,
  samozdanenie_clenenie_kv_kod text,
  -- Členenie bez odpočtu pre neplatiteľa / registráciu §7a.
  clenenie_bez_odpoctu_id text,
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by text REFERENCES users(id)
);

CREATE INDEX organization_dph_profiles_tenant_idx ON organization_dph_profiles (tenant_id);

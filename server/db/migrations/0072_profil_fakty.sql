-- Profil klienta ako katalóg faktov: každý fakt má jednu aktuálnu hodnotu
-- a stav. Engine používa len potvrdené; navrhnuté z histórie sa len ukazujú.
-- Kódy POHODY sa ukladajú ako KÓDY (code_list_items.code), nie id — id sa pri
-- importe číselníkov mení. potvrdene_at slúži len meraniu presnosti (knownAt).
CREATE TABLE profil_fakty (
  organization_id text NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  tenant_id text NOT NULL REFERENCES tenants(id),
  kluc text NOT NULL,
  stav text NOT NULL CHECK (stav IN ('potvrdene', 'navrhnute', 'nepouziva_sa')),
  -- Potvrdená alebo navrhnutá hodnota; pri nepouziva_sa NULL.
  hodnota jsonb,
  zdroj text NOT NULL CHECK (zdroj IN ('historia', 'uctovnik', 'migracia')),
  -- Posledný dôkaz z histórie (aj pri potvrdenom) — z neho sa pozná rozpor.
  dokaz jsonb,
  potvrdil text REFERENCES users(id),
  potvrdene_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (organization_id, kluc)
);
CREATE INDEX profil_fakty_tenant ON profil_fakty (tenant_id);

-- Otázky účtovníkovi na úrovni firmy. Identita je kľúč, nie id pravidla
-- (ucto_pravidla.id sa pri každom prepočte mení): 'fakt:<kluc faktu>' alebo
-- 'spor:<agenda>:<protistrana>'.
CREATE TABLE profil_otazky (
  id text PRIMARY KEY,
  tenant_id text NOT NULL REFERENCES tenants(id),
  organization_id text NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  kluc text NOT NULL,
  druh text NOT NULL CHECK (druh IN ('fakt', 'spor_protistrany')),
  stav text NOT NULL CHECK (stav IN ('otvorena', 'odlozena', 'zodpovedana', 'zastarana')),
  blokuje boolean NOT NULL DEFAULT false,
  dokladov integer NOT NULL DEFAULT 0,
  data jsonb NOT NULL,
  odpoved jsonb,
  odpovedal text REFERENCES users(id),
  odpovedane_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (organization_id, kluc)
);

-- Dáta zo starého profilu. Platiteľstvo nikto nepotvrdil (predvolené bolo
-- „platiteľ"), preto len návrh; história ho aj tak navrhne znova.
INSERT INTO profil_fakty (organization_id, tenant_id, kluc, stav, hodnota, zdroj, updated_at)
SELECT organization_id, tenant_id, 'dph.status', 'navrhnute', jsonb_build_object('status', platitel_dph), 'migracia', updated_at
  FROM organization_dph_profiles;

-- Pravidlá áut: id predkontácií a členení sa preložia na kódy; pravidlo, ktoré
-- sa preložiť nedá (alebo nemá kľúčové slovo), by schémou faktu neprešlo.
INSERT INTO profil_fakty (organization_id, tenant_id, kluc, stav, hodnota, zdroj, potvrdil, potvrdene_at, updated_at)
SELECT d.organization_id, d.tenant_id, 'vozidla.pravidla', 'potvrdene', r.hodnota, 'migracia', d.updated_by, d.updated_at, d.updated_at
  FROM organization_dph_profiles d
  CROSS JOIN LATERAL (
    SELECT jsonb_agg(jsonb_strip_nulls(jsonb_build_object(
             'nazov', p->>'kategoria',
             'klucoveSlova', p->'klucoveSlova',
             'percentoZakladu', p->'percento',
             'percentoDph', coalesce(p->'percentoDph', p->'percento'),
             'predkontaciaKod', btrim(pk.code),
             'predkontaciaNedanovaKod', btrim(pn.code),
             'clenenieDphNedanoveKod', btrim(cl.code))) ORDER BY e.i) AS hodnota
      FROM jsonb_array_elements(d.pravidla_aut) WITH ORDINALITY AS e(p, i)
      JOIN code_list_items pk ON pk.id = p->>'predkontaciaId' AND pk.kind = 'predkontacie' AND pk.organization_id = d.organization_id
      JOIN code_list_items pn ON pn.id = p->>'predkontaciaNedanovaId' AND pn.kind = 'predkontacie' AND pn.organization_id = d.organization_id
      LEFT JOIN code_list_items cl ON cl.id = p->>'clenenieDphNedanoveId' AND cl.kind = 'cleneniaDph' AND cl.organization_id = d.organization_id
     WHERE jsonb_array_length(coalesce(p->'klucoveSlova', '[]'::jsonb)) > 0
       AND (p->>'clenenieDphNedanoveId' IS NULL OR cl.id IS NOT NULL)
  ) r
 WHERE r.hodnota IS NOT NULL;

-- Pomerné odpočítanie: obe časti na tom istom účte, nedaňová s neodpočtovým členením.
INSERT INTO profil_fakty (organization_id, tenant_id, kluc, stav, hodnota, zdroj, potvrdil, potvrdene_at, updated_at)
SELECT d.organization_id, d.tenant_id, 'naklady.pomerne', 'potvrdene', r.hodnota, 'migracia', d.updated_by, d.updated_at, d.updated_at
  FROM organization_dph_profiles d
  CROSS JOIN LATERAL (
    SELECT jsonb_agg(jsonb_build_object(
             'nazov', p->>'kategoria',
             'klucoveSlova', p->'klucoveSlova',
             'percentoDph', coalesce(p->'percentoDph', p->'percento'),
             'predkontaciaKod', btrim(pk.code),
             'clenenieDphNedanoveKod', btrim(cl.code)) ORDER BY e.i) AS hodnota
      FROM jsonb_array_elements(d.pomerne_odpocitanie) WITH ORDINALITY AS e(p, i)
      JOIN code_list_items pk ON pk.id = p->>'predkontaciaId' AND pk.kind = 'predkontacie' AND pk.organization_id = d.organization_id
      JOIN code_list_items cl ON cl.id = p->>'clenenieDphNedanoveId' AND cl.kind = 'cleneniaDph' AND cl.organization_id = d.organization_id
     WHERE jsonb_array_length(coalesce(p->'klucoveSlova', '[]'::jsonb)) > 0
       AND coalesce(p->>'percentoDph', p->>'percento')::numeric BETWEEN 1 AND 99
  ) r
 WHERE r.hodnota IS NOT NULL;

INSERT INTO profil_fakty (organization_id, tenant_id, kluc, stav, hodnota, zdroj, potvrdil, potvrdene_at, updated_at)
SELECT d.organization_id, d.tenant_id, 'dph.clenenie_bez_odpoctu', 'potvrdene', jsonb_build_object('clenenieKod', btrim(c.code)),
       'migracia', d.updated_by, d.updated_at, d.updated_at
  FROM organization_dph_profiles d
  JOIN code_list_items c ON c.id = d.clenenie_bez_odpoctu_id AND c.kind = 'cleneniaDph' AND c.organization_id = d.organization_id;

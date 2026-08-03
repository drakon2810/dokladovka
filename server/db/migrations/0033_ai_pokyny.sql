-- Pravidlá pre AI písané textom (nie číselníkmi): globálne od správcu platformy
-- a lokálne od účtovníka firmy. Idú do promptu extrakcie aj návrhu zaúčtovania.
-- Globálne pravidlo nemá tenanta ani organizáciu — platí pre všetky firmy.
CREATE TABLE ai_instructions (
  id text PRIMARY KEY,
  scope text NOT NULL CHECK (scope IN ('global','organization')),
  tenant_id text REFERENCES tenants(id),
  organization_id text REFERENCES organizations(id) ON DELETE CASCADE,
  nazov text NOT NULL,
  text text NOT NULL,
  -- Do ktorej fázy pravidlo patrí: čítanie dokladu, návrh zaúčtovania, alebo obe.
  faza text NOT NULL DEFAULT 'both' CHECK (faza IN ('extraction','accounting','both')),
  -- Prázdne pole = pravidlo platí pre všetky typy dokladov.
  typy_dokladov jsonb NOT NULL DEFAULT '[]'::jsonb,
  klucove_slova jsonb NOT NULL DEFAULT '[]'::jsonb,
  priorita integer NOT NULL DEFAULT 100,
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by text REFERENCES users(id),
  CONSTRAINT ai_instructions_scope_ciel CHECK (
    (scope = 'global' AND tenant_id IS NULL AND organization_id IS NULL)
    OR (scope = 'organization' AND tenant_id IS NOT NULL AND organization_id IS NOT NULL)
  )
);
CREATE INDEX ai_instructions_org_idx ON ai_instructions (organization_id) WHERE scope = 'organization';
CREATE INDEX ai_instructions_global_idx ON ai_instructions (priorita) WHERE scope = 'global';

-- Správca platformy: píše globálne pravidlá a nemá prístup k dátam firiem
-- (nemá členstvo v žiadnej organizácii, takže requireOrganizationAccess ho
-- odmietne, a v requireRole nie je uvedený nikde inde). Účet môže byť len jeden.
ALTER TABLE users DROP CONSTRAINT IF EXISTS users_role_check;
ALTER TABLE users ADD CONSTRAINT users_role_check
  CHECK (role IN ('uctovnik', 'schvalovatel', 'admin', 'superadmin'));
CREATE UNIQUE INDEX users_jediny_superadmin ON users ((role)) WHERE role = 'superadmin';

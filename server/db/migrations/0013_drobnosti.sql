-- Drobné rozšírenia: typ subjektu (FO nepodnikateľ), adresa po častiach,
-- whitelist odosielateľov na organizáciu, preddefinované poznámky
-- a e-mailové šablóny.
ALTER TABLE organizations ADD COLUMN subject_type text NOT NULL DEFAULT 'company'
  CHECK (subject_type IN ('company', 'fo_nepodnikatel'));
ALTER TABLE organizations ADD COLUMN street text;
ALTER TABLE organizations ADD COLUMN city text;
ALTER TABLE organizations ADD COLUMN zip text;
ALTER TABLE organizations ADD COLUMN country text;
-- Whitelist odosielateľov: [] = prijíma sa všetko; inak e-maily od iných
-- odosielateľov končia v karanténe (sender_not_whitelisted).
ALTER TABLE organizations ADD COLUMN sender_whitelist jsonb NOT NULL DEFAULT '[]'::jsonb;

-- Preddefinované poznámky pre pole „poznámka“ na doklade.
CREATE TABLE note_templates (
  id text PRIMARY KEY,
  tenant_id text NOT NULL REFERENCES tenants(id),
  organization_id text NOT NULL REFERENCES organizations(id),
  text text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by text REFERENCES users(id)
);
CREATE INDEX note_templates_scope_idx ON note_templates (tenant_id, organization_id);

-- E-mailové šablóny (predmet + telo) pre komunikáciu s klientom.
CREATE TABLE email_templates (
  id text PRIMARY KEY,
  tenant_id text NOT NULL REFERENCES tenants(id),
  organization_id text NOT NULL REFERENCES organizations(id),
  name text NOT NULL,
  subject text NOT NULL,
  body text NOT NULL,
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by text REFERENCES users(id)
);
CREATE INDEX email_templates_scope_idx ON email_templates (tenant_id, organization_id);

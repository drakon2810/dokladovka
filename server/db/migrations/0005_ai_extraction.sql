CREATE TABLE accounting_rules (
  id text PRIMARY KEY,
  tenant_id text NOT NULL REFERENCES tenants(id),
  organization_id text NOT NULL REFERENCES organizations(id),
  supplier_ico text,
  supplier_name_normalized text,
  predkontacia_id text,
  clenenie_dph_id text,
  ciselny_rad_id text,
  stredisko_id text,
  priority integer NOT NULL DEFAULT 100,
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE documents
  ADD COLUMN applied_extraction_run_id text REFERENCES extraction_runs(id);
CREATE INDEX accounting_rules_scope_idx
  ON accounting_rules (tenant_id, organization_id, active, priority);

CREATE TABLE organization_accounting_defaults (
  organization_id text PRIMARY KEY REFERENCES organizations(id),
  tenant_id text NOT NULL REFERENCES tenants(id),
  predkontacia_id text,
  clenenie_dph_id text,
  ciselny_rad_id text,
  stredisko_id text,
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX organization_accounting_defaults_scope_idx
  ON organization_accounting_defaults (tenant_id, organization_id);

CREATE TABLE accounting_suggestions (
  document_id text PRIMARY KEY REFERENCES documents(id) ON DELETE CASCADE,
  tenant_id text NOT NULL REFERENCES tenants(id),
  organization_id text NOT NULL REFERENCES organizations(id),
  predkontacia_id text,
  clenenie_dph_id text,
  ciselny_rad_id text,
  stredisko_id text,
  source text NOT NULL CHECK (source IN ('manual_rule','supplier_history','organization_default','ai','none')),
  confidence numeric(5,4) NOT NULL DEFAULT 0,
  reason text NOT NULL,
  based_on_document_id text REFERENCES documents(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX accounting_suggestions_scope_idx
  ON accounting_suggestions (tenant_id, organization_id, document_id);

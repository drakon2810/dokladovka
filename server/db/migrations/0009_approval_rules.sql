-- Schvaľovanie podľa sumy (vzor Doklado): doklady od prahu musí schváliť
-- vyhradená rola. Jedno pravidlo na organizáciu.
CREATE TABLE approval_rules (
  organization_id text PRIMARY KEY REFERENCES organizations(id),
  tenant_id text NOT NULL REFERENCES tenants(id),
  min_amount numeric(18,2) NOT NULL CHECK (min_amount >= 0),
  required_role text NOT NULL CHECK (required_role IN ('admin', 'schvalovatel')),
  active boolean NOT NULL DEFAULT true,
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by text REFERENCES users(id)
);
CREATE INDEX approval_rules_tenant_idx ON approval_rules (tenant_id);

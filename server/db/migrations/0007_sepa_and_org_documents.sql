-- SEPA camt.053 výpisy ako ďalší deterministický provider.
ALTER TABLE extraction_runs DROP CONSTRAINT extraction_runs_provider_check;
ALTER TABLE extraction_runs ADD CONSTRAINT extraction_runs_provider_check
  CHECK (provider IN ('mock', 'openai', 'peppol', 'sepa'));

-- Schránka organizácie: voľné dokumenty (PDF a pod.) mimo účtovného workflow.
CREATE TABLE organization_documents (
  id text PRIMARY KEY,
  tenant_id text NOT NULL REFERENCES tenants(id),
  organization_id text NOT NULL REFERENCES organizations(id),
  file_name text NOT NULL,
  mime_type text NOT NULL,
  byte_size bigint NOT NULL,
  sha256 text NOT NULL,
  storage_key text NOT NULL,
  uploaded_by text REFERENCES users(id),
  note text,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX organization_documents_scope_idx
  ON organization_documents (tenant_id, organization_id, created_at DESC);

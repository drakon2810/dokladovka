-- Platobný kontúr: úhrady dokladov (manuálne aj automaticky spárované z výpisu).
CREATE TABLE document_payments (
  id text PRIMARY KEY,
  tenant_id text NOT NULL REFERENCES tenants(id),
  organization_id text NOT NULL REFERENCES organizations(id),
  document_id text NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  amount numeric(18,2) NOT NULL,
  currency text NOT NULL,
  paid_on date NOT NULL,
  source text NOT NULL CHECK (source IN ('manual', 'bank_statement')),
  bank_statement_document_id text REFERENCES documents(id),
  note text,
  created_by text REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX document_payments_scope_idx
  ON document_payments (tenant_id, organization_id, document_id);
CREATE INDEX document_payments_statement_idx
  ON document_payments (bank_statement_document_id);

-- Rozšírenie číselníkov: členenie KV a analytické dimenzie (zákazky, činnosti, projekty).
ALTER TABLE code_list_items DROP CONSTRAINT code_list_items_kind_check;
ALTER TABLE code_list_items ADD CONSTRAINT code_list_items_kind_check
  CHECK (kind IN ('predkontacie','cleneniaDph','ciselneRady','strediska','clenenieKv','zakazky','cinnosti','projekty'));

CREATE TABLE tenants (
  id text PRIMARY KEY,
  name text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE users (
  id text PRIMARY KEY,
  tenant_id text NOT NULL REFERENCES tenants(id),
  name text NOT NULL,
  email text NOT NULL,
  password_hash text NOT NULL,
  role text NOT NULL CHECK (role IN ('uctovnik', 'schvalovatel', 'admin')),
  language text NOT NULL DEFAULT 'sk',
  notifications jsonb NOT NULL DEFAULT '{"email":true,"inApp":true,"comments":true,"mentions":true}'::jsonb,
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX users_email_normalized_uq ON users (lower(email));
CREATE INDEX users_tenant_idx ON users (tenant_id);

CREATE TABLE organizations (
  id text PRIMARY KEY,
  tenant_id text NOT NULL REFERENCES tenants(id),
  name text NOT NULL,
  ico text NOT NULL,
  dic text NOT NULL DEFAULT '',
  ic_dph text,
  color text NOT NULL DEFAULT '#0E7A5F',
  archived boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, ico)
);
CREATE INDEX organizations_tenant_idx ON organizations (tenant_id, archived);

CREATE TABLE organization_bank_accounts (
  id text PRIMARY KEY,
  tenant_id text NOT NULL REFERENCES tenants(id),
  organization_id text NOT NULL REFERENCES organizations(id),
  label text NOT NULL,
  iban text NOT NULL,
  bic text,
  currency text NOT NULL CHECK (currency IN ('EUR','CZK','USD')),
  is_default boolean NOT NULL DEFAULT false,
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX organization_bank_accounts_scope_idx ON organization_bank_accounts (tenant_id, organization_id, active);

CREATE TABLE document_queues (
  id text PRIMARY KEY,
  tenant_id text NOT NULL REFERENCES tenants(id),
  organization_id text NOT NULL REFERENCES organizations(id),
  name text NOT NULL,
  kind text NOT NULL,
  document_types jsonb NOT NULL,
  import_alias text,
  active boolean NOT NULL DEFAULT true,
  features jsonb NOT NULL DEFAULT '{}'::jsonb,
  warning_threshold numeric(5,4),
  automation jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX document_queues_scope_idx ON document_queues (tenant_id, organization_id, active);

CREATE TABLE organization_memberships (
  user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  organization_id text NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  tenant_id text NOT NULL REFERENCES tenants(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, organization_id)
);
CREATE INDEX organization_memberships_scope_idx ON organization_memberships (tenant_id, organization_id);

CREATE TABLE organization_email_aliases (
  id text PRIMARY KEY,
  tenant_id text NOT NULL REFERENCES tenants(id),
  organization_id text NOT NULL REFERENCES organizations(id),
  address text NOT NULL,
  address_normalized text NOT NULL,
  local_part text NOT NULL,
  domain text NOT NULL,
  slug_at_creation text NOT NULL,
  token text NOT NULL,
  status text NOT NULL CHECK (status IN ('active', 'grace_period', 'disabled')),
  is_primary boolean NOT NULL DEFAULT false,
  provider_route_id text,
  created_at timestamptz NOT NULL DEFAULT now(),
  grace_until timestamptz,
  disabled_at timestamptz
);
CREATE UNIQUE INDEX organization_email_alias_address_uq ON organization_email_aliases (address_normalized);
CREATE UNIQUE INDEX organization_email_alias_primary_uq
  ON organization_email_aliases (organization_id) WHERE is_primary AND status <> 'disabled';
CREATE INDEX organization_email_alias_tenant_idx ON organization_email_aliases (tenant_id, organization_id);

CREATE TABLE sessions (
  id text PRIMARY KEY,
  user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  tenant_id text NOT NULL REFERENCES tenants(id),
  token_hash text NOT NULL UNIQUE,
  csrf_token_hash text NOT NULL,
  expires_at timestamptz NOT NULL,
  last_seen_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX sessions_user_idx ON sessions (tenant_id, user_id, expires_at);

CREATE TABLE audit_logs (
  id text PRIMARY KEY,
  tenant_id text NOT NULL REFERENCES tenants(id),
  organization_id text REFERENCES organizations(id),
  actor_type text NOT NULL CHECK (actor_type IN ('user', 'agent', 'system')),
  actor_id text,
  action text NOT NULL,
  entity_type text NOT NULL,
  entity_id text,
  correlation_id text NOT NULL,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX audit_logs_scope_idx ON audit_logs (tenant_id, organization_id, created_at DESC);
CREATE INDEX audit_logs_correlation_idx ON audit_logs (correlation_id);

CREATE TABLE inbound_emails (
  id text PRIMARY KEY,
  tenant_id text REFERENCES tenants(id),
  organization_id text REFERENCES organizations(id),
  alias_id text REFERENCES organization_email_aliases(id),
  provider text NOT NULL,
  provider_message_id text NOT NULL,
  envelope_recipients jsonb NOT NULL,
  sender_email text,
  sender_name text,
  subject text,
  received_at timestamptz NOT NULL,
  status text NOT NULL CHECK (status IN ('received','queued','processed','partially_processed','quarantine','failed')),
  attachment_count integer NOT NULL DEFAULT 0,
  raw_message_storage_key text,
  quarantine_reason text,
  processing_error_code text,
  processing_error_message text,
  correlation_id text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (provider, provider_message_id)
);
CREATE INDEX inbound_emails_scope_idx ON inbound_emails (tenant_id, organization_id, created_at DESC);

CREATE TABLE inbound_attachments (
  id text PRIMARY KEY,
  tenant_id text REFERENCES tenants(id),
  inbound_email_id text NOT NULL REFERENCES inbound_emails(id) ON DELETE CASCADE,
  organization_id text REFERENCES organizations(id),
  original_file_name text NOT NULL,
  safe_file_name text NOT NULL,
  declared_mime_type text,
  detected_mime_type text,
  byte_size bigint NOT NULL,
  sha256 text NOT NULL,
  storage_key text,
  status text NOT NULL CHECK (status IN ('received','ignored_inline','stored','queued','processing','document_created','duplicate','quarantine','failed')),
  document_id text,
  quarantine_reason text,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX inbound_attachments_scope_idx ON inbound_attachments (tenant_id, organization_id, sha256);

CREATE TABLE documents (
  id text PRIMARY KEY,
  tenant_id text NOT NULL REFERENCES tenants(id),
  organization_id text NOT NULL REFERENCES organizations(id),
  queue_id text REFERENCES document_queues(id),
  document_type text NOT NULL CHECK (document_type IN ('FP','FV','BV','MZDY','OZ','PD')),
  status text NOT NULL,
  processing_status text NOT NULL,
  source jsonb NOT NULL DEFAULT '{}'::jsonb,
  extracted jsonb NOT NULL DEFAULT '{}'::jsonb,
  accounting jsonb NOT NULL DEFAULT '{}'::jsonb,
  field_confidence jsonb NOT NULL DEFAULT '{}'::jsonb,
  confidence numeric(5,4) NOT NULL DEFAULT 0,
  total_amount numeric(18,2),
  currency text,
  history jsonb NOT NULL DEFAULT '[]'::jsonb,
  comments jsonb NOT NULL DEFAULT '[]'::jsonb,
  version integer NOT NULL DEFAULT 1,
  approved_version integer,
  approved_snapshot jsonb,
  export_id text,
  quarantine_reason text,
  duplicate_of_document_id text REFERENCES documents(id),
  not_duplicate boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX documents_scope_idx ON documents (tenant_id, organization_id, status, created_at DESC);

CREATE TABLE code_list_items (
  id text PRIMARY KEY,
  tenant_id text NOT NULL REFERENCES tenants(id),
  organization_id text NOT NULL REFERENCES organizations(id),
  kind text NOT NULL CHECK (kind IN ('predkontacie','cleneniaDph','ciselneRady','strediska')),
  code text NOT NULL,
  name text NOT NULL,
  source text NOT NULL CHECK (source IN ('manual','pohoda')),
  active boolean NOT NULL DEFAULT true,
  external_id text,
  agenda text,
  accounting_year text,
  synced_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, organization_id, kind, code)
);
CREATE INDEX code_list_items_scope_idx ON code_list_items (tenant_id, organization_id, kind, active);

CREATE TABLE processing_jobs (
  id text PRIMARY KEY,
  tenant_id text NOT NULL REFERENCES tenants(id),
  organization_id text NOT NULL REFERENCES organizations(id),
  attachment_id text REFERENCES inbound_attachments(id),
  document_id text REFERENCES documents(id),
  kind text NOT NULL,
  status text NOT NULL CHECK (status IN ('queued','running','succeeded','failed','dead_letter')),
  attempts integer NOT NULL DEFAULT 0,
  max_attempts integer NOT NULL DEFAULT 5,
  available_at timestamptz NOT NULL DEFAULT now(),
  locked_at timestamptz,
  locked_by text,
  correlation_id text NOT NULL,
  payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  error_code text,
  error_message text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX processing_jobs_poll_idx ON processing_jobs (status, available_at, created_at);
CREATE INDEX processing_jobs_scope_idx ON processing_jobs (tenant_id, organization_id);

CREATE TABLE extraction_runs (
  id text PRIMARY KEY,
  tenant_id text NOT NULL REFERENCES tenants(id),
  organization_id text NOT NULL REFERENCES organizations(id),
  document_id text REFERENCES documents(id),
  provider text NOT NULL CHECK (provider IN ('mock','openai')),
  model text,
  prompt_version text NOT NULL,
  schema_version text NOT NULL,
  status text NOT NULL CHECK (status IN ('queued','running','succeeded','failed')),
  result jsonb,
  error_code text,
  error_message text,
  latency_ms integer,
  usage jsonb,
  started_at timestamptz,
  completed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX extraction_runs_scope_idx ON extraction_runs (tenant_id, organization_id, document_id);

CREATE TABLE export_batches (
  id text PRIMARY KEY,
  tenant_id text NOT NULL REFERENCES tenants(id),
  organization_id text NOT NULL REFERENCES organizations(id),
  created_by text REFERENCES users(id),
  document_ids jsonb NOT NULL,
  xml_file_name text NOT NULL,
  xml_snapshot text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX export_batches_scope_idx ON export_batches (tenant_id, organization_id, created_at DESC);

CREATE TABLE tenant_integrations (
  tenant_id text PRIMARY KEY REFERENCES tenants(id),
  mostik_enabled boolean NOT NULL DEFAULT false,
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by text REFERENCES users(id)
);

CREATE TABLE agent_installations (
  id text PRIMARY KEY,
  tenant_id text NOT NULL REFERENCES tenants(id),
  name text NOT NULL,
  hostname text NOT NULL,
  token_hash text NOT NULL UNIQUE,
  created_at timestamptz NOT NULL DEFAULT now(),
  last_seen_at timestamptz,
  agent_version text NOT NULL,
  status text NOT NULL DEFAULT 'connected' CHECK (status IN ('connected','revoked')),
  revoked_at timestamptz
);
CREATE INDEX agent_installations_tenant_idx ON agent_installations (tenant_id, status);

CREATE TABLE agent_pairing_codes (
  id text PRIMARY KEY,
  code_hash text NOT NULL UNIQUE,
  tenant_id text NOT NULL REFERENCES tenants(id),
  created_by text NOT NULL REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  used_at timestamptz
);
CREATE INDEX agent_pairing_codes_expiry_idx ON agent_pairing_codes (expires_at, used_at);

CREATE TABLE pohoda_company_links (
  organization_id text PRIMARY KEY REFERENCES organizations(id),
  tenant_id text NOT NULL REFERENCES tenants(id),
  ico text NOT NULL,
  db_name text,
  accounting_year text,
  preferred_year text NOT NULL DEFAULT 'latest',
  matched_at timestamptz,
  match_rule text CHECK (match_rule IN ('auto_ico','manual')),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX pohoda_company_links_tenant_idx ON pohoda_company_links (tenant_id);

CREATE TABLE export_jobs (
  id text PRIMARY KEY,
  tenant_id text NOT NULL REFERENCES tenants(id),
  organization_id text NOT NULL REFERENCES organizations(id),
  document_ids jsonb NOT NULL,
  status text NOT NULL CHECK (status IN ('pending','sent','confirmed','failed')),
  idempotency_key text NOT NULL,
  request_xml text NOT NULL,
  request_xml_hash text NOT NULL,
  response_meta jsonb,
  result_hash text,
  attempt integer NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by text NOT NULL REFERENCES users(id),
  sent_at timestamptz,
  completed_at timestamptz,
  retry_of_job_id text REFERENCES export_jobs(id),
  UNIQUE (tenant_id, idempotency_key)
);
CREATE INDEX export_jobs_queue_idx ON export_jobs (tenant_id, organization_id, status, created_at);

CREATE TABLE agent_releases (
  version text PRIMARY KEY,
  download_url text NOT NULL,
  sha256 text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  active boolean NOT NULL DEFAULT true
);

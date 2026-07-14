CREATE TABLE agent_sync_runs (
  id text PRIMARY KEY,
  tenant_id text NOT NULL REFERENCES tenants(id),
  organization_id text NOT NULL REFERENCES organizations(id),
  agent_installation_id text NOT NULL REFERENCES agent_installations(id),
  kind text NOT NULL CHECK (kind IN ('predkontacie','cleneniaDph','ciselneRady','strediska')),
  state text NOT NULL CHECK (state IN ('ok','error')),
  item_count integer NOT NULL DEFAULT 0 CHECK (item_count >= 0),
  duration_ms integer NOT NULL DEFAULT 0 CHECK (duration_ms >= 0),
  error_code text,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX agent_sync_runs_scope_idx ON agent_sync_runs (tenant_id, organization_id, created_at DESC);

CREATE TABLE notification_outbox (
  id text PRIMARY KEY,
  tenant_id text NOT NULL REFERENCES tenants(id),
  event_type text NOT NULL CHECK (event_type IN ('agent_offline','export_failure_rate')),
  dedup_key text NOT NULL UNIQUE,
  payload jsonb NOT NULL,
  state text NOT NULL DEFAULT 'pending' CHECK (state IN ('pending','sent','failed')),
  created_at timestamptz NOT NULL DEFAULT now(),
  sent_at timestamptz
);
CREATE INDEX notification_outbox_queue_idx ON notification_outbox (state, created_at);

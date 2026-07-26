-- História chatov s asistentom, samostatne pre každú firmu. Vlákno je jeden
-- riadok so správami v jsonb — konverzácie sú krátke, netreba join ani
-- stránkovanie. Mazanie firmy odstráni aj jej vlákna.
CREATE TABLE assistant_threads (
  id text PRIMARY KEY,
  tenant_id text NOT NULL REFERENCES tenants(id),
  organization_id text NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  title text NOT NULL,
  created_by text REFERENCES users(id),
  messages jsonb NOT NULL DEFAULT '[]'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX assistant_threads_scope_idx
  ON assistant_threads (tenant_id, organization_id, updated_at DESC);

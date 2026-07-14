ALTER TABLE agent_pairing_codes
  ADD COLUMN organization_id text REFERENCES organizations(id);

CREATE INDEX agent_pairing_codes_organization_idx
  ON agent_pairing_codes (tenant_id, organization_id, expires_at);

ALTER TABLE agent_releases
  ADD COLUMN file_size bigint,
  ADD COLUMN published_at timestamptz,
  ADD COLUMN publisher text,
  ADD COLUMN publisher_thumbprint text,
  ADD COLUMN minimum_windows_version text,
  ADD COLUMN signed boolean NOT NULL DEFAULT false;

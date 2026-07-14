ALTER TABLE agent_releases
  ADD COLUMN signature_trust text NOT NULL DEFAULT 'public'
    CHECK (signature_trust IN ('public', 'self-signed')),
  ADD COLUMN certificate_url text,
  ADD COLUMN release_channel text NOT NULL DEFAULT 'production'
    CHECK (release_channel IN ('production', 'temporary'));

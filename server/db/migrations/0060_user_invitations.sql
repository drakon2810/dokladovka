-- Pozvánky do kancelárie. Registrácia vždy zakladá NOVÝ tenant, takže kolega,
-- ktorý sa zaregistroval sám, skončil v prázdnej kancelárii bez firiem aj bez
-- Mostíka. Pozvánka ho pridá do existujúcej kancelárie s rolou a s firmami,
-- ktoré mu vlastník vybral.
CREATE TABLE IF NOT EXISTS user_invitations (
  id text PRIMARY KEY,
  tenant_id text NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  email text NOT NULL,
  email_normalized text NOT NULL,
  name text NOT NULL,
  role text NOT NULL CHECK (role IN ('admin', 'uctovnik', 'schvalovatel')),
  -- Firmy, ku ktorým pozvaný dostane prístup. Admin dostane pri prijatí všetky.
  organization_ids jsonb NOT NULL DEFAULT '[]'::jsonb,
  token_hash text NOT NULL UNIQUE,
  invited_by text NOT NULL REFERENCES users(id),
  expires_at timestamptz NOT NULL,
  accepted_at timestamptz,
  revoked_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- Jedna otvorená pozvánka na adresu v kancelárii. Nová pozvánka tú starú
-- odvolá, takže platí vždy len posledný odkaz.
CREATE UNIQUE INDEX IF NOT EXISTS user_invitations_open_idx
  ON user_invitations (tenant_id, email_normalized)
  WHERE accepted_at IS NULL AND revoked_at IS NULL;

-- Admin kancelárie vidí každú jej firmu. Odteraz sa to drží pri založení firmy,
-- pri pozvánke aj pri povýšení na admina — tu sa to isté dorovná pre dáta,
-- ktoré vznikli skôr. Prístup ide stále len cez členstvo.
INSERT INTO organization_memberships (user_id, organization_id, tenant_id)
SELECT u.id, o.id, u.tenant_id
  FROM users u
  JOIN organizations o ON o.tenant_id = u.tenant_id
 WHERE u.role = 'admin' AND u.active = true
ON CONFLICT DO NOTHING;

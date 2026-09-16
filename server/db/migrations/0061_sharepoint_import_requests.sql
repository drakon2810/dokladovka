-- Súbory zo SharePointu, ktoré účtovník vybral na nahratie.
--
-- Poller doteraz sťahoval do Dokladovky všetko, čo v priečinku „nespracované"
-- pribudlo. Teraz si účtovník v okne „Nahrať zo SharePointu" vyberie, čo chce,
-- a poller zoberie len to. Presun do „spracované" po prenose do POHODY sa
-- nemení — ten sa odvodzuje zo stavu dokladov ako doteraz.
CREATE TABLE IF NOT EXISTS sharepoint_import_requests (
  id text PRIMARY KEY,
  tenant_id text NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  organization_id text NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  drive_id text NOT NULL,
  item_id text NOT NULL,
  file_name text NOT NULL,
  -- Z ktorého priečinka: „chybné" sa dá nahrať znova, keď sa napr. opravil súbor.
  zdroj text NOT NULL CHECK (zdroj IN ('nespracovane', 'chybne')),
  requested_by text REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  done_at timestamptz,
  -- Dôvod, prečo sa súbor nenahral (napr. medzitým zmizol zo SharePointu).
  error text
);

-- Ten istý súbor nemôže čakať dvakrát — dvojklik ani dve okná ho nestiahnu dvakrát.
CREATE UNIQUE INDEX IF NOT EXISTS sharepoint_import_requests_pending_idx
  ON sharepoint_import_requests (organization_id, item_id)
  WHERE done_at IS NULL;

CREATE INDEX IF NOT EXISTS sharepoint_import_requests_org_idx
  ON sharepoint_import_requests (tenant_id, organization_id, created_at)
  WHERE done_at IS NULL;

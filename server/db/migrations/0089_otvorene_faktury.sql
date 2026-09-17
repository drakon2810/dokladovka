-- Neuhradené faktúry z POHODY pre párovanie banky. Denník ani document_payments
-- zostatok nenesú; POHODA áno („K likvidácii"). Mostík ich stiahne na žiadosť
-- a zoznam firmy sa pri úspešnom prenose nahradí celý.
CREATE TABLE pohoda_otvorene_faktury (
  tenant_id text NOT NULL REFERENCES tenants(id),
  organization_id text NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  zdroj_databaza text NOT NULL,
  pohoda_doklad_id bigint NOT NULL,
  agenda text NOT NULL,
  doklad_cislo text,
  partner_ico text,
  partner_nazov text,
  var_symbol text,
  -- NULL = domáca mena.
  mena text,
  suma numeric,
  suma_mena numeric,
  -- Záporný pri dobropise.
  zostatok numeric,
  zostatok_mena numeric,
  synced_at timestamptz NOT NULL,
  PRIMARY KEY (tenant_id, organization_id, pohoda_doklad_id)
);

ALTER TABLE pohoda_company_links ADD COLUMN open_invoices_sync_requested_at timestamptz;

-- Telemetria behu — route ho overí, databáza ho musí aj prijať (pozri 0046).
ALTER TABLE agent_sync_runs DROP CONSTRAINT agent_sync_runs_kind_check;
ALTER TABLE agent_sync_runs ADD CONSTRAINT agent_sync_runs_kind_check
  CHECK (kind IN ('predkontacie', 'cleneniaDph', 'ciselneRady', 'strediska',
                  'bankoveUcty', 'treningAi', 'adresar',
                  'uctovnyProfil', 'uctovnyDennik', 'otvoreneFaktury'));

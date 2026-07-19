-- Partneri (kontrahenti): adresár dodávateľov na organizáciu. Záznamy sa
-- zakladajú automaticky z extrahovaných dokladov a dajú sa upraviť ručne.
-- Predvolené zaúčtovanie partnera je zdroj návrhu 'partner_default'.
CREATE TABLE partners (
  id text PRIMARY KEY,
  tenant_id text NOT NULL REFERENCES tenants(id),
  organization_id text NOT NULL REFERENCES organizations(id),
  name text NOT NULL,
  name_normalized text NOT NULL,
  ico text,
  dic text,
  ic_dph text,
  iban text,
  address text,
  email text,
  phone text,
  default_predkontacia_id text,
  default_clenenie_dph_id text,
  default_stredisko_id text,
  note text,
  source text NOT NULL DEFAULT 'auto' CHECK (source IN ('auto', 'manual')),
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by text REFERENCES users(id)
);

CREATE INDEX partners_scope_idx ON partners (tenant_id, organization_id, name_normalized);
CREATE INDEX partners_ico_idx ON partners (tenant_id, organization_id, ico);

-- Nový zdroj návrhu zaúčtovania: predvoľby partnera.
ALTER TABLE accounting_suggestions DROP CONSTRAINT accounting_suggestions_source_check;
ALTER TABLE accounting_suggestions ADD CONSTRAINT accounting_suggestions_source_check
  CHECK (source IN ('manual_rule','partner_default','supplier_history','organization_default','ai','none'));

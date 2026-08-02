-- Predvolený číselný rad na typ dokladu. Firma má v POHODE desiatky radov, ale
-- prijaté faktúry účtuje spravidla do jedného — bez tejto predvoľby ostávalo
-- pole v editore prázdne, lebo pamäť rozhodnutí ani história dodávateľa číselný
-- rad často nenesú. Rad je per typ dokladu: pokladňa a faktúry nemôžu zdieľať rad.
CREATE TABLE organization_series_defaults (
  organization_id text NOT NULL REFERENCES organizations(id),
  tenant_id text NOT NULL REFERENCES tenants(id),
  document_type text NOT NULL CHECK (document_type IN ('FP','FV','BV','MZDY','OZ','PD')),
  ciselny_rad_id text NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (organization_id, document_type)
);
CREATE INDEX organization_series_defaults_tenant_idx ON organization_series_defaults (tenant_id);

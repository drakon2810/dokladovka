-- Samozdanenie na prijatej faktúre: voľba účtovníka (vytvoriť interné doklady,
-- už zaúčtované v POHODE, nevzniká povinnosť) s vypočítaným základom a daňou.
-- Pri schválení sa zmrazí aj do approved_snapshot; stav prenosu interných
-- dokladov do POHODY je v kľúči export (po jednom na doklad).
ALTER TABLE documents ADD COLUMN samozdanenie jsonb;

-- Pamäť dodávateľa: „nevzniká povinnosť samozdanenia" sa pýta raz na dodávateľa.
-- Kľúč je IČO, bez neho normalizované meno (ako pravidlá protistrany).
CREATE TABLE samozdanenie_dodavatelia (
  organization_id text NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  tenant_id text NOT NULL REFERENCES tenants(id),
  dodavatel_kluc text NOT NULL,
  dodavatel_nazov text,
  volba text NOT NULL CHECK (volba IN ('nevznika')),
  dovod text NOT NULL,
  dovod_text text,
  zapisal text REFERENCES users(id),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (organization_id, dodavatel_kluc)
);
CREATE INDEX samozdanenie_dodavatelia_tenant ON samozdanenie_dodavatelia (tenant_id);

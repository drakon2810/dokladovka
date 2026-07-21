-- Pamäť rozhodnutí: pri schválení dokladu sa uloží „odtlačok" dodávateľa a
-- textu položiek spolu s finálnym zaúčtovaním. Návrhy potom kopírujú najnovšie
-- potvrdené rozhodnutia — učenie bez trénovania modelu. source='import' je
-- pripravený pre import historických dokladov (Excel / POHODA XML).
CREATE TABLE ucto_decisions (
  id text PRIMARY KEY,
  tenant_id text NOT NULL REFERENCES tenants(id),
  organization_id text NOT NULL REFERENCES organizations(id),
  document_id text REFERENCES documents(id) ON DELETE CASCADE,
  supplier_ico text,
  supplier_name_normalized text,
  line_text_normalized text,
  predkontacia_id text,
  clenenie_dph_id text,
  ciselny_rad_id text,
  stredisko_id text,
  clenenie_kv_kod text,
  source text NOT NULL CHECK (source IN ('approved','import')),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX ucto_decisions_document_idx
  ON ucto_decisions (document_id) WHERE document_id IS NOT NULL;
CREATE INDEX ucto_decisions_supplier_idx
  ON ucto_decisions (tenant_id, organization_id, supplier_ico, created_at DESC);
CREATE INDEX ucto_decisions_supplier_name_idx
  ON ucto_decisions (tenant_id, organization_id, supplier_name_normalized, created_at DESC);

-- Návrh zaúčtovania: nový zdroj 'decision_memory' a členenie KV (kód sekcie
-- kontrolného výkazu — kód, nie ID číselníka).
ALTER TABLE accounting_suggestions ADD COLUMN clenenie_kv_kod text;
ALTER TABLE accounting_suggestions DROP CONSTRAINT accounting_suggestions_source_check;
ALTER TABLE accounting_suggestions ADD CONSTRAINT accounting_suggestions_source_check
  CHECK (source IN ('manual_rule','partner_default','decision_memory','supplier_history','organization_default','ai','none'));

-- Číselný rad je v POHODE daný identifikátorom (typ:id), nie predponou.
--
-- Kľúč (tenant, organizácia, druh, kód) zlieval rady s rovnakou predponou do
-- jedného: rad „26" má ALPINA v pokladni aj v ostatných záväzkoch. Uložil sa
-- prvý, druhý sa stratil — a doklad potom dostal rad cudzej agendy. Rady sa preto kľúčujú identifikátorom POHODY
-- a rovnaký kód smie niesť viac radov. Ostatné číselníky aj rad bez
-- identifikátora (ručne založený, starší prenos) ostávajú kľúčované kódom.
--
-- Id riadkov sa nemenia: doklady, návrhy aj predvolené rady na ne odkazujú
-- bez cudzieho kľúča.
ALTER TABLE code_list_items DROP CONSTRAINT IF EXISTS code_list_items_tenant_id_organization_id_kind_code_key;

CREATE UNIQUE INDEX IF NOT EXISTS code_list_items_kod
  ON code_list_items (tenant_id, organization_id, kind, code) WHERE kind <> 'ciselneRady';
CREATE UNIQUE INDEX IF NOT EXISTS code_list_items_rad_external_id
  ON code_list_items (tenant_id, organization_id, external_id) WHERE kind = 'ciselneRady' AND external_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS code_list_items_rad_kod
  ON code_list_items (tenant_id, organization_id, code) WHERE kind = 'ciselneRady' AND external_id IS NULL;

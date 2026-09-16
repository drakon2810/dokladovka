-- Oprava účtovníka ukazuje na stopu rozhodnutia, z ktorej návrh vzišiel.
-- Bez nej sa zo záznamu opravy nedá povedať, ktoré pravidlo sa pomýlilo.
-- Bez cudzieho kľúča: oprava prežije zmazanie dokladu, stopa nie.
ALTER TABLE ucto_opravy ADD COLUMN stopa_id text;
CREATE INDEX ucto_opravy_stopa_idx ON ucto_opravy (stopa_id) WHERE stopa_id IS NOT NULL;

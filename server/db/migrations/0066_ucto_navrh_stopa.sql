-- Stopa návrhu zaúčtovania: z ktorých dokladov histórie a potvrdených
-- príkladov AI čerpala, pri akom dátume histórie a z ktorých agend.
--
-- Bez nej sa nedalo spätne povedať, prečo návrh vyzerá tak, ako vyzerá, ani
-- porovnať dva návrhy toho istého dokladu. Doklad histórie sa odkazuje cez
-- riadok_hash (stabilný aj pri novom prenose, id riadkov sa menia) a hash
-- JSON-u, ktorý naozaj odišiel modelu.
--
-- Samostatná tabuľka, nie jsonb v accounting_suggestions: dátový snapshot
-- posiela accounting_suggestions cez SELECT * každému prehliadaču pri každom
-- dopyte, takže by dôkazy putovali k používateľom a nafukovali každý poll.
-- Návrh nesie len stopa_id. Pri zmazaní dokladu stopa zmizne s ním.
CREATE TABLE ucto_navrh_stopa (
  id uuid PRIMARY KEY,
  tenant_id text NOT NULL REFERENCES tenants(id),
  organization_id text NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  document_id text NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  -- Dátum, ku ktorému sa história držala (meranie); v produkcii NULL.
  as_of date,
  agendy text[] NOT NULL,
  -- História prišla z bežných dokladov typu, lebo firma druh ešte nemala.
  zakladna boolean NOT NULL DEFAULT false,
  -- [{ref, riadky: [riadok_hash], hash: sha256 JSON-u poslaného modelu}]
  doklady jsonb NOT NULL DEFAULT '[]'::jsonb,
  -- id riadkov ucto_decisions poslaných ako „priklady".
  priklady text[] NOT NULL DEFAULT '{}',
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ucto_navrh_stopa_dokument
  ON ucto_navrh_stopa (tenant_id, organization_id, document_id, created_at DESC);

ALTER TABLE accounting_suggestions ADD COLUMN stopa_id text;

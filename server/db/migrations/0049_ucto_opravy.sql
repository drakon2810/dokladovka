-- Čo účtovník na doklade zmenil oproti návrhu.
--
-- Doteraz to systém nikde nedržal: accounting_suggestions nesie návrh,
-- approved_snapshot výsledok, ale porovnať sa nedajú. Návrh totiž vzniká aj
-- z documents.accounting, ktoré predtým zapísala samotná extrakcia, takže na
-- časti dokladov je návrh doslovnou kópiou toho, s čím by sme ho porovnávali.
-- A documents.history obsahuje iba záznamy „Systém" a „POHODA" — nula úkonov
-- používateľa. Databáza preto nevie odlíšiť „účtovník súhlasil" od „účtovník
-- sa nepozrel", a bez toho sa nedá zmerať, či je akákoľvek zmena zlepšením.
--
-- Táto tabuľka drží dvojicu „čo bolo navrhnuté → čo bolo schválené" v okamihu
-- schválenia. Je to jediný učiaci signál, ktorý v POHODE neexistuje: tam leží
-- iba výsledok, nie to, čo systém navrhol pred ním.
--
-- Zámerne BEZ cudzieho kľúča na documents: záznam musí prežiť zmazanie
-- dokladu. Pri accounting_suggestions to tak nie je a s 27 zmazanými dokladmi
-- jednej organizácie odišli aj ich návrhy — presne tie, kde bola oprava
-- najpravdepodobnejšia.
CREATE TABLE ucto_opravy (
  id text PRIMARY KEY,
  tenant_id text NOT NULL REFERENCES tenants(id),
  organization_id text NOT NULL REFERENCES organizations(id),
  document_id text NOT NULL,
  document_type text,
  podtyp text,
  supplier_ico text,
  supplier_name text,
  -- Návrh a výsledok ako celok, nie len rozdiel: pri neskoršej analýze treba
  -- vedieť aj to, čo účtovník ponechal, nie iba to, čo prepísal.
  navrhnute jsonb NOT NULL,
  schvalene jsonb NOT NULL,
  -- Polia, ktoré sa líšia. Prázdne pole = účtovník návrh prijal bez zmeny.
  zmenene text[] NOT NULL,
  navrh_zdroj text,
  navrh_confidence numeric(5,4),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX ucto_opravy_scope_idx ON ucto_opravy (tenant_id, organization_id, created_at DESC);
CREATE INDEX ucto_opravy_document_idx ON ucto_opravy (document_id);

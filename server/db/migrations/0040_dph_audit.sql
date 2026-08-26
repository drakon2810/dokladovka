-- Právna kontrola členenia DPH — druhá mienka k návrhu z pamäte.
--
-- Vlastná tabuľka, nie stĺpce v accounting_suggestions: verdikt má svoj vlastný
-- život. Návrh sa prepočítava pri zmene pamäte, verdikt pri zmene členenia na
-- doklade, a keď účtovník rozpor rozhodne, verdikt zostáva ako stopa toho, čo
-- kontrola hovorila — aj keď sa rozhodol inak.
CREATE TABLE dph_audit (
  document_id text PRIMARY KEY REFERENCES documents(id) ON DELETE CASCADE,
  tenant_id text NOT NULL REFERENCES tenants(id),
  organization_id text NOT NULL REFERENCES organizations(id),
  -- Členenie, ktoré sa posudzovalo. Keď ho účtovník zmení, verdikt sa prepočíta.
  posudene_clenenie_kod text,
  posudena_kv_sekcia text,
  verdikt text NOT NULL CHECK (verdikt IN ('suhlasi', 'nesuhlasi', 'neisty')),
  odporucane_clenenie_kod text,
  odporucana_kv_sekcia text,
  dovod text NOT NULL,
  istota numeric(3, 2),
  model text,
  -- Rozhodnutie účtovníka: prijal odporúčanie, alebo ponechal pôvodné.
  -- NULL = rozpor ešte nikto neriešil.
  rozhodnutie text CHECK (rozhodnutie IN ('prijate', 'ponechane')),
  rozhodol_uzivatel text,
  rozhodnute_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX dph_audit_tenant_idx ON dph_audit (tenant_id, organization_id);
-- Nevyriešené rozpory sa vyberajú do dávkovej kontroly pred priznaním DPH.
CREATE INDEX dph_audit_nevyriesene_idx ON dph_audit (organization_id)
  WHERE verdikt <> 'suhlasi' AND rozhodnutie IS NULL;

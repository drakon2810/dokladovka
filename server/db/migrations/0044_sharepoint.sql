-- Príjem dokladov zo SharePointu.
--
-- Klient hodí PDF do priečinka „nespracované", server ho po pár minútach
-- vyzdvihne a po prenose do POHODY presunie do „spracované" s dátumom a číslom
-- v názve. Priečinok tak sám ukazuje, čo ešte nie je zaúčtované — a vidí to aj
-- klient, nielen účtovník.
--
-- Dve tabuľky, lebo ide o dve rôzne veci s rôznou životnosťou:
--   * pripojenie je JEDNO na účtovnú kanceláriu (tenant). SharePoint si zakladá
--     sám účtovník, takže sa prihlási svojím kontom a to isté konto vidí na
--     všetky firmy, ktoré vedie.
--   * priečinky sú PER FIRMA. Jedna firma = jeden pár priečinkov, a práve tým
--     je vyriešené priradenie dokladu k firme: pri e-maile ho treba hádať z
--     adresy príjemcu, tu ho určuje samotný priečinok.
CREATE TABLE sharepoint_connections (
  id text PRIMARY KEY,
  tenant_id text NOT NULL UNIQUE REFERENCES tenants(id) ON DELETE CASCADE,
  -- Identifikátor tenanta v Microsofte (nie náš) — do adresy token endpointu.
  ms_tenant_id text NOT NULL,
  account_email text NOT NULL,
  account_name text,
  -- Šifrovaný refresh token (AES-256-GCM, server/crypto.ts). Nikdy nie v čistom
  -- tvare a nikdy sa nevracia do API odpovede.
  refresh_token_encrypted text NOT NULL,
  connected_by text REFERENCES users(id),
  connected_at timestamptz NOT NULL DEFAULT now(),
  -- Posledná chyba obnovenia tokenu. Keď účtovník zmení heslo alebo správca
  -- odvolá súhlas, refresh token prestane platiť — a jediné, čo používateľ
  -- uvidí, je že sa doklady prestali objavovať. Preto sa dôvod drží tu a
  -- nastavenia ho ukážu s výzvou pripojiť znova.
  last_error text,
  last_error_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE sharepoint_folders (
  id text PRIMARY KEY,
  tenant_id text NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  organization_id text NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  site_id text NOT NULL,
  drive_id text NOT NULL,
  nespracovane_folder_id text NOT NULL,
  spracovane_folder_id text NOT NULL,
  -- Kam ide to, čo sa nepodarilo spracovať (fotka, .docx, poškodené PDF).
  -- Bez tretieho priečinka by taký súbor zostal v „nespracované" navždy a
  -- klient by nikdy nezistil prečo. Voliteľné — bez neho súbor ostáva ležať.
  chybne_folder_id text,
  active boolean NOT NULL DEFAULT true,
  last_poll_at timestamptz,
  last_error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  -- Jedna firma = jeden pár priečinkov. Dva zdroje pre tú istú firmu by len
  -- rozmnožili spôsoby, ako sa to pokazí.
  UNIQUE (organization_id)
);

CREATE INDEX sharepoint_folders_poll_idx ON sharepoint_folders (tenant_id) WHERE active = true;

-- Odkaz na zdrojový súbor. Drží sa na prílohe (nie na doklade), lebo z jedného
-- PDF môže rozdelením vzniknúť viac dokladov — a súbor sa smie presunúť až keď
-- sú prenesené VŠETKY. Príloha je to jediné, čo je so súborom v pomere 1:1.
ALTER TABLE inbound_attachments ADD COLUMN sharepoint_drive_id text;
ALTER TABLE inbound_attachments ADD COLUMN sharepoint_item_id text;

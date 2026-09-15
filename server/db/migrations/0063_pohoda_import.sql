-- Prenos histórie z Mostíka po dávkach do stagingu a jedna atomická publikácia.
--
-- Doteraz prvá dávka s reset=true zmazala živý korpus (ucto_historia), pamäť
-- (ucto_decisions source='import') a ďalšie dávky ho plnili postupne. Výpadok
-- siete alebo 500 na druhej dávke nechal v živých dátach zlomok histórie
-- a návrhy zaúčtovania z neho čerpali, kým účtovník nepožiadal o nový prenos.
--
-- Teraz dávky prenosu (importId) ležia v pohoda_import_davky a živé tabuľky
-- sa vymenia až pri publikácii, v jednej transakcii a len keď manifest sedí.
-- Čitatelia sa nemenia: každý príkaz vidí buď starý, alebo nový stav (MVCC).
CREATE TABLE pohoda_importy (
  id text PRIMARY KEY,
  tenant_id text NOT NULL REFERENCES tenants(id),
  organization_id text NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  druh text NOT NULL CHECK (druh IN ('historia', 'pamat', 'dennik')),
  stav text NOT NULL DEFAULT 'prijima' CHECK (stav IN ('prijima', 'publikovany', 'zamietnuty')),
  chyba text,
  -- Čo POHODA vrátila po agendách (stav, počty, preskočené) — dôkaz úplnosti.
  manifest jsonb,
  vysledok jsonb,
  agent_version text,
  created_at timestamptz NOT NULL DEFAULT now(),
  published_at timestamptz
);
CREATE INDEX pohoda_importy_org_druh ON pohoda_importy (organization_id, druh, created_at DESC);

CREATE TABLE pohoda_import_davky (
  import_id text NOT NULL REFERENCES pohoda_importy(id) ON DELETE CASCADE,
  davka integer NOT NULL CHECK (davka >= 0),
  -- Dávka po validácii, tak ako ju prijala route (denník už rozobraný).
  obsah jsonb NOT NULL,
  pocet integer NOT NULL,
  PRIMARY KEY (import_id, davka)
);

-- Pôvod riadka korpusu: databáza POHODY (jeden súbor = jeden účtovný rok)
-- a natívne id dokladu a položky. Publikácia mení len riadky svojej databázy,
-- takže prechod na databázu nového roka minulý rok nezmaže. Staré riadky majú
-- NULL a nahradí ich prvý prenos, rovnako ako doterajší reset.
ALTER TABLE ucto_historia
  ADD COLUMN zdroj_databaza text,
  ADD COLUMN pohoda_doklad_id bigint,
  ADD COLUMN pohoda_polozka_id bigint;

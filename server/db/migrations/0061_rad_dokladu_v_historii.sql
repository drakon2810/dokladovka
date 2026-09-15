-- Číselný rad každého dokladu histórie, presne podľa POHODY.
--
-- Rad sa doteraz odhadoval z predpony čísla dokladu (doklad_cislo LIKE kód||'%')
-- a odhad je chybný naprieč firmami: marcové vydané faktúry AGS (26030…) padli
-- do „Vydané ťarchopisy" 2603, februárové SLO do zálohových 2602, vydané
-- faktúry ROFA do „Prijaté dopropisy" 2026. POHODA pritom pri každom doklade
-- posiela identifikátor radu (typ:id) aj jeho predponu (typ:ids) — tie sa
-- ukladajú sem a rad nového dokladu sa potom počíta, nie háda.
--
-- krajina je krajina protistrany dokladu: niektoré firmy delia rady na
-- tuzemské a zahraničné a pri novom dodávateľovi sa to inak naučiť nedá.
ALTER TABLE ucto_historia ADD COLUMN IF NOT EXISTS rad_external_id text;
ALTER TABLE ucto_historia ADD COLUMN IF NOT EXISTS rad_kod text;
ALTER TABLE ucto_historia ADD COLUMN IF NOT EXISTS krajina text;
CREATE INDEX IF NOT EXISTS ucto_historia_org_rad
  ON ucto_historia (organization_id, agenda, datum) WHERE rad_external_id IS NOT NULL;

-- Rad prečítaný z dokladov nemal rok, a tak sa ponúkal aj rad minulého roka:
-- ROFA dostala „FP20" z decembrových faktúr 2025, ktoré ostali v databáze 2026.
-- Rok je rok dokladu s posledným číslom radu — ten doklad je v histórii.
UPDATE code_list_items c
   SET accounting_year = h.rok, updated_at = now()
  FROM (
    SELECT organization_id, doklad_cislo, max(extract(year FROM datum))::int::text AS rok
      FROM ucto_historia
     WHERE datum IS NOT NULL AND doklad_cislo IS NOT NULL
     GROUP BY organization_id, doklad_cislo
  ) h
 WHERE c.kind = 'ciselneRady' AND c.source = 'pohoda_doklad' AND c.accounting_year IS NULL
   AND h.organization_id = c.organization_id AND h.doklad_cislo = c.last_number;

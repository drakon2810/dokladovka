-- Pravidlá odvodené z histórie: čo firma s dokladmi tejto protistrany robí.
--
-- Doteraz to vedel len model — a zakaždým nanovo, z dvoch náhodných minulých
-- dokladov, ktoré mu dopyt priniesol. Nikde to nebolo zapísané, takže sa to
-- nedalo prečítať, skontrolovať ani opraviť. Účtovník mal veriť číslu
-- z merania a nič viac.
--
-- Pravidlo sa počíta DETERMINISTICKY, bez modelu: väčšinová hlavička a ustálený
-- tvar položiek. Nie je záväzné ako pravidlo účtovníka (ai_rules) — je to
-- zhrnutie praxe, ktoré ide modelu do promptu namiesto dvoch náhodných dokladov
-- a účtovníkovi na obrazovku.
--
-- Meranie na ALPINE hovorí, čo od toho čakať: hlavičku model trafí v 94 %
-- a rozpis v 93 % aj bez pravidiel. Pravidlá teda nie sú o presnosti, ale
-- o tom, aby to isté vyšlo novej firme na jedno stlačenie a aby sa dalo
-- pozrieť, čo sa vlastne naučilo.
CREATE TABLE ucto_pravidla (
  id text PRIMARY KEY,
  tenant_id text NOT NULL REFERENCES tenants(id),
  organization_id text NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  -- Agenda korpusu (FP, OZ, INT…) — tá istá protistrana sa na faktúre a na
  -- internom doklade účtuje inak.
  agenda text NOT NULL,
  protistrana text NOT NULL,
  protistrana_ico text,
  -- Z koľkých dokladov je pravidlo odvodené a v koľkých z nich väčšinová
  -- hlavička naozaj platí. Účtovník má vidieť, či je to zákon alebo zvyk.
  dokladov integer NOT NULL,
  zhoda integer NOT NULL,
  predkontacia_kod text,
  clenenie_dph_kod text,
  clenenie_kv_kod text,
  -- Ustálený tvar položiek: [{ text, predkontaciaKod, clenenieDphKod,
  -- clenenieKvKod, podiel }]. Prázdne pole = doklad sa nerozpisuje.
  rozpis jsonb NOT NULL DEFAULT '[]'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);
-- Prepočet pravidiel je náhrada celej sady, nie prírastok.
CREATE UNIQUE INDEX ucto_pravidla_identita ON ucto_pravidla (organization_id, agenda, protistrana);
CREATE INDEX ucto_pravidla_org_idx ON ucto_pravidla (tenant_id, organization_id, dokladov DESC);

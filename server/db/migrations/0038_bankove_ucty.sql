-- Číselník bankových účtov POHODY (skratka PB/SBUS + IBAN + mena).
-- Základ pre agendu Banka: výpis sa páruje na účet POHODY podľa IBAN-u
-- a export bankových pohybov nesie skratku účtu (bnk:account).
ALTER TABLE code_list_items DROP CONSTRAINT code_list_items_kind_check;
ALTER TABLE code_list_items ADD CONSTRAINT code_list_items_kind_check
  CHECK (kind IN ('predkontacie','cleneniaDph','ciselneRady','strediska','clenenieKv','zakazky','cinnosti','projekty','bankoveUcty'));

-- IBAN a mena majú zmysel len pre bankové účty; pri ostatných druhoch ostávajú NULL.
ALTER TABLE code_list_items ADD COLUMN iban text;
ALTER TABLE code_list_items ADD COLUMN mena text;

-- Telemetria synchronizácie mostíkom pozná aj bankové účty.
ALTER TABLE agent_sync_runs DROP CONSTRAINT agent_sync_runs_kind_check;
ALTER TABLE agent_sync_runs ADD CONSTRAINT agent_sync_runs_kind_check
  CHECK (kind IN ('predkontacie','cleneniaDph','ciselneRady','strediska','bankoveUcty','treningAi'));

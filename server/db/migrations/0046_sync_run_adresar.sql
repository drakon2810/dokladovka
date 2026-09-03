-- Telemetria synchronizácie pozná aj adresár.
--
-- Kind som pridal do zod schémy v route, ale CHECK na tabuľke zostal starý.
-- Požiadavka teda prešla validáciou a spadla až na INSERT-e; agent výsledok
-- telemetrie posiela cez „Try" a chybu si zapísal iba do vlastného logu.
-- Výsledok: na serveri nebolo po adresári ani stopy a vyzeralo to rovnako ako
-- keby sa ten kód nikdy nespustil.
--
-- Overenie v jednej vrstve a odmietnutie v druhej — presne to, čo malo byť
-- vidieť na prvý pokus.
ALTER TABLE agent_sync_runs DROP CONSTRAINT agent_sync_runs_kind_check;
ALTER TABLE agent_sync_runs ADD CONSTRAINT agent_sync_runs_kind_check
  CHECK (kind IN ('predkontacie', 'cleneniaDph', 'ciselneRady', 'strediska',
                  'bankoveUcty', 'treningAi', 'adresar'));

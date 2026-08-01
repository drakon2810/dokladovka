-- „Synchronizovať mostíkom" pre Tréning AI: web nastaví žiadosť, agent pri
-- najbližšom cykle stiahne prijaté faktúry z POHODY (XML export, iba čítanie)
-- a nahrá rozhodnutia do pamäte. Rovnaký vzor ako code_list_sync_requested_at.
ALTER TABLE pohoda_company_links ADD COLUMN training_sync_requested_at timestamptz;

-- Telemetria behu tréningovej synchronizácie v agent_sync_runs.
ALTER TABLE agent_sync_runs DROP CONSTRAINT agent_sync_runs_kind_check;
ALTER TABLE agent_sync_runs ADD CONSTRAINT agent_sync_runs_kind_check
  CHECK (kind IN ('predkontacie','cleneniaDph','ciselneRady','strediska','treningAi'));

-- Per-riadkové zaúčtovanie z documents.extracted.polozky[].ucto — jediná
-- per-položková pravda v systéme (pamäť aj návrhy pracujú s hlavičkou).
-- Zbiera sa do zásoby pre budúci seed číselníka typov položiek; zatiaľ bez čitateľa.
ALTER TABLE ucto_decisions ADD COLUMN polozky_ucto jsonb;

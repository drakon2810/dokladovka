-- PEPPOL BIS 3.0 deterministický parser ako ďalší extraction provider.
ALTER TABLE extraction_runs DROP CONSTRAINT extraction_runs_provider_check;
ALTER TABLE extraction_runs ADD CONSTRAINT extraction_runs_provider_check
  CHECK (provider IN ('mock', 'openai', 'peppol'));

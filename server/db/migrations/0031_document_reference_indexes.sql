-- Mazanie dokladov bolo kvadratické: cudzie kľúče na documents(id) nemali index,
-- takže každý zmazaný doklad spustil sekvenčný sken referencujúcej tabuľky.
-- Pri väčšej firme (rádovo desaťtisíce dokladov) DELETE prekročil statement_timeout
-- a firma sa nedala zmazať vôbec. Zrýchľuje aj mazanie jedného dokladu vo workeri.
CREATE INDEX IF NOT EXISTS documents_duplicate_of_idx ON documents (duplicate_of_document_id);
CREATE INDEX IF NOT EXISTS processing_jobs_document_idx ON processing_jobs (document_id);
CREATE INDEX IF NOT EXISTS extraction_runs_document_idx ON extraction_runs (document_id);
CREATE INDEX IF NOT EXISTS accounting_suggestions_based_on_idx ON accounting_suggestions (based_on_document_id);

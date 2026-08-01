-- Synchronizácia číselníkov mostíkom na kliknutie (parita s Doklado
-- „Synchronizovať mostíkom"): web nastaví žiadosť, agent ju pri najbližšom
-- cykle (~30 s) vybaví mimo hodinového intervalu a pri nahratí číselníkov
-- sa žiadosť zmaže.
ALTER TABLE pohoda_company_links ADD COLUMN code_list_sync_requested_at timestamptz;

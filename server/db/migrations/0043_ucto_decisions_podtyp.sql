-- Podtyp v pamäti rozhodnutí.
--
-- Mostík do pamäte ukladá aj dobropisy a zálohové faktúry (sú v zozname typov,
-- ktoré vyváža), ale druh dokladu neposielal — všetko pristálo ako FP. V pamäti
-- ALPINY tak leží najmenej 33 dobropisov medzi 1249 riadkami bežných faktúr.
--
-- Prečo to prekáža: pamäť odpovedá na otázku „ako tento dodávateľ účtuje tento
-- text". Dobropis sa účtuje opačným smerom a do inej sekcie kontrolného výkazu
-- (C2, nie B1), takže ako príklad pre bežnú faktúru ťahá k zlej sekcii.
--
-- Rovnaká chyba ako v korpuse histórie, len v druhom úložisku; tam sa vyriešila
-- rozdelením agend (0042), tu podtypom. 'bezna' je default — existujúce riadky
-- sú prevažne bežné faktúry a prepíše ich až ďalší prenos z Mostíka.
ALTER TABLE ucto_decisions ADD COLUMN podtyp text NOT NULL DEFAULT 'bezna'
  CHECK (podtyp IN ('bezna', 'dobropis', 'tarchopis', 'zalohova'));

-- Príklady sa hľadajú podľa dvojice (document_type, podtyp) — index ich drží
-- spolu, aby dobropisy nemusel filter prechádzať riadok po riadku.
CREATE INDEX ucto_decisions_druh ON ucto_decisions (organization_id, document_type, podtyp)
  WHERE excluded = false;

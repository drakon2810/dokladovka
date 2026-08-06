-- Predvolená pokladňa k pokladničnému dokladu. POHODA má pri doklade okrem
-- číselného radu aj pole „Pokl." (HP1, HP…) a bez neho doklad neprijme, takže
-- účtovník ho doteraz písal ručne na každom doklade. Rad aj pokladňa patria k
-- tomu istému typu dokladu, preto sedia v jednom riadku.
-- Stĺpec je voliteľný: pri ostatných typoch dokladu pokladňa neexistuje.
ALTER TABLE organization_series_defaults ADD COLUMN IF NOT EXISTS pokladna_kod text;

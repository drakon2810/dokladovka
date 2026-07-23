-- Príznak „neučiť sa z tohto záznamu": vylúči rozhodnutie z návrhov, retrievalu
-- aj analýzy pravidiel bez toho, aby sa zmazalo (napr. starý plán účtov, chybný
-- historický import). Aktívne/neaktívne položky číselníkov rieši onlyActiveIds.
ALTER TABLE ucto_decisions ADD COLUMN excluded boolean NOT NULL DEFAULT false;

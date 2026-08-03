-- Predkontácie POHODY s kódom „BEZ…" (BEZ321100, BEZ325999, BEZ314100…) sú
-- doklady BEZ zaúčtovania — údajová uzávierka, úhrada preplatku, záloha. Nie sú
-- to účty; návrh s takou predkontáciou je vždy nesprávny. Kód ich odteraz
-- nikde neponúka ani sa z nich neučí, tu sa dočistí, čo už v profile je.
UPDATE ucto_historia SET predkontacia_kod = NULL, predkontacia_id = NULL
 WHERE predkontacia_kod ILIKE 'BEZ%';
DELETE FROM ucto_historia
 WHERE predkontacia_kod IS NULL AND clenenie_dph_kod IS NULL;

UPDATE ucto_kategorie SET predkontacia_kod = NULL, predkontacia_id = NULL
 WHERE predkontacia_kod ILIKE 'BEZ%';

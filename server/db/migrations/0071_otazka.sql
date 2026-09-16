-- Otázka účtovníkovi (R09): protistrana má viac praxí s inou daňou a hádať nemá
-- kto. Podoby praxe preložené na id číselníka, ktoré karta dokladu ponúkne na
-- výber. Patrí návrhu — nový návrh ju prepíše alebo zruší.
ALTER TABLE accounting_suggestions ADD COLUMN otazka jsonb;

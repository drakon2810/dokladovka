-- Vysvetlenie „Prečo?" je odteraz pre KAŽDÉ pole zvlášť: predkontácia sa opiera
-- o účtovnú metodiku, členenie DPH a kontrolný výkaz o zdroje finančnej správy.
-- Staré jednotné stĺpce boli iba keš (regenerovateľná), preto sa rušia.
ALTER TABLE accounting_suggestions DROP COLUMN vysvetlenie;
ALTER TABLE accounting_suggestions DROP COLUMN vysvetlenie_zdroje;
ALTER TABLE accounting_suggestions ADD COLUMN vysvetlenia jsonb;

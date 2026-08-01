-- Typ položky = predkontácia + účty + daňový pomer. POHODA posiela účty MD/DAL
-- v atribútoch debit/credit číselníka predkontácií (doteraz sa zahadzovali);
-- tax_ratio_kod odkazuje na konštantný katalóg pomerov (server/services/taxRatios.ts).
ALTER TABLE code_list_items ADD COLUMN ucet_md text;
ALTER TABLE code_list_items ADD COLUMN ucet_dal text;
ALTER TABLE code_list_items ADD COLUMN tax_ratio_kod text;

-- Dôvod pravidla: prečo firma účtuje daného dodávateľa/kľúčové slová takto.
-- dovod_source rozlišuje AI návrh (ai_draft) od textu potvrdeného človekom
-- (human) — AI draft sa nikdy nesmie zobrazovať ako overená prax firmy.
ALTER TABLE accounting_rules ADD COLUMN dovod text;
ALTER TABLE accounting_rules ADD COLUMN dovod_source text CHECK (dovod_source IN ('human','ai_draft'));
ALTER TABLE accounting_rules ADD COLUMN dovod_updated_at timestamptz;
ALTER TABLE accounting_rules ADD COLUMN dovod_updated_by text;

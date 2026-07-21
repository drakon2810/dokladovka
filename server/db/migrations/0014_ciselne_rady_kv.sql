-- Číselné rady: najvyššie použité číslo (topNumber z exportu POHODY) pre
-- logické pokračovanie číslovania naprieč agendami (prijaté faktúry, interné
-- doklady, ostatné záväzky, zálohové faktúry, pokladňa).
ALTER TABLE code_list_items ADD COLUMN last_number text;

-- Členenie DPH: sekcia Kontrolného výkazu DPH prevzatá z položky členenia DPH
-- (element sectionInVATLedgerStatement), ak ju POHODA pri exporte vyplní.
-- POHODA XML nemá samostatný export číselníka „Členenie KV DPH“; sekciu preto
-- odvodzujeme z členenia DPH, tak ako ich prepája samotná POHODA.
ALTER TABLE code_list_items ADD COLUMN kv_section text;

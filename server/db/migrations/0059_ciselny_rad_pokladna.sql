-- Pokladňa číselného radu. POHODA ju drží priamo na rade pokladne
-- (numericalSeries.cashAccount — „vyžadován při vytvoření číselné řady pro
-- agendu Pokladna"), agent ju však doteraz nečítal. Pokladničný doklad potom
-- prichádzal bez kódu pokladne a účtovník ho v každej firme písal ručne.
ALTER TABLE code_list_items ADD COLUMN IF NOT EXISTS pokladna_kod text;

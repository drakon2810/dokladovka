-- Pravidlo protistrany môže platiť len pre vybrané typy dokladov. Odpoveď na
-- spor praxe ostatných záväzkov (napr. PN na bločku) nesmie prebiť bežnú
-- faktúru toho istého dodávateľa s nárokom na odpočet. NULL = všetky typy.
ALTER TABLE accounting_rules ADD COLUMN typy_dokladov text[];

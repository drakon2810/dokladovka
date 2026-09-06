-- Poradie riadka v doklade sa aj ukladá, nielen počíta do odtlačku.
--
-- Doteraz šlo len do riadok_hash, takže sa z korpusu nedalo zistiť, ktorý
-- riadok je hlavička dokladu a ktorý jeho položka. Meranie presnosti pritom
-- musí doklad poskladať späť: hlavička nesie zaúčtovanie, s ktorým sa návrh
-- porovnáva, položky nesú to, čo model dostane na vstup.
ALTER TABLE ucto_historia ADD COLUMN riadok_index integer;

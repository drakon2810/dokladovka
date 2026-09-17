-- Druhy operácie protistrany. Pravidlo bolo kľúčované len protistranou, takže
-- zamestnanec so zúčtovaním stravného aj pokutami dostal na každý doklad tú
-- istú (prevažujúcu či prvú) podobu. Druh je hlavička s účtom, slová, ktorými
-- sa text jej dokladov líši od ostatných dokladov protistrany (odvodené
-- z histórie, bez mena protistrany), a prax len z dokladov druhu.
--
-- druhy: [{ slova, dokladov, zhoda, predkontaciaKod, clenenieDphKod,
-- clenenieKvKod, rozpis, konflikt, varianty, zmenaRezimu }]. Prázdne pole (aj pred prepočtom praxe) = návrh ostáva pri
-- pravidle protistrany.
ALTER TABLE ucto_pravidla ADD COLUMN druhy jsonb NOT NULL DEFAULT '[]'::jsonb;

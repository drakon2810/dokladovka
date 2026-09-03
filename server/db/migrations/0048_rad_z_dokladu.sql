-- Číselný rad prečítaný z dokladu, nie z číselníka POHODY.
--
-- POHODA rad, ktorý nemá vyplnené pole Obdobie, do exportu číselníka vôbec
-- nedá: v jej schéme numericalSeries.xsd je element „period" povinný a
-- obmedzený na {permanent, yearlong}, takže taký záznam nevie zapísať a ticho
-- ho vynechá. ALPINA tak z 18 radov ostatných záväzkov dostala 13 a chýbal
-- medzi nimi 26OZ, na ktorom má vyše 370 dokladov. Overené na jej reálnom
-- exporte: filter podľa agendy ani podľa obdobia s tým nepohol a starý formát
-- listNumericSeries POHODA 14301 už neprijme (XML komunikácia 1.x zrušená).
--
-- Doklad ten istý rad nesie bez problémov — <typ:id> je identifikátor radu
-- a <typ:ids> jeho prefix — tak sa berie odtiaľ.
--
-- Vlastný zdroj je nutný: hodinová synchronizácia číselníka deaktivuje každý
-- rad so source='pohoda', ktorý v dávke nie je, a tieto rady v nej nikdy
-- nebudú. Zároveň sa nesmú tváriť ako ručne založené, aby sa dali odlíšiť.
ALTER TABLE code_list_items DROP CONSTRAINT code_list_items_source_check;

ALTER TABLE code_list_items ADD CONSTRAINT code_list_items_source_check
  CHECK (source IN ('manual', 'pohoda', 'pohoda_doklad'));

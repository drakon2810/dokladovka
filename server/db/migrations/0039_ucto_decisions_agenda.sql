-- Pamäť rozhodnutí doteraz nevedela, z akej agendy rozhodnutie pochádza.
-- Vydaná faktúra tak dostávala návrhy z PRIJATÝCH faktúr podobného mena
-- (sesterské firmy tej istej siete) a preberala ich DPH schému. Doklad sa
-- s pamäťou odteraz páruje len v rámci rovnakej agendy.
ALTER TABLE ucto_decisions ADD COLUMN document_type text;
UPDATE ucto_decisions d SET document_type=doc.document_type
  FROM documents doc WHERE d.document_id=doc.id;
-- Tréningový import číta prijaté faktúry POHODY; riadky bez dokladu sú FP.
UPDATE ucto_decisions SET document_type='FP' WHERE document_type IS NULL;

-- Doterajšie rozhodnutia z vydaných faktúr sú kľúčované vlastnou firmou (vtedy
-- bol kľúčom vždy „dodávateľ"). Po prechode na protistranu by ich už žiadna
-- nová vydaná faktúra nenašla — prekľúčujeme ich na odberateľa z dokladu, aby
-- sa firma neprestala učiť z toho, čo už raz schválila.
-- Normalizácia mena musí sedieť s normalizeName() na serveri (trim, lowercase,
-- zlúčené medzery) — inak by prekľúčované riadky pamäť nikdy nenašla. Preto:
-- najprv nezalomiteľná medzera z „s. r. o." na obyčajnú (SQL trim reže len tú
-- ASCII), potom zlúčenie medzier a až nakoniec orezanie okrajov.
UPDATE ucto_decisions d SET
  supplier_ico = nullif(regexp_replace(coalesce(doc.extracted->'odberatel'->>'ico', ''), '[^0-9]', '', 'g'), ''),
  supplier_name_normalized = nullif(lower(trim(regexp_replace(
    translate(coalesce(doc.extracted->'odberatel'->>'nazov', ''), chr(160), ' '), '[[:space:]]+', ' ', 'g'))), '')
FROM documents doc
WHERE d.document_id = doc.id AND doc.document_type = 'FV'
  AND (doc.extracted->'odberatel'->>'nazov' <> '' OR doc.extracted->'odberatel'->>'ico' <> '');

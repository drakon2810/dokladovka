-- Rozdelenie dokladu: jeden prijatý súbor môže skončiť ako dva doklady v POHODE
-- (napr. rekapitulácia miezd — hrubé mzdy interným dokladom, odvody poisťovni
-- ako ostatný záväzok). Nový doklad si pamätá, z ktorého vznikol, aby sa dal
-- zobraziť pôvodný sken aj skočiť medzi časťami.
ALTER TABLE documents ADD COLUMN split_from_document_id text REFERENCES documents(id);

-- Index kvôli mazaniu organizácie a dohľadaniu súrodencov (rovnaký dôvod ako 0031).
CREATE INDEX documents_split_from_idx ON documents (split_from_document_id)
  WHERE split_from_document_id IS NOT NULL;

-- Stopa rozhodnutia, nie len dôkazov. „Prečo" doteraz skladalo vysvetlenie
-- dodatočne z výsledných kódov (a platilo za to ďalšie volanie modelu),
-- hoci výsledok často nie je voľbou modelu: účet bez odpočtu prepíše
-- členenie, prax firmy sekciu KV, nastavenie firmy rad. Tu je, čo model
-- vybral, čo z toho ktoré pravidlo zmenilo a prečo návrh dostal svoju istotu.
-- Len id, kódy a čísla — žiadny text dokladu ani prompt.
ALTER TABLE ucto_navrh_stopa
  ADD COLUMN model text,
  ADD COLUMN odpoved jsonb,
  ADD COLUMN zmeny jsonb NOT NULL DEFAULT '[]'::jsonb,
  ADD COLUMN istota jsonb;

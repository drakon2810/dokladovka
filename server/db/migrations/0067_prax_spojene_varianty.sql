-- Spoločná prax protistrany a kategórie, ktoré analýza neprepíše.
--
-- Pravidlo protistrany bralo účet, členenie DPH a sekciu KV ako tri nezávislé
-- väčšiny. Protistrana s účtom A v 60 dokladoch (30× VATx, 30× VATz) a účtom B
-- v 40 dokladoch VATy tak dostala pravidlo A + VATy — kombináciu, ktorú firma
-- nikdy nepoužila. Pravidlo sa teraz vyberá z CELÝCH podôb dokladu (hlavička
-- aj tvar položiek); keď žiadna neprevažuje, pravidlo to povie a nesie podoby.
--
-- varianty: [{ predkontaciaKod, clenenieDphKod, clenenieKvKod, tvar, dokladov,
-- od, do, vitaz?, zmenaRezimu? }] — zoradené podľa počtu dokladov.
ALTER TABLE ucto_pravidla ADD COLUMN varianty jsonb NOT NULL DEFAULT '[]'::jsonb;
-- Žiadna podoba neprevažuje: pravidlo nemá kódy hlavičky, len podoby.
ALTER TABLE ucto_pravidla ADD COLUMN konflikt boolean NOT NULL DEFAULT false;

-- Kategórie: analýza ich doteraz po každej dávke zmazala a vložila s novými id.
-- Ručné úpravy sa stratili, zmazané kategórie sa vrátili a PATCH z otvorenej
-- obrazovky dostal 404. Kategória má teraz stabilný kľúč (meno, ktoré jej dal
-- model) a zoznam polí, ktoré upravil človek — tie analýza nechá tak.
-- kluc ostáva nullable: staršia verzia servera vkladá kategórie bez neho.
ALTER TABLE ucto_kategorie ADD COLUMN kluc text;
ALTER TABLE ucto_kategorie ADD COLUMN rucne_polia text[] NOT NULL DEFAULT '{}';

-- Rovnaké meno dvakrát v jednej firme (staré dáta) dostane pri druhom výskyte
-- príponu id, inak by jedinečný index nevznikol.
UPDATE ucto_kategorie k
   SET kluc = CASE WHEN p.poradie = 1 THEN p.zaklad ELSE p.zaklad || ':' || k.id END
  FROM (SELECT id, lower(nazov) AS zaklad,
               row_number() OVER (PARTITION BY organization_id, lower(nazov) ORDER BY active DESC, created_at, id) AS poradie
          FROM ucto_kategorie) p
 WHERE p.id = k.id;

-- updated_at mení len ručná úprava a zmazanie (rozpis ani právna poznámka nie),
-- takže kategória upravená po vzniku sa považuje za ručnú celá — radšej
-- zachovať priveľa než stratiť opravu účtovníka.
UPDATE ucto_kategorie
   SET rucne_polia = ARRAY['nazov', 'popis', 'slovnik', 'predkontaciaKod', 'clenenieDphKod', 'clenenieKvKod']
 WHERE updated_at > created_at + interval '1 second' OR active = false;

CREATE UNIQUE INDEX ucto_kategorie_kluc ON ucto_kategorie (organization_id, kluc) WHERE kluc IS NOT NULL;

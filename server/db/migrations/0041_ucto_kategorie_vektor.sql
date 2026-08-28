-- Sémantický vektor kategórie plnenia.
--
-- Kategórie sa doteraz vyberali výskytom podreťazca zo slovníka v texte
-- položiek. Taliansky „Intervento del 13/03/2026" tak netrafil kategóriu
-- „Asistenčné služby a odťah vozidiel" ani jedným znakom, model dostal prázdny
-- zoznam kategórií a predkontáciu volil podľa NÁZVU z účtovného rozvrhu.
--
-- Vektor je jsonb, nie pgvector: produkcia beží na čistom postgres:17-alpine
-- a testy na PGlite, ktorý vektorové rozšírenie vôbec nebalí. Pri ~30
-- kategóriách na firmu je kosínus v Node aj tak lacnejší než round-trip.
--
-- vektor_model drží model, ktorým vektor vznikol. Vektory z iného modelu ležia
-- v inom priestore a kosínus by medzi nimi vrátil číslo, nie chybu — pri
-- nezhode s konfiguráciou sa preto riadok berie ako bez vektora.
--
-- NULL = presne dnešné správanie (len lexikálna zhoda). Naplní ho až ďalšia
-- analýza účtovného profilu; migrácia to spraviť nemôže, vyžaduje sieť.
ALTER TABLE ucto_kategorie ADD COLUMN vektor jsonb;
ALTER TABLE ucto_kategorie ADD COLUMN vektor_model text;

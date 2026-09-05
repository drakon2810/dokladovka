-- Účtovný denník z POHODY — proviozky tak, ako doklad naozaj zaúčtovali.
--
-- Doterajší korpus (ucto_historia) drží JEDEN riadok na doklad: hlavičku
-- s jednou predkontáciou. Denník za rok 2026 pritom ukazuje, že u ALPINY má
-- 48 % dokladov viac než jednu proviozku a 24 % ide na niekoľko RÔZNYCH
-- nákladových účtov — teda každý štvrtý doklad je skutočne rozdelený a korpus
-- z neho vidí len prvý riadok. Print-Office je toho príklad: 8 z 9 faktúr
-- rozdelených na 501400 + 513100 (reprezentácia) + 548002 + DPH, kým v korpuse
-- majú jedinú predkontáciu.
--
-- PRAVDOU SÚ ÚČTY, NIE PREDKONTÁCIA. Meranie na tom istom dennÍku proti 1141
-- predkontáciám organizácie: dvojica účtov sadne na práve jednu predkontáciu
-- v 55 % proviozok, na viac kandidátov v 25 % a na žiadnu v 20 %. Keby sa pri
-- načítaní vynucoval jeden kód, takmer polovica záznamov by sa buď pokazila,
-- alebo zahodila. Kandidáti sa preto držia ako pole a rozhodujú sa neskôr —
-- podľa textu a protistrany, keď je na to viac signálu.
CREATE TABLE ucto_dennik (
  id text PRIMARY KEY,
  tenant_id text NOT NULL REFERENCES tenants(id),
  organization_id text NOT NULL REFERENCES organizations(id),
  -- act:id — identita proviozky v POHODE; drží opakovaný import bez duplicít.
  externalny_id text NOT NULL,
  -- act:source, napr. „Prijaté faktúry"; slovník POHODY, nie agendy korpusu.
  agenda text NOT NULL,
  doklad_cislo text,
  datum date,
  text text,
  suma numeric(18,2),
  ucet_md text NOT NULL,
  ucet_dal text NOT NULL,
  partner_ico text,
  partner_nazov text,
  stredisko_kod text,
  cinnost_kod text,
  zakazka_kod text,
  -- Kódy predkontácií, ktorých účty sedia s touto proviozkou. Prázdne pole je
  -- legitímny stav (banka, pokladňa) — nie chyba.
  predkontacia_kody text[] NOT NULL DEFAULT '{}',
  created_at timestamptz NOT NULL DEFAULT now()
);

-- Opakovaný import prepíše záznam, nezdvojí ho.
CREATE UNIQUE INDEX ucto_dennik_identita ON ucto_dennik (organization_id, externalny_id);
-- Doklad sa z proviozok skladá naspäť práve podľa agendy a čísla.
CREATE INDEX ucto_dennik_doklad_idx ON ucto_dennik (tenant_id, organization_id, agenda, doklad_cislo);
CREATE INDEX ucto_dennik_partner_idx ON ucto_dennik (tenant_id, organization_id, partner_nazov);

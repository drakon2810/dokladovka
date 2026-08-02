-- Heartbeat agenta vidí všetky ročníky firmy (databázy StwPh_{ICO}_{rok}), doteraz
-- sa uložil len ten vybraný. Zoznam drží dvojice rok + názov databázy, aby výber
-- roka v Nastaveniach vedel poslať aj správnu databázu (agent páruje podľa nej).
ALTER TABLE pohoda_company_links ADD COLUMN available_years jsonb NOT NULL DEFAULT '[]'::jsonb;

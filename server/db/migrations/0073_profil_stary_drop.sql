-- Starý profil klienta. DPH profil prešiel do profil_fakty (0072) a nič ho už
-- nečíta; účtovný profil (obdobie, zaokrúhľovanie, párovanie, rozvrh) žiadnu
-- logiku nemal — párovanie partnerov ide vždy predvoleným poradím.
DROP TABLE organization_dph_profiles;
DROP TABLE organization_accounting_profiles;

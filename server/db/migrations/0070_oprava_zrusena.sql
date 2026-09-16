-- Zrušené schválenie. Oprava ostáva (je to história rozhodovania), ale už
-- neplatí: doklad sa vrátil na kontrolu a opätovné schválenie zapíše novú.
-- Bez príznaku sa ten istý doklad rátal dvakrát.
ALTER TABLE ucto_opravy ADD COLUMN zrusena_at timestamptz;

-- Etapa 4 tréningu AI: pravidlá navrhnuté AI (potvrdzuje účtovník) a
-- samokontrola pravidiel. Pravidlo môže okrem dodávateľa matchovať aj kľúčové
-- slová v texte položiek a niesť členenie KV. Tri opravy návrhu z pravidla po
-- sebe pravidlo deaktivujú a označia na kontrolu (needs_review).
ALTER TABLE accounting_rules ADD COLUMN keywords jsonb NOT NULL DEFAULT '[]'::jsonb;
ALTER TABLE accounting_rules ADD COLUMN clenenie_kv_kod text;
ALTER TABLE accounting_rules ADD COLUMN origin text NOT NULL DEFAULT 'manual' CHECK (origin IN ('manual','ai'));
ALTER TABLE accounting_rules ADD COLUMN corrections_count integer NOT NULL DEFAULT 0;
ALTER TABLE accounting_rules ADD COLUMN needs_review boolean NOT NULL DEFAULT false;

-- Návrh si pamätá, ktoré pravidlo ho vytvorilo — spätná väzba pri schválení
-- vie pravidlo potvrdiť (reset počítadla) alebo mu pripísať opravu.
ALTER TABLE accounting_suggestions ADD COLUMN rule_id text;

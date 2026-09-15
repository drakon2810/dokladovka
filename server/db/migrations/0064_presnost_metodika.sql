-- Meranie presnosti, metodika 2: bez zápisov, história ku dňu KAŽDÉHO dokladu,
-- neznáma skutočnosť sa nepočíta ako zhoda a rozpis sa porovnáva celým tvarom.
--
-- Staré behy (metodika 1) sa neprepočítavajú: merali s jedným delítkom,
-- s kategóriami z celej histórie a neznáme DPH/KV rátali ako správne. Ich čísla
-- s novými porovnať nejde, preto ostávajú označené a UI ich tak aj ukáže.
ALTER TABLE ucto_presnost ADD COLUMN metodika integer NOT NULL DEFAULT 1;
-- 'bez_ai' = lokálny výber z dôkazov v prompte, 'ai' = skutočný model.
ALTER TABLE ucto_presnost ADD COLUMN rezim text;
-- Z čoho beh vznikol: commit, model, hash inštrukcií, okná, politika asOf,
-- vylúčené zdroje, odtlačok korpusu pred a po, tokeny. Bez neho sa dva behy
-- nedajú férovo porovnať.
ALTER TABLE ucto_presnost ADD COLUMN manifest jsonb;
-- Výsledok po dokladoch (najviac 500) — z neho sa počíta interval spoľahlivosti
-- a beh sa dá prehodnotiť bez nového volania modelu.
ALTER TABLE ucto_presnost ADD COLUMN doklady jsonb;

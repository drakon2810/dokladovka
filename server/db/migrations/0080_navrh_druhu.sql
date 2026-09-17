-- Druh dokladu (typ a podtyp), ako ho určila extrakcia a klasifikácia, skôr než
-- ho účtovník prvýkrát zmenil. Klasifikácia svoj podtyp nikde neukladala a úprava
-- dokladu ho prepísala, takže oprava „faktúra → dobropis" sa do ucto_opravy
-- nedostala. NULL = druh nikto nemenil, návrhom je aktuálny druh dokladu.
ALTER TABLE documents ADD COLUMN navrh_druhu jsonb;

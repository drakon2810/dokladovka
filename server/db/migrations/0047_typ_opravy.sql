-- Opravy typu dokladu — pamäť pre krok „čo je to za papier".
--
-- Keď účtovník prepne typ (INY → OZ, FP → PD), dnes to nikam nejde. Ďalší
-- rovnaký doklad prejde tou istou cestou a spraví tú istú chybu. Pamäť
-- rozhodnutí existuje, ale drží iba zaúčtovanie — teda krok PO tom, čo je typ
-- už určený, a filtruje sa práve tým typom. Na chybu v type teda nedosiahne.
--
-- Rossum aj Vic.ai stavajú produkt presne na tomto: každá oprava zvyšuje podiel
-- dokladov, ktoré prejdú bez človeka. Bez nej sa systém nastaví raz a ďalej sa
-- nezlepšuje.
--
-- Zapisuje sa dodávateľ a text dokladu — to, čo sa dá porovnať s ďalším
-- papierom. Nie ID dokladu: ten je jedinečný a nikdy sa nezopakuje.
CREATE TABLE typ_opravy (
  id text PRIMARY KEY,
  tenant_id text NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  organization_id text NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  document_id text REFERENCES documents(id) ON DELETE SET NULL,
  supplier_name_normalized text,
  text_normalized text,
  povodny_typ text NOT NULL,
  novy_typ text NOT NULL,
  created_by text REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now()
);

-- Profil firmy sa skladá pri každej klasifikácii, takže musí byť lacný.
CREATE INDEX typ_opravy_profil_idx ON typ_opravy (tenant_id, organization_id, created_at DESC);

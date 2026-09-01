-- Presun súboru do „spracované" po prenose do POHODY.
--
-- Žiadny job, žiadna fronta: čo sa má presunúť, sa dá ODVODIŤ zo stavu dokladov
-- a jednej značky. Poller si to zakaždým spočíta nanovo, takže keď je Graph
-- chvíľu nedostupný, ďalší cyklus to dobehne sám — bez opakovaní, mŕtvych
-- jobov a bez rizika, že sa presun stratí medzi commitom a odoslaním.
--
-- Podmienka je „všetky doklady z tohto súboru sú vybavené", nie „tento doklad
-- je prenesený": z jedného PDF môže rozdelením vzniknúť viac dokladov a súbor
-- by odišiel do „spracované", kým sú dva ešte rozrobené.
ALTER TABLE inbound_attachments ADD COLUMN sharepoint_moved_at timestamptz;

-- Číslo, ktoré dokladu pridelila POHODA. Doteraz žilo iba vo vete histórie
-- („Prenos potvrdený č. …"), odkiaľ sa nedá spoľahlivo prečítať. Ide do názvu
-- presunutého súboru, takže v priečinku klienta je vidieť, pod čím je doklad
-- zaúčtovaný — a účtovník ho konečne vidí aj v samotnom doklade.
ALTER TABLE documents ADD COLUMN pohoda_number text;

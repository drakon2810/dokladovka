-- Podtyp dokladu: dobropis, ťarchopis, zálohová faktúra.
--
-- POHODA ich rieši dvoma spôsobmi naraz a my kopírujeme oba:
--   * dobropis a ťarchopis sú TYP vnútri agendy faktúr — to isté okno, ten istý
--     číselník radov (2611 Prijaté faktúry, 2612 Prijaté dopropisy, 2613 Prijaté
--     ťarchopisy ležia vedľa seba), navyše pole „Pôv. doklad";
--   * zálohová faktúra má VLASTNÚ agendu (prijate_zalohove_faktury) a v nej
--     žiadne členenie DPH — daňový moment ešte nenastal.
--
-- Preto podtyp, nie nové typy dokladu: na doklade.typ visí 63 vetvení (párovanie
-- úhrad, export, rozloženie karty) a pre dobropis sú identické. Rozhoduje AŽ
-- dvojica (typ, podtyp) — mapy agend ju berú celú, takže prekladač ukáže každé
-- miesto, kde sa poslal iba typ.
--
-- 'bezna' je default: všetky existujúce doklady sú bežné faktúry a nič sa im
-- nemení. Rozdelenie histórie na FP-D/FP-T/FP-Z prinesie až Mostík (etapa 2).
ALTER TABLE documents ADD COLUMN podtyp text NOT NULL DEFAULT 'bezna'
  CHECK (podtyp IN ('bezna', 'dobropis', 'tarchopis', 'zalohova'));

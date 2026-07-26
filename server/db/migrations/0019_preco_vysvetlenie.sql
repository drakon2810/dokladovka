-- Kešované AI vysvetlenie „Prečo?" — generuje sa raz na doklad a nuluje sa
-- pri prepočte návrhu, aby vysvetlenie nikdy nezaostávalo za návrhom.
ALTER TABLE accounting_suggestions ADD COLUMN vysvetlenie text;

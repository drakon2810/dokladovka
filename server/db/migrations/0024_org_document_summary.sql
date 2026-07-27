-- Krátke AI zhrnutie firemného dokumentu (sekcia „Iné doklady" v zozname).
-- Ukladá sa, aby sa za to isté PDF neplatilo pri každom otvorení znova.

ALTER TABLE organization_documents ADD COLUMN ai_summary jsonb;
ALTER TABLE organization_documents ADD COLUMN ai_summary_at timestamptz;

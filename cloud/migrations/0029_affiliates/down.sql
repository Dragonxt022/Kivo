ALTER TABLE charges DROP COLUMN discount_cents;
ALTER TABLE charges DROP COLUMN discount_pct;
ALTER TABLE charges DROP COLUMN original_amount_cents;
ALTER TABLE companies DROP COLUMN affiliate_id;
DROP TABLE IF EXISTS affiliates;

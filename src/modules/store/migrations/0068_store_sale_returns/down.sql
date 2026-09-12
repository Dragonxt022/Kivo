DROP INDEX IF EXISTS idx_sale_return_items_sale;
DROP INDEX IF EXISTS idx_sale_return_items_return;
DROP TABLE IF EXISTS sale_return_items;
DROP INDEX IF EXISTS idx_sale_returns_sale;
DROP TABLE IF EXISTS sale_returns;
ALTER TABLE sales DROP COLUMN discount_reason;

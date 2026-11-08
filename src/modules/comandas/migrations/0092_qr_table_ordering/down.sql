-- 0092_qr_table_ordering (down)
DROP INDEX IF EXISTS idx_qr_orders_comanda;
DROP TABLE IF EXISTS qr_orders;
ALTER TABLE comanda_items DROP COLUMN qr_order_id;
ALTER TABLE comanda_items DROP COLUMN origem;
ALTER TABLE comanda_items DROP COLUMN para_viagem;
ALTER TABLE store_tables DROP COLUMN qr_updated_at;
ALTER TABLE store_tables DROP COLUMN qr_token;

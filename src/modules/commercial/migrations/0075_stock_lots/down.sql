DROP TABLE IF EXISTS lot_consumptions;
ALTER TABLE stock_movements DROP COLUMN lot_id;
DROP TABLE IF EXISTS product_lots;
ALTER TABLE products DROP COLUMN controla_lote;

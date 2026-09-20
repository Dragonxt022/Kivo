-- Reversão da 0071. SQLite (>=3.35) suporta DROP COLUMN; as colunas aqui são simples
-- (sem índice/constraint próprios), então o DROP funciona direto.
DROP TABLE IF EXISTS product_barcodes;
ALTER TABLE product_suppliers DROP COLUMN pack_unit;
ALTER TABLE product_suppliers DROP COLUMN pack_qty;
ALTER TABLE suppliers DROP COLUMN default_markup_bps;
ALTER TABLE suppliers DROP COLUMN contact_email;
ALTER TABLE suppliers DROP COLUMN contact_phone;
ALTER TABLE suppliers DROP COLUMN contact_name;
ALTER TABLE suppliers DROP COLUMN state;
ALTER TABLE suppliers DROP COLUMN city;
ALTER TABLE suppliers DROP COLUMN district;
ALTER TABLE suppliers DROP COLUMN complement;
ALTER TABLE suppliers DROP COLUMN number;
ALTER TABLE suppliers DROP COLUMN street;
ALTER TABLE suppliers DROP COLUMN cep;
ALTER TABLE suppliers DROP COLUMN ie;

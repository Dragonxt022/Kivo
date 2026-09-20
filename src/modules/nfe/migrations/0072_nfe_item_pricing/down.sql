-- Reversão da 0072: remove as colunas de preço/conversão do item de NF-e.
ALTER TABLE purchase_invoice_items DROP COLUMN prev_price_cents;
ALTER TABLE purchase_invoice_items DROP COLUMN ean_box;
ALTER TABLE purchase_invoice_items DROP COLUMN conversion_unit;
ALTER TABLE purchase_invoice_items DROP COLUMN conversion_qty;
ALTER TABLE purchase_invoice_items DROP COLUMN suggested_price_cents;
ALTER TABLE purchase_invoice_items DROP COLUMN sale_price_cents;

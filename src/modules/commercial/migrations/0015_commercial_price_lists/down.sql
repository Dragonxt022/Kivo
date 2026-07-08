DROP INDEX idx_customers_price_list;
ALTER TABLE customers DROP COLUMN price_list_id;
DROP INDEX idx_price_list_items_product;
DROP INDEX idx_price_list_items_unique;
DROP TABLE price_list_items;
DROP INDEX idx_price_lists_one_default;
DROP TABLE price_lists;

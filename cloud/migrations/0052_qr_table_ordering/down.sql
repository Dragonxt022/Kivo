-- 0052_qr_table_ordering (down)
DROP TABLE IF EXISTS public_orders;
DROP TABLE IF EXISTS menu_table_tokens;
DROP TABLE IF EXISTS menu_publications;
DROP INDEX idx_menu_items_sort ON menu_items;
ALTER TABLE menu_items DROP COLUMN sort_order;
ALTER TABLE menu_items DROP COLUMN complements_json;
ALTER TABLE menu_items DROP COLUMN category_name;
ALTER TABLE company_commands DROP COLUMN public_order_id;
ALTER TABLE company_commands DROP COLUMN source;
ALTER TABLE company_commands MODIFY COLUMN created_by_user_uuid CHAR(36) NOT NULL;

ALTER TABLE sale_items DROP COLUMN line_group_uuid;
ALTER TABLE sale_items DROP COLUMN notes;
DROP TABLE IF EXISTS product_complement_groups;
DROP TABLE IF EXISTS complement_group_items;
DROP TABLE IF EXISTS complement_groups;

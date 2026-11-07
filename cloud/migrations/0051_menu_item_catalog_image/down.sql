ALTER TABLE catalog_images DROP KEY idx_catalog_images_product_name;
ALTER TABLE menu_items DROP COLUMN catalog_image_id;

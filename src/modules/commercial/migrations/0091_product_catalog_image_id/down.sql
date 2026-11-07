-- 0091_product_catalog_image_id — down: remove o vínculo com o banco de imagens do Cloud.
ALTER TABLE products DROP COLUMN catalog_image_id;

DROP INDEX IF EXISTS idx_product_image_submissions_status;
DROP TABLE IF EXISTS product_image_submissions;
ALTER TABLE products DROP COLUMN image_url;

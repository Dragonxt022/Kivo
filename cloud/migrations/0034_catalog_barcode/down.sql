ALTER TABLE catalog_demand DROP COLUMN barcode;
ALTER TABLE catalog_images DROP KEY idx_catalog_images_barcode;
ALTER TABLE catalog_images DROP COLUMN barcode;

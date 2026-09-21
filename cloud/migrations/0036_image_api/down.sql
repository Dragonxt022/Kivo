DROP TABLE IF EXISTS catalog_search_cache;
DROP TABLE IF EXISTS image_api_usage;

SET @sql := IF(
  (SELECT COUNT(*) FROM information_schema.COLUMNS
    WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'catalog_images'
      AND COLUMN_NAME = 'source'
      AND COLUMN_TYPE LIKE '%api%') > 0,
  "ALTER TABLE catalog_images MODIFY COLUMN source ENUM('submissao','manual') NOT NULL DEFAULT 'submissao'",
  'DO 0');
PREPARE stmt FROM @sql;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

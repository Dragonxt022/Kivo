SET @exists := (
  SELECT COUNT(*) FROM information_schema.STATISTICS
   WHERE TABLE_SCHEMA = DATABASE()
     AND TABLE_NAME = 'sync_records'
     AND INDEX_NAME = 'idx_sync_records_received'
);
SET @sql := IF(@exists = 1,
  'DROP INDEX idx_sync_records_received ON sync_records',
  'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

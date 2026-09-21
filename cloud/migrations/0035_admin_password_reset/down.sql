DROP TABLE IF EXISTS admin_password_resets;

SET @sql := IF(
  (SELECT COUNT(*) FROM information_schema.COLUMNS
    WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'admin_users'
      AND COLUMN_NAME = 'email') > 0,
  'ALTER TABLE admin_users DROP COLUMN email',
  'DO 0');
PREPARE stmt FROM @sql;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

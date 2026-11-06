DROP TABLE IF EXISTS admin_role_permissions;
DROP TABLE IF EXISTS admin_roles;

SET @has_role_id := (
  SELECT COUNT(*) FROM information_schema.COLUMNS
   WHERE TABLE_SCHEMA = DATABASE()
     AND TABLE_NAME = 'admin_users'
     AND COLUMN_NAME = 'role_id'
);
SET @sql := IF(@has_role_id > 0,
  'ALTER TABLE admin_users DROP COLUMN role_id',
  'SELECT 1');
PREPARE stmt FROM @sql;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

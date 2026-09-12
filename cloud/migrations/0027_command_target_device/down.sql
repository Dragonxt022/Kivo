SET @sql := IF(
  (SELECT COUNT(*) FROM information_schema.STATISTICS
    WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'company_commands'
      AND INDEX_NAME = 'idx_commands_target') > 0,
  'DROP INDEX idx_commands_target ON company_commands',
  'DO 0');
PREPARE stmt FROM @sql;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

ALTER TABLE company_commands DROP COLUMN target_machine_id;

-- 0049_sync_usage_index — acelera o painel “Uso das empresas”.
--
-- O painel agrega sync_records por período (últimos 7/30/90 dias) para todas as
-- empresas, e o índice existente começa por company_uuid — não ajuda um filtro global
-- por data. Este índice cobre o filtro por período e a quebra por módulo/empresa.
-- Idempotente: o migrate pode repetir a migration depois de uma falha parcial.

SET @exists := (
  SELECT COUNT(*) FROM information_schema.STATISTICS
   WHERE TABLE_SCHEMA = DATABASE()
     AND TABLE_NAME = 'sync_records'
     AND INDEX_NAME = 'idx_sync_records_received'
);
SET @sql := IF(@exists = 0,
  'CREATE INDEX idx_sync_records_received ON sync_records (server_received_at, company_uuid, entity_type)',
  'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

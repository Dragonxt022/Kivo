-- 0027_command_target_device — destino por máquina na fila de comandos.
--
-- Alguns comandos precisam valer para TODAS as instalações de uma empresa (ex.: forçar
-- atualização). A fila original encerra o comando no primeiro ack (status deixa de ser
-- 'pendente'), então uma linha só nunca alcançaria as demais máquinas. Com
-- `target_machine_id`, o painel insere uma linha por máquina e cada uma dá o seu ack.
-- NULL continua significando "qualquer máquina" (comportamento atual dos comandos de suporte).
--
-- Idempotente (checagem em information_schema) porque DDL no MySQL faz commit implícito: se
-- uma execução falhar no meio, o retry precisa conseguir continuar sem "duplicate column".

SET @sql := IF(
  (SELECT COUNT(*) FROM information_schema.COLUMNS
    WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'company_commands'
      AND COLUMN_NAME = 'target_machine_id') = 0,
  'ALTER TABLE company_commands ADD COLUMN target_machine_id VARCHAR(64) NULL AFTER company_uuid',
  'DO 0');
PREPARE stmt FROM @sql;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

-- CREATE INDEX não aceita IF NOT EXISTS no MySQL.
SET @sql := IF(
  (SELECT COUNT(*) FROM information_schema.STATISTICS
    WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'company_commands'
      AND INDEX_NAME = 'idx_commands_target') = 0,
  'CREATE INDEX idx_commands_target ON company_commands (company_uuid, target_machine_id, status, id)',
  'DO 0');
PREPARE stmt FROM @sql;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

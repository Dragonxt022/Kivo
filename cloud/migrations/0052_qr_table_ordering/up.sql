-- 0052_qr_table_ordering — pedido público pela mesa via QR.
--
-- O cardápio do QR é publicado pelo próprio app local (inclusive no Trial, que não
-- tem sync geral) em `menu_publications` + `menu_items`. O pedido vira uma linha em
-- `public_orders` e uma intenção em `company_commands`; o desktop só o aplica, e o
-- garçom confirma antes de mandar à cozinha.

CREATE TABLE IF NOT EXISTS menu_publications (
  company_uuid CHAR(36) NOT NULL,
  enabled TINYINT NOT NULL DEFAULT 0,
  payload_hash CHAR(64) NULL,
  published_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (company_uuid)
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS menu_table_tokens (
  id BIGINT AUTO_INCREMENT PRIMARY KEY,
  company_uuid CHAR(36) NOT NULL,
  table_uuid CHAR(36) NOT NULL,
  table_label VARCHAR(120) NOT NULL,
  token_hash CHAR(64) NOT NULL,
  machine_id VARCHAR(64) NULL,
  active TINYINT NOT NULL DEFAULT 1,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  rotated_at DATETIME(3) NULL,
  UNIQUE KEY uq_menu_table_tokens_token (token_hash),
  UNIQUE KEY uq_menu_table_tokens_table (company_uuid, table_uuid),
  KEY idx_menu_table_tokens_company (company_uuid)
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS public_orders (
  id BIGINT AUTO_INCREMENT PRIMARY KEY,
  order_uuid CHAR(36) NOT NULL,
  client_request_id VARCHAR(80) NOT NULL,
  company_uuid CHAR(36) NOT NULL,
  table_uuid CHAR(36) NOT NULL,
  table_label VARCHAR(120) NULL,
  items_json JSON NOT NULL,
  total_cents INT NOT NULL,
  note VARCHAR(500) NULL,
  status ENUM('recebido', 'aplicado', 'confirmado', 'recusado', 'erro') NOT NULL DEFAULT 'recebido',
  rejection_reason VARCHAR(255) NULL,
  command_id BIGINT NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  UNIQUE KEY uq_public_orders_uuid (order_uuid),
  UNIQUE KEY uq_public_orders_client (company_uuid, client_request_id),
  KEY idx_public_orders_company (company_uuid, created_at)
) ENGINE=InnoDB;

-- Alinha ao collation REAL de `companies` (mesmo motivo da 0019: o default do banco
-- varia entre docker e VPS e comparações entre CHAR de collations diferentes falham).
SET @coll := (SELECT TABLE_COLLATION FROM information_schema.TABLES
              WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'companies');

SET @sql := CONCAT('ALTER TABLE menu_publications CONVERT TO CHARACTER SET ',
                   SUBSTRING_INDEX(@coll, '_', 1), ' COLLATE ', @coll);
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @sql := CONCAT('ALTER TABLE menu_table_tokens CONVERT TO CHARACTER SET ',
                   SUBSTRING_INDEX(@coll, '_', 1), ' COLLATE ', @coll);
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @sql := CONCAT('ALTER TABLE public_orders CONVERT TO CHARACTER SET ',
                   SUBSTRING_INDEX(@coll, '_', 1), ' COLLATE ', @coll);
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

-- `menu_items` ganha o necessário para o cardápio do QR: nome da categoria (o Trial não
-- tem sync de categorias), complementos já resolvidos e ordem estável.
SET @sql := IF(
  (SELECT COUNT(*) FROM information_schema.COLUMNS
    WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'menu_items' AND COLUMN_NAME = 'category_name') = 0,
  'ALTER TABLE menu_items ADD COLUMN category_name VARCHAR(120) NULL AFTER category_uuid',
  'DO 0');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @sql := IF(
  (SELECT COUNT(*) FROM information_schema.COLUMNS
    WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'menu_items' AND COLUMN_NAME = 'complements_json') = 0,
  'ALTER TABLE menu_items ADD COLUMN complements_json JSON NULL AFTER price_cents',
  'DO 0');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @sql := IF(
  (SELECT COUNT(*) FROM information_schema.COLUMNS
    WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'menu_items' AND COLUMN_NAME = 'sort_order') = 0,
  'ALTER TABLE menu_items ADD COLUMN sort_order INT NOT NULL DEFAULT 0 AFTER complements_json',
  'DO 0');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

-- Fila de comandos: além do celular (Kivo Web), agora aceita pedido público e deixa
-- `created_by_user_uuid` nulo quando não há usuário (cliente anônimo da mesa).
ALTER TABLE company_commands MODIFY COLUMN created_by_user_uuid CHAR(36) NULL;

SET @sql := IF(
  (SELECT COUNT(*) FROM information_schema.COLUMNS
    WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'company_commands' AND COLUMN_NAME = 'source') = 0,
  "ALTER TABLE company_commands ADD COLUMN source VARCHAR(20) NOT NULL DEFAULT 'mobile' AFTER kind",
  'DO 0');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @sql := IF(
  (SELECT COUNT(*) FROM information_schema.COLUMNS
    WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'company_commands' AND COLUMN_NAME = 'public_order_id') = 0,
  'ALTER TABLE company_commands ADD COLUMN public_order_id BIGINT NULL AFTER payload',
  'DO 0');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @sql := IF(
  (SELECT COUNT(*) FROM information_schema.STATISTICS
    WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'menu_items' AND INDEX_NAME = 'idx_menu_items_sort') = 0,
  'CREATE INDEX idx_menu_items_sort ON menu_items (company_uuid, sort_order)',
  'DO 0');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

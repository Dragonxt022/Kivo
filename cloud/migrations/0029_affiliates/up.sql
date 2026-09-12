-- 0029_affiliates — programa de indicação (afiliados) e desconto nas cobranças.
--
-- Cada afiliado (quem indicou) tem um percentual de desconto. A empresa indicada aponta para
-- o afiliado, e toda cobrança dela sai com esse desconto aplicado automaticamente. Guardamos
-- o valor cheio (original_amount_cents), o percentual e o desconto na própria cobrança, para o
-- histórico não mudar se o afiliado for editado depois.
--
-- Idempotente: DDL no MySQL faz commit implícito, então o retry precisa conseguir continuar.

CREATE TABLE IF NOT EXISTS affiliates (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  name VARCHAR(120) NOT NULL,
  contact VARCHAR(160) NULL,
  discount_pct INT NOT NULL DEFAULT 0,
  active TINYINT(1) NOT NULL DEFAULT 1,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id)
) ENGINE=InnoDB;

-- Empresa indicada: aponta para o afiliado (NULL = sem indicação).
SET @sql := IF(
  (SELECT COUNT(*) FROM information_schema.COLUMNS
    WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'companies'
      AND COLUMN_NAME = 'affiliate_id') = 0,
  'ALTER TABLE companies ADD COLUMN affiliate_id BIGINT UNSIGNED NULL',
  'DO 0');
PREPARE stmt FROM @sql;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

-- Cobrança: valor original, percentual e valor do desconto aplicado.
SET @sql := IF(
  (SELECT COUNT(*) FROM information_schema.COLUMNS
    WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'charges'
      AND COLUMN_NAME = 'original_amount_cents') = 0,
  'ALTER TABLE charges ADD COLUMN original_amount_cents BIGINT NULL AFTER amount_cents',
  'DO 0');
PREPARE stmt FROM @sql;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

SET @sql := IF(
  (SELECT COUNT(*) FROM information_schema.COLUMNS
    WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'charges'
      AND COLUMN_NAME = 'discount_pct') = 0,
  'ALTER TABLE charges ADD COLUMN discount_pct INT NOT NULL DEFAULT 0 AFTER original_amount_cents',
  'DO 0');
PREPARE stmt FROM @sql;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

SET @sql := IF(
  (SELECT COUNT(*) FROM information_schema.COLUMNS
    WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'charges'
      AND COLUMN_NAME = 'discount_cents') = 0,
  'ALTER TABLE charges ADD COLUMN discount_cents BIGINT NOT NULL DEFAULT 0 AFTER discount_pct',
  'DO 0');
PREPARE stmt FROM @sql;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

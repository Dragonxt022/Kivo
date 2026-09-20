-- 0032_affiliate_commissions — afiliados como representantes comerciais (comissão).
--
-- A 0029 trouxe o afiliado como "desconto para o cliente indicado". Aqui o afiliado
-- também passa a GANHAR: cada um tem um percentual de comissão e, sempre que uma
-- cobrança de uma empresa indicada é marcada como paga, o sistema lança um crédito
-- (affiliate_commissions) para o afiliado responsável.
--
-- O valor da comissão é calculado sobre `charges.amount_cents` (o que efetivamente
-- entrou — já líquido do desconto de indicação), com o percentual congelado no momento
-- do lançamento. O pagamento é agrupado em `affiliate_payouts`: o afiliado (ou o admin)
-- pede o pagamento, os créditos disponíveis viram "solicitado", e a confirmação baixa
-- tudo como "pago". O portal do afiliado usa `affiliate_sessions`.
--
-- Idempotente: DDL no MySQL faz commit implícito, então o retry precisa conseguir continuar.

-- ── Campos novos do afiliado ────────────────────────────────────────────────────────
SET @sql := IF(
  (SELECT COUNT(*) FROM information_schema.COLUMNS
    WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'affiliates'
      AND COLUMN_NAME = 'city') = 0,
  'ALTER TABLE affiliates ADD COLUMN city VARCHAR(120) NULL AFTER contact',
  'DO 0');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @sql := IF(
  (SELECT COUNT(*) FROM information_schema.COLUMNS
    WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'affiliates'
      AND COLUMN_NAME = 'document') = 0,
  'ALTER TABLE affiliates ADD COLUMN document VARCHAR(40) NULL AFTER city',
  'DO 0');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

-- Percentual de comissão que o afiliado ganha sobre o que for recebido das empresas dele.
SET @sql := IF(
  (SELECT COUNT(*) FROM information_schema.COLUMNS
    WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'affiliates'
      AND COLUMN_NAME = 'commission_pct') = 0,
  'ALTER TABLE affiliates ADD COLUMN commission_pct INT NOT NULL DEFAULT 0 AFTER discount_pct',
  'DO 0');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @sql := IF(
  (SELECT COUNT(*) FROM information_schema.COLUMNS
    WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'affiliates'
      AND COLUMN_NAME = 'pix_key') = 0,
  'ALTER TABLE affiliates ADD COLUMN pix_key VARCHAR(160) NULL AFTER commission_pct',
  'DO 0');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @sql := IF(
  (SELECT COUNT(*) FROM information_schema.COLUMNS
    WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'affiliates'
      AND COLUMN_NAME = 'notes') = 0,
  'ALTER TABLE affiliates ADD COLUMN notes VARCHAR(255) NULL AFTER pix_key',
  'DO 0');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

-- Acesso do afiliado ao próprio portal (usuário + senha com hash bcrypt).
SET @sql := IF(
  (SELECT COUNT(*) FROM information_schema.COLUMNS
    WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'affiliates'
      AND COLUMN_NAME = 'username') = 0,
  'ALTER TABLE affiliates ADD COLUMN username VARCHAR(60) NULL AFTER notes',
  'DO 0');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @sql := IF(
  (SELECT COUNT(*) FROM information_schema.COLUMNS
    WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'affiliates'
      AND COLUMN_NAME = 'password_hash') = 0,
  'ALTER TABLE affiliates ADD COLUMN password_hash VARCHAR(120) NULL AFTER username',
  'DO 0');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @sql := IF(
  (SELECT COUNT(*) FROM information_schema.COLUMNS
    WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'affiliates'
      AND COLUMN_NAME = 'last_login_at') = 0,
  'ALTER TABLE affiliates ADD COLUMN last_login_at DATETIME(3) NULL AFTER password_hash',
  'DO 0');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

-- Usuário do portal é único (NULL repetido é permitido no MySQL, então quem não tem
-- acesso continua sem usuário).
SET @sql := IF(
  (SELECT COUNT(*) FROM information_schema.STATISTICS
    WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'affiliates'
      AND INDEX_NAME = 'uq_affiliates_username') = 0,
  'CREATE UNIQUE INDEX uq_affiliates_username ON affiliates (username)',
  'DO 0');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

-- ── Créditos de comissão gerados por cobranças pagas ────────────────────────────────
CREATE TABLE IF NOT EXISTS affiliate_commissions (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  affiliate_id BIGINT UNSIGNED NOT NULL,
  company_uuid CHAR(36) NOT NULL,
  charge_id BIGINT NOT NULL,
  base_cents BIGINT NOT NULL DEFAULT 0,
  pct INT NOT NULL DEFAULT 0,
  amount_cents BIGINT NOT NULL DEFAULT 0,
  status VARCHAR(20) NOT NULL DEFAULT 'disponivel',
  payout_id BIGINT UNSIGNED NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  paid_at DATETIME(3) NULL,
  PRIMARY KEY (id),
  -- Uma cobrança gera no máximo um crédito, mesmo se "marcar paga" for clicado de novo.
  UNIQUE KEY uq_affiliate_commission_charge (charge_id),
  KEY idx_aff_comm_affiliate (affiliate_id, status),
  KEY idx_aff_comm_payout (payout_id)
) ENGINE=InnoDB;

-- ── Pedidos/baixas de pagamento ao afiliado ─────────────────────────────────────────
CREATE TABLE IF NOT EXISTS affiliate_payouts (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  affiliate_id BIGINT UNSIGNED NOT NULL,
  amount_cents BIGINT NOT NULL DEFAULT 0,
  method VARCHAR(40) NULL,
  notes VARCHAR(255) NULL,
  status VARCHAR(20) NOT NULL DEFAULT 'solicitado',
  requested_by VARCHAR(60) NULL,
  requested_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  paid_at DATETIME(3) NULL,
  paid_by VARCHAR(60) NULL,
  PRIMARY KEY (id),
  KEY idx_aff_payout_affiliate (affiliate_id, status)
) ENGINE=InnoDB;

-- ── Sessões do portal do afiliado (persistidas, como as do painel admin) ────────────
CREATE TABLE IF NOT EXISTS affiliate_sessions (
  token_hash CHAR(64) NOT NULL,
  affiliate_id BIGINT UNSIGNED NOT NULL,
  expires_at DATETIME(3) NOT NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (token_hash),
  KEY idx_aff_sessions_expires (expires_at)
) ENGINE=InnoDB;

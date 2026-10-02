-- 0042_contracts — o contrato assinado e o bloco de cobranças que ele gera.
--
-- O caminho comercial do Kivo é: instala e ativa o teste → cliente usa os 15 dias → vai lá
-- com o contrato → assina por 12 meses. Antes disso o painel só sabia criar cobrança avulsa,
-- uma por uma. Aqui entra o contrato (número, prazo, valor mensal, PDF assinado) e o vínculo
-- de cada parcela com ele, para o bloco de 12 cobranças sair de uma vez.

CREATE TABLE IF NOT EXISTS contracts (
  id BIGINT AUTO_INCREMENT PRIMARY KEY,
  company_uuid CHAR(36) NOT NULL,
  contract_number VARCHAR(40) NOT NULL,
  title VARCHAR(160) NULL,
  status ENUM('ativo','concluido','cancelado') NOT NULL DEFAULT 'ativo',
  first_due_date DATE NOT NULL,
  months INT NOT NULL,
  monthly_amount_cents BIGINT NOT NULL,
  extends_days INT NOT NULL DEFAULT 30,
  payer_email VARCHAR(160) NULL,
  signed_on DATE NULL,
  document_name VARCHAR(200) NULL,
  document_file VARCHAR(200) NULL,
  document_bytes INT NULL,
  document_sha256 CHAR(64) NULL,
  notes TEXT NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  UNIQUE KEY uq_contracts_number (contract_number),
  KEY idx_contracts_company (company_uuid, status),
  CONSTRAINT fk_contracts_company FOREIGN KEY (company_uuid) REFERENCES companies(company_uuid)
) ENGINE=InnoDB;

-- Sequência do número do contrato, por ano (KIVO-2026-0001). Tabela própria em vez de
-- COUNT(*) na tabela de contratos: dois cadastros ao mesmo tempo não repetem número.
CREATE TABLE IF NOT EXISTS contract_number_seq (
  ano SMALLINT NOT NULL PRIMARY KEY,
  ultimo INT NOT NULL DEFAULT 0
) ENGINE=InnoDB;

-- charges.contract_id: de qual contrato a cobrança veio (NULL = cobrança avulsa, como antes).
SET @exists := (SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'charges' AND COLUMN_NAME = 'contract_id');
SET @sql := IF(@exists = 0,
  'ALTER TABLE charges ADD COLUMN contract_id BIGINT NULL COMMENT ''Contrato que gerou esta cobrança (NULL = avulsa).''',
  'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

-- charges.installment_number: qual parcela do contrato é esta (1..N), para a tela mostrar "3/12".
SET @exists := (SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'charges' AND COLUMN_NAME = 'installment_number');
SET @sql := IF(@exists = 0,
  'ALTER TABLE charges ADD COLUMN installment_number INT NULL COMMENT ''Número da parcela dentro do contrato (1..N). NULL em cobrança avulsa.''',
  'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @exists := (SELECT COUNT(*) FROM information_schema.STATISTICS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'charges' AND INDEX_NAME = 'idx_charges_contract');
SET @sql := IF(@exists = 0,
  'ALTER TABLE charges ADD KEY idx_charges_contract (contract_id, installment_number)',
  'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

-- Apagar um contrato não pode apagar dinheiro já cobrado: as cobranças ficam, só perdem o vínculo.
SET @exists := (SELECT COUNT(*) FROM information_schema.TABLE_CONSTRAINTS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'charges' AND CONSTRAINT_NAME = 'fk_charges_contract');
SET @sql := IF(@exists = 0,
  'ALTER TABLE charges ADD CONSTRAINT fk_charges_contract FOREIGN KEY (contract_id) REFERENCES contracts(id) ON DELETE SET NULL',
  'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

-- 0040_billing_gateway — cobrança com gateway: Mercado Pago (Pix, boleto e link de cartão).
--
-- A tabela `charges` já existia para cobrança manual (criar, marcar paga, cancelar). Aqui
-- entram os campos do gateway: o que o Mercado Pago devolveu (id, status, QR do Pix, linha
-- digitável do boleto, link do checkout) e o que o Kivo usa para fechar o ciclo (token da
-- página pública e quantos dias a licença avança quando a cobrança é paga).
--
-- Idempotente (checa information_schema antes de cada ALTER), como as demais migrations —
-- o migrator pode reexecutar depois de uma falha no meio.

SET @exists := (SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'charges' AND COLUMN_NAME = 'public_token');
SET @sql := IF(@exists = 0,
  'ALTER TABLE charges ADD COLUMN public_token CHAR(36) NULL COMMENT ''Token opaco da página pública de pagamento (/pagar/<token>). Gerado na primeira cobrança pelo gateway — não expõe o id da cobrança nem permite enumerar as outras.''',
  'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @exists := (SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'charges' AND COLUMN_NAME = 'payer_email');
SET @sql := IF(@exists = 0,
  'ALTER TABLE charges ADD COLUMN payer_email VARCHAR(160) NULL COMMENT ''E-mail do pagador enviado ao Mercado Pago (obrigatório no Pix). Padrão: o e-mail de contato da empresa.''',
  'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @exists := (SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'charges' AND COLUMN_NAME = 'extends_days');
SET @sql := IF(@exists = 0,
  'ALTER TABLE charges ADD COLUMN extends_days INT NULL COMMENT ''Quantos dias somar em companies.valid_until quando esta cobrança for paga. NULL = não mexe na validade (só baixa a cobrança).''',
  'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @exists := (SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'charges' AND COLUMN_NAME = 'mp_payment_id');
SET @sql := IF(@exists = 0,
  'ALTER TABLE charges ADD COLUMN mp_payment_id VARCHAR(40) NULL COMMENT ''ID do pagamento no Mercado Pago (payment.id). É por ele que o webhook reencontra a cobrança.''',
  'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @exists := (SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'charges' AND COLUMN_NAME = 'mp_method');
SET @sql := IF(@exists = 0,
  'ALTER TABLE charges ADD COLUMN mp_method VARCHAR(20) NULL COMMENT ''Forma escolhida no gateway: pix, boleto ou card (link do Checkout Pro).''',
  'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @exists := (SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'charges' AND COLUMN_NAME = 'mp_status');
SET @sql := IF(@exists = 0,
  'ALTER TABLE charges ADD COLUMN mp_status VARCHAR(30) NULL COMMENT ''Status cru devolvido pelo Mercado Pago (pending, approved, rejected, cancelled, refunded, in_process...). O status do Kivo continua em charges.status.''',
  'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @exists := (SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'charges' AND COLUMN_NAME = 'mp_status_detail');
SET @sql := IF(@exists = 0,
  'ALTER TABLE charges ADD COLUMN mp_status_detail VARCHAR(80) NULL COMMENT ''Detalhe do status do Mercado Pago (accredited, waiting_payment, cc_rejected_insufficient_amount...). Mostrado ao admin para explicar por que não caiu.''',
  'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @exists := (SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'charges' AND COLUMN_NAME = 'mp_qr_code');
SET @sql := IF(@exists = 0,
  'ALTER TABLE charges ADD COLUMN mp_qr_code TEXT NULL COMMENT ''Pix copia e cola devolvido pelo Mercado Pago (point_of_interaction.transaction_data.qr_code).''',
  'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @exists := (SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'charges' AND COLUMN_NAME = 'mp_qr_code_base64');
SET @sql := IF(@exists = 0,
  'ALTER TABLE charges ADD COLUMN mp_qr_code_base64 MEDIUMTEXT NULL COMMENT ''Imagem do QR do Pix em base64, para o app e a página pública desenharem sem depender de rede.''',
  'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @exists := (SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'charges' AND COLUMN_NAME = 'mp_ticket_url');
SET @sql := IF(@exists = 0,
  'ALTER TABLE charges ADD COLUMN mp_ticket_url VARCHAR(500) NULL COMMENT ''Link do boleto (ou do comprovante do Pix) devolvido pelo Mercado Pago.''',
  'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @exists := (SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'charges' AND COLUMN_NAME = 'mp_init_point');
SET @sql := IF(@exists = 0,
  'ALTER TABLE charges ADD COLUMN mp_init_point VARCHAR(500) NULL COMMENT ''Link do Checkout Pro (cartão de crédito/débito) criado para a cobrança.''',
  'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @exists := (SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'charges' AND COLUMN_NAME = 'mp_updated_at');
SET @sql := IF(@exists = 0,
  'ALTER TABLE charges ADD COLUMN mp_updated_at DATETIME(3) NULL COMMENT ''Quando o gateway falou com a gente pela última vez sobre esta cobrança (criação ou webhook).''',
  'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @exists := (SELECT COUNT(*) FROM information_schema.STATISTICS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'charges' AND INDEX_NAME = 'uq_charges_public_token');
SET @sql := IF(@exists = 0,
  'ALTER TABLE charges ADD UNIQUE KEY uq_charges_public_token (public_token)',
  'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @exists := (SELECT COUNT(*) FROM information_schema.STATISTICS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'charges' AND INDEX_NAME = 'idx_charges_mp_payment');
SET @sql := IF(@exists = 0,
  'ALTER TABLE charges ADD KEY idx_charges_mp_payment (mp_payment_id)',
  'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

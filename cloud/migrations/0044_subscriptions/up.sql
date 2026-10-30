-- 0044_subscriptions — assinatura recorrente no Mercado Pago (produto "Assinaturas").
--
-- O Kivo já cobrava parcelas avulsas (Pix/boleto/cartão). Aqui entra o fluxo recorrente:
-- o admin cria a assinatura, manda o link do Mercado Pago para o cliente autorizar o cartão
-- e, a cada cobrança aprovada, o webhook gera uma linha em `charges` e chama o mesmo
-- `settleCharge` — que estende a licença e lança a comissão do afiliado.
--
-- `company_subscriptions` é a configuração/estado local; `preapproval_id` é o id do
-- Mercado Pago. `public_token` é o link público que o cliente abre para autorizar.
--
-- Sem FK para `companies`: a collation de `companies.company_uuid` varia entre instalações
-- antigas (0017 já precisou alinhar `trial_registry` por causa disso) e a FK derrubaria a
-- migration inteira em produção. A limpeza é feita explicitamente em `deleteCompanyCompletely`.

CREATE TABLE IF NOT EXISTS company_subscriptions (
  id BIGINT AUTO_INCREMENT PRIMARY KEY,
  company_uuid CHAR(36) NOT NULL,
  plan_key VARCHAR(30) NULL,
  reason VARCHAR(160) NOT NULL,
  amount_cents BIGINT NOT NULL,
  extends_days INT NOT NULL DEFAULT 30,
  frequency INT NOT NULL DEFAULT 1,
  frequency_type ENUM('days','months') NOT NULL DEFAULT 'months',
  payer_email VARCHAR(160) NULL,
  public_token CHAR(36) NOT NULL,
  preapproval_id VARCHAR(80) NULL,
  status ENUM('pendente','autorizada','pausada','cancelada','encerrada','erro') NOT NULL DEFAULT 'pendente',
  init_point VARCHAR(700) NULL,
  next_payment_date DATETIME(3) NULL,
  last_payment_at DATETIME(3) NULL,
  last_payment_id VARCHAR(80) NULL,
  last_error VARCHAR(500) NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  UNIQUE KEY uq_subscriptions_public_token (public_token),
  UNIQUE KEY uq_subscriptions_preapproval (preapproval_id),
  KEY idx_subscriptions_company (company_uuid, status)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- charges.subscription_id: de qual assinatura veio a cobrança recorrente.
SET @exists := (SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'charges' AND COLUMN_NAME = 'subscription_id');
SET @sql := IF(@exists = 0,
  'ALTER TABLE charges ADD COLUMN subscription_id BIGINT NULL COMMENT ''Assinatura que gerou esta cobrança (NULL = avulsa/contrato).''',
  'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

-- charges.subscription_payment_id: id da cobrança recorrente no Mercado Pago. A UNIQUE é a
-- idempotência do webhook: a mesma notificação repetida não cria/estende a licença duas vezes.
SET @exists := (SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'charges' AND COLUMN_NAME = 'subscription_payment_id');
SET @sql := IF(@exists = 0,
  'ALTER TABLE charges ADD COLUMN subscription_payment_id VARCHAR(80) NULL COMMENT ''ID da cobrança recorrente no Mercado Pago (idempotência).''',
  'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @exists := (SELECT COUNT(*) FROM information_schema.STATISTICS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'charges' AND INDEX_NAME = 'uq_charges_subscription_payment');
SET @sql := IF(@exists = 0,
  'ALTER TABLE charges ADD UNIQUE KEY uq_charges_subscription_payment (subscription_payment_id)',
  'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @exists := (SELECT COUNT(*) FROM information_schema.STATISTICS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'charges' AND INDEX_NAME = 'idx_charges_subscription');
SET @sql := IF(@exists = 0,
  'ALTER TABLE charges ADD KEY idx_charges_subscription (subscription_id)',
  'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @exists := (SELECT COUNT(*) FROM information_schema.TABLE_CONSTRAINTS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'charges' AND CONSTRAINT_NAME = 'fk_charges_subscription');
SET @sql := IF(@exists = 0,
  'ALTER TABLE charges ADD CONSTRAINT fk_charges_subscription FOREIGN KEY (subscription_id) REFERENCES company_subscriptions(id) ON DELETE SET NULL',
  'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

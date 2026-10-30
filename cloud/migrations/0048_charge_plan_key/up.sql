-- 0048_charge_plan_key — cobrança à vista de um plano (Pix/boleto/cartão).
--
-- A assinatura recorrente já sabe qual plano ativar (`company_subscriptions.plan_key`).
-- Para o pagamento à vista, a cobrança carrega o plano para que `settleCharge` ative o
-- mesmo plano e o limite de dispositivos quando o pagamento for aprovado.

SET @exists := (SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'charges' AND COLUMN_NAME = 'plan_key');
SET @sql := IF(@exists = 0,
  'ALTER TABLE charges ADD COLUMN plan_key VARCHAR(30) NULL COMMENT ''Plano contratado nesta cobrança à vista (NULL = cobrança comum).''',
  'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

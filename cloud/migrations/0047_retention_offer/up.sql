-- 0047_retention_offer — oferta única de 1 mês grátis para retenção.
--
-- Quando o teste acaba ou o cliente tenta cancelar, o app oferece mais 30 dias. A decisão
-- fica registrada para a oferta não ser repetida: aceita = licença estendida; recusada =
-- nenhuma extensão. Em ambos os casos, uma assinatura ativa é cancelada no Mercado Pago
-- para não gerar cobrança durante o período grátis.

SET @exists := (SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'companies' AND COLUMN_NAME = 'retention_offer_decided_at');
SET @sql := IF(@exists = 0,
  'ALTER TABLE companies ADD COLUMN retention_offer_decided_at DATETIME(3) NULL COMMENT ''Quando a oferta de retenção foi aceita/recusada.''',
  'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @exists := (SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'companies' AND COLUMN_NAME = 'retention_offer_accepted');
SET @sql := IF(@exists = 0,
  'ALTER TABLE companies ADD COLUMN retention_offer_accepted TINYINT(1) NULL COMMENT ''1 = aceitou o mês grátis; 0 = recusou.''',
  'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

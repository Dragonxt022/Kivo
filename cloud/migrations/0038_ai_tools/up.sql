-- 0038_ai_tools — ferramentas de IA que COBRAM créditos por uso, com cota DIÁRIA.
--
-- O assistente de suporte é grátis e ilimitado (feature 'support', nunca bloqueado). As
-- ferramentas (piloto: geração de descrição de produto) consomem créditos e têm cota diária
-- que reinicia à meia-noite no fuso do cliente.
--
-- `ai_tools` guarda o padrão global de cada ferramenta (custo por uso e cota diária);
-- `company_ai_quotas` guarda o consumo do dia por empresa/ferramenta e um eventual override
-- do limite. `ai_usage` ganha a dimensão `feature` + os créditos cobrados, para o painel.
--
-- Idempotente: DDL no MySQL faz commit implícito, então o retry do migrate precisa continuar.

CREATE TABLE IF NOT EXISTS ai_tools (
  id VARCHAR(60) NOT NULL PRIMARY KEY,
  label VARCHAR(120) NOT NULL,
  description VARCHAR(255) NULL,
  cost INT NOT NULL DEFAULT 1,
  daily_credits INT NOT NULL DEFAULT 20,
  enabled TINYINT(1) NOT NULL DEFAULT 1,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3)
) ENGINE=InnoDB;

INSERT INTO ai_tools (id, label, description, cost, daily_credits, enabled)
VALUES ('product_description', 'Descrição de produto', 'Gera a descrição/ingredientes de um produto com IA.', 1, 20, 1)
ON DUPLICATE KEY UPDATE id = id;

CREATE TABLE IF NOT EXISTS company_ai_quotas (
  company_uuid CHAR(36) NOT NULL,
  feature VARCHAR(60) NOT NULL,
  -- NULL = usa o padrão da ferramenta (ai_tools.daily_credits).
  daily_limit INT NULL,
  used INT NOT NULL DEFAULT 0,
  -- Dia do consumo (AAAA-MM-DD no fuso do cliente). Quando muda, o contador zera sozinho.
  period_day CHAR(10) NULL,
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (company_uuid, feature)
) ENGINE=InnoDB;

-- ai_usage: dimensão da ferramenta + créditos cobrados (default 'support' = grátis).
SET @sql := IF(
  (SELECT COUNT(*) FROM information_schema.COLUMNS
    WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'ai_usage' AND COLUMN_NAME = 'feature') = 0,
  "ALTER TABLE ai_usage ADD COLUMN feature VARCHAR(60) NOT NULL DEFAULT 'support'",
  'DO 0');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @sql := IF(
  (SELECT COUNT(*) FROM information_schema.COLUMNS
    WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'ai_usage' AND COLUMN_NAME = 'credits') = 0,
  "ALTER TABLE ai_usage ADD COLUMN credits INT NOT NULL DEFAULT 0",
  'DO 0');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

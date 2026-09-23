-- 0037_ai_usage — medição de uso da KIVO IA e créditos por empresa.
--
-- Cada empresa tem um teto de tokens de IA (`ai_token_limit`; 0 = ilimitado) e o consumo
-- do período corrente (`ai_tokens_used` + `ai_period` = AAAA-MM, reset mensal). O detalhe de
-- cada requisição fica em `ai_usage`, para os gráficos do painel (barras por dia, pizza por
-- empresa/modelo).

ALTER TABLE companies ADD COLUMN ai_token_limit BIGINT NOT NULL DEFAULT 0;
ALTER TABLE companies ADD COLUMN ai_tokens_used BIGINT NOT NULL DEFAULT 0;
ALTER TABLE companies ADD COLUMN ai_period CHAR(7) NULL;

CREATE TABLE ai_usage (
  id BIGINT AUTO_INCREMENT PRIMARY KEY,
  company_uuid CHAR(36) NOT NULL,
  period CHAR(7) NOT NULL,
  model VARCHAR(120) NOT NULL,
  prompt_tokens INT NOT NULL DEFAULT 0,
  completion_tokens INT NOT NULL DEFAULT 0,
  total_tokens INT NOT NULL DEFAULT 0,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  KEY idx_ai_usage_company_period (company_uuid, period),
  KEY idx_ai_usage_created (created_at),
  CONSTRAINT fk_ai_usage_company FOREIGN KEY (company_uuid) REFERENCES companies(company_uuid)
) ENGINE=InnoDB;

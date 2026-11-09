-- 0053_installer_leads — cadastro obrigatório antes de baixar o instalador.
--
-- Substitui o registro anônimo de cliques em installer_downloads no fluxo público: nome,
-- celular e e-mail passam a ser a origem do lead, e um token libera o download por 7 dias.
-- A tabela antiga continua no banco apenas como histórico; o site não escreve mais nela.
--
-- Sem FK com companies: o cadastro acontece no navegador, antes de existir empresa. O e-mail
-- é obrigatório para o painel conseguir filtrar duplicados e identificar quem está testando.

CREATE TABLE IF NOT EXISTS installer_leads (
  id BIGINT AUTO_INCREMENT PRIMARY KEY,
  name VARCHAR(120) NOT NULL,
  whatsapp VARCHAR(40) NOT NULL,
  email VARCHAR(160) NOT NULL,
  ip VARCHAR(64) NULL,
  user_agent VARCHAR(400) NULL,
  referer VARCHAR(500) NULL,
  origem VARCHAR(80) NULL,
  version VARCHAR(24) NULL,
  download_token CHAR(48) NOT NULL,
  token_expires_at DATETIME(3) NOT NULL,
  downloaded_at DATETIME(3) NULL,
  download_count INT NOT NULL DEFAULT 0,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  UNIQUE KEY uq_installer_leads_token (download_token),
  INDEX idx_installer_leads_created (created_at),
  INDEX idx_installer_leads_email (email),
  INDEX idx_installer_leads_whatsapp (whatsapp)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

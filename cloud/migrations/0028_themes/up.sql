-- 0028_themes — loja de temas (pacotes de ícones) do Kivo Cloud.
--
-- O admin cadastra um tema (nome, capa, grátis ou pago) e envia os SVGs. Temas grátis ficam
-- disponíveis para toda empresa; temas pagos só para quem o admin liberar em `theme_grants`.
--
-- O pack é guardado como JSON (nome do arquivo -> conteúdo) para o desktop baixar tudo numa
-- resposta só, sem depender de zip em nenhum dos lados. A capa é um arquivo em disco
-- (storage/themes) e aqui fica só o nome do arquivo + o mime.

CREATE TABLE IF NOT EXISTS themes (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  slug VARCHAR(60) NOT NULL,
  name VARCHAR(120) NOT NULL,
  description VARCHAR(500) NULL,
  price_cents INT NOT NULL DEFAULT 0,
  cover_path VARCHAR(255) NULL,
  cover_mime VARCHAR(40) NULL,
  pack_json MEDIUMTEXT NOT NULL,
  files_count INT NOT NULL DEFAULT 0,
  active TINYINT(1) NOT NULL DEFAULT 1,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  UNIQUE KEY uq_themes_slug (slug)
) ENGINE=InnoDB;

-- Liberação de tema pago por empresa. Sem FK de propósito: a 0019 mostrou que FK entre
-- colunas CHAR com collations diferentes (herdadas do banco vs. declaradas) é recusada em
-- produção; a limpeza é feita no delete da empresa, como nas demais tabelas.
CREATE TABLE IF NOT EXISTS theme_grants (
  company_uuid CHAR(36) NOT NULL,
  theme_id BIGINT UNSIGNED NOT NULL,
  granted_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (company_uuid, theme_id),
  KEY idx_theme_grants_theme (theme_id)
) ENGINE=InnoDB;

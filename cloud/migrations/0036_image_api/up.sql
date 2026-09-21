-- 0036_image_api — busca de imagens externa centralizada (Pexels) + curadoria do escolhido.
--
-- Antes, cada instalação do Kivo configurava a própria chave de busca de imagens. Agora a
-- chave fica no Kivo Cloud (Configurações) e os clientes chamam /api/catalog/external-search.
--
-- Para não abusar da API gratuita (Pexels: 200 req/h e 20.000/mês): os resultados de cada
-- termo ficam em cache por alguns dias (`catalog_search_cache`) e há um teto diário próprio
-- (`image_api_usage`). Quando o cliente confirma uma imagem externa, ela é baixada e entra
-- na curadoria como `source='api'` — aprovada, passa a sair do nosso banco sem tocar na API.
--
-- Idempotente: DDL no MySQL faz commit implícito, então o retry precisa conseguir continuar.

CREATE TABLE IF NOT EXISTS catalog_search_cache (
  term VARCHAR(191) NOT NULL,
  provider VARCHAR(20) NOT NULL DEFAULT 'pexels',
  results JSON NOT NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  expires_at DATETIME(3) NOT NULL,
  PRIMARY KEY (term, provider),
  KEY idx_search_cache_expires (expires_at)
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS image_api_usage (
  day DATE NOT NULL,
  provider VARCHAR(20) NOT NULL DEFAULT 'pexels',
  requests INT NOT NULL DEFAULT 0,
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (day, provider)
) ENGINE=InnoDB;

-- Origem "api": imagem baixada da busca externa e enfileirada para curadoria pelo cliente.
SET @sql := IF(
  (SELECT COUNT(*) FROM information_schema.COLUMNS
    WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'catalog_images'
      AND COLUMN_NAME = 'source'
      AND COLUMN_TYPE NOT LIKE '%api%') > 0,
  "ALTER TABLE catalog_images MODIFY COLUMN source ENUM('submissao','manual','api') NOT NULL DEFAULT 'submissao'",
  'DO 0');
PREPARE stmt FROM @sql;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

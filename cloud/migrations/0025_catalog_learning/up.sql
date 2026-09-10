-- Aprendizado do banco de imagens: aliases + demanda. Ambos ANÔNIMOS (sem empresa).
--
-- Alias: nome de produto que uma empresa usou para uma imagem aprovada. Faz a busca casar
-- sinônimos que o cadastro original não tinha ("coca lata 350" acha "refrigerante cola ...").
CREATE TABLE IF NOT EXISTS catalog_image_aliases (
  id BIGINT AUTO_INCREMENT PRIMARY KEY,
  catalog_image_id BIGINT NOT NULL,
  alias VARCHAR(255) NOT NULL,
  occurrences INT NOT NULL DEFAULT 1,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  UNIQUE KEY uq_alias (catalog_image_id, alias),
  FULLTEXT KEY ft_alias_search (alias),
  CONSTRAINT fk_alias_image FOREIGN KEY (catalog_image_id) REFERENCES catalog_images(id) ON DELETE CASCADE
) ENGINE=InnoDB;

-- Demanda: termo buscado que NÃO achou imagem. Prioriza o que o admin deve adicionar.
CREATE TABLE IF NOT EXISTS catalog_demand (
  id BIGINT AUTO_INCREMENT PRIMARY KEY,
  term VARCHAR(255) NOT NULL,
  misses INT NOT NULL DEFAULT 1,
  last_seen_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  UNIQUE KEY uq_demand_term (term)
) ENGINE=InnoDB;

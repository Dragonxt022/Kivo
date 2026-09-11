-- Ranking global das sugestões de imagem.
--
-- pick_count em catalog_images: quantas vezes a imagem do catálogo Kivo foi ESCOLHIDA
-- por uma empresa (incrementado no /learn). É o sinal de "produto mais escolhido" que
-- ordena a busca — antes só o alias tinha `occurrences`, e ele ordenava apenas dentro
-- do bloco de sinônimos, nunca a busca principal.
ALTER TABLE catalog_images ADD COLUMN pick_count INT NOT NULL DEFAULT 0;

-- Imagens da web (Google CSE) que alguém escolheu. O catálogo Kivo não guarda esses
-- bytes: guardamos a URL e um contador de escolhas para reapresentar, com prioridade,
-- as que já deram certo para o mesmo termo — mesmo entre empresas diferentes.
-- `term` é o nome normalizado (normalizeKeywords) do produto no momento da escolha.
CREATE TABLE IF NOT EXISTS catalog_web_images (
  id BIGINT AUTO_INCREMENT PRIMARY KEY,
  term VARCHAR(191) NOT NULL,
  url_hash CHAR(64) NOT NULL,
  url VARCHAR(1000) NOT NULL,
  thumb VARCHAR(1000) NULL,
  title VARCHAR(500) NULL,
  pick_count INT NOT NULL DEFAULT 1,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  UNIQUE KEY uq_web_term_url (term, url_hash),
  KEY idx_web_term_pick (term, pick_count)
) ENGINE=InnoDB;

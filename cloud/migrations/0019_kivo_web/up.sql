-- 0019_kivo_web — acesso pelo celular (Kivo Web) e fila de comandos.

-- Concessões de acesso, criadas pelo desktop (POST /api/mobile/grants).
--
-- `permissions` chega pronta do desktop em vez de sincronizar users/roles/role_permissions:
-- menos superfície replicada e, principalmente, o `password_hash` do PDV nunca sai da
-- máquina do lojista. A autenticação aqui é pelo token do link/QR, não por senha.
CREATE TABLE company_mobile_grants (
  company_uuid CHAR(36) NOT NULL,
  user_uuid CHAR(36) NOT NULL,
  username VARCHAR(80) NOT NULL,
  name VARCHAR(160) NOT NULL,
  role_slug VARCHAR(60) NULL,
  permissions JSON NOT NULL,
  -- sha256 do token do link. O token em claro nunca chega à nuvem: o desktop manda o hash,
  -- e o celular manda o token, que é hasheado aqui para comparar.
  token_hash CHAR(64) NOT NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  last_used_at DATETIME NULL,
  revoked_at DATETIME NULL,
  PRIMARY KEY (company_uuid, user_uuid),
  UNIQUE KEY uq_mobile_grants_token (token_hash),
  CONSTRAINT fk_mobile_grants_company FOREIGN KEY (company_uuid) REFERENCES companies(company_uuid)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- Fila de comandos: o celular grava a INTENÇÃO, o desktop executa a regra de negócio.
--
-- Escrever direto em sync_records não funcionaria: o pull do desktop insere linhas direto nas
-- tabelas, sem passar por createQuote/createSale — que é quem valida produto, resolve preço,
-- move estoque e lança no caixa. O orçamento chegaria como linha órfã.
CREATE TABLE company_commands (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  company_uuid CHAR(36) NOT NULL,
  -- Ex.: 'store.quote.create'. Novos tipos entram sem migration.
  kind VARCHAR(60) NOT NULL,
  payload JSON NOT NULL,
  -- Quem pediu: o desktop executa no nome desta pessoa, com as permissões dela.
  created_by_user_uuid CHAR(36) NOT NULL,
  status ENUM('pendente', 'aplicado', 'erro') NOT NULL DEFAULT 'pendente',
  result JSON NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  applied_at DATETIME NULL,
  PRIMARY KEY (id),
  KEY idx_commands_pending (company_uuid, status, id),
  CONSTRAINT fk_commands_company FOREIGN KEY (company_uuid) REFERENCES companies(company_uuid)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- O painel mobile lê sync_records filtrando por tipo e ordenando por data. O índice existente
-- (company_uuid, entity_type) não cobre a ordenação, e "as 20 últimas vendas" é a consulta
-- mais frequente do painel.
CREATE INDEX idx_sync_records_type_updated ON sync_records (company_uuid, entity_type, updated_at);

-- 0019_kivo_web — acesso pelo celular (Kivo Web) e fila de comandos.
--
-- ⚠ Charset/collation: NÃO declarar `DEFAULT CHARSET` aqui. `companies` (0001) foi criada
-- sem charset explícito, então herda o do BANCO — que na VPS é utf8mb4_general_ci. Declarar
-- `DEFAULT CHARSET=utf8mb4` sem COLLATE junto faz o MySQL usar o default do SERVIDOR
-- (utf8mb4_0900_ai_ci no MySQL 8), e uma FK entre duas colunas CHAR com collations
-- diferentes é recusada com ER_FK_INCOMPATIBLE_COLUMNS. Em docker os dois defaults
-- coincidem, então o erro só aparece em produção. É a mesma armadilha da 0017.
--
-- Por segurança, as tabelas ainda são alinhadas ao collation REAL de `companies` antes das
-- FKs entrarem: em instalação que já tenha sido convertida à mão, herdar do banco não basta.
--
-- Tudo idempotente (IF NOT EXISTS + checagem em information_schema) porque DDL no MySQL faz
-- commit implícito: a transação do migrate.ts não desfaz um CREATE TABLE, então uma falha no
-- meio deixaria estado parcial e o retry precisa conseguir continuar de onde parou.

-- Concessões de acesso, criadas pelo desktop (POST /api/mobile/grants).
--
-- `permissions` chega pronta do desktop em vez de sincronizar users/roles/role_permissions:
-- menos superfície replicada e, principalmente, o `password_hash` do PDV nunca sai da
-- máquina do lojista. A autenticação aqui é pelo token do link/QR, não por senha.
CREATE TABLE IF NOT EXISTS company_mobile_grants (
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
  UNIQUE KEY uq_mobile_grants_token (token_hash)
) ENGINE=InnoDB;

-- Fila de comandos: o celular grava a INTENÇÃO, o desktop executa a regra de negócio.
--
-- Escrever direto em sync_records não funcionaria: o pull do desktop insere linhas direto nas
-- tabelas, sem passar por createQuote/createSale — que é quem valida produto, resolve preço,
-- move estoque e lança no caixa. O orçamento chegaria como linha órfã.
CREATE TABLE IF NOT EXISTS company_commands (
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
  KEY idx_commands_pending (company_uuid, status, id)
) ENGINE=InnoDB;

-- Alinha ao collation REAL de `companies` (o charset sai do próprio nome do collation, que
-- sempre começa por ele). Ler em vez de fixar um valor é o que faz isto valer tanto em
-- docker quanto na VPS, cujos defaults diferem.
SET @coll := (SELECT TABLE_COLLATION FROM information_schema.TABLES
              WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'companies');

SET @sql := CONCAT('ALTER TABLE company_mobile_grants CONVERT TO CHARACTER SET ',
                   SUBSTRING_INDEX(@coll, '_', 1), ' COLLATE ', @coll);
PREPARE stmt FROM @sql;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

SET @sql := CONCAT('ALTER TABLE company_commands CONVERT TO CHARACTER SET ',
                   SUBSTRING_INDEX(@coll, '_', 1), ' COLLATE ', @coll);
PREPARE stmt FROM @sql;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

-- FKs só agora, com os collations já iguais. Condicionadas para o retry não esbarrar em
-- "constraint already exists" se uma execução anterior tiver chegado até aqui.
SET @sql := IF(
  (SELECT COUNT(*) FROM information_schema.TABLE_CONSTRAINTS
    WHERE TABLE_SCHEMA = DATABASE() AND CONSTRAINT_NAME = 'fk_mobile_grants_company') = 0,
  'ALTER TABLE company_mobile_grants ADD CONSTRAINT fk_mobile_grants_company
     FOREIGN KEY (company_uuid) REFERENCES companies(company_uuid)',
  'DO 0');
PREPARE stmt FROM @sql;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

SET @sql := IF(
  (SELECT COUNT(*) FROM information_schema.TABLE_CONSTRAINTS
    WHERE TABLE_SCHEMA = DATABASE() AND CONSTRAINT_NAME = 'fk_commands_company') = 0,
  'ALTER TABLE company_commands ADD CONSTRAINT fk_commands_company
     FOREIGN KEY (company_uuid) REFERENCES companies(company_uuid)',
  'DO 0');
PREPARE stmt FROM @sql;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

-- O painel mobile lê sync_records filtrando por tipo e ordenando por data. O índice existente
-- (company_uuid, entity_type) não cobre a ordenação, e "as 20 últimas vendas" é a consulta
-- mais frequente do painel. `CREATE INDEX` não aceita IF NOT EXISTS no MySQL.
SET @sql := IF(
  (SELECT COUNT(*) FROM information_schema.STATISTICS
    WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'sync_records'
      AND INDEX_NAME = 'idx_sync_records_type_updated') = 0,
  'CREATE INDEX idx_sync_records_type_updated ON sync_records (company_uuid, entity_type, updated_at)',
  'DO 0');
PREPARE stmt FROM @sql;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

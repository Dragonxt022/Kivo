-- 0033_messages — central de mensagens do Kivo (suporte -> empresas).
--
-- O admin escreve uma mensagem (título, subtítulo, categoria, corpo HTML, imagem de destaque
-- e marca "urgente") e escolhe enviar para TODAS as empresas ou para uma específica. Quando
-- não é para todas, cada destino vira uma linha em `message_targets`.
--
-- A entrega ao desktop é PULL: o servidor local da loja chama /api/messages/inbox com as
-- credenciais de licença (mesmo contrato de themes/sync). O estado do usuário — lido,
-- favorito, excluído, categoria própria e ordem — fica no aparelho, não aqui: é escolha do
-- usuário, não dado da empresa.

CREATE TABLE IF NOT EXISTS messages (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  uuid CHAR(36) NOT NULL,
  title VARCHAR(200) NOT NULL,
  subtitle VARCHAR(300) NULL,
  category VARCHAR(40) NOT NULL DEFAULT 'comunicado',
  body_html MEDIUMTEXT NOT NULL,
  image_path VARCHAR(255) NULL,
  image_mime VARCHAR(60) NULL,
  is_urgent TINYINT(1) NOT NULL DEFAULT 0,
  target_all TINYINT(1) NOT NULL DEFAULT 1,
  status ENUM('rascunho','publicada') NOT NULL DEFAULT 'rascunho',
  published_at DATETIME(3) NULL,
  created_by VARCHAR(80) NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  UNIQUE KEY uq_messages_uuid (uuid),
  KEY idx_messages_status (status, published_at)
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS message_targets (
  message_id BIGINT UNSIGNED NOT NULL,
  company_uuid CHAR(36) NOT NULL,
  PRIMARY KEY (message_id, company_uuid),
  KEY idx_message_targets_company (company_uuid)
) ENGINE=InnoDB;

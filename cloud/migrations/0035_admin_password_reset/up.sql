-- 0035_admin_password_reset — recuperação de senha do painel por e-mail.
--
-- O admin cadastra um e-mail no próprio perfil e o login ganha "Esqueci minha senha": o
-- sistema manda um link de redefinição (token de uso único, validade de 1 hora) usando o
-- SMTP configurado em Configurações. Guardamos só o hash do token — o valor cru só existe
-- no link enviado por e-mail.
--
-- Idempotente: DDL no MySQL faz commit implícito, então o retry precisa conseguir continuar.

SET @sql := IF(
  (SELECT COUNT(*) FROM information_schema.COLUMNS
    WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'admin_users'
      AND COLUMN_NAME = 'email') = 0,
  'ALTER TABLE admin_users ADD COLUMN email VARCHAR(160) NULL AFTER password_hash',
  'DO 0');
PREPARE stmt FROM @sql;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

CREATE TABLE IF NOT EXISTS admin_password_resets (
  token_hash CHAR(64) NOT NULL,
  username VARCHAR(100) NOT NULL,
  expires_at DATETIME(3) NOT NULL,
  used_at DATETIME(3) NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (token_hash),
  KEY idx_admin_resets_user (username),
  KEY idx_admin_resets_expires (expires_at)
) ENGINE=InnoDB;

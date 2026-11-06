-- 0050_admin_roles — grupos de permissão do painel Cloud.
--
-- O menu lateral foi substituído por cards. Cada card (bloco) é uma permissão e
-- cada administrador pertence a um grupo (Administrador, Afiliados, Suporte ou um
-- grupo personalizado). A checagem é feita no servidor em requireAdminAuth.
--
-- Idempotente: o migrator pode repetir a migration depois de uma falha parcial.

CREATE TABLE IF NOT EXISTS admin_roles (
  id BIGINT AUTO_INCREMENT PRIMARY KEY,
  slug VARCHAR(60) NOT NULL UNIQUE,
  name VARCHAR(100) NOT NULL,
  description VARCHAR(255) NULL,
  is_system TINYINT(1) NOT NULL DEFAULT 0,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3)
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS admin_role_permissions (
  role_id BIGINT NOT NULL,
  permission_key VARCHAR(60) NOT NULL,
  PRIMARY KEY (role_id, permission_key),
  CONSTRAINT fk_admin_role_permissions_role
    FOREIGN KEY (role_id) REFERENCES admin_roles (id) ON DELETE CASCADE
) ENGINE=InnoDB;

SET @has_role_id := (
  SELECT COUNT(*) FROM information_schema.COLUMNS
   WHERE TABLE_SCHEMA = DATABASE()
     AND TABLE_NAME = 'admin_users'
     AND COLUMN_NAME = 'role_id'
);
SET @sql := IF(@has_role_id = 0,
  'ALTER TABLE admin_users ADD COLUMN role_id BIGINT NULL, ADD INDEX idx_admin_users_role (role_id)',
  'SELECT 1');
PREPARE stmt FROM @sql;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

INSERT INTO admin_roles (slug, name, description, is_system)
VALUES
  ('administrador', 'Administrador', 'Acesso completo ao painel Cloud.', 1),
  ('afiliados', 'Afiliados', 'Gestão de afiliados, indicações, comissões e pagamentos.', 1),
  ('suporte', 'Suporte', 'Atendimento às empresas, dispositivos e conteúdo.', 1)
ON DUPLICATE KEY UPDATE
  name = VALUES(name),
  description = VALUES(description),
  is_system = 1;

-- Administradores que já existiam passam a ser Administrador; os novos escolhem
-- o grupo no cadastro.
UPDATE admin_users
   SET role_id = (SELECT id FROM admin_roles WHERE slug = 'administrador')
 WHERE role_id IS NULL;

-- Administrador: todos os blocos.
INSERT IGNORE INTO admin_role_permissions (role_id, permission_key)
SELECT id, 'dashboard' FROM admin_roles WHERE slug = 'administrador';
INSERT IGNORE INTO admin_role_permissions (role_id, permission_key)
SELECT id, 'companies' FROM admin_roles WHERE slug = 'administrador';
INSERT IGNORE INTO admin_role_permissions (role_id, permission_key)
SELECT id, 'usage' FROM admin_roles WHERE slug = 'administrador';
INSERT IGNORE INTO admin_role_permissions (role_id, permission_key)
SELECT id, 'devices' FROM admin_roles WHERE slug = 'administrador';
INSERT IGNORE INTO admin_role_permissions (role_id, permission_key)
SELECT id, 'downloads' FROM admin_roles WHERE slug = 'administrador';
INSERT IGNORE INTO admin_role_permissions (role_id, permission_key)
SELECT id, 'versions' FROM admin_roles WHERE slug = 'administrador';
INSERT IGNORE INTO admin_role_permissions (role_id, permission_key)
SELECT id, 'leads' FROM admin_roles WHERE slug = 'administrador';
INSERT IGNORE INTO admin_role_permissions (role_id, permission_key)
SELECT id, 'contracts' FROM admin_roles WHERE slug = 'administrador';
INSERT IGNORE INTO admin_role_permissions (role_id, permission_key)
SELECT id, 'subscriptions' FROM admin_roles WHERE slug = 'administrador';
INSERT IGNORE INTO admin_role_permissions (role_id, permission_key)
SELECT id, 'charges' FROM admin_roles WHERE slug = 'administrador';
INSERT IGNORE INTO admin_role_permissions (role_id, permission_key)
SELECT id, 'plans' FROM admin_roles WHERE slug = 'administrador';
INSERT IGNORE INTO admin_role_permissions (role_id, permission_key)
SELECT id, 'gateways' FROM admin_roles WHERE slug = 'administrador';
INSERT IGNORE INTO admin_role_permissions (role_id, permission_key)
SELECT id, 'affiliates' FROM admin_roles WHERE slug = 'administrador';
INSERT IGNORE INTO admin_role_permissions (role_id, permission_key)
SELECT id, 'commissions' FROM admin_roles WHERE slug = 'administrador';
INSERT IGNORE INTO admin_role_permissions (role_id, permission_key)
SELECT id, 'payouts' FROM admin_roles WHERE slug = 'administrador';
INSERT IGNORE INTO admin_role_permissions (role_id, permission_key)
SELECT id, 'support' FROM admin_roles WHERE slug = 'administrador';
INSERT IGNORE INTO admin_role_permissions (role_id, permission_key)
SELECT id, 'messages' FROM admin_roles WHERE slug = 'administrador';
INSERT IGNORE INTO admin_role_permissions (role_id, permission_key)
SELECT id, 'catalog' FROM admin_roles WHERE slug = 'administrador';
INSERT IGNORE INTO admin_role_permissions (role_id, permission_key)
SELECT id, 'themes' FROM admin_roles WHERE slug = 'administrador';
INSERT IGNORE INTO admin_role_permissions (role_id, permission_key)
SELECT id, 'ai' FROM admin_roles WHERE slug = 'administrador';
INSERT IGNORE INTO admin_role_permissions (role_id, permission_key)
SELECT id, 'documentacao' FROM admin_roles WHERE slug = 'administrador';
INSERT IGNORE INTO admin_role_permissions (role_id, permission_key)
SELECT id, 'settings' FROM admin_roles WHERE slug = 'administrador';
INSERT IGNORE INTO admin_role_permissions (role_id, permission_key)
SELECT id, 'errors' FROM admin_roles WHERE slug = 'administrador';
INSERT IGNORE INTO admin_role_permissions (role_id, permission_key)
SELECT id, 'hardware' FROM admin_roles WHERE slug = 'administrador';
INSERT IGNORE INTO admin_role_permissions (role_id, permission_key)
SELECT id, 'admins' FROM admin_roles WHERE slug = 'administrador';
INSERT IGNORE INTO admin_role_permissions (role_id, permission_key)
SELECT id, 'roles' FROM admin_roles WHERE slug = 'administrador';

-- Afiliados: visão comercial e todo o fluxo de afiliados.
INSERT IGNORE INTO admin_role_permissions (role_id, permission_key)
SELECT id, 'dashboard' FROM admin_roles WHERE slug = 'afiliados';
INSERT IGNORE INTO admin_role_permissions (role_id, permission_key)
SELECT id, 'companies' FROM admin_roles WHERE slug = 'afiliados';
INSERT IGNORE INTO admin_role_permissions (role_id, permission_key)
SELECT id, 'usage' FROM admin_roles WHERE slug = 'afiliados';
INSERT IGNORE INTO admin_role_permissions (role_id, permission_key)
SELECT id, 'contracts' FROM admin_roles WHERE slug = 'afiliados';
INSERT IGNORE INTO admin_role_permissions (role_id, permission_key)
SELECT id, 'affiliates' FROM admin_roles WHERE slug = 'afiliados';
INSERT IGNORE INTO admin_role_permissions (role_id, permission_key)
SELECT id, 'commissions' FROM admin_roles WHERE slug = 'afiliados';
INSERT IGNORE INTO admin_role_permissions (role_id, permission_key)
SELECT id, 'payouts' FROM admin_roles WHERE slug = 'afiliados';

-- Suporte: atendimento, empresas, dispositivos e conteúdo.
INSERT IGNORE INTO admin_role_permissions (role_id, permission_key)
SELECT id, 'companies' FROM admin_roles WHERE slug = 'suporte';
INSERT IGNORE INTO admin_role_permissions (role_id, permission_key)
SELECT id, 'usage' FROM admin_roles WHERE slug = 'suporte';
INSERT IGNORE INTO admin_role_permissions (role_id, permission_key)
SELECT id, 'devices' FROM admin_roles WHERE slug = 'suporte';
INSERT IGNORE INTO admin_role_permissions (role_id, permission_key)
SELECT id, 'downloads' FROM admin_roles WHERE slug = 'suporte';
INSERT IGNORE INTO admin_role_permissions (role_id, permission_key)
SELECT id, 'versions' FROM admin_roles WHERE slug = 'suporte';
INSERT IGNORE INTO admin_role_permissions (role_id, permission_key)
SELECT id, 'support' FROM admin_roles WHERE slug = 'suporte';
INSERT IGNORE INTO admin_role_permissions (role_id, permission_key)
SELECT id, 'messages' FROM admin_roles WHERE slug = 'suporte';
INSERT IGNORE INTO admin_role_permissions (role_id, permission_key)
SELECT id, 'catalog' FROM admin_roles WHERE slug = 'suporte';
INSERT IGNORE INTO admin_role_permissions (role_id, permission_key)
SELECT id, 'documentacao' FROM admin_roles WHERE slug = 'suporte';
INSERT IGNORE INTO admin_role_permissions (role_id, permission_key)
SELECT id, 'errors' FROM admin_roles WHERE slug = 'suporte';
INSERT IGNORE INTO admin_role_permissions (role_id, permission_key)
SELECT id, 'hardware' FROM admin_roles WHERE slug = 'suporte';

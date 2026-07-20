-- 0002_security — Fase 1: usuários, cargos, permissões, sessões e auditoria.
-- Regra do projeto: toda tabela tem coluna `comment` descrevendo o objetivo da tabela.

CREATE TABLE roles (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  slug TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  is_system INTEGER NOT NULL DEFAULT 0,
  uuid TEXT NOT NULL UNIQUE,
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  deleted_at TEXT,
  synced_at TEXT,
  origin_machine TEXT,
  comment TEXT NOT NULL DEFAULT 'Cargos do sistema (Administrador, Gerente, Operador, Caixa, Entregador, Estoquista e personalizados). Base do RBAC.'
);

CREATE TABLE permissions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  key TEXT NOT NULL UNIQUE,
  description TEXT NOT NULL,
  module TEXT NOT NULL DEFAULT 'core',
  comment TEXT NOT NULL DEFAULT 'Catálogo de permissões por módulo/ação (ex.: users.delete). Módulos registram suas permissões aqui via manifesto.'
);

CREATE TABLE role_permissions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  role_id INTEGER NOT NULL REFERENCES roles(id) ON DELETE CASCADE,
  permission_key TEXT NOT NULL,
  comment TEXT NOT NULL DEFAULT 'Vínculo cargo → permissão. Define o que cada cargo pode fazer (RBAC).',
  UNIQUE(role_id, permission_key)
);

CREATE TABLE users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  username TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  email TEXT,
  password_hash TEXT NOT NULL,
  role_id INTEGER NOT NULL REFERENCES roles(id),
  active INTEGER NOT NULL DEFAULT 1,
  last_login_at TEXT,
  uuid TEXT NOT NULL UNIQUE,
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  deleted_at TEXT,
  synced_at TEXT,
  origin_machine TEXT,
  comment TEXT NOT NULL DEFAULT 'Usuários do sistema com credenciais (hash bcrypt) e cargo. Toda ação no Kivo é feita por um usuário autenticado.'
);

CREATE TABLE sessions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  token TEXT NOT NULL UNIQUE,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  remember INTEGER NOT NULL DEFAULT 0,
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  ip TEXT,
  machine TEXT,
  comment TEXT NOT NULL DEFAULT 'Sessões ativas de login (token httpOnly). Sessões "lembrar login" têm validade estendida.'
);

CREATE TABLE audit_logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER REFERENCES users(id),
  username TEXT,
  action TEXT NOT NULL,
  entity TEXT NOT NULL,
  entity_id TEXT,
  before_json TEXT,
  after_json TEXT,
  ip TEXT,
  machine TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  uuid TEXT NOT NULL UNIQUE,
  comment TEXT NOT NULL DEFAULT 'Trilha de auditoria: quem fez o quê, em qual entidade, com estado antes/depois, quando, de onde. Nunca é apagada pela aplicação.'
);

CREATE INDEX idx_sessions_token ON sessions(token);
CREATE INDEX idx_audit_created ON audit_logs(created_at);
CREATE INDEX idx_audit_entity ON audit_logs(entity, entity_id);

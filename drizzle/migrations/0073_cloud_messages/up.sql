-- Central de mensagens do Kivo (suporte -> loja). Três tabelas locais:
--   cloud_messages            cache das mensagens publicadas para esta empresa (puxadas da nuvem);
--   cloud_message_state       estado POR USUÁRIO: lida, favorita, excluída, categoria própria e ordem;
--   cloud_message_categories  categorias criadas pelo usuário para guardar mensagens.
-- O estado é local de propósito (escolha de quem lê), então não sincroniza nem sobe para a nuvem.

CREATE TABLE cloud_messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  uuid TEXT NOT NULL UNIQUE,
  title TEXT NOT NULL,
  subtitle TEXT,
  category TEXT NOT NULL DEFAULT 'comunicado',
  body_html TEXT NOT NULL DEFAULT '',
  has_image INTEGER NOT NULL DEFAULT 0,
  image_mime TEXT,
  image_b64 TEXT,
  is_urgent INTEGER NOT NULL DEFAULT 0,
  published_at TEXT,
  remote_updated_at TEXT,
  fetched_at TEXT NOT NULL DEFAULT (datetime('now')),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  comment TEXT NOT NULL DEFAULT 'Cache local das mensagens publicadas pelo suporte/Kivo Cloud para esta empresa. Alimentada por pull em /api/messages/inbox.'
);
CREATE INDEX idx_cloud_messages_published ON cloud_messages(published_at);

CREATE TABLE cloud_message_state (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  uuid TEXT NOT NULL UNIQUE,
  message_uuid TEXT NOT NULL,
  user_id INTEGER NOT NULL,
  read_at TEXT,
  dismissed_at TEXT,
  favorite INTEGER NOT NULL DEFAULT 0,
  custom_category_id INTEGER,
  sort_order INTEGER,
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  comment TEXT NOT NULL DEFAULT 'Estado de cada mensagem por usuário: lida, favorita, excluída, categoria própria e ordem de exibição. Local, não sincroniza.',
  UNIQUE(message_uuid, user_id)
);
CREATE INDEX idx_cloud_message_state_user ON cloud_message_state(user_id);

CREATE TABLE cloud_message_categories (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  uuid TEXT NOT NULL UNIQUE,
  user_id INTEGER NOT NULL,
  name TEXT NOT NULL,
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  comment TEXT NOT NULL DEFAULT 'Categorias criadas pelo usuário para organizar mensagens (ex.: "Tutoriais que uso"). Local, não sincroniza.',
  UNIQUE(user_id, name)
);

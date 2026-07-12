-- 0030_capabilities — Capacidades finas declaradas por módulo.
-- Cada capability é um recurso ligável/desligável por empresa, dentro de um módulo
-- já contratado (ex.: 'variantes', 'kits', 'complementos'). Upsert no boot como
-- permissões — nunca resetam o `enabled` atual.
CREATE TABLE capabilities (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  key TEXT NOT NULL UNIQUE,
  description TEXT NOT NULL,
  module TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 0,
  uuid TEXT NOT NULL UNIQUE,
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  deleted_at TEXT,
  synced_at TEXT,
  origin_machine TEXT,
  comment TEXT NOT NULL DEFAULT 'Capacidades finas declaradas por módulo; enabled é decidido por empresa, não pelo licenciamento.'
);

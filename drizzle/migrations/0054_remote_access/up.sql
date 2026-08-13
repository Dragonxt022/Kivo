-- 0054_remote_access — acesso ao Kivo Web (celular) por link/QR, concedido por usuário.
--
-- Guarda SÓ o sha256 do token; o valor em claro existe uma única vez, no diálogo que mostra
-- o QR. Quem tiver acesso ao banco não consegue montar o link de volta.
--
-- Deliberadamente FORA de `syncTables`: é credencial. Para a nuvem vai apenas o hash, por
-- rota dedicada (core/remote/service.ts → POST /api/mobile/grants), junto do username, cargo
-- e lista de permissões — nunca o `password_hash` do usuário, que continua só nesta máquina.
CREATE TABLE remote_access (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id),
  -- sha256 do token em claro (hex, 64 chars). Único: dois acessos nunca colidem.
  token_hash TEXT NOT NULL UNIQUE,
  -- Como o dono reconhece este acesso na lista ("Celular do Bruno").
  label TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  -- Preenchido pela nuvem no ack do sync: mostra ao dono se o acesso está mesmo em uso.
  last_used_at TEXT,
  revoked_at TEXT,
  uuid TEXT NOT NULL UNIQUE,
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  deleted_at TEXT,
  synced_at TEXT,
  origin_machine TEXT,
  comment TEXT NOT NULL DEFAULT 'Concessões de acesso ao Kivo Web (celular) por link/QR. Guarda apenas o hash do token; nunca o token em claro nem a senha do usuário.'
);

CREATE INDEX idx_remote_access_user ON remote_access (user_id) WHERE deleted_at IS NULL;

-- Sessões do painel admin persistidas no banco — sobrevivem a restart/deploy do servidor.
-- Guarda só o hash do token (o cookie carrega o token cru), com validade de 12h.

CREATE TABLE IF NOT EXISTS admin_sessions (
  token_hash CHAR(64) PRIMARY KEY,
  username VARCHAR(120) NOT NULL,
  expires_at DATETIME(3) NOT NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  last_seen_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  INDEX idx_admin_sessions_expires (expires_at)
);

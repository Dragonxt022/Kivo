-- Fila local de erros anônimos para envio ao cloud (suporte).
-- Agregada por fingerprint: erros iguais incrementam `occurrences` em vez de virar
-- milhares de linhas. Removida após o envio com sucesso. Só dado técnico, sem dado pessoal.
CREATE TABLE telemetry_errors (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  fingerprint TEXT NOT NULL UNIQUE,
  scope TEXT,
  level TEXT NOT NULL DEFAULT 'error',
  message TEXT NOT NULL,
  stack TEXT,
  context TEXT,
  app_version TEXT,
  os TEXT,
  occurrences INTEGER NOT NULL DEFAULT 1,
  first_seen_at TEXT NOT NULL DEFAULT (datetime('now')),
  last_seen_at TEXT NOT NULL DEFAULT (datetime('now')),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  uuid TEXT NOT NULL UNIQUE,
  comment TEXT NOT NULL DEFAULT 'Fila local de erros anônimos para envio ao suporte no cloud. Agregada por fingerprint, removida após o envio. Só dado técnico.'
);
CREATE INDEX idx_telemetry_errors_last_seen ON telemetry_errors(last_seen_at);

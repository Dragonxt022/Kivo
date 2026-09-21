-- 0003_backup_license — Fase 1: histórico de backups e licenciamento base.
-- Regra do projeto: toda tabela tem coluna `comment` descrevendo o objetivo da tabela.

CREATE TABLE backups (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  file_path TEXT NOT NULL,
  size_bytes INTEGER NOT NULL,
  checksum TEXT NOT NULL,
  trigger TEXT NOT NULL DEFAULT 'manual',
  status TEXT NOT NULL DEFAULT 'ok',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  uuid TEXT NOT NULL UNIQUE,
  comment TEXT NOT NULL DEFAULT 'Histórico de backups do banco local: arquivo gerado, tamanho, checksum sha256 (usado para validar restauração) e origem (manual/agendado).'
);

CREATE TABLE license (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  machine_id TEXT NOT NULL,
  company_uuid TEXT,
  license_key TEXT,
  plan TEXT,
  modules_json TEXT,
  valid_until TEXT,
  last_validated_at TEXT,
  offline_grace_days INTEGER NOT NULL DEFAULT 3,
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  comment TEXT NOT NULL DEFAULT 'Licença desta instalação: Machine ID + Empresa (UUID) + License Key, plano, módulos habilitados e validade. Validada no boot com tolerância offline configurável.'
);

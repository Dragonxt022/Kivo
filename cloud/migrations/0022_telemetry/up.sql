-- 0022_telemetry — erros anônimos por cliente e inventário de hardware.
-- Sem dado pessoal: só dado técnico. O vínculo é (company_uuid, machine_id), ambos já
-- conhecidos pelo cloud via company_devices.

CREATE TABLE IF NOT EXISTS client_error_reports (
  id BIGINT AUTO_INCREMENT PRIMARY KEY,
  company_uuid CHAR(36) NOT NULL,
  machine_id VARCHAR(64) NOT NULL,
  fingerprint VARCHAR(64) NOT NULL,
  scope VARCHAR(80) NULL,
  level VARCHAR(10) NOT NULL DEFAULT 'error',
  message TEXT NULL,
  stack MEDIUMTEXT NULL,
  context JSON NULL,
  app_version VARCHAR(24) NULL,
  os VARCHAR(160) NULL,
  occurrences INT NOT NULL DEFAULT 1,
  first_seen_at DATETIME(3) NULL,
  last_seen_at DATETIME(3) NULL,
  received_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  UNIQUE KEY ux_error_fingerprint (company_uuid, machine_id, fingerprint),
  INDEX idx_error_last_seen (last_seen_at),
  INDEX idx_error_company (company_uuid, last_seen_at)
);

CREATE TABLE IF NOT EXISTS client_machine_inventory (
  company_uuid CHAR(36) NOT NULL,
  machine_id VARCHAR(64) NOT NULL,
  data JSON NOT NULL,
  os VARCHAR(160) NULL,
  cpu VARCHAR(160) NULL,
  ram_gb INT NULL,
  app_version VARCHAR(24) NULL,
  first_seen_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  last_seen_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (company_uuid, machine_id),
  INDEX idx_inventory_last_seen (last_seen_at)
);

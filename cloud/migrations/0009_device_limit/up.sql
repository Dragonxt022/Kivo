ALTER TABLE companies ADD COLUMN max_devices INT NOT NULL DEFAULT 1;

CREATE TABLE company_devices (
  id BIGINT AUTO_INCREMENT PRIMARY KEY,
  company_uuid CHAR(36) NOT NULL,
  machine_id VARCHAR(64) NOT NULL,
  first_seen_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  last_seen_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  removed_at DATETIME(3) NULL,
  UNIQUE KEY uq_company_devices (company_uuid, machine_id),
  CONSTRAINT fk_company_devices_company FOREIGN KEY (company_uuid) REFERENCES companies(company_uuid)
) ENGINE=InnoDB;

-- Grandfathering: empresas que já sincronizam de mais de 1 máquina hoje (histórico real
-- em sync_records.origin_machine) ganham folga automática — sem isso, o default=1
-- quebraria clientes multi-PC legítimos assim que esta trava entrar em produção.
UPDATE companies c SET c.max_devices = GREATEST(1, (
  SELECT COUNT(DISTINCT sr.origin_machine) FROM sync_records sr WHERE sr.company_uuid = c.company_uuid
)) WHERE EXISTS (SELECT 1 FROM sync_records sr WHERE sr.company_uuid = c.company_uuid);

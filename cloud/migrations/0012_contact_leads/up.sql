CREATE TABLE contact_leads (
  id BIGINT AUTO_INCREMENT PRIMARY KEY,
  name VARCHAR(120) NOT NULL,
  whatsapp VARCHAR(40) NOT NULL,
  email VARCHAR(160) NULL,
  business VARCHAR(160) NULL,
  message TEXT NULL,
  status VARCHAR(16) NOT NULL DEFAULT 'novo',
  contacted_at DATETIME(3) NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  KEY idx_contact_leads_status (status),
  KEY idx_contact_leads_created (created_at)
) ENGINE=InnoDB

CREATE TABLE support_tickets (
  id BIGINT AUTO_INCREMENT PRIMARY KEY,
  company_uuid CHAR(36) NOT NULL,
  subject VARCHAR(160) NOT NULL,
  category VARCHAR(24) NOT NULL DEFAULT 'suporte',
  status VARCHAR(16) NOT NULL DEFAULT 'aberto',
  created_by VARCHAR(120) NULL,
  client_unread INT NOT NULL DEFAULT 0,
  admin_unread INT NOT NULL DEFAULT 1,
  last_message_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  KEY idx_support_tickets_company (company_uuid),
  KEY idx_support_tickets_status (status),
  KEY idx_support_tickets_last_msg (last_message_at)
) ENGINE=InnoDB;
CREATE TABLE support_messages (
  id BIGINT AUTO_INCREMENT PRIMARY KEY,
  ticket_id BIGINT NOT NULL,
  sender VARCHAR(16) NOT NULL,
  sender_name VARCHAR(120) NULL,
  body TEXT NOT NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  KEY idx_support_messages_ticket (ticket_id),
  CONSTRAINT fk_support_messages_ticket FOREIGN KEY (ticket_id) REFERENCES support_tickets(id) ON DELETE CASCADE
) ENGINE=InnoDB

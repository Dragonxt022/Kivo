CREATE TABLE menu_items (
  id BIGINT AUTO_INCREMENT PRIMARY KEY,
  company_uuid CHAR(36) NOT NULL,
  product_uuid CHAR(36) NOT NULL,
  name VARCHAR(255) NOT NULL,
  description TEXT NULL,
  price_cents INT NOT NULL,
  category_uuid CHAR(36) NULL,
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  UNIQUE KEY uq_menu_items_company_product (company_uuid, product_uuid),
  KEY idx_menu_items_company (company_uuid),
  CONSTRAINT fk_menu_items_company FOREIGN KEY (company_uuid) REFERENCES companies(company_uuid)
) ENGINE=InnoDB;

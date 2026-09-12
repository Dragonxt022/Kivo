-- 0067_commercial_customer_profile — segmentação de clientes.
-- birthday: data de nascimento (YYYY-MM-DD) para aniversariantes/campanhas.
-- tags: etiquetas livres separadas por vírgula (ex.: "VIP,atacado,bairro X").
-- Ambas são colunas da própria tabela e sincronizam automaticamente entre as máquinas
-- (ver syncTables do module.manifest: customers só exclui os saldos derivados).
ALTER TABLE customers ADD COLUMN birthday TEXT;
ALTER TABLE customers ADD COLUMN tags TEXT;
CREATE INDEX idx_customers_birthday ON customers(birthday);

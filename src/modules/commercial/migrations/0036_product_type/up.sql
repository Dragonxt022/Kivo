-- 0032_product_type — coluna de tipo de produto para o Catálogo Avançado (Fase 2).
-- Nesta fase, a coluna existe mas não é exposta na UI: a API continua aceitando
-- só 'fisico' e o valor default é 'fisico'. A constraint CHECK lista todos os 10
-- tipos do plano para evitar recriar a tabela depois (SQLite exige rebuild para
-- alterar CHECK).
ALTER TABLE products ADD COLUMN product_type TEXT NOT NULL DEFAULT 'fisico'
  CHECK (product_type IN ('fisico','variante','fracionado','composto','kit','combo','produzido','servico','digital','assinatura'));

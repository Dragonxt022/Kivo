-- 0077_product_type_config — comportamento configurável de cada tipo de produto.
--
-- Até aqui o comportamento dos tipos estava hardcoded (no cadastro e no servidor): quais
-- controlam estoque, quais aparecem para escolher etc. Esta tabela tira isso do código e
-- vira configuração editável em Configurações › Tipos de produto.
--
-- Os UUIDs são FIXOS (não aleatórios) de propósito: as duas máquinas semeiam as mesmas
-- linhas e o motor de sync casa por uuid — com uuid aleatório, cada máquina criaria a sua
-- e o índice único de `key` estouraria no merge.

CREATE TABLE product_type_config (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  key TEXT NOT NULL UNIQUE,
  label TEXT NOT NULL,
  description TEXT,
  controls_stock INTEGER NOT NULL DEFAULT 1,
  active INTEGER NOT NULL DEFAULT 1,
  sort_order INTEGER NOT NULL DEFAULT 0,
  uuid TEXT NOT NULL UNIQUE,
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  deleted_at TEXT,
  synced_at TEXT,
  origin_machine TEXT,
  comment TEXT NOT NULL DEFAULT 'Comportamento de cada tipo de produto (controla estoque, ativo), editável em Configurações › Tipos de produto. Lido pelo cadastro de produtos e pelo servidor.'
);

INSERT INTO product_type_config (key, label, description, controls_stock, active, sort_order, uuid) VALUES
  ('fisico',      'Simples',     'Item físico comum, com estoque próprio.',                     1, 1, 1, '11111111-1111-4111-8111-111111111111'),
  ('servico',     'Serviço',     'Mão de obra ou execução. Não tem estoque.',                   0, 1, 2, '22222222-2222-4222-8222-222222222222'),
  ('complemento', 'Complemento', 'Adicional/opcional de outro produto. Sem saldo próprio.',     0, 1, 3, '33333333-3333-4333-8333-333333333333'),
  ('variante',    'Variantes',   'Agrupador de variações. O saldo fica em cada variação.',      0, 1, 4, '44444444-4444-4444-8444-444444444444'),
  ('kit',         'Kit',         'Conjunto de produtos vendidos juntos como um só item.',       1, 1, 5, '55555555-5555-4555-8555-555555555555'),
  ('combo',       'Combo',       'Combinação promocional com preço especial.',                  1, 1, 6, '66666666-6666-4666-8666-666666666666'),
  ('produzido',   'Produzido',   'Fabricado internamente com ficha técnica.',                   1, 1, 7, '77777777-7777-4777-8777-777777777777');

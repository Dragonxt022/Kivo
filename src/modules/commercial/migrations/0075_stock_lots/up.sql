-- 0075_stock_lots — controle de estoque por LOTE, validade e saída FIFO/FEFO.
--
-- Contexto: até aqui o estoque era um saldo único por produto (products.stock_qty) mantido
-- pelo ledger stock_movements, sem noção de lote nem validade. Este passo adiciona a camada
-- de lote para os produtos marcados com `controla_lote`:
--
--   - a ENTRADA cria/reabastece um lote (código + validade + custo);
--   - a SAÍDA consome os lotes do mais antigo (ou de validade mais próxima) para o mais novo;
--   - `lot_consumptions` registra qual lote saiu, quanto e a que custo (rastreabilidade e
--     base do CMV por FIFO).
--
-- Tudo aditivo: colunas novas com DEFAULT e tabelas novas. Produtos sem `controla_lote`
-- (o padrão) seguem exatamente o comportamento anterior.

-- 1 = o produto trabalha por lote (entra lote/validade; sai FIFO/FEFO). 0 = saldo único (padrão).
ALTER TABLE products ADD COLUMN controla_lote INTEGER NOT NULL DEFAULT 0;

CREATE TABLE product_lots (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  product_id INTEGER NOT NULL REFERENCES products(id),
  code TEXT,
  expires_at TEXT,
  qty REAL NOT NULL DEFAULT 0,
  cost_cents INTEGER NOT NULL DEFAULT 0,
  supplier_id INTEGER REFERENCES suppliers(id),
  ref_entity TEXT,
  ref_id TEXT,
  received_at TEXT NOT NULL DEFAULT (datetime('now')),
  uuid TEXT NOT NULL UNIQUE,
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  deleted_at TEXT,
  synced_at TEXT,
  origin_machine TEXT,
  comment TEXT NOT NULL DEFAULT 'Lotes de estoque de um produto: código, validade, saldo atual e custo unitário. A saída consome os lotes em FIFO/FEFO (validade mais próxima primeiro).'
);

CREATE INDEX idx_product_lots_product ON product_lots(product_id, expires_at);
CREATE INDEX idx_product_lots_expiry ON product_lots(expires_at);

-- Lote do movimento (entradas/ajustes de um lote específico). NULL para produtos sem lote.
ALTER TABLE stock_movements ADD COLUMN lot_id INTEGER REFERENCES product_lots(id);

-- Consumo de lote por uma saída/ajuste: qual lote saiu, quanto e a que custo.
CREATE TABLE lot_consumptions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  product_id INTEGER NOT NULL REFERENCES products(id),
  lot_id INTEGER REFERENCES product_lots(id),
  movement_id INTEGER REFERENCES stock_movements(id),
  qty REAL NOT NULL,
  unit_cost_cents INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  uuid TEXT NOT NULL UNIQUE,
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  deleted_at TEXT,
  synced_at TEXT,
  origin_machine TEXT,
  comment TEXT NOT NULL DEFAULT 'Consumo de lote por uma saída/ajuste: qual lote saiu, quanto e a que custo unitário. Base do CMV por FIFO e da rastreabilidade do que foi vendido.'
);

CREATE INDEX idx_lot_consumptions_lot ON lot_consumptions(lot_id);
CREATE INDEX idx_lot_consumptions_movement ON lot_consumptions(movement_id);
CREATE INDEX idx_lot_consumptions_product ON lot_consumptions(product_id);

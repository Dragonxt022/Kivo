-- 0023_finance_payment_methods_new_types — SQLite não altera CHECK existente, então
-- recria a tabela com o type aceitando os 3 novos tipos (crédito de loja, fidelidade,
-- convênio). Os 3 nascem desativados (active=0): o lojista habilita quando quiser usar,
-- sem mudar o comportamento de instalações já em produção.
CREATE TABLE payment_methods_new (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL UNIQUE,
  type TEXT NOT NULL CHECK (type IN ('dinheiro', 'debito', 'credito', 'pix', 'prazo', 'outro', 'credito_loja', 'fidelidade', 'convenio')),
  fee_bps INTEGER NOT NULL DEFAULT 0 CHECK (fee_bps >= 0 AND fee_bps <= 10000),
  active INTEGER NOT NULL DEFAULT 1,
  sort INTEGER NOT NULL DEFAULT 0,
  uuid TEXT NOT NULL UNIQUE,
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  deleted_at TEXT,
  synced_at TEXT,
  origin_machine TEXT,
  comment TEXT NOT NULL DEFAULT 'Formas de pagamento aceitas, com taxa da operadora em basis points (160 = 1,6%). O tipo controla o comportamento: dinheiro passa pela gaveta com troco; prazo gera conta a receber; credito_loja/fidelidade descontam de um saldo do cliente; convenio vira cobrança pendente da empresa conveniada.'
);
INSERT INTO payment_methods_new SELECT * FROM payment_methods;
DROP TABLE payment_methods;
ALTER TABLE payment_methods_new RENAME TO payment_methods;

INSERT INTO payment_methods (name, type, fee_bps, active, sort, uuid) VALUES
  ('Crédito de loja', 'credito_loja', 0, 0, 6, lower(hex(randomblob(16)))),
  ('Pontos de fidelidade', 'fidelidade', 0, 0, 7, lower(hex(randomblob(16)))),
  ('Convênio', 'convenio', 0, 0, 8, lower(hex(randomblob(16))));

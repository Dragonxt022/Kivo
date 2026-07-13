DELETE FROM payment_methods WHERE type IN ('credito_loja', 'fidelidade', 'convenio');

CREATE TABLE payment_methods_old (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL UNIQUE,
  type TEXT NOT NULL CHECK (type IN ('dinheiro', 'debito', 'credito', 'pix', 'prazo', 'outro')),
  fee_bps INTEGER NOT NULL DEFAULT 0 CHECK (fee_bps >= 0 AND fee_bps <= 10000),
  active INTEGER NOT NULL DEFAULT 1,
  sort INTEGER NOT NULL DEFAULT 0,
  uuid TEXT NOT NULL UNIQUE,
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  deleted_at TEXT,
  synced_at TEXT,
  origin_machine TEXT,
  comment TEXT NOT NULL DEFAULT 'Formas de pagamento aceitas, com taxa da operadora em basis points (160 = 1,6%). O tipo controla o comportamento: dinheiro passa pela gaveta com troco; prazo gera conta a receber.'
);
INSERT INTO payment_methods_old SELECT * FROM payment_methods;
DROP TABLE payment_methods;
ALTER TABLE payment_methods_old RENAME TO payment_methods;

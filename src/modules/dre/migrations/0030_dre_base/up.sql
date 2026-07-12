-- 0030_dre_base — DRE (Demonstrativo de Resultado): categorias e ajuste percentual de simulação.
-- Regra do projeto: toda tabela tem coluna `comment` descrevendo o objetivo da tabela.
-- adjustment_bps em basis points (pode ser negativo = desconto): 1000 = +10%, -500 = -5%.

CREATE TABLE dre_categories (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  key TEXT NOT NULL UNIQUE,
  label TEXT NOT NULL,
  dre_line TEXT NOT NULL CHECK (dre_line IN ('receita_bruta', 'deducoes', 'cmv', 'despesas_operacionais', 'despesas_financeiras')),
  source TEXT NOT NULL DEFAULT 'manual' CHECK (source IN ('manual', 'sales_revenue', 'cogs', 'card_fees')),
  system INTEGER NOT NULL DEFAULT 0,
  adjustment_bps INTEGER NOT NULL DEFAULT 0 CHECK (adjustment_bps >= -10000 AND adjustment_bps <= 10000),
  sort INTEGER NOT NULL DEFAULT 99,
  active INTEGER NOT NULL DEFAULT 1,
  uuid TEXT NOT NULL UNIQUE,
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  deleted_at TEXT,
  synced_at TEXT,
  origin_machine TEXT,
  comment TEXT NOT NULL DEFAULT 'Categorias do DRE: linhas automáticas (receita/CMV/taxas de cartão, calculadas de vendas) e categorias manuais (associadas a contas a pagar). Cada categoria tem um ajuste percentual opcional (padrão 0) usado só como simulação no relatório, nunca altera o lançamento real. Categorias system=1 não podem ser excluídas nem trocar de linha/origem.'
);

INSERT INTO dre_categories (key, label, dre_line, source, system, sort, uuid) VALUES
  ('receita_bruta_vendas', 'Receita Bruta de Vendas', 'receita_bruta', 'sales_revenue', 1, 1, lower(hex(randomblob(16)))),
  ('impostos_sobre_vendas', 'Impostos sobre Vendas', 'deducoes', 'manual', 1, 1, lower(hex(randomblob(16)))),
  ('cmv', 'CMV (Custo da Mercadoria Vendida)', 'cmv', 'cogs', 1, 1, lower(hex(randomblob(16)))),
  ('outras_despesas_operacionais', 'Outras Despesas Operacionais', 'despesas_operacionais', 'manual', 1, 99, lower(hex(randomblob(16)))),
  ('taxas_cartao', 'Taxas de Cartão', 'despesas_financeiras', 'card_fees', 1, 1, lower(hex(randomblob(16)))),
  ('outras_despesas_financeiras', 'Outras Despesas Financeiras', 'despesas_financeiras', 'manual', 1, 99, lower(hex(randomblob(16))));

ALTER TABLE payables ADD COLUMN dre_category_id INTEGER REFERENCES dre_categories(id);

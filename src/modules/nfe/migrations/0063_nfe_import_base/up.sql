-- 0063_nfe_import_base — módulo nfe: importação de NF-e (XML modelo 55 v4.00).
-- Regras do projeto: dinheiro em centavos (INTEGER), soft delete via deleted_at,
-- toda tabela tem coluna `comment` descrevendo o objetivo.

-- Vínculo produto × fornecedor: o código que CADA fornecedor usa para o produto
-- (cProd da NF-e), com snapshot do nome e do último custo/compra. Permite que
-- fornecedores diferentes usem códigos diferentes para o mesmo produto.
CREATE TABLE product_suppliers (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  product_id INTEGER NOT NULL REFERENCES products(id),
  supplier_id INTEGER NOT NULL REFERENCES suppliers(id),
  supplier_code TEXT,
  supplier_name TEXT,
  last_cost_cents INTEGER NOT NULL DEFAULT 0,
  last_purchase_at TEXT,
  uuid TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  deleted_at TEXT,
  synced_at TEXT,
  origin_machine TEXT,
  comment TEXT NOT NULL DEFAULT 'Vínculo produto x fornecedor: código que o fornecedor usa (cProd), nome e último custo/compra. Códigos diferentes por fornecedor apontam para o mesmo produto.'
);
CREATE UNIQUE INDEX ux_product_suppliers_active ON product_suppliers(product_id, supplier_id) WHERE deleted_at IS NULL;
CREATE INDEX idx_product_suppliers_code ON product_suppliers(supplier_id, supplier_code);

-- NF-e de compra importada: histórico/rastreabilidade do XML. A chave de acesso é
-- UNIQUE — a mesma nota nunca entra duas vezes. `xml` fica inline para a transação
-- ser atômica (nada de arquivo órfão se o COMMIT falhar).
CREATE TABLE purchase_invoices (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  access_key TEXT NOT NULL,
  supplier_id INTEGER NOT NULL REFERENCES suppliers(id),
  supplier_name TEXT,
  invoice_number TEXT,
  series TEXT,
  issued_at TEXT,
  total_cents INTEGER NOT NULL DEFAULT 0,
  xml TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'importada',
  imported_by INTEGER REFERENCES users(id),
  uuid TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  deleted_at TEXT,
  synced_at TEXT,
  origin_machine TEXT,
  comment TEXT NOT NULL DEFAULT 'NF-e de compra importada (XML modelo 55). Chave de acesso única impede importar a mesma nota duas vezes; mantém o histórico do documento.'
);
CREATE UNIQUE INDEX ux_purchase_invoices_access_key ON purchase_invoices(access_key) WHERE deleted_at IS NULL;

-- Item da NF-e importada: snapshot fiscal (NCM, CFOP, unidade, EAN) e de custo da
-- operação. product_id fica NULL quando a linha foi ignorada; status documenta a
-- decisão aplicada na conferência (criado/vinculado/ignorado).
CREATE TABLE purchase_invoice_items (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  purchase_invoice_id INTEGER NOT NULL REFERENCES purchase_invoices(id) ON DELETE CASCADE,
  line INTEGER NOT NULL,
  product_id INTEGER REFERENCES products(id),
  supplier_code TEXT,
  ean TEXT,
  description TEXT NOT NULL,
  ncm TEXT,
  cfop TEXT,
  unit TEXT,
  qty REAL NOT NULL DEFAULT 0,
  unit_cost_cents INTEGER NOT NULL DEFAULT 0,
  total_cost_cents INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'importado',
  uuid TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  deleted_at TEXT,
  synced_at TEXT,
  origin_machine TEXT,
  comment TEXT NOT NULL DEFAULT 'Item de NF-e importada: linha (nItem), produto resolvido, código/EAN da nota, descrição, tributário (NCM/CFOP/unidade) e custo da operação. Preserva os dados fiscais da NF-e sem alterar o cadastro do produto.'
);
CREATE INDEX idx_purchase_invoice_items_invoice ON purchase_invoice_items(purchase_invoice_id);

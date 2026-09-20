-- 0071_supplier_profile_barcodes — fornecedor mais completo, múltiplos códigos de barras
-- por produto e conversão de unidade de compra por fornecedor.
--
-- Contexto: o importador de NF-e precisa (a) cadastrar o fornecedor com os dados que já
-- vêm no XML (IE, endereço, contato), (b) NÃO gravar o EAN da CAIXA como código principal
-- do produto e (c) reaproveitar a conversão un/cx que o fornecedor usa.
--
-- Tudo aditivo: colunas novas com DEFAULT e uma tabela nova. Nenhuma coluna existente
-- muda de significado, então bancos antigos seguem funcionando sem ajuste de dados.

-- Fornecedor: dados fiscais e de contato que o XML traz no emitente e que faltavam.
ALTER TABLE suppliers ADD COLUMN ie TEXT;
ALTER TABLE suppliers ADD COLUMN cep TEXT;
ALTER TABLE suppliers ADD COLUMN street TEXT;
ALTER TABLE suppliers ADD COLUMN number TEXT;
ALTER TABLE suppliers ADD COLUMN complement TEXT;
ALTER TABLE suppliers ADD COLUMN district TEXT;
ALTER TABLE suppliers ADD COLUMN city TEXT;
ALTER TABLE suppliers ADD COLUMN state TEXT;
ALTER TABLE suppliers ADD COLUMN contact_name TEXT;
ALTER TABLE suppliers ADD COLUMN contact_phone TEXT;
ALTER TABLE suppliers ADD COLUMN contact_email TEXT;
-- Markup padrão de venda sobre o custo, em basis points (10000 = 100%). 0 = usa o global.
ALTER TABLE suppliers ADD COLUMN default_markup_bps INTEGER NOT NULL DEFAULT 0;

-- Códigos de barras ADICIONAIS do produto (caixa, lastro, inner). O `products.barcode`
-- continua sendo o código principal de VENDA (unidade); um EAN de embalagem nunca o
-- sobrescreve — entra aqui, com quantas unidades de venda a embalagem contém.
CREATE TABLE product_barcodes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  product_id INTEGER NOT NULL REFERENCES products(id),
  barcode TEXT NOT NULL,
  kind TEXT NOT NULL DEFAULT 'unidade',
  pack_qty REAL,
  supplier_id INTEGER REFERENCES suppliers(id),
  uuid TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  deleted_at TEXT,
  synced_at TEXT,
  origin_machine TEXT,
  comment TEXT NOT NULL DEFAULT 'Códigos de barras adicionais do produto (unidade, caixa, lastro, inner). O products.barcode segue sendo o principal de venda; EAN de embalagem entra aqui para não virar o código do produto.'
);
CREATE UNIQUE INDEX ux_product_barcodes_active ON product_barcodes(barcode) WHERE deleted_at IS NULL;
CREATE INDEX idx_product_barcodes_product ON product_barcodes(product_id);

-- Conversão de compra POR FORNECEDOR: quantas unidades de venda vêm em uma unidade de
-- compra (ex.: 1 CX = 12 UN). Reaproveitada nas próximas notas do mesmo fornecedor.
ALTER TABLE product_suppliers ADD COLUMN pack_qty REAL;
ALTER TABLE product_suppliers ADD COLUMN pack_unit TEXT;

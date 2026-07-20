-- 0026_products_image_catalog — foto do produto + fila local de envio ao banco de
-- imagens do Kivo Cloud (curadoria manual, ver cloud/migrations/0008_catalog_images).
ALTER TABLE products ADD COLUMN image_url TEXT;

CREATE TABLE product_image_submissions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  product_id INTEGER NOT NULL REFERENCES products(id),
  local_path TEXT NOT NULL,
  sha256 TEXT NOT NULL,
  product_name TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pendente_envio',
  remote_catalog_image_id TEXT,
  error_message TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  comment TEXT NOT NULL DEFAULT 'Fila local de imagens de produto enviadas ao banco de imagens do Kivo Cloud para curadoria manual (best-effort — falha de rede não afeta o app offline, só fica pendente para a próxima tentativa).'
);
CREATE INDEX idx_product_image_submissions_status ON product_image_submissions(status);

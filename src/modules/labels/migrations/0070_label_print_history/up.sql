-- 0070_label_print_history — histórico de impressões do Gerador de Etiquetas.
--
-- Cada vez que a folha é gerada (POST /app/labels/imprimir) grava-se uma linha aqui: quem
-- imprimiu, quando, qual modelo de folha, simbologia, quantas etiquetas/páginas e o
-- `payload_json` original (itens + configuração), que permite REIMPRIMIR exatamente a mesma
-- folha depois. `fields_json` guarda o que foi escolhido exibir (nome, preço, SKU, empresa).
--
-- `user_id` referencia `users` (não sincroniza); `user_name` é o snapshot para a lista.
CREATE TABLE label_print_jobs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  sheet_id INTEGER,
  sheet_name TEXT NOT NULL,
  symbology TEXT NOT NULL,
  fields_json TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  summary_json TEXT,
  total_labels INTEGER NOT NULL DEFAULT 0,
  pages INTEGER NOT NULL DEFAULT 0,
  user_id INTEGER REFERENCES users(id),
  user_name TEXT,
  uuid TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  deleted_at TEXT,
  synced_at TEXT,
  origin_machine TEXT,
  comment TEXT NOT NULL DEFAULT 'Histórico de impressões de etiquetas: quem imprimiu, quando, modelo de folha, simbologia, quantidade e o payload para reimprimir a mesma folha.'
);
CREATE INDEX idx_label_print_jobs_created ON label_print_jobs(created_at);

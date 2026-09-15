-- 0069_labels_base — módulo labels: gerador de etiquetas de produto em folha A4.
-- Regras do projeto: dinheiro em centavos (INTEGER), soft delete via deleted_at,
-- toda tabela tem coluna `comment` descrevendo o objetivo.

-- Modelos de folha de etiqueta: descrevem a GRADE física da folha (dimensões da página
-- e da etiqueta, colunas, linhas, margens e espaçamentos), todas em MILÍMETROS, para a
-- tela de impressão posicionar cada etiqueta com precisão. Presets de fábrica
-- (is_preset=1, ex.: Pimaco 6180/6181/6187) são recriados no boot por uuid estável;
-- modelos custom (is_preset=0) são criados pelo lojista para folhas de outras marcas.
CREATE TABLE label_sheets (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  brand TEXT,
  code TEXT,
  page_w_mm REAL NOT NULL DEFAULT 210,
  page_h_mm REAL NOT NULL DEFAULT 297,
  label_w_mm REAL NOT NULL,
  label_h_mm REAL NOT NULL,
  cols INTEGER NOT NULL DEFAULT 1,
  rows INTEGER NOT NULL DEFAULT 1,
  margin_top_mm REAL NOT NULL DEFAULT 0,
  margin_left_mm REAL NOT NULL DEFAULT 0,
  gutter_x_mm REAL NOT NULL DEFAULT 0,
  gutter_y_mm REAL NOT NULL DEFAULT 0,
  is_preset INTEGER NOT NULL DEFAULT 0,
  uuid TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  deleted_at TEXT,
  comment TEXT NOT NULL DEFAULT 'Modelos de folha de etiqueta (ex.: Pimaco A4): dimensões em mm da página e da etiqueta, grade de colunas/linhas, margens e espaçamentos. Presets de fábrica (is_preset=1) são recriados no boot por uuid estável; modelos custom são criados pelo lojista.'
);
CREATE INDEX idx_label_sheets_preset ON label_sheets(is_preset);

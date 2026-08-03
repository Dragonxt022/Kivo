-- 0054_fiscal_base — Documentos fiscais eletrônicos (NFC-e) e a fila de envio.
--
-- A mesma tabela é o arquivo fiscal E o outbox: `status`/`attempts`/`next_attempt_at`
-- governam o reenvio, e o registro nunca some depois de autorizado (arquivamento legal).
--
-- `environment` entra em TODA chave de unicidade: homologação (2) e produção (1) têm
-- numerações independentes por lei, e o beta começa emitindo em homologação — sem essa
-- separação, testar queimaria a numeração de produção.
--
-- O XML autorizado NÃO fica no banco: vai para `storage/fiscal/<ano>/<mes>/<chave>.xml`
-- e aqui só o caminho + hash. São ~4-8 KB por nota, e o backup copia o SQLite inteiro
-- para a nuvem — guardar o XML dentro inflaria banco e backup por nada.

CREATE TABLE fiscal_documents (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  model TEXT NOT NULL CHECK (model IN ('55', '65')),
  serie INTEGER NOT NULL,
  number INTEGER NOT NULL,
  environment INTEGER NOT NULL CHECK (environment IN (1, 2)),
  key TEXT,
  status TEXT NOT NULL DEFAULT 'pendente' CHECK (status IN (
    'pendente', 'enviando', 'autorizada', 'rejeitada', 'cancelada', 'contingencia', 'inutilizada'
  )),
  sale_id INTEGER REFERENCES sales(id),
  customer_id INTEGER REFERENCES customers(id),
  cpf_dest TEXT,
  is_test INTEGER NOT NULL DEFAULT 0,
  tp_emis INTEGER NOT NULL DEFAULT 1,
  total_cents INTEGER NOT NULL DEFAULT 0,
  protocol TEXT,
  cstat INTEGER,
  motive TEXT,
  qr_code TEXT,
  xml_path TEXT,
  xml_hash TEXT,
  provider TEXT,
  provider_ref TEXT,
  attempts INTEGER NOT NULL DEFAULT 0,
  next_attempt_at TEXT,
  emitted_at TEXT NOT NULL DEFAULT (datetime('now')),
  authorized_at TEXT,
  canceled_at TEXT,
  uuid TEXT NOT NULL UNIQUE,
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  deleted_at TEXT,
  synced_at TEXT,
  origin_machine TEXT,
  comment TEXT NOT NULL DEFAULT 'Documentos fiscais eletrônicos (NFC-e) e fila de envio. É também o arquivo legal: registro autorizado nunca é apagado. XML fica em storage/fiscal, não aqui.'
);

-- Numeração de notas por modelo/série/ambiente. Reserva atômica em transação: número
-- repetido é rejeição na SEFAZ e dor de cabeça com o contador.
CREATE TABLE fiscal_sequences (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  model TEXT NOT NULL,
  serie INTEGER NOT NULL,
  environment INTEGER NOT NULL CHECK (environment IN (1, 2)),
  next_number INTEGER NOT NULL DEFAULT 1,
  uuid TEXT NOT NULL UNIQUE,
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  deleted_at TEXT,
  synced_at TEXT,
  origin_machine TEXT,
  comment TEXT NOT NULL DEFAULT 'Próximo número livre por modelo/série/ambiente. Produção e homologação contam separado.'
);

CREATE UNIQUE INDEX idx_fiscal_seq_unique ON fiscal_sequences(model, serie, environment);

-- Garante que o mesmo número nunca sai duas vezes na mesma série/ambiente.
CREATE UNIQUE INDEX idx_fiscal_docs_num ON fiscal_documents(model, serie, number, environment);

-- A chave de acesso só existe depois que o emissor a devolve; até lá é NULL, e vários
-- NULLs precisam conviver — daí o índice parcial em vez de UNIQUE na coluna.
CREATE UNIQUE INDEX idx_fiscal_docs_key ON fiscal_documents(key) WHERE key IS NOT NULL;

-- Consulta do worker da fila: pendentes cuja hora de retentativa já passou.
CREATE INDEX idx_fiscal_docs_queue ON fiscal_documents(status, next_attempt_at);
CREATE INDEX idx_fiscal_docs_sale ON fiscal_documents(sale_id);

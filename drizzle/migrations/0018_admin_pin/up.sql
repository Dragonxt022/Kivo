-- 0016_admin_pin — PIN de administrador para confirmar ações críticas no dia a dia
-- (ex.: remover item já lançado no carrinho do PDV). Linha única (id sempre 1).
-- Não sincroniza entre máquinas: assim como settings/users hoje, é configuração local
-- de cada instalação — cada máquina define seu próprio PIN.
CREATE TABLE security_pin (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  pin_hash TEXT NOT NULL,
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_by INTEGER REFERENCES users(id),
  comment TEXT NOT NULL DEFAULT 'PIN de administrador (hash) usado para confirmar ações críticas no ponto de venda quando a proteção estiver ativada. Configuração local da máquina, não sincroniza.'
);

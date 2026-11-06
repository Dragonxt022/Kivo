-- 0091_user_startup — abertura personalizada POR USUÁRIO.
--
-- Quando ligada, ao abrir o Kivo (ou depois do login) o usuário vai direto para o
-- módulo escolhido e, opcionalmente, entra em tela cheia. É o caso do tablet fixo na
-- cozinha ou do terminal que só usa Mesas: esconde a tela inicial e economiza cliques.
--
-- Desligada por padrão: linha ausente/`enabled = 0` = comportamento normal. Fora de
-- `syncTables` de propósito — a preferência é local do usuário nesta instalação, não
-- uma configuração da empresa que deva viajar entre máquinas.
CREATE TABLE user_startup (
  user_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  -- 0 = desligado (padrão); 1 = abrir direto no módulo escolhido.
  enabled INTEGER NOT NULL DEFAULT 0,
  -- Href exato de um item do menu (ex.: '/app/comandas/mesas'). Validado contra as
  -- permissões do usuário no momento de salvar e de novo ao abrir.
  module_href TEXT NOT NULL DEFAULT '',
  -- 1 = entrar em tela cheia junto com a abertura.
  fullscreen INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  comment TEXT NOT NULL DEFAULT 'Preferência POR USUÁRIO: abrir o Kivo direto em um módulo (e em tela cheia) ao iniciar. Desligada por padrão.'
);

CREATE INDEX idx_user_startup_enabled ON user_startup (enabled) WHERE enabled = 1;

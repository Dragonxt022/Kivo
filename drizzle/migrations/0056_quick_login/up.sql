-- 0056_quick_login — entrada rápida por perfil na tela de login ("igual Instagram"):
-- o usuário aparece como um balão redondo e entra num clique, sem digitar senha.
--
-- Resolve o caso da loja de família, em que todo mundo acabava usando o MESMO login porque
-- trocar de usuário custava caro — e com isso a auditoria não dizia quem fez o quê.
--
-- Deliberadamente FORA de `syncTables`, e sem `uuid`/`synced_at`/`origin_machine` (mesmo
-- padrão de `sessions`, `security_pin` e `password_recovery`): entrada sem senha vale só no
-- computador onde alguém a ligou de propósito. Se isto sincronizasse, marcar a caixa uma vez
-- liberaria login sem senha em TODAS as máquinas da empresa, inclusive num tablet largado no
-- salão — o oposto de "salvar o perfil neste computador".
--
-- Não há segredo guardado aqui porque não haveria o que proteger: a rota que troca o perfil
-- por uma sessão só aceita chamada da própria máquina (loopback), e quem já está nela
-- consegue ler este banco de qualquer jeito.
CREATE TABLE quick_login_profiles (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL UNIQUE REFERENCES users(id) ON DELETE CASCADE,
  -- Cor do balão, sorteada na criação e fixa depois: o operador reconhece o próprio perfil
  -- pela cor antes de ler o nome.
  avatar_color TEXT NOT NULL DEFAULT '#2563eb',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  last_used_at TEXT,
  comment TEXT NOT NULL DEFAULT 'Perfis de entrada rápida (login em um clique, sem senha) salvos NESTA máquina. Não sincroniza: ligar em um computador não libera nos outros.'
);

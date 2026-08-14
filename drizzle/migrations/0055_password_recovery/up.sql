-- 0055_password_recovery — resgate de senha offline, por código de desafio/resposta.
--
-- Problema que resolve: o `password_hash` mora só nesta máquina, então não existe "enviar
-- e-mail de recuperação" — o link chegaria no celular e teria que alcançar um servidor em
-- localhost, atrás de NAT. Quando existe um segundo administrador ele redefine em Usuários;
-- quando o administrador é único, não havia saída nenhuma a não ser editar o bcrypt na mão.
--
-- Como funciona: o app gera um desafio aleatório, o lojista dita para o suporte, e o suporte
-- devolve a resposta = HMAC(segredo da instalação, desafio) truncado. O segredo é entregue
-- pela nuvem na validação da licença e guardado no cofre (core/secrets), NUNCA aqui —
-- portanto ler esta tabela não permite forjar resposta nenhuma.
--
-- Fora de `syncTables` de propósito (tabelas só sincronizam se registradas): é estado
-- efêmero de uma máquina só. Também sem as colunas de contrato (uuid/synced_at/
-- origin_machine): nada referencia uma linha daqui, ela vive minutos e é consumida.
CREATE TABLE password_recovery (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  -- Desafio em claro (base32 legível). Não é segredo: sem o segredo da instalação ele não
  -- serve para nada, e o lojista precisa lê-lo em voz alta para o suporte.
  challenge TEXT NOT NULL UNIQUE,
  -- A quem a troca de senha se aplica. Fixado na criação para que a resposta valha para
  -- ESTE usuário — não dá para pedir o código para o caixa e usá-lo no dono.
  user_id INTEGER NOT NULL REFERENCES users(id),
  -- Freio por desafio, além do rate limit da rota: a resposta é curta (48 bits), então
  -- tentativa ilimitada no mesmo desafio seria força bruta viável.
  attempts INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  -- Preenchido quando a senha é efetivamente trocada; um desafio usado nunca volta a valer.
  used_at TEXT,
  comment TEXT NOT NULL DEFAULT 'Desafios de resgate de senha (pendentes ou consumidos). Não guarda segredo: a resposta é derivada do segredo da instalação, que fica no cofre em storage/secrets.json.'
);

CREATE INDEX idx_password_recovery_open ON password_recovery (challenge) WHERE used_at IS NULL;

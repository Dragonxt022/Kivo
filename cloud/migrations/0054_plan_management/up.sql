-- 0054_plan_management — planos de venda gerenciáveis pelo painel.
--
-- Antes, os 3 planos comerciais (Prata/Ouro/Diamante) eram hard-coded em src/plans.ts
-- (só preço/promoção/selo eram configuráveis, via app_settings). Esta migration move a
-- definição para a tabela `plans`: criar, editar, ativar/pausar e marcar as
-- funcionalidades de cada plano passa a ser operação de painel, sem release.
--
-- A chave (`plan_key`) nunca muda depois de criada: `charges.plan_key`,
-- `company_subscriptions.plan_key` e `companies.plan` referenciam a chave, e cobranças
-- antigas de um plano pausado precisam continuar resolvendo (baixa/settle e selo).
-- "Remover" no painel é PAUSAR (active = 0): o plano sai do catálogo de venda, mas
-- quem já o contratou segue válido e cobranças em aberto continuam baixáveis.

CREATE TABLE IF NOT EXISTS plans (
  plan_key VARCHAR(50) PRIMARY KEY,
  label VARCHAR(60) NOT NULL,
  description VARCHAR(255) NOT NULL DEFAULT '',
  price_cents INT NOT NULL,
  extends_days INT NOT NULL DEFAULT 30,
  max_devices INT NOT NULL DEFAULT 1,
  features JSON NOT NULL,
  position INT NOT NULL DEFAULT 0,
  active TINYINT(1) NOT NULL DEFAULT 1,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- Seed com o catálogo vigente (mesmos preços e regras do hard-code anterior).
-- features: cloud_sync = backup/sync em nuvem; web_app = Kivo Web (celular);
-- qr_order = cardápio online + pedido pela mesa (QR).
INSERT INTO plans (plan_key, label, description, price_cents, extends_days, max_devices, features, position, active) VALUES
  ('prata', 'Prata', 'PDV, estoque, financeiro e relatórios.', 15000, 30, 1,
   JSON_OBJECT('cloud_sync', false, 'web_app', false, 'qr_order', false), 1, 1),
  ('ouro', 'Ouro', 'Tudo do Prata + nuvem, backup e cardápio online.', 20000, 30, 3,
   JSON_OBJECT('cloud_sync', true, 'web_app', false, 'qr_order', false), 2, 1),
  ('diamante', 'Diamante', 'Operação completa + Kivo Web e mesas/cozinha.', 25000, 30, 10,
   JSON_OBJECT('cloud_sync', true, 'web_app', true, 'qr_order', true), 3, 1);

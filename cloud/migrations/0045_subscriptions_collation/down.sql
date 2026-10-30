-- 0045_subscriptions_collation: sem rollback automático — a collation anterior dependia do
-- servidor e voltar para ela reintroduziria a incompatibilidade. A 0044 derruba a tabela.
SELECT 1;

-- Down: volta a valer o hard-code de src/plans.ts (Prata/Ouro/Diamante) — os preços
-- configurados no painel ficam preservados em app_settings.plan_pricing, mas só a
-- promoção/selo do dia é aplicável de novo; o preço volta ao valor de tabela do código.
DROP TABLE IF EXISTS plans;

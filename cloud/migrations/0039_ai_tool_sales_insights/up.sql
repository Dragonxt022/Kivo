-- 0039_ai_tool_sales_insights — nova ferramenta de IA: "Insights de vendas".
--
-- A estrutura (ai_tools + company_ai_quotas) veio na 0038; aqui só entra a linha da ferramenta,
-- com o custo por uso e a cota diária padrão. O app manda o resumo das vendas do período, o
-- cloud injeta no prompt e devolve a análise.
--
-- Idempotente (INSERT ... ON DUPLICATE KEY UPDATE) para o retry do migrate continuar.

INSERT INTO ai_tools (id, label, description, cost, daily_credits, enabled)
VALUES ('sales_insights', 'Insights de vendas', 'Analisa as vendas do período e sugere ações práticas.', 1, 5, 1)
ON DUPLICATE KEY UPDATE id = id;

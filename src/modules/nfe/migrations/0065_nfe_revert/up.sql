-- 0065_nfe_revert — suporte à reversão de uma importação de NF-e ("desfazer").
--
-- A reversão devolve o estado anterior à nota: estoque, custo, produtos criados,
-- vínculos produto×fornecedor, fornecedor, compra e o próprio documento. Estas colunas
-- guardam o que é preciso para isso.

-- Compra comercial (commercial.purchases) gerada por esta importação. Sem isso, a
-- reversão teria de adivinhar a compra pelo texto de `notes`.
ALTER TABLE purchase_invoices ADD COLUMN purchase_id INTEGER;

-- 1 quando o fornecedor foi criado por ESTA importação — permite apagá-lo na reversão
-- sem risco de remover um fornecedor que já existia.
ALTER TABLE purchase_invoices ADD COLUMN supplier_created INTEGER NOT NULL DEFAULT 0;

-- Custo do produto ANTES da entrada da nota (para restaurar o custo médio no rollback).
-- NULL em notas importadas antes desta coluna — a reversão então não mexe no custo.
ALTER TABLE purchase_invoice_items ADD COLUMN prev_cost_cents INTEGER;

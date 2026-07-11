-- Contagem opcional de notas e moedas no fechamento do caixa: JSON { "centavos_da_denominacao": quantidade }.
-- NULL quando o operador não usa a contagem por denominação (só informa o total contado).
ALTER TABLE cash_registers ADD COLUMN count_breakdown TEXT;

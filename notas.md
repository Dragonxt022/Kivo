Resumo das alterações
1. BUG — CMV no DRE usava custo atual do produto (src/modules/dre/report.ts + store/sales.ts)
- Problema: dre/report.ts:64 fazia JOIN com products e usava p.cost_cents — se o custo do produto mudasse, o CMV de vendas passadas mudava retroativamente.
- Solução: 
- Nova migration 0034_store_sale_cost_cents → coluna cost_cents em sale_items
- store/sales.ts agora congela p.cost_cents no momento da venda
- dre/report.ts usa i.cost_cents da própria sale_items
2. RISCO — Contas sem categoria somem do DRE (src/modules/dre/report.ts)
- Problema: Payables sem dre_category_id eram excluídas do relatório.
- Solução: O DRE agora soma esses valores e os injeta na primeira categoria manual de despesas_operacionais (ou cria uma virtual "Sem categoria").
3. RISCO — original_amount_cents preservado (src/modules/finance/bills.ts)
- Problema: Na liquidação parcial, amount_cents era sobrescrito e o valor original se perdia.
- Solução: Nova migration 0035_finance_original_amount + código preserva original_amount_cents em payables/receivables (nunca alterado após criação).
4. RISCO 5 (pontos fidelidade) — Mantido como está
- O Math.round em store/sales.ts:206 já protege contra dízimas. É seguro.
5. Teste fase4 atualizado (src/tests/fase4.ts)
- Teste enviava {} para o endpoint settle, que agora exige payments[]. Corrigido com busca dinâmica dos métodos de pagamento.
Juros sobre juros
- Confirmado com você: mantém o comportamento atual (capitaliza)
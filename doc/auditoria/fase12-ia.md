# FASE 12 — Inteligência Artificial

## Escopo

Identificar lugares onde IA gera valor real para o Katsu, sem modismo.

---

## Oportunidades por Prioridade

### ALTA — OCR de Notas Fiscais
**Problema real:** Clientes do Katsu (comércio/restaurantes) digitam notas
fiscais manualmente para dar entrada em estoque.

**Solução:** Integrar OCR (Tesseract.js ou API Google Vision) para extrair
produtos, quantidades e valores de PDF/NFe XML. Reduz horas de trabalho
manual por semana.

**Esforço:** 20-40h para integração inicial.

### ALTA — Sugestão de Compras (Reposição)
**Problema real:** Donos de comércio não sabem quando comprar.

**Solução:** Com base no histórico de vendas e estoque atual, sugerir
quais produtos comprar e em qual quantidade. Regras simples primeiro
(ponto de pedido + lote econômico), ML depois.

**Esforço:** 16-24h para regras determinísticas.

### MÉDIA — Previsão Financeira
**Problema real:** Pequenos negócios têm fluxo de caixa imprevisível.

**Solução:** Usar contas a pagar/receber + histórico de vendas para
projetar saldo diário para os próximos 30-90 dias. Avisar se vai
ficar negativo.

**Esforço:** 12-20h (cálculos, não ML).

### MÉDIA — Classificação Automática de Produtos
**Problema real:** Categorizar centenas de produtos manualmente.

**Solução:** Sugerir categoria com base no nome do produto (similaridade
textual com categorias existentes). Não precisa de ML treinado — embedding
simples com TF-IDF ou similaridade de string.

**Esforço:** 8-12h.

### MÉDIA — Recomendação de Produtos (Cross-sell)
**Problema real:** Vendedores esquecem de sugerir itens complementares.

**Solução:** "Quem comprou X também comprou Y" baseado em histórico de
vendas. Regra de afinidade simples (contagem de co-ocorrências).

**Esforço:** 8-12h (não precisa de ML complexo).

### BAIXA — Chatbot Interno
**Problema real:** Funcionários têm dúvidas sobre o sistema.

**Solução:** Chatbot treinado na documentação do Katsu. Valor médio
— help desk humano ainda seria necessário.

**Esforço:** 16-24h (RAG simples com docs).

### BAIXA — Previsão de Vendas
**Problema real:** Interessante mas de baixo impacto prático imediato.

**Solução:** Séries temporais simples (média móvel, sazonalidade).
Pode ser implementada depois.

**Esforço:** 8-16h.

---

## Recomendação

Focar em **OCR de notas** e **sugestão de compras** primeiro — são os
problemas mais reais e dolorosos para o público-alvo do Katsu. O resto
pode vir em versões futuras.

**Abordagem sugerida:** Regras determinísticas primeiro, ML depois.
Não precisa de LLM caro — algoritmos clássicos resolvem a maioria
dos casos.

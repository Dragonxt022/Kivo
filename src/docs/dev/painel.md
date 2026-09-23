# Módulo Painel de Controle — Regras de Negócio

Visão geral (KPIs) e relatórios de estoque e de caixas, com exportação CSV. Módulo de
**sistema** (`alwaysEnabled`): nasce ativo em toda instalação e não depende do plano.

## Visão geral

O Painel é **somente leitura**: agrega o que os outros módulos já gravaram (produtos/estoque,
caixas, contas). Nada de escrita — quem altera continua nas telas de cada módulo.

## KPIs

- **Caixa**: se há caixa aberto, quando abriu e o valor esperado (via serviço `finance.cash`,
  para não reimplementar a regra).
- **Vendas**: hoje, ontem, mês atual e mês anterior (vendas concluídas, data local).
- **Estoque**: quantidade de produtos com saldo baixo e zerado.
- **Contas a receber e a pagar**: abertas, vencidas e a vencer em 7 dias (quantidade e valor).

## Relatórios

Relatórios de estoque e de caixas, exportáveis em CSV.

## Permissão

`overview.view` — concedida ao Administrador e ao Gerente.

## Arquivos-chave

- `src/modules/overview/data.ts` — consultas agregadas (somente leitura).

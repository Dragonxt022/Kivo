# Módulo DRE — Regras de Negócio

Demonstrativo de Resultado do Exercício, por categoria, com duas bases de apuração.

## Visão geral

O DRE agrega o que os outros módulos gravaram (vendas, CMV, devoluções, taxas de cartão,
contas a pagar) em cinco linhas, cada uma com categorias e um percentual de ajuste opcional.

## Linhas

`receita_bruta`, `deducoes`, `cmv`, `despesas_operacionais`, `despesas_financeiras`.

Os totais derivam das linhas: receita líquida (bruta - deduções), lucro bruto (líquida - CMV),
resultado operacional (lucro bruto - despesas operacionais) e resultado líquido (operacional -
despesas financeiras).

## Base de apuração

- **Competência** (`competencia`): pela data da venda/emissão. Receita = soma de `sales`
  concluídas; devoluções pela data da devolução.
- **Caixa** (`caixa`): pelo que efetivamente entrou/saiu. Receita = recebimentos imediatos
  (dinheiro, cartão, PIX) + contas a receber quitadas no período. Formas que não geram dinheiro
  imediato (prazo, convênio, crédito, fidelidade) entram quando o título é recebido.

## Categorias e fontes

Cada categoria tem uma **fonte**:

- `sales_revenue` — receita de vendas.
- `cogs` — CMV (custo das mercadorias).
- `card_fees` — taxas de cartão (dedução).
- `manual` — despesas lançadas em contas a pagar, vinculadas a uma categoria do DRE.

Devoluções reduzem a receita bruta e o CMV (linhas virtuais de devolução). Cada categoria pode
ter um `adjustment_bps` (ajuste percentual) para projeções — o relatório mostra o valor real e
o ajustado.

## Sincronização

`dre_categories` **sincroniza**: é configuração de negócio — todas as filiais/computadores da
empresa devem enxergar as mesmas categorias e ajustes.

## Permissões

- `dre.view` — ver o relatório.
- `dre.categories.edit` — cadastrar/editar categorias e ajustes.

## Arquivos-chave

- `src/modules/dre/report.ts` — apuração por linha e base.
- `src/modules/dre/setup.ts` — categorias padrão.

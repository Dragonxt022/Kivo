# Módulo Financeiro — Regras de Negócio

Caixa, contas a pagar/receber, formas de pagamento, convênios e conciliação. É a base de
dinheiro do sistema e alimenta o DRE e o Painel.

## Visão geral

O financeiro gira em torno do **caixa** (turno de operação) e dos **títulos** (contas a pagar
e a receber). As vendas passam por aqui para receber dinheiro, gerar recebíveis (prazo,
convênio) e registrar taxas. Nada é editado "no saldo": o caixa também é um livro-razão
(`cash_movements`).

## Caixa

- **Abrir** (`openRegister`): só pode existir **um** caixa aberto por vez. O fundo de troco
  entra como movimento `abertura` (entrada).
- **Movimentos** (`addMovement`): tipos `abertura`, `suprimento`, `sangria`, `venda`,
  `recebimento`, `pagamento`, cada um com direção `entrada` ou `saida`.
- **Valor esperado**: `expectedCents = entradas - saidas` dos movimentos do turno.
- **Fechar** (`closeRegister`): informa o valor contado; `difference = contado - esperado`.
  Aceita `count_breakdown` (contagem por cédula/moeda).
- **Editar caixa fechado** (`editClosedRegister`): só caixas com status `fechado`, exige a
  permissão `finance.cash.edit` e é auditado (correção do valor contado/observação).

O PDV exige caixa aberto para vender; vendas em dinheiro lançam `venda` (entrada) e
cancelamentos/devoluções em dinheiro lançam `pagamento` (saída).

## Contas a pagar e a receber

São tabelas simétricas (`payables` e `receivables`) com as mesmas regras.

- **Status**: `aberta`, `paga`/`recebida`, `cancelada`.
- **Quitação** (`settle`): exige a permissão de quitar (`finance.payables.pay` /
  `finance.receivables.receive`); grava data, valor quitado e a forma de pagamento usada.
- **Parcelamento**: títulos podem ter `installment_group_id`, `installment_no`,
  `installment_count`. A venda a prazo gera N parcelas em intervalos de 30 dias.
- **Aging**: as listagens mostram dias em atraso e faixas (a vencer, 1–30, 31–60, 61–90,
  acima de 90 dias).
- **Encargos de atraso** (`computeLateCharges`): multa (percentual, uma vez) + juros
  (percentual ao dia × dias de atraso), conforme configuração. Não se aplica a título futuro
  ou que vence hoje.
- **Anexos**: boletos/comprovantes ficam **só nesta máquina** (não sincronizam — um anexo
  sincronizado sem o arquivo viraria link morto).
- Contas a pagar podem ter categoria do DRE (`dre_category_id`).

## Formas de pagamento

- Cada forma tem um `type` (dinheiro, débito, crédito, pix, prazo, convênio, crédito de loja,
  fidelidade) e `fee_bps` (taxa da maquininha em basis points).
- **Não sincronizam**: são configuração por máquina/terminal (cada maquininha pode ter taxa
  própria). O que importa para o histórico é o que fica **congelado** em `sale_payments`
  (`method_name`, `method_type`, `fee_bps`).

## Convênios

- Uma venda paga por convênio gera uma **cobrança** pendente da empresa conveniada
  (`chargeAgreementRaw`).
- **Fatura** (`generateInvoice`): agrega as cobranças pendentes num recebível do período
  (`period_key` = AAAA-MM), com vencimento no `billing_day` da empresa. É **idempotente por
  período**: não gera duas faturas para o mesmo mês.
- O agendador (`agreementScheduler`) identifica empresas que já passaram do dia de
  faturamento e têm cobrança pendente.

## Conciliação

Relatório de saldos de crédito de loja/fidelidade que ficaram **negativos após a
sincronização** — sintoma de resgate feito em duas máquinas offline. Serve para o lojista
ajustar. Permissão `finance.reconciliation.view`.

## Configurações

| Chave | Efeito |
| --- | --- |
| `financeiro.multa_atraso.ativa` / `.percentual` | Multa por atraso |
| `financeiro.juros_atraso.ativo` / `.percentual_dia` | Juros por dia de atraso |
| `caixa.lembrete_24h` | Lembrete de caixa aberto há mais de 24h |

## Endpoints principais

| Método e rota | Função |
| --- | --- |
| `POST /api/finance/cash/open` | Abre o caixa |
| `POST /api/finance/cash/close` | Fecha o caixa |
| `POST /api/finance/cash/movement` | Suprimento/sangria |
| `GET/POST/PUT /api/finance/payables` e `/receivables` | Contas |
| `POST /api/finance/payables/:id/pay` e `/receivables/:id/receive` | Quitar |
| `GET/POST /api/finance/payment-methods` | Formas de pagamento |
| `POST /api/finance/agreements/:id/invoice` | Gerar fatura de convênio |

## Erros comuns e diagnóstico

- "Já existe um caixa aberto." — feche o turno atual antes de abrir outro.
- "Nenhum caixa aberto." — a venda/troca depende de caixa aberto.
- "Já existe fatura gerada para o período." — a fatura do mês já foi emitida.
- Encargos não aparecem — multa/juros desligados em Configurações › Financeiro.

## Arquivos-chave

- `src/modules/finance/cash.ts` — abertura, fechamento e movimentos.
- `src/modules/finance/bills.ts` — contas a pagar/receber, aging e quitação.
- `src/modules/finance/lateFees.ts` — multa e juros.
- `src/modules/finance/agreements.ts` — convênios e faturas.
- `src/modules/finance/setup.ts` — serviços expostos ao Core (caixa, recebíveis, formas).

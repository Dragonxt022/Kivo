# Documentação Técnica — Índice

Regras de negócio por módulo, para suporte e treinamento de agentes de IA. É a versão técnica
(administrador), separada da wiki do cliente.

## Como usar

- Cada documento descreve **um módulo**: visão geral, entidades, regras, integrações,
  sincronização, permissões, endpoints, erros comuns e arquivos-chave.
- O conteúdo vive em `src/docs/dev/*.md` (Markdown), versionado no repositório — legível
  tanto aqui quanto direto no código.
- Acesso restrito: permissão `dev.docs.view` (por padrão, só o Administrador).

## Módulos

| Documento | Assunto |
| --- | --- |
| [Estoque](/admin/documentacao?doc=estoque) | Produtos, saldo/ledger, lotes, FIFO, validade, custo/CMV, compras, NF-e |
| [Vendas / PDV](/admin/documentacao?doc=vendas) | Venda, pagamentos, cancelamento, devolução, orçamentos |
| [Financeiro](/admin/documentacao?doc=financeiro) | Caixa, contas a pagar/receber, formas de pagamento, convênios |
| [Fiscal](/admin/documentacao?doc=fiscal) | NFC-e, certificado, prontidão, emissão e cancelamento |
| [Comercial](/admin/documentacao?doc=comercial) | Clientes, fornecedores, categorias, listas de preço |
| [Comandas](/admin/documentacao?doc=comandas) | Mesas e comandas |
| [Food Service](/admin/documentacao?doc=foodservice) | Cozinha (KDS) e roteamento de produção |
| [Etiquetas](/admin/documentacao?doc=etiquetas) | Gerador de etiquetas de produto |
| [DRE](/admin/documentacao?doc=dre) | Demonstrativo de resultado |
| [Painel](/admin/documentacao?doc=painel) | Painel de controle (KPIs) |
| [NF-e](/admin/documentacao?doc=nfe) | Importação de NF-e de compra |

## Arquitetura e dependências

O Core não conhece os módulos: cada um se registra por manifesto (`module.manifest.ts`) e
expõe serviços pelo registry. Um módulo só usa outro via serviço registrado ou repositório
compartilhado.

```
core
 ├─ commercial ── nfe
 │             └─ labels
 ├─ finance
 ├─ store            (depende de commercial + finance)
 │    └─ fiscal      (depende de commercial + store)
 ├─ comandas         (usa commercial + store + foodservice)
 ├─ foodservice
 ├─ dre
 └─ overview         (lê commercial + finance + store + dre; sempre ativo)
```

Fluxo de dados do dia a dia:

```
compra / NF-e  ─►  estoque (ledger + lotes)  ─►  venda  ─►  caixa
                         ▲                          │
                    custo/CMV                       ▼
                         └──────────────  DRE / Painel
```

## Conceitos que atravessam os módulos

- **Ledger**: saldo de estoque e de caixa são derivados de movimentações append-only, nunca
  editados direto. `stock_qty` não sincroniza — é recalculado.
- **Retrocompatibilidade**: mudanças são aditivas; comportamento novo entra por configuração
  com padrão que preserva o que já existia.
- **Recursos (capabilities)**: módulos/funcionalidades opcionais nascem desligados e são
  ativados em Configurações › Recursos.
- **Segredos**: chaves sensíveis ficam no cofre (`core/secrets`), nunca na tabela `settings`.
- **Sincronização**: tabelas declaram `syncTables`; FKs viram UUIDs; conflitos por
  last-write-wins com auditoria. Tabelas derivadas/config locais ficam de fora.

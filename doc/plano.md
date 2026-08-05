Estou em modo de planejamento (somente leitura) — não posso gravar arquivos agora. Segue o conteúdo completo do documento que será salvo em doc/plano-ordem-servico.md assim que você aprovar a saída do modo plano:
# Kivo — Plano: Módulo Ordem de Serviço (serviceorder)

> **Status:** aprovado para implementação
> **Segmentos:** oficinas de carro e moto, assistência técnica de celular, lavajato,
> barbearia, manicure e clínicas veterinárias.
> **Padrão:** Controller → Service → Repository (KIVO_PLANO.md §3), manifesto de módulo (§4),
> preço em centavos (INTEGER), toda tabela com `comment`.

## 1. Decisões de design (validadas)

| Decisão | Escolha |
|---|---|
| Fechamento financeiro | Concluir OS gera venda via `store.sales.createSale` (padrão `closeComanda`) |
| Objeto do serviço | Campos estruturados na OS (tipo, placa, marca, modelo, ano, cor, serial, detalhes) |
| Visibilidade | Sem capability gate — sempre visível por entitlement (como Loja/Food Service) |
| Fluxo de status | Completo: aberta → em_andamento → aguardando_peca/aguardando_cliente → concluida → entregue; cancelada com motivo; itens: pendente → em_andamento → concluido |
| Onboarding | Novo tipo de negócio `servicos` com produtos de exemplo |

## 2. Estrutura de arquivos

src/modules/serviceorder/
├── module.manifest.ts
├── routes.ts                     # API /api/serviceorder
├── pages.ts                      # Páginas /app/serviceorder/os...
├── setup.ts                      # registerService('serviceorder.orders', ...)
├── orders.ts                     # Regras de negócio (service layer)
├── controllers/ServiceOrderController.ts
├── repositories/ServiceOrderRepository.ts
├── migrations/0058_serviceorder_base/up.sql + down.sql
└── views/
    ├── serviceorder-orders.ejs   # Lista + dialog novo/editar
    ├── serviceorder-detalhe.ejs  # Detalhe com board de itens e ações
    └── serviceorder-print.ejs    # Impressão da OS
src/public/icons/wrench.svg                 # Novo ícone do menu
src/core/onboarding/service.ts              # businessType 'servicos' + produtos demo
src/core/onboarding/controller.ts           # Validação do novo businessType
src/views/partials/onboarding.ejs           # Novo card de escolha + resumo
cloud/src/views/partials/module-toggles.ejs # KNOWN_MODULES + serviceorder
src/tests/fase_serviceorder.ts              # Testes de integração
scripts/commands.json                       # Comando test:serviceorder
scripts/kivo.js                             # Lista de Testes
doc/plano-ordem-servico.md                  # Este documento

## 3. Migration `0058_serviceorder_base`

### `service_orders`
- `customer_id` FK `customers` (nullable) + `customer_name` (cliente avulso)
- `status` CHECK: aberta | em_andamento | aguardando_peca | aguardando_cliente | concluida | entregue | cancelada (default `aberta`)
- `priority` CHECK: normal | urgente (default `normal`)
- Objeto: `object_type` CHECK (veiculo | moto | celular | eletronico | pet | outro),
  `object_brand`, `object_model`, `object_year`, `object_color`, `object_plate`
  (busca por placa), `object_serial` (IMEI/registro), `object_details`
- `reported_issue` (relato do cliente), `technician` (texto livre), `promise_at`
  (previsão de entrega), `warranty`
- `subtotal_cents`, `discount_cents`, `surcharge_cents`, `total_cents`
- `sale_id` FK `sales` (preenchido na conclusão)
- `opened_by`/`closed_by`/`canceled_by` FK `users`; `opened_at`, `closed_at`,
  `delivered_at`, `canceled_at`, `cancel_reason`
- Colunas de contrato: `uuid`, `updated_at`, `deleted_at`, `synced_at`, `origin_machine`, `comment`

### `service_order_items`
- `service_order_id` FK `service_orders` (CASCADE)
- `product_id` FK `products`, `item_type` (servico | produto — snapshot),
  `product_name`, `qty`, `unit_price_cents`, `total_cents`
- `status` CHECK: pendente | em_andamento | concluido (default `pendente`), `notes`
- Índices: `idx_so_status`, `idx_so_customer`, `idx_so_items_order`

## 4. Manifesto (`module.manifest.ts`)

- `id: 'serviceorder'`, name `Ordem de Serviço (prestação de serviços)`, version `1.0.0`
- `dependsOn: ['commercial', 'finance', 'store']`
- Permissões (concedidas ao Administrador): `serviceorder.view`, `serviceorder.create`,
  `serviceorder.edit`, `serviceorder.status.manage`, `serviceorder.conclude`
- Menu: `Ordens de Serviço` → `/app/serviceorder/os`, ícone `wrench`
- `syncTables`:
  - `service_orders` (FKs `customer_id`→customers, `sale_id`→sales; exclui `opened_by`/`closed_by`/`canceled_by`)
  - children `service_order_items` (parentColumn `service_order_id`, FK `product_id`→products)

## 5. Regras de negócio (`orders.ts`)

- `createOrder`: cliente cadastrado OU avulso; objeto validado por tipo; status inicial `aberta`
- `updateOrder`: bloqueado após `concluida`; recalcula totais quando desconto/acréscimo muda
- `addItem`: OS precisa estar aberta; preço via `commercial.pricing.resolvePrice`
  (override com permissão `serviceorder.edit`); recalcula subtotal/total
- `updateItem`/`removeItem` (soft delete): só em OS aberta
- `advanceItemStatus`: pendente → em_andamento → concluido (guard: OS não cancelada)
- `advanceOrderStatus`/`setStatus` com transições validadas:
  aberta → em_andamento | aguardando_peca | aguardando_cliente | cancelada
  em_andamento → aguardando_peca | aguardando_cliente | concluida | cancelada
  aguardando_* → em_andamento | cancelada
  concluida → entregue (final); entregue e cancelada terminais
- `conclude`: exige ≥1 item; chama `store.sales.createSale` dentro de transação
  (padrão `closeComanda`, `allowPriceOverride: true`) com itens da OS; grava
  `sale_id`, `closed_at`; paga com dinheiro/cartão/pix/prazo/fidelidade/convênio
  (caixa, recebíveis, estoque de peças já cobertos pelo motor de vendas)
- `deliver`: exige `concluida`; grava `delivered_at`
- `cancel`: exige OS não concluída/entregue/cancelada; grava motivo
- Auditoria `audit()` em todas as ações

## 6. API (`/api/serviceorder`) e páginas

- API (todas com `requirePermission`):
  `GET /orders?status=&q=` · `GET /orders/:id` · `POST /orders` · `PUT /orders/:id` ·
  `POST /orders/:id/items` · `PUT /orders/:id/items/:itemId` ·
  `DELETE /orders/:id/items/:itemId` · `PUT /orders/:id/items/:itemId/status` ·
  `PUT /orders/:id/status` · `POST /orders/:id/conclude` · `POST /orders/:id/deliver` ·
  `POST /orders/:id/cancel`
- Páginas EJS + Alpine.js (padrão `store-quotes.ejs`): lista com filtro de status e busca
  (cliente/placa/nº); dialog de criação com objeto estruturado e seletor de itens
  (produtos + `product_type='servico'`); detalhe com board de itens (avançar status),
  dialog de pagamento (métodos de `finance.paymethods`), imprimir
- Impressão `serviceorder-print.ejs` (dados da empresa via `settingsRepository`, padrão `store-quote-print`)

## 7. Onboarding (`servicos`)

- `service.ts`: `OnboardingBusinessType` += `'servicos'`; nova
  `createServicosDemoProducts()` com categorias `Serviços` e `Peças e insumos`:
  - Serviços (`product_type: 'servico'`, track_stock 0): Troca de óleo (R$ 120),
    Revisão básica (R$ 250), Corte de cabelo (R$ 40), Banho & tosa (R$ 60),
    Manutenção de celular (R$ 80)
  - Produtos físicos (peças): Filtro de óleo, Óleo 1L, Lâmina/Reposição
  - `provision()` ganha o branch `else if (businessType === 'servicos')`
- `controller.ts`: `BUSINESS_TYPE_VALUES` += `'servicos'`
- `onboarding.ejs`: novo choice-card "Prestação de serviços / Oficina" e item de resumo
  ("Serviços e peças de exemplo prontos para Ordem de Serviço")

## 8. Nuvem (painel admin)

- `cloud/src/views/partials/module-toggles.ejs`: `KNOWN_MODULES` +=
  `{ id: 'serviceorder', label: 'Ordem de Serviço (prestação de serviços)' }`

## 9. Testes (`fase_serviceorder.ts` — padrão `fase_fiscal.ts`)

1. Migration cria tabelas/colunas/índices
2. Permissões registradas e concedidas ao admin
3. Menu aparece para admin com entitlement (home contém `/app/serviceorder/os`)
4. Criar OS (objeto estruturado) + validações (400) + edição bloqueada após concluída
5. Adicionar item serviço/produto; recálculo de totais; override de preço com permissão
6. Fluxo de item pendente → em_andamento → concluido
7. Transições de status válidas/inválidas; cancelar com motivo
8. Concluir → venda criada (`sale_id` vinculado, status `concluida`), pagamento em
   dinheiro movimenta caixa, peça baixa estoque
9. Entregar (guard antes de concluir → 400)
10. Impressão renderiza 200
- Registrar `test:serviceorder` em `scripts/commands.json` e na lista Testes de `scripts/kivo.js`
  (o `test:all` descobre `fase_serviceorder.ts` automaticamente)

## 10. Verificação final

npm run lint
npx tsc -p tsconfig.json --noEmit
tsx src/tests/fase_serviceorder.ts

## 11. Fora do escopo (v2 candidato)

- Catálogo de técnicos/colaboradores (v1 usa texto livre)
- Várias OS por objeto / histórico do objeto (v1: 1 objeto por OS)
- Lembrete de revisão preventiva / retorno de garantia
Aprovando a saída do modo plano, eu salvo este documento em doc/plano-ordem-servico.md e começo a implementação na ordem: migration → manifest → service → rotas → páginas → onboarding → cloud → testes. Posso prosseguir?
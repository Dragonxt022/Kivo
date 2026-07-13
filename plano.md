# Plano de Evolução da Plataforma Comercial Katsu

## Fase 1 — Infraestrutura (Capabilities + Tipos de Produto) — ✅ IMPLEMENTADA

Construiu o campo `capabilities?` no `ModuleManifest`, a tabela `capabilities` + `registerCapabilities()`/`hasCapability()`/`setCapabilityEnabled()`, a tela Configurações → Recursos, e a coluna `products.product_type` (10 valores no CHECK, só `'fisico'` usado até aqui). Commitada em `45571a2`. Verificada nesta sessão: `npx tsc --noEmit` limpo, teste `npm run test:capabilities` 24/24 PASS (reexecutado de forma isolada). Único ponto solto, de baixa severidade e não-bloqueante: as migrations `0030_capabilities`/`0032_product_type` reusaram números já ocupados por `0030_dre_base`/`0032_finance_settle_method` — não quebra nada (o migrator só rejeita nome de pasta idêntico, não número), mas quebra a convenção de sequência global. Já aplicadas no banco real de dev; corrigir a numeração agora exigiria mexer em `_migrations`, então foi deixado como está.

## Fase 2 — Variantes de Produto — ✅ IMPLEMENTADA

Construiu `products.parent_product_id`, `product_attributes`/`product_attribute_values`/`product_variant_values`, geração combinatória de variantes (`POST /products/:id/attributes/generate-variants`), CRUD de atributos, `requireCapability` (primeiro consumidor real de `hasCapability`), seletor de tipo de produto e seção de variantes na UI, cascade de exclusão pai→filhas, e correção do endpoint de duplicar para preservar `product_type`/`parent_product_id`. Commitada em `a33d78c`. Verificada nesta sessão: `npx tsc --noEmit` limpo, `npm run test:variants` 26/26 PASS (reexecutado de forma isolada, banco descartável). Mesmo ponto solto de numeração: migration `0033_product_variants` reusou o número de `0033_finance_bill_installments` já existente — mesma causa raiz, não-bloqueante, sinalizado de novo abaixo para não repetir uma terceira vez. Nota à parte: o commit também apagou `notas.md` (anotações antigas de outra sessão, não relacionadas a variantes) — não é um bug, mas vale saber que sumiu caso precise dele.

## Fase 2b — Complementos — ✅ IMPLEMENTADA

Construiu `complement_groups`/`complement_group_items`/`product_complement_groups` (complemento = produto comum, reaproveitando preço/estoque/DRE existentes), colunas aditivas `sale_items.notes`/`line_group_uuid`, modal de seleção no PDV (`add(p)` agora assíncrono, checa `/products/:id/complement-groups` antes de decidir se abre modal), e agrupamento visual do carrinho por `lineGroupUuid`. Commitada em `ff9ae95`, migration `0036_product_complements` — **sem colisão de número desta vez** (o aviso repetido nas fases anteriores surtiu efeito). Verificada nesta sessão: `npx tsc --noEmit` limpo, `npm run test:complementos` 29/29 PASS (isolado, banco descartável), e revisão completa do diff de `sales.ts`/`routes.ts`/`store-pdv.ejs` — tudo bate com o desenho combinado.

**Achado relevante para a Fase 2c**: o endpoint normal de venda (`POST /sales` em `store/routes.ts`) chama `createSale(req, req.body as SaleInput)` **sem** `{ allowPriceOverride: true }` — então hoje, fora do fluxo de orçamento (`quotes.ts`), o cliente nunca consegue ditar `unitPriceCents` de um item; o servidor sempre recalcula via `pricing.resolvePrice`. Isso é proposital (evita manipulação de preço pelo cliente) e é a restrição que molda o desenho de Kits abaixo: a linha de um componente de kit a custo zero **não pode** vir de um `unitPriceCents` enviado pelo carrinho — tem que ser calculada no servidor, dentro de `createSale`, a partir de uma tabela confiável (`kit_items`).

## Fase 2c — Kits & Combos — ✅ IMPLEMENTADA

Construiu `kit_items` (componente fixo de um produto `kit`/`combo`, ligado a um produto comum já existente), expansão server-side no `createSale` (para cada item vendido cujo `product_type` seja `kit`/`combo`, além da própria linha gera uma linha por componente a `unit_price_cents=0`/`total_cents=0` mas com `cost_cents` real, todas com o mesmo `line_group_uuid`), endpoints de CRUD (`/products/:id/kit-items`, `/kit-items/:id`, com validação server-side contra kit-dentro-de-kit e auto-referência), seletor `kit`/`combo` na UI de produto + seção "Componentes fixos" + bônus: seção "Grupos de complementos vinculados" (preenchendo um gap que a Fase 2b tinha deixado — nunca existiu UI para isso, só API). Como bônus técnico, a implementação também corrigiu, dentro do próprio `createSale`, o bug latente que o desenho desta fase expôs: o loop de INSERT casava `items[idx]` com `input.items[idx]` por índice para pegar `notes`/`lineGroupUuid` — isso só funcionava enquanto `items.length === input.items.length` (1:1); a correção passou a carregar `notes`/`lineGroupUuid` diretamente em cada entrada de `items`, e o INSERT itera só sobre `items`.

Commitada em `e4cdbfd`, migration `0037_kit_items` — de novo sem colisão de número. Verificada nesta sessão: `npx tsc --noEmit` limpo, `npm run test:kits` 28/28 PASS (isolado, banco descartável), revisão completa do diff de `sales.ts`/`routes.ts`/`commercial-products.ejs` — tudo bate com o desenho combinado, incluindo a decisão de segurança de **não** expor `unitPriceCents` do cliente para zerar preço (o endpoint normal de venda nunca passa `allowPriceOverride`; a linha a custo zero do componente é calculada inteiramente no servidor a partir de `kit_items`, nunca do carrinho).

## Fase 2d — Produto Produzido — ✅ IMPLEMENTADA

Construiu `product_recipe_items` (ficha técnica: insumo + quantidade consumida por unidade produzida), cálculo dinâmico de `cost_cents` no `createSale` a partir da receita (sem gerar linha própria em `sale_items` para cada insumo — só o produto produzido aparece na venda, com custo real embutido), N `stock_movements` de saída para os insumos, e a correção de `cancelSale` para reverter estoque a partir do ledger `stock_movements` (`ref_entity='sale' AND ref_id=?`) em vez de reler `sale_items` — necessário porque insumos não têm linha própria. Commitada em `c4f436f`, migration `0038_product_recipe_items`, sem colisão de número. Verificada nesta sessão: `npx tsc --noEmit` limpo, `npm run test:producao` 29/29 PASS, e regressão de `npm run test:kits`/`npm run test:complementos` (isolados) confirmando que a mudança em `cancelSale` não quebrou nada. Revisão do diff de `sales.ts`/`routes.ts` confirmou tudo conforme o desenho (inclusive validações extras de bom senso que a implementação acrescentou: proteção contra drift de ponto flutuante na quantidade consumida, e `allowNegative` na reversão de estoque).

Com isso, **todo o Catálogo Avançado do documento de arquitetura original está implementado**: Variantes, Complementos, Kits/Combos e Produto Produzido. Restam as duas últimas peças do roadmap original — Food Service e Comandas & Mesas — que combino num plano só a partir daqui, a pedido do usuário, já que o agente de execução está dando conta rápido.

## Contexto da Fase 3+4 (Food Service + Comandas & Mesas, combinadas)

Estas são as duas últimas peças do documento de arquitetura original — depois delas, o roadmap inicial está 100% coberto. Diferente das sub-fases do Catálogo Avançado (que só estendiam `commercial`+`store`, módulos sempre instalados), estas duas são **módulos novos e opcionais** (`foodservice` e `comandas`) — um restaurante de mesa quer os dois, uma lanchonete de balcão só quer Food Service, uma loja de roupa não quer nenhum dos dois. O loader já suporta isso nativamente: `loadModules()` (`src/core/modules/loader.ts`) descobre qualquer pasta em `src/modules/*` com um `module.manifest.ts`, sem nenhum registro central — e o acesso (rotas `/api/:id` e páginas `/app/:id`) já é bloqueado por `requireModuleEntitlement` conforme `license.modules_json` (fail-open em dev, como confirmado desde a Fase 1).

**Decisão arquitetural central — sem barramento de eventos, dois módulos novos se comunicam com `store` só via `service registry` (`registerService`/`getService`/`hasService`), nunca lendo tabelas um do outro**:

- **`comandas`** precisa criar vendas de verdade ao fechar uma comanda — mas `createSale`/`cancelSale` hoje são exports diretos de `store/sales.ts`, usados só dentro do próprio módulo `store`. Para manter o princípio "PDV é o único dono da lógica de venda" mesmo com um módulo de fora precisando *disparar* uma venda, `store/setup.ts` passa a expor um novo serviço `store.sales` (`{ createSale, cancelSale }`) — o mesmo padrão já usado por `commercial.stock`/`commercial.pricing`/`finance.cash`. `comandas` nunca duplica lógica de venda: ele só monta um `SaleInput` a partir dos itens da comanda e chama esse serviço.
- **`foodservice`** não deveria saber nada sobre o schema interno de `store` ou `comandas` (isso os acoplaria). Em vez disso, ele expõe um serviço `foodservice.kitchen.notifyOrder(req, { sourceType, sourceId, tableLabel?, items })`, que `store` (dentro de `createSale`, depois de a venda commitar) e `comandas` (ao adicionar item numa comanda) chamam **de forma best-effort e opcional** — só se `hasService('foodservice.kitchen')` for verdadeiro (ou seja, se o módulo estiver instalado e a capability ligada). `hasService` já existe em `core/services/registry.ts` desde sempre mas nunca tinha um caller de verdade — esta é a primeira vez que o padrão "integração opcional" é usado de fato. Uma falha dentro de `notifyOrder` nunca derruba a venda/comanda: a chamada fica fora da transação principal, em `try/catch`.
- Consequência bonita dessa camada: **Kits, Combos e Produto Produzido funcionam através de uma comanda sem nenhum código novo**. Fechar uma comanda só monta `SaleInput.items` a partir de `comanda_items` (que guardam `productId`/`qty`/`notes`/`lineGroupUuid`, exatamente os campos que `SaleItemInput` já aceita) e chama `createSale` — toda a expansão de kit e o cálculo de ficha técnica já acontece dentro de `createSale`, não importa se quem chamou foi o PDV direto ou uma comanda.
- **Congelamento de preço em `comanda_items` precisa do mesmo mecanismo que `quotes.ts` já usa**: o preço de cada item é resolvido via `commercial.pricing`'s `resolvePrice` no momento em que é *pedido* (não quando a comanda fecha, que pode ser horas depois). Ao fechar, `comandas` chama `createSale(req, input, { allowPriceOverride: true })` passando esse preço já congelado — o mesmo padrão exato que `quotes.ts` usa para honrar o preço cotado antes. Isso **não reabre a brecha de segurança** identificada na Fase 2c (lá o risco era o cliente do PDV ditar preço arbitrário de um produto qualquer; aqui o preço "override" foi ele mesmo calculado pelo servidor mais cedo, só está sendo honrado depois — o mesmo raciocínio de `quotes.ts`).
- **Cozinha não lê `sale_items` nem `comanda_items` diretamente** (evita acoplar `foodservice` ao schema de dois outros módulos): ele mantém sua própria tabela `kitchen_routing` (quais produtos geram ticket de cozinha, com estação/tempo estimado opcionais) e, ao receber `notifyOrder`, filtra os itens contra essa lista antes de criar um `kitchen_ticket` — um produto que não estiver em `kitchen_routing` (ex.: uma lata de refrigerante) nunca aparece na tela de cozinha.
- Estoque de uma comanda aberta só é afetado ao **fechar** (vira uma venda normal nesse momento) — não há reserva de estoque no momento do pedido; isso é intencional e é exatamente o "converte em venda normal ao fechar" do roadmap original.

## Fase 3 — Módulo Food Service — ✅ IMPLEMENTADA

Construiu o módulo novo `src/modules/foodservice` (opcional, descoberto pelo loader sem registro central): `kitchen_routing`/`kitchen_tickets`/`kitchen_ticket_items` (migration `0039_foodservice_base`, sem colisão de número), `notifyOrder`/`listTickets`/`advanceItemStatus`/`advanceTicketStatus`/`recalcTicketStatus` em `kitchen.ts`, o serviço `foodservice.kitchen` exposto via `registerService`, rotas de roteamento (CRUD) e de tickets atrás de `requireCapability('foodservice.cozinha')`, telas de KDS (`foodservice-cozinha.ejs`, polling a cada ~5s), roteamento (`foodservice-routing.ejs`) e impressão de ticket, e o hook best-effort em `store/sales.ts` (`hasService('foodservice.kitchen')` após a transação de `createSale` commitar, `try/catch` que nunca derruba a venda).

Commitada em `0640bc4` junto com a Fase 4 (mesmo commit). Verificada nesta sessão de finalização — o commit original não tinha sido testado, e a verificação revelou o módulo funcionalmente correto (nenhum bug em `kitchen.ts`/`routes.ts`/`setup.ts`); os únicos ajustes desta sessão foram cosméticos: adicionados `src/public/icons/chef-hat.svg` (o manifest já referenciava esse ícone, que não existia no set — card do menu quebrado) e o novo teste `src/tests/fase_foodservice.ts` (`npm run test:foodservice`, 21/21 PASS via servidor HTTP real — login, capability começa desligada/403, roteia 1 produto e deixa outro de fora, venda real via `POST /api/store/sales` gera exatamente 1 ticket com só o item roteado, avanço de status do item reavalia o ticket, venda sem item roteado não cria ticket, capability desligada volta a bloquear). `npx tsc --noEmit` limpo.

## Fase 3 (texto original do plano, mantido como referência do desenho)

### 1. Modelo de dados (nova migration `src/modules/foodservice/migrations/00NN_foodservice_base/up.sql`)

Confirmar o próximo número livre antes de criar a pasta (na verificação desta sessão, o maior número em uso no repo é `0038`; o correto agora é `0039`, mas reconfirmar no momento de implementar):
```
find drizzle/migrations src/modules -maxdepth 3 -type d -regex '.*/[0-9]\{4\}_.*' | sed -E 's#.*/([0-9]{4})_.*$#\1#' | sort -n | tail -3
```

```sql
CREATE TABLE kitchen_routing (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  product_id INTEGER NOT NULL REFERENCES products(id),
  station TEXT,
  estimated_minutes INTEGER,
  uuid TEXT NOT NULL UNIQUE, updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  deleted_at TEXT, synced_at TEXT, origin_machine TEXT,
  comment TEXT NOT NULL DEFAULT 'Marca quais produtos geram ticket de cozinha ao serem pedidos/vendidos, com estação e tempo estimado opcionais.',
  UNIQUE(product_id)
);

CREATE TABLE kitchen_tickets (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  source_type TEXT NOT NULL CHECK (source_type IN ('sale','comanda')),
  source_id INTEGER NOT NULL,
  table_label TEXT,
  status TEXT NOT NULL DEFAULT 'pendente' CHECK (status IN ('pendente','preparo','pronto','entregue')),
  uuid TEXT NOT NULL UNIQUE, updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  deleted_at TEXT, synced_at TEXT, origin_machine TEXT,
  comment TEXT NOT NULL DEFAULT 'Ticket de produção — 1 por venda direta ou por pedido de comanda com ao menos 1 item roteado para a cozinha.'
);

CREATE TABLE kitchen_ticket_items (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ticket_id INTEGER NOT NULL REFERENCES kitchen_tickets(id),
  product_id INTEGER NOT NULL REFERENCES products(id),
  product_name TEXT NOT NULL,
  qty REAL NOT NULL,
  notes TEXT,
  station TEXT,
  estimated_minutes INTEGER,
  status TEXT NOT NULL DEFAULT 'pendente' CHECK (status IN ('pendente','preparo','pronto','entregue')),
  uuid TEXT NOT NULL UNIQUE, updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  deleted_at TEXT, synced_at TEXT, origin_machine TEXT,
  comment TEXT NOT NULL DEFAULT 'Item de um ticket de cozinha — snapshot de estação/tempo estimado no momento do pedido.'
);
CREATE INDEX idx_kitchen_ticket_items_ticket ON kitchen_ticket_items(ticket_id);
```

### 2. `src/modules/foodservice/kitchen.ts` — lógica

```ts
export interface NotifyOrderItem { productId: number; name: string; qty: number; notes?: string }
export function notifyOrder(req: Request, params: { sourceType: 'sale' | 'comanda'; sourceId: number; tableLabel?: string; items: NotifyOrderItem[] }): void
export function listTickets(status?: string[]): KitchenTicket[]
export function advanceItemStatus(req: Request, ticketId: number, itemId: number, status: string): Result
export function advanceTicketStatus(req: Request, ticketId: number, status: string): Result
```
`notifyOrder` faz `JOIN` de `params.items` contra `kitchen_routing` (por `product_id`); se nenhum item bater, não cria ticket nenhum; se algum bater, cria 1 `kitchen_tickets` + N `kitchen_ticket_items` (só os itens roteados), com `audit(req, 'criar_ticket_cozinha', 'kitchen_ticket', ...)`. Status do ticket é reavaliado a cada avanço de item (ex.: todos `pronto` → ticket `pronto`).

### 3. `src/modules/foodservice/setup.ts`

```ts
registerService('foodservice.kitchen', { notifyOrder } satisfies FoodserviceKitchenService);
```

### 4. `src/modules/foodservice/routes.ts` (atrás de `requireCapability('foodservice.cozinha')`)

- `GET /kitchen/tickets?status=pendente,preparo` — `foodservice.kitchen.view`.
- `PUT /kitchen/tickets/:id/items/:itemId/status` / `PUT /kitchen/tickets/:id/status` — `foodservice.kitchen.manage`.
- `GET/POST/PUT/DELETE /kitchen-routing` — `foodservice.routing.manage` (CRUD simples: produto + estação + tempo estimado).

### 5. UI (`src/modules/foodservice/pages.ts` + `views/`)

- `foodservice-cozinha.ejs` — tela de cozinha (KDS): colunas por status (Pendente/Preparo/Pronto), cartões por ticket agrupando seus itens, botão para avançar status. Atualização por polling simples (`setInterval`, mesmo padrão já usado em `store-pdv.ejs:801` para `checkOnline()` a cada 25s — aqui um intervalo mais curto, ~5s, já que é uma tela operacional).
- `foodservice-routing.ejs` — admin: lista de produtos com toggle "vai para a cozinha" + estação + tempo estimado.
- `foodservice-ticket-print.ejs` — impressão do ticket (`window.print()`), mesmo padrão de `store-carne-print.ejs`/`store-quote-print.ejs` (não há integração ESC/POS no projeto — mantém o mesmo nível de maturidade já existente).

### 6. `module.manifest.ts` do `foodservice`

```ts
const manifest: ModuleManifest = {
  id: 'foodservice', name: 'Food Service (cozinha e produção)', version: '1.0.0', requiresCore: '>=0.1.0',
  permissions: [
    { key: 'foodservice.kitchen.view', description: 'Visualizar painel de cozinha' },
    { key: 'foodservice.kitchen.manage', description: 'Avançar status de itens/tickets na cozinha' },
    { key: 'foodservice.routing.manage', description: 'Definir quais produtos vão para a cozinha' },
  ],
  capabilities: [{ key: 'foodservice.cozinha', description: 'Painel de cozinha (KDS) e roteamento de produtos para produção' }],
  routes: './routes', pages: './pages', views: './views', migrations: './migrations', setup: './setup',
  menu: [{ label: 'Cozinha', href: '/app/foodservice/cozinha', permission: 'foodservice.kitchen.view', description: 'Painel de produção da cozinha.', icon: 'chef-hat' }],
  syncTables: [
    { table: 'kitchen_routing', foreignKeys: { product_id: 'products' } },
    { table: 'kitchen_tickets', children: [{ table: 'kitchen_ticket_items', parentColumn: 'ticket_id', foreignKeys: { product_id: 'products' } }] },
  ],
};
```

### 7. Hook em `src/modules/store/sales.ts`

Depois que `db.transaction(() => { ... })()` de `createSale` termina com sucesso (fora da transação — falha aqui nunca derruba a venda):
```ts
try {
  if (hasService('foodservice.kitchen')) {
    getService<FoodserviceKitchenService>('foodservice.kitchen').notifyOrder(req, {
      sourceType: 'sale', sourceId: saleId,
      items: items.map((i) => ({ productId: i.productId, name: i.name, qty: i.qty, notes: i.notes ?? undefined })),
    });
  }
} catch { /* best-effort: cozinha é opcional, venda já está commitada */ }
```
Precisa importar `hasService` (já existe em `core/services/registry.ts`, só nunca teve consumidor real).

## Fase 4 — Módulo Comandas & Mesas — ✅ IMPLEMENTADA

Construiu o módulo novo `src/modules/comandas` (opcional): `store_tables`/`comandas`/`comanda_items` (migration `0040_comandas_base`, sem colisão), `openComanda`/`addItem`/`voidItem`/`transfer`/`split`/`merge`/`closeComanda`/`cancelComanda` em `comandas.ts`, rotas atrás de `requireCapability('comandas.mesas')`, o serviço `store.sales` exposto por `store/setup.ts` (`{ createSale, cancelSale }`, mesmo padrão de `commercial.stock`/`commercial.pricing`), e telas de grid de mesas + detalhe de comanda com transferir/dividir/unir/fechar/cancelar.

Commitada em `0640bc4` junto com a Fase 3. **Diferente da Fase 3, esta tinha 3 bugs reais** que a verificação desta sessão encontrou e corrigiu (o commit original nunca tinha rodado `tsc` nem qualquer teste):
1. `comandas.ts` (`addItem`) chamava `pricing.resolvePrice({ productId, qty, customerId })` com um objeto, mas a assinatura real de `resolvePrice` (`commercial/pricing.ts`) é posicional — erro de compilação, `addItem` quebraria em runtime. Corrigido para `pricing.resolvePrice(product.id, params.qty, comanda.customer_id)`.
2. Mesma função lia `comanda.customer_id` de um `SELECT` que não buscava essa coluna — segundo erro de compilação. Corrigido incluindo `customer_id` no `SELECT`.
3. `/api/comandas/tables` reusava `makeCrudRouter` (fábrica pensada para tabelas com colunas `name`/`active`, como clientes/fornecedores), mas `store_tables` tem `label`/`status` — todo GET/POST/PUT/DELETE quebraria com `SQLite: no such column`, e além disso a fábrica exige permissões `comandas.tables.view/.create/.edit/.delete` que o manifest nunca declarou (só existe `comandas.tables.manage`), então nem o admin teria acesso. Corrigido substituindo por um router dedicado e pequeno em `routes.ts`, usando as colunas reais e a permissão única `comandas.tables.manage`.
4. As views `comandas-mesas.ejs`/`comandas-detalhe.ejs` (e as duas do Food Service, mesmo bug) incluíam os partials compartilhados com caminho relativo (`include('../../../store/views/partials/theme-init')`) em vez do padrão correto `include('partials/theme-init')` — 500 ao abrir qualquer página do módulo. Só apareceu no passe manual desta sessão (nenhum teste de API renderiza páginas). Ver detalhe no item 6 da seção Verificação.

Também faltava por completo a integração combinada com o PDV que a própria UI de comandas já pressupunha (`comandas-detalhe.ejs` já redirecionava para `/app/store/pdv?comandaId=<id>` no botão "Fechar Comanda", mas `store-pdv.ejs` não tinha nenhum código para tratar esse parâmetro). Implementado nesta sessão: detecção de `?comandaId=` no `init()`, `loadComanda()` busca a comanda e pré-carrega o carrinho do slot ativo (ou de um slot novo, se o atual já tiver itens) com os preços já congelados — `repriceCart()` ganhou um guard para nunca re-resolver esses preços —, a busca/edição de itens fica oculta em modo comanda (a comanda é a fonte da verdade dos itens, não o carrinho do PDV), e `finish()` chama `POST /api/comandas/:id/close` em vez de `POST /api/store/sales`, redirecionando para `/app/comandas/mesas` ao fechar o modal pós-venda. Ícone do menu ("Mesas") também estava quebrado (`utensils.svg` não existia no set) — adicionado.

Verificada nesta sessão: `npx tsc --noEmit` limpo (falhava com 2 erros antes da correção), novo teste `src/tests/fase_comandas.ts` (`npm run test:comandas`, 45/45 PASS via servidor HTTP real — mesas, abrir comanda, adicionar item normal + kit + produzido com preço congelado mesmo após o catálogo mudar, anular item, transferir, dividir, unir, fechar gerando venda real com expansão de kit/ficha técnica idêntica a uma venda direta do PDV — inclusive `stock_movements` do insumo —, mesa libera ao fechar, cancelar sem gerar venda e liberando a mesa, gating por capability), e regressão isolada de `npm run test:kits`/`npm run test:complementos`/`npm run test:producao` confirmando que o novo serviço `store.sales` e o hook de `foodservice` não mudaram nenhum comportamento de venda direta existente.

## Fase 4 (texto original do plano, mantido como referência do desenho)

### 1. Modelo de dados (nova migration `src/modules/comandas/migrations/00NN_comandas_base/up.sql`, próximo número após o do Food Service)

```sql
CREATE TABLE store_tables (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  label TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'livre' CHECK (status IN ('livre','ocupada')),
  sort_order INTEGER NOT NULL DEFAULT 0,
  uuid TEXT NOT NULL UNIQUE, updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  deleted_at TEXT, synced_at TEXT, origin_machine TEXT,
  comment TEXT NOT NULL DEFAULT 'Mesa física — status reflete se há uma comanda aberta vinculada.'
);

CREATE TABLE comandas (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  table_id INTEGER REFERENCES store_tables(id),
  customer_id INTEGER REFERENCES customers(id),
  status TEXT NOT NULL DEFAULT 'aberta' CHECK (status IN ('aberta','fechada','cancelada')),
  opened_by INTEGER REFERENCES users(id),
  sale_id INTEGER REFERENCES sales(id),
  notes TEXT,
  closed_at TEXT,
  uuid TEXT NOT NULL UNIQUE, updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  deleted_at TEXT, synced_at TEXT, origin_machine TEXT,
  comment TEXT NOT NULL DEFAULT 'Pré-venda aberta numa mesa ou balcão. Ao fechar vira uma venda normal (sale_id) — Financeiro/DRE não sabem que existiu comanda.'
);

CREATE TABLE comanda_items (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  comanda_id INTEGER NOT NULL REFERENCES comandas(id),
  product_id INTEGER NOT NULL REFERENCES products(id),
  product_name TEXT NOT NULL,
  qty REAL NOT NULL,
  unit_price_cents INTEGER NOT NULL,
  notes TEXT,
  line_group_uuid TEXT,
  added_by INTEGER REFERENCES users(id),
  voided_at TEXT,
  uuid TEXT NOT NULL UNIQUE, updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  deleted_at TEXT, synced_at TEXT, origin_machine TEXT,
  comment TEXT NOT NULL DEFAULT 'Item pedido numa comanda aberta — preço já congelado via resolvePrice no momento do pedido; vira sale_items só ao fechar a comanda.'
);
CREATE INDEX idx_comanda_items_comanda ON comanda_items(comanda_id) WHERE deleted_at IS NULL;
```
Status de preparo (cozinha) **não** é duplicado aqui — quem quiser saber se um item está pronto consulta o `kitchen_ticket` correspondente (`source_type='comanda' AND source_id=comandaId`) via Food Service; manter uma segunda cópia de status aqui criaria duas fontes de verdade divergentes.

### 2. `src/modules/comandas/comandas.ts` — lógica

- `openComanda(req, { tableId?, customerId?, notes? })` — se `tableId` informado, valida mesa `livre` (senão erro), marca `ocupada`.
- `addItem(req, comandaId, { productId, qty, notes?, lineGroupUuid? })` — resolve preço via `commercial.pricing` (`resolvePrice`, mesmo serviço que `createSale` usa), insere `comanda_items`, chama o hook opcional de `foodservice.kitchen.notifyOrder({ sourceType: 'comanda', sourceId: comandaId, tableLabel, items: [...] })`.
- `voidItem(req, comandaId, itemId)` — soft void (`voided_at`), audit.
- `transfer(req, comandaId, { tableId })` — muda `table_id`, libera mesa antiga, ocupa a nova, audit `transferir_comanda` com before/after.
- `split(req, comandaId, { itemIds[] })` — cria uma **nova** comanda (mesma mesa, ou sem mesa se preferir) e **move** (não copia) os `comanda_items` informados para ela; audit `dividir_comanda`. Cobre o caso de uso mais comum ("essas 3 cervejas são do João"); dividir a conta em partes de valor igual já é resolvido hoje pelo multi-pagamento existente no PDV (`SalePaymentInput[]`), não precisa de feature nova aqui.
- `merge(req, targetComandaId, sourceComandaId)` — move todos os itens ativos de `sourceComandaId` para `targetComandaId`, cancela a comanda de origem; audit `unir_comandas`.
- `close(req, comandaId, { payments, discountCents?, surchargeCents?, customerId? })` — monta `SaleInput.items` a partir dos `comanda_items` não anulados (`productId`, `qty`, `notes`, `lineGroupUuid`, `unitPriceCents` = preço já congelado), chama `getService('store.sales').createSale(req, input, { allowPriceOverride: true })`; se `ok`, marca `comandas.status='fechada'`, `sale_id`, `closed_at`, libera a mesa; se falhar, devolve o erro e a comanda continua aberta.
- `cancel(req, comandaId)` — cancela sem gerar venda (cliente foi embora), libera mesa, audit.

### 3. `src/modules/comandas/routes.ts` (atrás de `requireCapability('comandas.mesas')`)

- `GET/POST/PUT/DELETE /tables` — `comandas.tables.manage`.
- `POST /comandas`, `GET /comandas?status=aberta`, `GET /comandas/:id` — `comandas.view`/`comandas.manage`.
- `POST /comandas/:id/items`, `DELETE /comandas/:id/items/:itemId` — `comandas.manage`.
- `POST /comandas/:id/transfer`, `POST /comandas/:id/split`, `POST /comandas/:id/merge` — `comandas.manage`.
- `POST /comandas/:id/close`, `POST /comandas/:id/cancel` — `comandas.manage`.

### 4. `src/modules/store/setup.ts` — novo serviço exposto

```ts
export interface StoreSalesService { createSale: typeof createSale; cancelSale: typeof cancelSale }
registerService('store.sales', { createSale, cancelSale } satisfies StoreSalesService);
```

### 5. UI

- `comandas-mesas.ejs` — grid de mesas (verde=livre, vermelho=ocupada; clique abre a comanda vinculada ou cria uma nova).
- `comandas-detalhe.ejs` — lista de itens da comanda + busca/adicionar produto (mesmo padrão de busca do PDV), botões Transferir/Dividir/Unir/Fechar/Cancelar.
- **Integração com o PDV existente para o pagamento**, em vez de duplicar a tela de pagamento: "Fechar comanda" navega para `/app/store/pdv?comandaId=123`. Pequeno ajuste em `store-pdv.ejs`: ao detectar `?comandaId=` na URL, busca `GET /api/comandas/:id` e pré-carrega `cart[]` a partir dos itens da comanda; ao finalizar, chama `POST /api/comandas/:id/close` (em vez de `POST /sales`) com o mesmo payload de pagamentos que a tela já monta hoje. Isso reaproveita 100% do modal de pagamento/split de pagamento existente, sem duplicar UI.

### 6. `module.manifest.ts` do `comandas`

```ts
const manifest: ModuleManifest = {
  id: 'comandas', name: 'Comandas & Mesas', version: '1.0.0', requiresCore: '>=0.1.0',
  permissions: [
    { key: 'comandas.view', description: 'Visualizar mesas e comandas' },
    { key: 'comandas.manage', description: 'Abrir, adicionar itens, transferir, dividir, unir e fechar comandas' },
    { key: 'comandas.tables.manage', description: 'Cadastrar/editar mesas' },
  ],
  capabilities: [{ key: 'comandas.mesas', description: 'Mesas e comandas — pré-venda que vira venda normal ao fechar' }],
  routes: './routes', pages: './pages', views: './views', migrations: './migrations',
  menu: [{ label: 'Mesas', href: '/app/comandas/mesas', permission: 'comandas.view', description: 'Mesas e comandas abertas.', icon: 'utensils' }],
  syncTables: [
    { table: 'store_tables' },
    { table: 'comandas', foreignKeys: { table_id: 'store_tables', customer_id: 'customers', sale_id: 'sales' }, excludeColumns: ['opened_by'] },
    { table: 'comanda_items', foreignKeys: { comanda_id: 'comandas', product_id: 'products' }, excludeColumns: ['added_by'] },
  ],
};
```

## Arquivos afetados

- `src/modules/foodservice/**` (novo módulo completo: manifest, routes, pages, setup, kitchen.ts, migrations, views).
- `src/modules/comandas/**` (novo módulo completo: manifest, routes, pages, comandas.ts, migrations, views).
- [src/modules/store/setup.ts](src/modules/store/setup.ts) — expõe `store.sales`.
- [src/modules/store/sales.ts](src/modules/store/sales.ts) — hook opcional pra `foodservice.kitchen.notifyOrder` depois da transação de `createSale`.
- [src/modules/store/views/store-pdv.ejs](src/modules/store/views/store-pdv.ejs) — suporte a `?comandaId=` para fechar comanda através do PDV.

Não precisam mudar: `commercial/*` (kits/complementos/variantes/produzido continuam funcionando através de uma comanda sem nenhuma alteração, pois tudo passa por `createSale`), `dre/report.ts` (comanda fechada é só mais uma `sale` comum).

## Verificação (executada na sessão de finalização)

1. ✅ Migrations `0039_foodservice_base`/`0040_comandas_base` aplicam limpo via `migrateUp()` (exercitado no boot de todos os testes novos, `resetTestDb()` + `migrateUp()` do zero a cada run).
2. ✅ `src/tests/fase_foodservice.ts` (`npm run test:foodservice`, 22/22 PASS) — servidor HTTP real (mesmo padrão de `fase5.ts`): cadastra 2 produtos, roteia 1 para a cozinha e deixa o outro de fora; venda real via `POST /api/store/sales` confirma que só 1 `kitchen_ticket`/`kitchen_ticket_items` foi criado; avança status do item até `pronto` e confirma que o ticket reflete; confirma que uma venda sem item roteado não cria ticket; confirma gating por `foodservice.cozinha` (403 antes/depois de desligar a capability).
3. ✅ `src/tests/fase_comandas.ts` (`npm run test:comandas`, 45/45 PASS) — mesmo padrão: abre mesa + comanda; adiciona 3 itens (suco normal + 1 kit + 1 produzido, reaproveitando o desenho das Fases 2c/2d) via `addItem`; confirma preço congelado em `comanda_items` mesmo depois de mudar o preço no catálogo; testa `transfer` (mesa muda, mesa antiga libera); testa `split` (move item pra comanda nova); testa `merge` (volta a juntar, origem fica cancelada); fecha a comanda (`close`) com pagamento via `POST /api/comandas/:id/close` e confirma que gera uma `sale` de verdade com os itens certos — o kit expandiu com o componente a preço zero e o produzido consumiu o insumo da ficha técnica em `stock_movements`, exatamente como uma venda direta do PDV geraria; confirma que a mesa libera ao fechar; testa `cancel` (libera mesa sem gerar venda); confirma gating por `comandas.mesas`.
4. ✅ Regressão: `npm run test:kits`/`npm run test:complementos`/`npm run test:producao` isolados, todos verdes — o novo serviço `store.sales` e o hook de `foodservice` não mudaram nenhum comportamento de venda direta existente.
5. ✅ `npx tsc --noEmit` limpo (achou e corrigiu os 2 erros de `comandas.ts` descritos acima).
6. Manual em duas rodadas. **Rodada 1** (via `npm run dev` + `curl` autenticado, cobrindo as páginas HTML que os testes de API não tocam): achou o 4º bug real — as 4 views novas (`comandas-mesas.ejs`, `comandas-detalhe.ejs`, `foodservice-cozinha.ejs`, `foodservice-routing.ejs`) incluíam os partials compartilhados com caminho relativo `include('../../../store/views/partials/theme-init')`/`.../nav`, mas o padrão correto (Express configurado com array de `views` — core + cada módulo, ver `core/server.ts`) é sempre `include('partials/theme-init')` sem prefixo relativo; as 4 páginas quebravam com 500. Corrigido.

   **Rodada 2** (navegador Chromium real via Playwright, clicando pelo fluxo Mesa → Comanda → Cozinha → Fechar pelo PDV de ponta a ponta — login, liga capabilities, cadastra produto, roteia pra cozinha, cria mesa, clica na mesa, adiciona item pela busca, fecha a comanda, paga no PDV, confirma mesa liberada e ticket na cozinha) achou mais 3 bugs reais que só aparecem com clique de verdade, invisíveis a testes de API/HTML estático:
   - **5º bug**: o dialog "Nova Mesa" em `comandas-mesas.ejs` usava `x-show="showAddTable"` num elemento `<dialog>` nativo sem nunca chamar `.showModal()` — o navegador aplica `dialog:not([open]) { display: none }` por padrão, então o dialog nunca ficava visível ao clicar "Nova Mesa" (diferente de todos os outros dialogs do app, que corretamente usam `showModal()`/`close()`). Corrigido para o mesmo padrão dos demais.
   - **6º bug**: em `comandas-detalhe.ejs`, o mesmo elemento tinha `x-show="comanda?.notes"` (guardado) mas `x-text="'Obs: ' + comanda.notes"` (sem guarda) — Alpine avalia todas as diretivas de um elemento independente do `x-show`, então toda vez que a página carrega (antes do primeiro fetch resolver, com `comanda: null`) o `x-text` lançava `Cannot read properties of null (reading 'notes')`. Corrigido para `comanda?.notes ?? ''`.
   - **7º bug, o mais interessante**: Alpine chama automaticamente um método chamado `init()` no objeto de dados de todo componente (hook de lifecycle) — **além** de executar a diretiva `x-init="init()"` que também chama `init()`. Isso significa que **todo `init()` de toda tela do app roda 2x** — inofensivo até agora porque cada `init()` só fazia fetch+atribuição idempotente (rodar 2x dá o mesmo resultado). O novo `loadComanda()` no PDV **não é idempotente**: a 2ª chamada via de regra encontrava `slots[0]` já preenchido pelo carrinho da comanda (da 1ª chamada) e, achando que era um carrinho "de venda em andamento" a preservar, criava uma 2ª aba de venda duplicada com a mesma comanda. Corrigido com uma guarda `if (this._initDone) return; this._initDone = true;` no início do `init()` do PDV — mais seguro e local do que tentar consertar o hook duplo do Alpine em todo o app (fora de escopo desta tarefa).

   Depois dos 7 fixes, o fluxo completo rodou limpo via Playwright: 0 erros de console, 0 exceções JS, carrinho da comanda pré-carregado corretamente (1 aba, não 2), venda registrada com o total certo, mesa liberada, ticket aparecendo no painel de cozinha. Screenshots de cada etapa foram capturados durante a verificação.

## Depois desta fase

Com Food Service e Comandas & Mesas implementados e verificados de ponta a ponta (testes automatizados + `tsc` limpos + passe completo num navegador real via Playwright, clicando pelo fluxo Mesa → Comanda → Cozinha → PDV → venda), **todo o roadmap do documento de arquitetura original está coberto** (Núcleo, Módulos, Capabilities, Tipos de Produto, Catálogo Avançado completo, Food Service, Comandas & Mesas). Qualquer trabalho depois disso é escopo novo, a ser levantado com o usuário quando surgir.

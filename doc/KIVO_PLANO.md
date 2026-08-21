# Kivo — Plano de Desenvolvimento

> **Versão atual:** 0.1.5
> **Arquitetura:** desktop-first, Electron + Express 5 + SQLite, módulos de domínio com camada Controller → Service → Repository.

---

## 1. Stack

| Camada | Escolha |
|--------|---------|
| Runtime desktop | **Electron** 36 |
| Servidor local | **Express 5** (localhost, dentro do Electron) |
| Linguagem | **TypeScript** 5.8 |
| Banco local | **better-sqlite3** + WAL |
| ORM (migrations) | **Drizzle ORM** (mínimo — só para schema types e migrations) |
| Views | **EJS** + **Alpine.js 3** (sem build step) |
| Validação | **Zod** 4 |
| Autenticação | **bcryptjs** + sessão via cookie (`kivo_session`) |
| Segurança HTTP | **Helmet**, **express-rate-limit**, **Morgan** |
| Atualização | **electron-updater** (GitHub Releases) |
| Nuvem | Node + Express + MySQL (`cloud/`, deploy independente) |

---

## 2. Estrutura de pastas (real)

```
kivo/
├── src/
│   ├── core/
│   │   ├── audit/              # Log de auditoria (routes, service)
│   │   ├── auth/               # Login, sessão, hash, middleware
│   │   ├── backup/             # Backup local (routes, service)
│   │   ├── billing/            # Faturamento (routes, service)
│   │   ├── capabilities/       # Feature flags (middleware, routes, service)
│   │   ├── config/             # Configurações do sistema (cloud URL, etc.)
│   │   ├── database/           # connection, repository (BaseRepository), migrator, schema, cli
│   │   ├── license/            # Licenciamento (service, plans, activation, routes)
│   │   ├── modules/            # Loader de módulos + tipos (module.manifest.ts)
│   │   ├── permissions/        # RBAC (middleware)
│   │   ├── repositories/       # Repositórios de entidades core (User, Role, Audit, Settings)
│   │   ├── security/           # Configurações de segurança (routes)
│   │   ├── server.ts           # Fábrica do Express (createServer)
│   │   ├── services/           # Registry + EventBus
│   │   ├── sync/               # Motor de sincronização multi-máquina (engine, client, registry, routes)
│   │   ├── updater/            # Auto-updater
│   │   └── users/              # CRUD de usuários (routes)
│   │
│   ├── modules/                # Módulos de domínio
│   │   ├── commercial/         # Produtos, clientes, fornecedores, estoque, pricing
│   │   ├── store/              # PDV (vendas, orçamentos, relatórios)
│   │   ├── finance/            # Caixa, contas a pagar/receber, métodos de pagamento, convênios
│   │   ├── foodservice/        # Cozinha (display de pedidos)
│   │   ├── comandas/           # Mesa / comandas
│   │   ├── dre/                # Demonstrativo de Resultado
│   │   └── hello/              # Módulo de exemplo (Fase 0)
│   │       └── module.manifest.ts
│   │
│   ├── shared/                 # Utilitários puros (money, date, cpf/cnpj, barcode, validation…)
│   ├── public/                 # Assets estáticos (CSS, JS, imagens, vendor/)
│   ├── views/                  # Templates EJS core (login, admin, home)
│   ├── electron/               # bootstrap.ts, main.ts, preload.ts
│   └── tests/                  # Testes de integração (fase*.ts)
│
├── cloud/                      # Servidor de nuvem (deploy independente)
│   ├── src/
│   │   ├── server.ts           # Express + MySQL
│   │   ├── routes/             # sync, license, backup, admin, billing, catalog, menu, wiki
│   │   ├── views/              # Templates EJS (admin, cardápio)
│   │   └── ...
│   ├── docker-compose.yml      # MySQL 8.0
│   └── package.json
│
├── drizzle/                    # Migrations do Core
├── build/                      # Ícones, NSIS config
├── scripts/                    # copy-build-assets, deploy, ensure-native-abi
├── doc/
│   ├── KIVO_PLANO.md          # Este arquivo
│   └── auditoria/              # Relatórios de auditoria técnica
│
├── package.json
└── tsconfig.json
```

---

## 3. Arquitetura em camadas

Cada módulo segue o padrão **Controller → Service → Repository**:

### 3.1 Controllers (`controllers/`)

- Manipulam request/response (req body → parâmetros tipados, devolvem JSON)
- Aplicam `requirePermission`, `validateBody`, `requireCapability`
- Delegam lógica de negócio para services

### 3.2 Services / Business Logic (`.ts` raiz do módulo)

- Funções puras de domínio (`createSale`, `cancelSale`, etc.)
- Importam **repositórios do próprio módulo** diretamente
- Consomem **serviços de outros módulos** via `getService('...')` (nunca import direto)
- Retornam `{ ok: true, ... } | { ok: false, error: string }`
- Explicitam transações via `repo.transaction(() => {...})`

### 3.3 Repositories (`repositories/`)

- Estendem `BaseRepository<T>` do Core
- Adicionam queries específicas de domínio
- Exportam singletons

### 3.4 Routes (`routes.ts`)

- One-liners: definem rota, aplicam middleware, chamam controller
- Sem lógica de negócio ou SQL inline

### 3.5 BaseRepository (`src/core/database/repository.ts`)

CRUD genérico com:
- `findById`, `findAll`, `findWhere`, `findOneWhere`, `findIn`, `searchLike`
- `create`, `update`, `updateWhere`
- `softDelete`, `softDeleteWhere`
- `transaction`
- `raw`, `rawOne`, `rawRun` (SQL direto)

Toda tabela tem: `id`, `uuid`, `deleted_at`, `updated_at`, `origin_machine`, `synced_at`, `comment`.

---

## 4. Comunicação entre módulos

Módulos **nunca** se importam diretamente. O contrato é:

```
setup.ts → registerService('commercial.stock', impl)
outro módulo → getService<CommercialStockService>('commercial.stock')
```

As interfaces de serviço ficam no próprio module (`type.ts` em cada módulo ou no `setup.ts`).
O Core fornece `EventBus` para eventos futuros.

### Módulos existentes e serviços que expõem:

| Módulo | Serviços |
|--------|----------|
| **commercial** | `stock`, `pricing`, `storeCredit`, `loyalty`, `paymethods` |
| **store** | `sales` |
| **finance** | `cash`, `receivables`, `agreements` |
| **foodservice** | `kitchen` |
| **comandas** | (nenhum serviço exposto — só consome) |

---

## 5. Módulo manifesto

Cada módulo declara `module.manifest.ts`:

```ts
export default {
  id: 'store',
  name: 'PDV',
  version: '1.0.0',
  requiresCore: '>=0.1.0',
  permissions: [
    { key: 'store.sales.create', description: 'Criar vendas' },
    { key: 'store.sales.view', description: 'Visualizar vendas' },
  ],
  setup: './setup',                // registra serviços
  routes: './routes',              // montado em /api/store
  pages: './pages',                // montado em /app/store
  views: './views',                // templates EJS
  menu: [{ label: 'PDV', route: '/app/store/pdv' }],
  dependsOn: ['commercial', 'finance'],
  syncTables: [{ entity: 'store.sales', table: 'sales', ... }],
  capabilities: [
    { key: 'store.kit', description: 'Venda de kits' },
    { key: 'store.complement', description: 'Complementos' },
  ],
}
```

O loader (`src/core/modules/loader.ts`) descobre, valida versão, ordena topologicamente por `dependsOn` e monta.

---

## 6. Estado atual (v0.1.5)

### ✅ Concluído

| Área | O quê |
|------|-------|
| **F0** | Electron + Express + SQLite + Drizzle + módulo hello |
| **F1** | Auth (bcrypt 12 rounds, cookie session), RBAC, auditoria |
| **F2** | Shared: money, date, cpf/cnpj, barcode, validation, response envelope |
| **F3** | Commercial: produtos, clientes, fornecedores, estoque, pricing, CRUD factory |
| **F4** | Financeiro: caixa, contas a pagar/receber, métodos de pagamento, convênios, DRE |
| **F5** | Store: PDV (vendas, orçamentos), foodservice (cozinha), comandas (mesas) |
| **F6a-d** | Sync engine, licenciamento remoto, backup nuvem, painel admin (cloud/) |
| **Repository layer** | BaseRepository + 24 repositórios de domínio |
| **Controller layer** | Store, Finance, Foodservice, Comandas |
| **Segurança** | Helmet, rate-limit, CSRF (sameSite strict), password strength, validação Zod em 70 das 140 rotas mutantes |
| **Segurança F5** | `requestSingleInstanceLock`, `sandbox: true`, crash handlers |
| **Segurança CSP** | Content-Security-Policy com nonce por requisição, sem handler inline em nenhuma view (`src/tests/csp.ts`) |
| **Performance** | PRAGMA cache, dirty rows LIMIT, backup stream, criação/modificação de índices |
| **Observabilidade** | Logger estruturado (`core/logger.ts`) com arquivo diário em `storage/logs/` e retenção de 14 dias |
| **Código** | Error handler global, Morgan, `assertAuth`, divider `commercial/routes.ts`, `createSale` + `cancelSale` extraídos |
| **Qualidade** | CI (tipos + lint + integração + e2e), lint sem erros, suíte verde sem Docker (testes de nuvem entram como SKIP) |
| **Empacotamento** | NSIS installer, auto-updater (GitHub Releases), licenciamento com planos Trial/Prata/Ouro/Diamante |

### 🔄 Pendente (não contratado)

| Item | Esforço |
|------|---------|
| CRUD factory para demais entidades (reduzir código manual) | ~4h |
| Cliente de API compartilhado no navegador (hoje ~298 `fetch()` soltos nas views) | ~8h |
| Paginação no servidor para catálogo grande — ver nota abaixo | decisão de produto |
| Zod nas 70 rotas mutantes restantes (a maioria sem corpo ou já validada à mão) | ~4h |
| Transações em openComanda / convertQuote | ~1h |
| Username enumeration timing fix | ~1h |
| Sanitizar stored XSS no PDV | ~1h |
| `origin_machine` stamp nos demais módulos | ~4h |
| Code signing do instalador | variável |
| Demais recomendações de auditoria (F7, F9, F10, F11, F12) | ~50h+ |

#### Nota — catálogo grande e paginação

Medido com catálogo gerado (`GET /api/commercial/products`, resposta completa):

| Produtos | Tempo | Tamanho da resposta |
|---|---|---|
| 500 | 21 ms | 266 KB |
| 2.000 | 20 ms | 1 MB |
| 10.000 | 92 ms | 5,3 MB |
| 30.000 | 243 ms | 16 MB |

O gargalo **não é o SQLite** — é o tamanho do JSON que o navegador precisa baixar, interpretar
e tornar reativo. A migration `0058_indice_listagem_produtos` tirou a ordenação temporária do
plano da consulta (21,3 → 17,6 ms em 30 mil produtos), mas não muda o volume.

Paginar de verdade exige mover busca, ordenação e filtro de aba para o servidor — e isso
conflita com a premissa do PDV, que carrega o catálogo inteiro **de propósito** para buscar e
validar o carrinho sem depender de rede. É decisão de produto (até que tamanho de loja o Kivo
se propõe a atender offline?), não faxina técnica.

#### Já resolvidos desta lista

- **Logger estruturado** — `core/logger.ts`; 45 chamadas de `console.*` migradas. O que ficou em
  `console.log` de propósito é saída de CLI (`database/cli.ts`, `dev.ts`), não registro de operação.
- **Índices compostos** — `0058_indice_listagem_produtos` (ver a nota acima).
- **Limpeza de sessões expiradas** — `purgeExpiredSessions()`, no boot e a cada 12h.

---

## 7. Nuvem (cloud/)

Serviço separado (Node + Express + MySQL) que provê:

- **Sincronização** — push/pull de registros sujos, resolução de conflitos LWW
- **Licenciamento** — validação, planos, gerenciamento de dispositivos
- **Backup** — upload/download de snapshots SQLite
- **Painel admin** — gestão de empresas, cobrança manual
- **Cardápio online** — páginas públicas de restaurante
- **Catálogo** — banco de imagens de produtos colaborativo

Deploy: `docker compose -f cloud/docker-compose.yml up -d` + migrations via `cloud:migrate`.

---

## 8. CLI

Os comandos do projeto estão em `scripts/commands.json` e são executados via `scripts/kivo.js`:

```sh
node scripts/kivo              # listar todos os comandos
node scripts/kivo dev          # servidor dev
npm run kivo dev               # (atalho)
npm run dev                     # (atalho mais curto)
npm run test                    # rodar todos os testes
npm run kivo test:fase1        # teste específico
```

O `package.json` contém apenas os atalhos mais usados; a lista completa está em `scripts/commands.json`.

---

## 9. Kivo Web (celular/tablet) — entregue

Acompanhar a loja e montar orçamento pelo celular, exclusivo do plano **Diamante**.
Provado ponta a ponta em `src/tests/kivo-web-e2e.ts` (desktop + nuvem + celular).

### Como funciona

| Peça | Onde |
|---|---|
| Ciclo automático de sync (3 min, ajustável) + disparo pós-venda | `src/core/sync/scheduler.ts` |
| Canal de eventos nuvem → desktop (SSE) | `cloud/src/events.ts` ↔ `src/core/sync/events.ts` |
| Concessão de acesso por link/QR | `src/core/remote/service.ts` ↔ `cloud/src/routes/mobileGrants.ts` |
| Sessão do celular | `cloud/src/mobileAuth.ts` |
| Painel (leitura de `sync_records`) | `cloud/src/routes/mobileApp.ts`, `cloud/src/mobileData.ts` |
| Fila de comandos | `cloud/src/routes/mobileCommands.ts` ↔ `src/core/sync/commands.ts` |

**Três decisões que explicam o desenho:**

1. **Login por link/QR, sem senha na nuvem.** `users` não sincroniza — o `password_hash` do
   PDV nunca sai da máquina. O desktop gera um token por usuário, guarda só o sha256 e manda
   à nuvem o hash + a lista de permissões. Revogar é imediato: a sessão do celular é o próprio
   token revalidado a cada requisição, sem tabela de sessão.
2. **Escrita por fila de comandos, não por sync.** O pull insere linhas direto nas tabelas,
   sem passar por `createQuote`/`createSale` — quem valida produto, resolve preço pela tabela
   do cliente, move estoque e lança no caixa. O celular grava a intenção; o desktop executa,
   no nome de quem pediu (`core/auth/systemContext.ts`).
3. **SSE, não webhook.** O desktop está atrás de NAT: a nuvem não consegue iniciar conexão
   para lá. Invertendo o sentido, o desktop abre um `GET` e a nuvem empurra por ele. O ciclo
   periódico continua como rede de segurança. **Exige `proxy_buffering off` no proxy da VPS —
   ver `doc/instruções_deploy.md`.**

> A capability `app.online`, antes reservada para isto, não foi usada: capabilities nascem
> desligadas, e um terceiro interruptor faria o recurso parecer quebrado para quem acabou de
> assinar Diamante. Os controles são o plano e a concessão por usuário.

### Próximo passo — fechar venda pelo celular

Falta o handler `store.sale.create` na fila. Três coisas a resolver antes:

1. `payment_methods` **não sincroniza** (é config por terminal) — o celular não sabe as formas
   de pagamento disponíveis.
2. A venda exige **caixa aberto** no desktop; a tela precisa dizer isso antes de deixar montar.
3. Definir o que acontece se o desktop recusar depois de o vendedor prometer o preço ao cliente.

Em paralelo: publicar **v0.2.0** com as refatorações concluídas (repository + controller +
cancelSale).

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
| **Segurança** | Helmet, rate-limit, CSRF (sameSite strict), password strength, validação Zod |
| **Segurança F5** | `requestSingleInstanceLock`, `sandbox: true`, crash handlers |
| **Performance** | PRAGMA cache, dirty rows LIMIT, backup stream, criação/modificação de índices |
| **Código** | Error handler global, Morgan, `assertAuth`, divider `commercial/routes.ts`, `createSale` + `cancelSale` extraídos |
| **Empacotamento** | NSIS installer, auto-updater (GitHub Releases), licenciamento com planos Trial/Prata/Ouro/Diamante |

### 🔄 Pendente (não contratado)

| Item | Esforço |
|------|---------|
| CRUD factory para demais entidades (reduzir código manual) | ~4h |
| Logger estruturado (substituir console.log) | ~4h |
| Índices compostos em tabelas de alta frequência | ~2h |
| Transações em openComanda / convertQuote | ~1h |
| Username enumeration timing fix | ~1h |
| Sanitizar stored XSS no PDV | ~1h |
| Limpeza de sessões expiradas | ~1h |
| `origin_machine` stamp nos demais módulos | ~4h |
| Code signing do instalador | variável |
| Demais recomendações de auditoria (F7, F9, F10, F11, F12) | ~50h+ |

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

## 9. Próximo passo

Publicar **v0.2.0** com todas as refatorações concluídas (repository + controller + cancelSale).

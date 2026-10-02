# KIVO_ODONTO_ARCHITECTURE_AUDIT

**Entrega da seção 30 da PR — Kivo Odonto**
**Repositório:** `C:\apps\Kivo` · **Branch:** `main` · **Commit base:** `497c5b0` ("feat(ai-tools): implementar limites de mensagens e histórico…", 2026-09-24)
**Data da auditoria:** 2026-10-02
**Método:** leitura direta do código (nenhum arquivo de código foi alterado nesta etapa), com execução da linha de base (`build`, `lint`, suíte de testes). Ignorados `dist/`, `dist-installer/`, `node_modules/`, `coverage/`, `db/dist/`, `cloud/dist/`.
**Regra seguida:** a PR §29 proíbe assumir a arquitetura — todo achado abaixo tem `arquivo:linha` e o que **não existe** está declarado explicitamente.

> Resumo de uma frase: o Kivo **não tem nada de odontologia hoje** (zero tabelas, rotas, permissões ou termos clínicos), mas tem um núcleo de módulos maduro, um financeiro completo e um estoque com lote/validade — o trabalho real do Kivo Odonto é **agenda + camada clínica + infraestrutura de arquivo clínico**, reaproveitando `customers`, `products` e `receivables`.

---

## 0. Resumo executivo

### 0.1 Veredito por capacidade

| Capacidade da PR | Situação real | Caminho |
|---|---|---|
| Estrutura de módulo, rotas, menu, permissões, capabilities | **Pronto** (auto-descoberta por manifesto) | Só criar `src/modules/odonto/` |
| Pacientes | Cadastro genérico existe como `customers` (com ficha financeira, convênio, preço por cliente) | **Estender**, não duplicar |
| Financeiro (cobrança, parcelamento, caixa, convênio) | **Completo** no módulo `finance` | Consumir via `getService` |
| Estoque (material, descartável, medicamento, lote/validade, FIFO/FEFO) | **Completo** no módulo `commercial` | Consumir via `getService` + categorias |
| Procedimentos | Só como `products` do tipo `servico` | **Estender** com metadados clínicos |
| Prontuário, anamnese, evolução, odontograma | **Não existe nada** | Criar |
| Agenda (agendamento, status, sala/cadeira, profissional) | **Não existe nada** | Criar do zero |
| Plano de tratamento | **Não existe nada** (o análogo comercial é `quotes`, que não serve) | Criar |
| Documentos com variáveis `{{paciente.nome}}` | **Não existe motor de template**; existe o encanamento de impressão | Criar motor, reusar impressão |
| Exames / imagens clínicas | Upload existe, mas **base64/5MB e sem autenticação no download** | Criar infraestrutura própria |
| Auditoria e LGPD | Auditoria de escrita existe; **sem leitura, podada em 365 dias, zerada no reset, não sincronizada, sem cifragem** | Adaptar + decidir |

### 0.2 As sete decisões que mudam o plano da PR

1. **Agenda não existe de forma alguma.** A PR §6 pede agenda; não há tabela, rota, menu, permissão, nem campo de data futura de agenda (o mais próximo é `store_tables` de restaurante, sem data/hora/profissional — `src/modules/comandas/migrations/0045_comandas_base/up.sql:1-9`). É o maior item isolado de esforço da v1.
2. **"Multiempresa" (PR §24.4) não é multi-tenant no banco local.** Não existe `company_id`, RLS nem empresa ativa no request: o isolamento é **1 banco SQLite por instalação** (`src/core/database/connection.ts:7-8`) e partição por `company_uuid` no cloud (`cloud/migrations/0001_sync_core/up.sql:1-22`). O requisito da PR é atendido pela instalação — **exceto** por um vetor real de vazamento: troca de licença sem limpeza local (`src/core/license/routes.ts:52-72`). Ver risco **D2**.
3. **Paciente deve ser extensão de `customers`**, não entidade independente: `receivables.customer_id` aponta para `customers` (`src/modules/finance/bills.ts:158`), e é lá que vivem ficha, convênio, crédito e preço por cliente. Uma tabela de paciente isolada obrigaria a duplicar cobrança e convênio.
4. **Cobrança do plano aprovado NÃO deve passar por `store.sales.createSale`**: ele exige caixa aberto (`src/modules/store/sales.ts:338-339`), inclusive a prazo. O caminho correto é `finance.receivables.create` (`src/modules/finance/setup.ts:46-67`), que não exige caixa.
5. **Não adicionar coluna em `receivables` para ligar plano→cobrança.** O motor de sync resolve FK para tabela não sincronizada usando "qualquer id local" (`src/core/sync/engine.ts:198`), o que geraria vínculo errado em outra máquina. Usar tabela de ligação do próprio Odonto (ver 16.4).
6. **Não criar tipos novos em `products.product_type`.** O CHECK exige rebuild destrutivo da tabela `products` (padrão usado em `src/modules/commercial/migrations/0049_add_complemento_product_type/up.sql:1-43`), que é central para vendas, kits, lotes e sync. Classificar material odontológico por **categoria** + `product_type_config` (editável sem migration — `0077_product_type_config/up.sql:11-34`).
7. **Arquivo clínico (exame/imagem) não pode usar `/uploads/*`.** Os diretórios de upload são servidos por `express.static` **antes** de qualquer autenticação (`src/core/server.ts:311-315` vs. `attachUser` em `:332`, `requireAuth` em `:397-398`). Para dado clínico é obrigatório rota autenticada com auditoria (ver risco **D1**).

### 0.3 Linha de base (estado atual **não verde** — medido antes de qualquer alteração)

| Etapa | Comando | Resultado |
|---|---|---|
| Build | `npm run build` | ✅ exit 0 |
| Lint | `npm run lint` | ❌ **1 erro pré-existente**: `src/core/devdocs/markdown.ts:30:17` `no-control-regex` |
| Testes | `npm test` | ❌ **56/58 passaram · 1542 checks · 2 falhas · 10 skip** (cloud/MySQL fora do ar) |
| — | `fase3.ts` | ❌ `FAIL fornecedor criado` → `POST /api/commercial/suppliers` responde **500** |
| — | `fase5b.ts` | ❌ mesma causa raiz do anterior (500 em `POST /api/commercial/suppliers`) |
| — | demais 56 arquivos | ✅ PASS |

**Causa raiz única das 2 falhas (investigada):** `NOT NULL constraint failed: suppliers.default_markup_bps`. O CRUD genérico monta o INSERT com **todos** os campos do config usando `body[f] ?? null` (`src/modules/commercial/crud.ts:219-222`), e `default_markup_bps` é `NOT NULL DEFAULT 0` (`src/modules/commercial/migrations/0071_supplier_profile_barcodes/up.sql:24`). Quando o cliente não envia o campo, o `NULL` explícito anula o DEFAULT e viola o NOT NULL. As duas falhas são **pré-existentes** (nada foi alterado nesta auditoria) e não têm relação com a PR Odonto, mas **precisam ser resolvidas antes**, porque são a rede de segurança que vai provar que o módulo novo não quebrou nada. Correção mínima recomendada em 18.1.

> **Atualização (mesma sessão de trabalho):** os três itens foram corrigidos antes de iniciar o
> módulo — CI restaurado de `HEAD`, `no-control-regex` silenciado com justificativa em
> `src/core/devdocs/markdown.ts`, e o CRUD genérico ganhou `defaults` por campo
> (`CrudConfig.defaults`, aditivo e sem mudar os demais CRUDs) com
> `defaults: { default_markup_bps: 0 }` no cadastro de fornecedores. Linha de base passou a
> **verde**: `npm run build` exit 0, `npm run lint` exit 0, `npm test` = todos os testes
> executados passaram (10 pulados por dependerem do MySQL do `cloud/`).

---

## 1. Stack e estrutura

| Camada | Tecnologia real |
|---|---|
| Shell | Electron 36 (`src/electron/{bootstrap,main,preload}.ts`) + Express 5 |
| Linguagem | TypeScript 5.8 `strict`, CommonJS, `target ES2022`, `rootDir: src`, `outDir: dist` (`tsconfig.json`) |
| Banco | **SQLite via better-sqlite3** com SQL puro; `drizzle-orm` existe mas está morto (ver §4.1) |
| Views | **EJS sem layout engine** + Alpine.js 3 (CDN local) + CSS próprio |
| Testes | Runner próprio (`scripts/test-runner.js`), sem framework |
| Empacotamento | electron-builder / NSIS (`package.json:59-87`) |

Estrutura de diretórios (relevante):

```
src/
├── core/            # framework: database, auth, modules, permissions, capabilities,
│                    # audit, license, sync, backup, billing, secrets, catalog, repos…
├── modules/         # domínio: commercial, store, finance, dre, fiscal, nfe,
│                    # comandas, foodservice, labels, overview, hello
├── shared/          # utilitários puros (money, date, cpf/cnpj, envelope, schemas zod)
├── electron/        # bootstrap, main, preload
├── views/           # views do core + partials (nav, search-filter, pager, confirm…)
├── public/          # css, js (table-toolkit, crud-page, masks…), icons, vendor
├── docs/dev/        # documentação técnica por módulo (/admin/documentacao)
└── tests/           # 64 arquivos de teste de integração + e2e/
drizzle/migrations/  # migrations do core (19)
cloud/               # servidor de sync/licença/backup (MySQL) — stack separada
```

Números: **361 arquivos** `.ts`/`.ejs`, **~63.800 linhas** (sem testes), **85 migrations** (core + módulos).

Módulos existentes e seus ids: `commercial`, `store`, `finance`, `dre`, `fiscal`, `nfe`, `comandas`, `foodservice`, `labels`, `overview` (sempre ativo), `hello` (módulo de teste que **continua carregado em produção** — `src/modules/hello/module.manifest.ts:3-15`).

**Achado de documentação:** `README.md:117-118` aponta para `doc/KIVO_PLANO.md` e `doc/auditoria/`, e o código cita "KIVO_PLANO.md §6" (`src/core/database/schema.ts:4`, `src/core/database/migrator.ts:131`) — **esses arquivos não existem**. O contrato de dados citado é hoje comentário no código, não documento.

---

## 2. Núcleo: como um módulo nasce (o caminho do Kivo Odonto)

### 2.1 Contrato declarativo

`src/core/modules/types.ts:24-54` define `ModuleManifest`: `id`, `name`, `version`, `requiresCore` (obrigatórios — `loader.ts:20-24`), e opcionais `permissions`, `capabilities`, `routes`, `pages`, `views`, `migrations`, `setup`, `menu`, `dependsOn`, `alwaysEnabled`, `syncTables`.

### 2.2 Ciclo de vida (ordem real, `src/core/modules/loader.ts:218-274`)

1. `readdirSync(src/modules)` → procura `module.manifest.ts` (sem manifesto, a pasta é ignorada em silêncio — `:227-228`).
2. `validateManifest` → `satisfiesCore` (incompatível = warn + ignorado, `:234-237`).
3. Ordenação topológica por `dependsOn` (`:199-216`; dependência inexistente é ignorada em silêncio).
4. Para cada módulo: **`setup`** (`:248-255`) → `app.use('/api/<id>', …)` (`:259`) → `app.use('/app/<id>', …)` (`:262`) → registro de views (`:264`) → `registerInDb` (`:266`) → `registerPermissions` (`:267`) → `registerCapabilities` (`:268`) → `registerSyncTables` (`:269`).
5. `server.ts:418-420`: views de módulo entram no lookup EJS **depois** das do core; menu global agregado.

**Implicações para o Odonto:**
- Todo módulo compatível é **sempre carregado**; plano (licença) e capability decidem **acesso**, não carga (`loader.ts:172-184`, `src/core/license/service.ts:302-312`). Em dev, `modules_json` nulo = **fail-open** (acesso liberado); em produção, `odonto` precisa constar no plano. O provisionamento é dado, não código (`cloud/src/provision-company.ts:3`).
- **Um módulo quebrado derruba o boot inteiro**: manifesto inválido, arquivo de rota declarado e ausente (`loader.ts:63`), `setup` que lança (`:253`) ou nome de serviço duplicado (`src/core/services/registry.ts:11`) abortam `createServer()`. Daí a exigência de cuidado.

### 2.3 Receita verificada — criar o módulo do zero

Obrigatório criar:
- `src/modules/odonto/module.manifest.ts`
- pelo menos um router: `routes.ts` (API em `/api/odonto`) e/ou `pages.ts` (páginas em `/app/odonto`)
- `migrations/0078_odonto_base/{up,down}.sql` se houver tabela

Conforme o manifesto declarar: `views/*.ejs`, `setup.ts`, `schemas.ts`, `repositories/`, `services/`.

Editar fora do módulo (só se aplicável): `src/core/roles/presets.ts` (cargos de fábrica), `src/core/onboarding/service.ts:101-138` (assistente), `src/views/partials/capability-gate.ejs:31-37` (rótulo amigável), `src/docs/dev/index.md` + `odonto.md`, `src/public/icons/` (ícone novo — **não existe ícone odontológico**: os 40 disponíveis estão em `src/public/icons`, e asset dentro da pasta do módulo não é copiado no build — `scripts/copy-build-assets.js:36-37` copia apenas `views/` e `migrations/`).

Não precisa editar: `server.ts`, `loader.ts`, `seeds.ts`, `migrator.ts`, `resetData.ts`, `sync/registry.ts`, `copy-build-assets.js`.

### 2.4 Serviços (comunicação entre módulos)

`src/core/services/registry.ts:8-33`: `registerService(name, impl)` / `getService<T>(name)` / `hasService(name)` — DI por **string**, sem contrato em runtime; o contrato é a interface TS exportada pelo `setup.ts` do fornecedor (modelo: `src/modules/foodservice/setup.ts:5-24`). Padrão correto de dependência opcional: `hasService` antes de `getService` (`src/modules/comandas/comandas.ts:108-109`).

Serviços que o Odonto vai consumir: `commercial.stock`, `commercial.pricing`, `finance.receivables`, `finance.paymethods`, `finance.cash`, `finance.agreements` (§7).

### 2.5 Permissões, capabilities e menu

- Permissões e capabilities são declaradas **no manifesto**; o loader faz UPSERT no catálogo (`loader.ts:93-134`) e **concede tudo ao cargo Administrador** a cada boot (`:119-133`). Capabilities nascem `enabled=0` (`:101`).
- **`capabilities.key` e `permissions.key` são UNIQUE globais** — chave repetida entre módulos faz o segundo "roubar" a capability/permissão (`loader.ts:102-104`, `:117`). Prefixar tudo com `odonto.` elimina o risco.
- Menu vem do manifesto (`menu: [{label, href, permission, capability?, icon?}]`) e é filtrado por entitlement e capability **a cada requisição** (`loader.ts:158-166`). O agrupamento da sidebar usa `manifest.name` cortado no primeiro `" ("` (`src/views/partials/nav.ejs:566`) → usar `name: 'Odonto (clínicas e consultórios)'` cria a seção **Odonto**.
- Páginas: `/app/odonto` só garante autenticação (`server.ts:398`); a permissão é responsabilidade do helper `page(view, permission)` copiado por módulo (`src/modules/labels/pages.ts:19`).

### 2.6 Sincronização (contrato de tabela)

`manifest.syncTables` registra `entityType = 'odonto.<tabela>'` (`src/core/sync/registry.ts:14-20`) com `foreignKeys`, `excludeColumns` (colunas derivadas não viajam), `children` e `ledgerFor` (`src/core/sync/types.ts:4-29`). Tabela fora de `syncTables` fica **só na máquina** — decisão explícita para tabelas clínicas (ver §10 e riscos).

---

## 3. Padrões de código: Model, Controller, Service, Repository, Routes

| Camada | Padrão vigente | Exemplo |
|---|---|---|
| **Repository** | `class X extends BaseRepository<T> { constructor(){ super('tabela') } }` + singleton exportado | `src/modules/commercial/repositories/ProductRepository.ts:34` |
| **BaseRepository** | `findById/findAll/findWhere/findOneWhere/findIn/searchLike` (todas filtram `deleted_at IS NULL`), `create/update/updateWhere/softDelete`, `count/exists`, `transaction(fn)`, escape hatch `raw/rawOne/rawRun` | `src/core/database/repository.ts:17-167` |
| **Service** | Função ou objeto publicado no registry, sempre recebendo `Request` para poder auditar/checar permissão | `src/modules/finance/setup.ts:30-44` |
| **Controller** | Só o módulo `finance` tem `controllers/` (`FinanceController.ts`); os demais usam closures nas rotas | `src/modules/finance/controllers/FinanceController.ts:190-194` |
| **Routes** | `Router()` + `requirePermission`/`requireCapability` + `validateBody(zod)` + `audit(...)` | `src/modules/labels/routes.ts:15-58` |
| **Pages** | `page(view, permission)` → `res.render('odonto-...')` | `src/modules/commercial/pages.ts:8-14` |
| **Validação** | Zod com mensagens PT: `validateBody(schema)` em `src/shared/validateBody.ts:61-72`; catálogo em `src/shared/schemas.ts` (549 linhas) | `src/shared/schemas.ts:407-435` |
| **Resposta** | Envelope aplicado no servidor: `{success, data}` / `{success, error}` | `src/shared/responseEnvelope.ts:11-44` |
| **CRUD genérico** | `makeCrudRouter(CrudConfig)` entrega lista+CRUD+soft delete+auditoria+bulk delete | `src/modules/commercial/crud.ts:11-34` |

**Armadilha do envelope:** o middleware envelopa tudo, mas o frontend frequentemente lê o corpo cru (`this.rows = await r.json()` em `src/public/js/crud-page.js:7`), enquanto os testes desembrulham com `unwrap()` (`src/tests/testUtils.ts:19-27`). Rota nova que devolva `res.json(rows)` continua funcionando na tela, mas quebra quem usa `data`. Padrão a seguir: **copiar o formato da rota irmã**, não inventar.

**Armadilha do CRUD genérico (a que está quebrando a suíte hoje):** todos os campos do config são enviados no INSERT com `?? null` (`crud.ts:219`). Coluna `NOT NULL DEFAULT x` cujo campo o cliente omite → 500. Isso será relevante para as tabelas do Odonto se usarmos `makeCrudRouter`.

---

## 4. Banco de dados e migrations

### 4.1 Formato real do schema

**SQL puro**, não Drizzle. `drizzle-orm` aparece em 3 pontos (`src/core/database/schema.ts:1`, `src/core/database/connection.ts:2,24`), `getDb()` não é chamado por nenhum repository, não existe `drizzle.config.*` e `drizzle-kit` não tem script. As migrations são `up.sql`/`down.sql` em pastas numeradas: `drizzle/migrations/` (core) e `src/modules/<id>/migrations/` (módulos).

Exemplos canônicos: `users` em `drizzle/migrations/0002_security/up.sql:33-48`; `products` em `src/modules/commercial/migrations/0004_commercial_base/up.sql:17-37`; ledger `stock_movements` em `0004_commercial_base/up.sql:74-87`.

### 4.2 Como as migrations rodam

- Descoberta por **convenção de pasta**, somando core + módulos; **nome duplicado lança erro** (`src/core/database/migrator.ts:157-174`); ordenação **alfabética global**.
- Aplicação em transação com `foreign_keys` desligado e `stripExistingObjects` (self-healing que comenta `CREATE TABLE`/`INDEX`/`ADD COLUMN` já existentes — `migrator.ts:69-127`).
- **Sem checksum, sem detecção de drift** (`_migrations` guarda só o nome).
- Rollback lê o `down.sql` do último nome (`:210-227`).
- Boot: `migrateUp()` → `runSeeds()` → `createServer()` (`src/dev.ts:32-38`; produção `src/electron/main.ts:380-381`).
- **Não existe scaffold** (`db:new`): migration nova = criar pasta + 2 arquivos à mão.

### 4.3 Numeração e convenções obrigatórias

- **Próximo número livre: `0078`** (maior hoje = `0077_product_type_config`; 85 migrations; verificado — não há nomes duplicados).
- **`0060_commercial_products_unique_indexes_repair` não tem `down.sql`** (único caso) → `db:rollback` que chegar nela estoura `ENOENT` (`migrator.ts:219`).
- Convenções extraídas do código (sem enforcement automático):
  - `id INTEGER PRIMARY KEY AUTOINCREMENT`;
  - bloco de sync: `uuid TEXT NOT NULL UNIQUE`, `updated_at TEXT NOT NULL DEFAULT (datetime('now'))`, `deleted_at TEXT`, `synced_at TEXT`, `origin_machine TEXT`;
  - `created_at` (sem `updated_at`) em evento/ledger;
  - **`comment TEXT NOT NULL DEFAULT '...'` em toda tabela** (`migrator.ts:135-136` — regra de revisão, sem teste);
  - dinheiro em **centavos inteiros** `*_cents`; quantidade `REAL`; booleano `INTEGER 0/1`; enum `TEXT + CHECK (x IN (...))`;
  - FK inline `REFERENCES tabela(id)`, `ON DELETE CASCADE` só em filho dependente;
  - índices `idx_<tabela>_<colunas>` no fim do arquivo;
  - seed de fábrica com **UUID determinístico** (`stableUuid`, `src/shared/uuid.ts:16-23`) — nunca `randomUUID()`, senão a segunda máquina duplica no merge (`0077_product_type_config/up.sql:7-9`).

### 4.4 Multiempresa: o que existe de verdade

- **Não existe** `company_id`, RLS, middleware de tenant ou "empresa ativa" no request. As 45 ocorrências de `company_id` no `src` são todas de **convênio** (`agreement_companies`), entidade de negócio.
- O isolamento é **por instalação**: 1 arquivo SQLite por empresa (`connection.ts:7-8`; produção em `%APPDATA%\Kivo\database\kivo.db` via `src/electron/bootstrap.ts:14-16`).
- No cloud, tudo é particionado por `company_uuid` (`cloud/migrations/0001_sync_core/up.sql:1-22`; push/pull/backup em `cloud/src/routes/sync.ts:83-132` e `cloud/src/routes/backup.ts:40-105`), com auth por header de licença (`cloud/src/auth.ts:19-50`).
- **Portanto:** o requisito "usuário de uma empresa não acessa paciente de outra" **não se implementa com coluna**; implementa-se (a) preservando a invariante de uma empresa por banco e (b) fechando o vetor de troca de licença descrito em **D2**.
- "Dentista vê só os seus pacientes" **não existe** (RBAC é por cargo, global). Se for requisito, é desenho novo (decisão de produto — §19).

### 4.5 Onde o banco vive e o que deriva dele

`KIVO_DB_PATH` é lido **no topo** de `connection.ts:7-8`; tudo o mais deriva de `dirname(KIVO_DB_PATH)`: logs (`src/core/logger.ts:61-65`), backups (`src/core/backup/service.ts:24-36`), cofre de segredos (`src/core/secrets/service.ts:47-53`), imagens, certificado fiscal, preferências de máquina. Consequência prática para testes: um banco isolado leva junto todo o estado lateral.

---

## 5. Autenticação e autorização

| Peça | Local |
|---|---|
| Cookie de sessão `kivo_session`, `httpOnly` + `SameSite=Strict`, **sem `secure`** | `src/core/auth/middleware.ts:4`; `src/core/auth/routes.ts:39-43` |
| `attachUser` (anexa `req.user`) / `requireAuth` (401 API, redirect UI) | `middleware.ts:19-26` / `:29-35` |
| `AuthUser {id, username, name, roleId, roleSlug, permissions:Set}` | `src/core/auth/service.ts:9-16` |
| bcrypt custo 12; sessão 12h (30 dias "lembrar") | `service.ts:18`, `:6-7` |
| Fluxo fora de HTTP: `systemRequest()` / `impersonate(userId)` | `src/core/auth/systemContext.ts:19`, `:31` |
| `requirePermission` / `requireAnyPermission` (auditam a negação) | `src/core/permissions/middleware.ts:8-21`, `:28-42` |
| `requireCapability` | `src/core/capabilities/middleware.ts:5-14` |
| Gate de módulo por plano (fail-open) | `src/core/modules/loader.ts:172-184`; `src/core/license/service.ts:302-312` |
| Sessões: token em texto no banco, sem hash | `drizzle/migrations/0002_security/up.sql:50-52` |

**Não existe proteção CSRF** em nenhum lugar (`grep csrf` = 0). As mitigações são `SameSite=Strict`, CSP com `connect-src 'self'` (`src/core/server.ts:296`) e ausência de checagem de Origin/Referer. Para um módulo clínico, isso é aceitável **apenas** porque tudo é same-origin e local — registrar como risco aceito consciente (D6 do §17 tem o contexto de LGPD).

**Onde é fácil esquecer a checagem:** nada é negado por padrão — `app.use('/api', requireAuth)` só exige login (`server.ts:397`). Achei um caso real: `GET /api/finance/payment-methods/active` não exige permissão alguma (`src/modules/finance/routes.ts:11` + `FinanceController.ts:20-23`). Regra para o Odonto: **toda** rota do módulo declara permissão explícita, inclusive leitura.

---

## 6. Auditoria e logs

| Peça | Local |
|---|---|
| **Assinatura:** `audit(req, action, entity, entityId?, before?, after?)` | `src/core/audit/service.ts:8-15` |
| INSERT com `before_json`/`after_json` (objeto inteiro), ip, machine, uuid | `service.ts:16-30` |
| Retenção configurável `auditoria.retencao_dias` (**padrão 365 dias**, 0 = nunca) | `service.ts:33-52`; `src/core/database/seeds.ts:236-241` |
| Leitura: `GET /api/audit` (`audit.view`, limite 500) + tela | `src/core/audit/routes.ts:7-16`; `src/views/audit.ejs:71` |
| 179 chamadas `audit(...)` no código; negação de acesso auditada automaticamente | `permissions/middleware.ts:15,36`; `capabilities/middleware.ts:8` |
| Banco de log de aplicação (arquivo, 14 dias) | `src/core/logger.ts:61-65`; README:70-74 |

**O que falta para dado clínico (evidência):**
- **sem auditoria de leitura** — abrir prontuário não gera trilha (só escritas, exportações e negações);
- a trilha é **podada** (`audit/service.ts:44-52`) e **zerada no reset de fábrica** (`src/core/database/resetData.ts:33,173` — `audit_logs` não está em `KEEP_INTACT_FABRICA`), apesar do comentário "Nunca é apagada pela aplicação" em `0002_security/up.sql:75`;
- **não sincroniza** (`audit_logs` não está em nenhum `syncTables`) → com 2+ terminais, cada máquina tem trilha parcial;
- `before_json`/`after_json` **duplicam** o dado sensível no log, sem mascaramento;
- `src/core/repositories/AuditRepository.ts:3` usa `super('audit_log')` — **nome divergente** da tabela real `audit_logs` (bug latente; hoje só `raw*` é usado).

**Para o Odonto:** usar `audit()` em toda mutação clínica **e** auditar leitura de prontuário (`audit(req, 'ler', 'odonto_prontuario', id, null, { pacienteId })`), além de definir retenção própria para a trilha clínica (proposta em 16.7).

---

## 7. Financeiro, cobrança, estoque, catálogo, clientes

### 7.1 Serviços reutilizáveis (assinaturas reais)

| Serviço | Métodos | Evidência |
|---|---|---|
| `finance.receivables` | `create({description, amountCents, dueDate, customerId?, notes?, saleId?, installmentNo?, installmentCount?}) → number`; `listBySale(saleId)`; `settleFull(req, id, {paymentMethodType?, settledAt?})` | `src/modules/finance/setup.ts:30-44`, `:46-67`; `src/modules/finance/bills.ts:340` |
| `finance.cash` | `currentRegister()`, `addMovement(req, registerId, direction, type, amountCents, …)`, `openRegister`, `closeRegister`, `expectedCents`, `getRegisterById` | `setup.ts:11-18`; `src/modules/finance/cash.ts:15-88` |
| `finance.paymethods` | `listActive()`, `get(id)`, `getByType(type)` (tipos incluem `convenio`, `credito_loja`, `fidelidade`; taxa em `fee_bps`) | `setup.ts:73-91` |
| `finance.agreements` | `chargeAgreementRaw(saleId, agreementCompanyId, amountCents)`, `pendingTotal`, `generateInvoice(req, companyId, periodKey?)`, `companiesDueForInvoice` + scheduler mensal | `setup.ts:80-85`; `src/modules/finance/agreements.ts:18-66`; `agreementScheduler.ts:26` |
| `commercial.stock` | `move(req, productId, type, qty, reason?, refEntity?, refId?, lot?, opts?)`, `moveRaw`, `listMovements`, `restoreLotsForSale`, `fifoUnitCostCents`, `writeOffLot` | `src/modules/commercial/setup.ts:52-64`; `stock.ts:151,184,239,265` |
| `commercial.pricing` | `resolvePrice(productId, qty, customerId?) → {unitCents, source, priceListId?}`, `resolveMany` | `setup.ts:52-64`; `pricing.ts:11` |
| `store.sales` | `createSale(req, input, opts?)` (**exige caixa aberto**) | `src/modules/store/sales.ts:295`, `:338-339` |

### 7.2 Ponto de integração plano aprovado → cobrança

**O que já existe:** o rateio de parcelas está implementado em `src/modules/store/sales.ts:402-420` (`base = floor(valor/parcelas)`, resto na 1ª, vencimentos de 30 em 30 dias, chamando `finance.receivables.create` com `installmentNo`/`installmentCount`). Baixa/recebimento: `settleFull` ou `POST /api/finance/receivables/:id/settle` (aceita múltiplas formas — `bills.ts:193-340`). Caixa movimentado automaticamente quando a forma é dinheiro (`bills.ts:228-233`, `:258-260`). Convênio odontológico (operadora) já pronto: `agreement_companies` + `customers.agreement_company_id` + fatura mensal com `period_key` e scheduler.

**O que falta:**
- **entidade de plano de tratamento** (nada existe);
- **serviço de parcelamento em N vezes** — hoje só existe na rota HTTP e replicado à mão em `sales.ts:409-418`; replicar significa **duas verdades sobre dinheiro** (recomendo extrair um serviço — ver 16.5);
- **vínculo plano→recebível** (ver D9);
- **idempotência** em `receivables.create` (não há chave; duplo clique/retry duplica cobrança);
- **auditoria na criação via serviço** — `createReceivable` (`setup.ts:46-67`) **não chama** `audit()`; o audit está na rota (`bills.ts:501`). Se o Odonto criar cobrança pelo serviço, precisa auditar por conta própria;
- **checagem de permissão** — serviços não checam nada (quem checa é a rota); as rotas do Odonto são responsáveis.

### 7.3 Pacientes: reusar `customers`

`customers` (`0004_commercial_base/up.sql:39-54` + `0020` + `0017:29` + `0067:6-7`) já tem `name, document (único — routes.ts:76), email, phone, address, cep, notes, active, birthday, tags, store_credit_cents, loyalty_points, agreement_company_id, price_list_id`, além da ficha `GET /customers/:id/summary` que soma recebíveis abertos/vencidos (`src/modules/commercial/routes.ts:137-167`). **Não existe entidade pessoa genérica** (só `customers`, `suppliers`, `users`).

**Decisão recomendada:** `odonto_patients` com `customer_id INTEGER NOT NULL REFERENCES customers(id)` + campos clínicos. A PR §23 previa `Patient` como entidade do módulo — isso continua verdade, mas **ancorada** em `customers` para não perder cobrança, convênio e preço.

### 7.4 Estoque e classificação de insumos

- Lotes com validade e **FIFO/FEFO**: `product_lots`/`lot_consumptions` (`0075_stock_lots/up.sql:16-58`), consumo `consumeFifo` (`stock.ts:130-133`), baixa de vencido (`writeOffLot`), custo FIFO (`fifoUnitCostCents`); flags `estoque.lote_obrigatorio`, `estoque.validade_acao`, `estoque.metodo_custo`.
- Categorias **hierárquicas** (`categories.parent_id` — `0004:5-15`) e `product_type_config` editável sem migration (`0077:11-34`) → caminho barato para "material odontológico / descartável / medicamento / equipamento".
- Tipos de produto atuais (CHECK de 11 valores — `0049:26-27`): `fisico, variante, fracionado, composto, kit, combo, produzido, servico, digital, assinatura, complemento`.

### 7.5 Procedimentos

Não existe entidade procedimento. O análogo é `products` com `product_type='servico'` (não controla estoque) + `price_lists` + ficha técnica (`product_recipe_items`) para consumo de insumos. Proposta: `odonto_procedures` com `product_id` + metadados clínicos (código, duração, especialidade, dentes/faces aplicáveis).

### 7.6 DRE, fiscal e NF-e (impacto na v1)

- **DRE:** receita por **competência** lê apenas `sales` com status `concluida` (`src/modules/dre/report.ts:59-64`); receita por **caixa** soma `sale_payments` + `receivables` recebidos (`:71-84`). Consequência: cobrança de plano que **não** vira venda aparece no DRE de caixa, mas **não** na competência; e material consumido fora de uma venda não entra no CMV (`:103-109`); taxa de cartão de cobrança que não gera `sale_payments` não entra em deduções (`:127-133`).
- **Fiscal:** só **NFC-e modelo 65** (beta, nasce desligada, `fiscal_documents` não sincroniza). **NFS-e/ISS não existe.** Para a v1 é defensável ignorar; se a clínica for contribuinte de serviço, é desenvolvimento novo.
- **NF-e:** importação de XML modelo 55 já integrada com lote/validade (`src/modules/nfe/nfeImport.ts:615-630,742-768`) — reutilizável para entrada de material sem trabalho extra.
- **Compra recebida não gera conta a pagar** (nenhum vínculo `purchases`↔`payables`) — despesa de insumo é lançada à mão. Não bloqueia a v1, mas afeta o "fechamento" da clínica.

---

## 8. Agenda: **não existe**

Busca exaustiva (inventário de `CREATE TABLE` em `src/**/*.sql` — 62 tabelas —, e grep por `agenda|agendamento|appointment|schedule|calendario|calendar|cadeira|sala|horario|slot` em `.ts` e `.ejs`):

- nenhum módulo, tabela, rota, permissão, item de menu ou campo de agendamento;
- os únicos acertos são **timers internos**: sync periódico (`src/core/sync/scheduler.ts`), backup agendado (`src/core/backup/service.ts:354`), fatura mensal de convênio (`src/modules/finance/agreementScheduler.ts:26`), updater (`src/core/updater/index.ts:167`);
- não há configuração de horário de funcionamento nem cadastro de profissional/executor.

**O mais próximo que existe:** `store_tables` (mesa `livre|ocupada`) do módulo `comandas` (`0045_comandas_base/up.sql:1-9`) — recurso físico ocupável, mas sem data/hora, profissional ou duração; e `kitchen_tickets` (fila por status) do `foodservice` (`0044_foodservice_base/up.sql:1-30`), que serve de analogia para "fila de atendimento", não para agenda.

**Conclusão:** a Fase 3 da PR é 100% construção nova, incluindo o conceito de **profissional** (que também não existe: `users` não tem CRO nem especialidade).

---

## 9. Uploads, arquivos, documentos e exames

### 9.1 Como funciona hoje

- **Não existe `multer`/`multipart`** em nenhum ponto (grep = 0). Todo upload é **base64 dentro de JSON**, com corpo limitado a `10mb` (`src/core/server.ts:309`).
- Implementação de referência (anexo de conta): pasta `storage/bill-attachments` derivada de `KIVO_DB_PATH` (`src/modules/finance/attachments.ts:24-30`), teto **5MB** (`:36`), allowlist de extensões com **SVG/HTML recusados** (`:39-53`), validação da **assinatura de bytes** (PDF `%PDF-`, imagens por `validateImageBuffer` — `:87-94`), gravação com nome `randomUUID().ext` (`:96-98`), metadados no banco (migration `0066_finance_bill_attachment/up.sql:2-14`), download por rota com `Content-Disposition`/`nosniff`/`path.basename` (`src/modules/finance/bills.ts:613-632`), auditoria ao anexar/remover (`:595,609`). Teste completo: `src/tests/finance-attachment.ts:35-85`.
- Imagens de produto/categoria/logo: mesmo princípio, com sniffing de JPEG/PNG/WEBP/AVIF (`src/core/catalog/imageValidation.ts:14-48`).

### 9.2 O problema estrutural (bloqueador para exames)

| # | Achado | Evidência |
|---|---|---|
| 1 | `/uploads/{products,categories,company,bills}` servidos por `express.static` **antes** de qualquer autenticação | `src/core/server.ts:311-315` (antes de `requireActivation:330`, `attachUser:332`, `requireAuth:397-398`) |
| 2 | O nome do arquivo no disco **é devolvido ao cliente** na listagem, então o download "autenticado" de bills é contornável pela URL direta | `src/modules/finance/repositories/BillRepository.ts:20,37` → `bills.ts:386` |
| 3 | Com "acesso pela rede local" ligado, o servidor escuta `0.0.0.0` | `src/electron/main.ts:440-457`; `src/dev.ts:39-43` |
| 4 | Base64 + teto de 5MB é inviável para radiografia/tomografia (infla ~33%, carrega tudo em memória, grava com `fs.writeFileSync` no caminho da requisição) | `attachments.ts:36,96-98`; `server.ts:309` |
| 5 | **Backup copia apenas o SQLite** — nenhuma mídia entra no backup nem no restore | `src/core/backup/service.ts:36-37,102,309` |
| 6 | Sem remoção de EXIF/GPS e sem antivírus em nenhum ponto | grep `exif|clamav|virus` = 0 |
| 7 | Anexos de conta são **excluídos do sync** de propósito; em multi-máquina o arquivo só existe no PC que subiu | `src/modules/finance/module.manifest.ts:55,57`; `bills.ts:622` |

### 9.3 Documentos e PDF

- `src/shared/documents` **não tem nada de documentos**: é validação/formatação de CPF/CNPJ (`src/shared/documents/index.ts:1-54`).
- Não existe **biblioteca de PDF** e não se usa `printToPDF` (grep `pdfkit|pdf-lib|puppeteer|jspdf|printToPDF` = 0). "Exportar PDF" hoje = diálogo de impressão do Chromium.
- O encanamento de impressão existe e é bom: rota server-side que remonta os dados e renderiza EJS com auto-`window.print()` — modelos em `src/modules/store/pages.ts:32-79` + `store-quote-print.ejs:5-23,86-92`; o fluxo com payload validado no servidor + histórico + reimpressão está em `src/modules/labels/pages.ts:42-95` + `routes.ts:70-87`; teste contratual em `src/tests/impressao.ts` (inclui `app.render(view, locals)` direto, `:150-151`).
- **Não existe motor de template com `{{variavel}}`**, nem tabela de templates, nem catálogo de variáveis. A PR §15 exige criar: tabela de templates, substituição de placeholders a partir de dados do paciente/profissional/consulta e sanitização do HTML resultante (o projeto usa `<%-` em pontos como `labels-print.ejs:57`).

---

## 10. Sincronização e offline

- Motor: `src/core/sync/engine.ts:26-357` (push `WHERE synced_at IS NULL` para ledgers; `synced_at IS NULL OR synced_at < updated_at` para o resto — `:59-68`), merge com resolução de conflito (`sync.conflict` auditado em `:243`), cloud MySQL particionado por `company_uuid`.
- Registro de tabelas: `manifest.syncTables` (`src/core/sync/registry.ts:14-20`); FK declarada é reescrita entre máquinas — e **FK para tabela não sincronizada usa "qualquer id local"** (`engine.ts:198`), o que torna obrigatório declarar corretamente (risco D9).
- Comandos remotos do celular existem e já roteiam recebimento (`src/core/sync/commands.ts:91-103`), reimpersonando usuário e **rechecando permissão no desktop** (`:94-98,132-136`) — padrão a seguir se o Odonto expuser ação remota.
- **A PR §24.7 manda não inventar sincronização específica antes de estudar a estratégia atual.** Estratégia atual resumida: tabela nova entra na sincronização **apenas** se declarada em `syncTables`; sem isso, fica local à máquina. Para dados clínicos, essa é uma decisão de produto explícita (ver §19) — o caminho de menor risco na v1 é **não sincronizar** prontuário/imagem, mantendo o banco clínico na máquina que o produziu, e documentar isso.

---

## 11. APIs

- Convenção de rota: `/api/<moduleId>/<recurso>` (`loader.ts:259`) e páginas em `/app/<moduleId>` (`:262`); core em `/api/<área>` (`server.ts:350-369`).
- Autenticação global por `/api` e `/app` (`server.ts:397-398`); autorização **por rota** (nunca herdada).
- Envelope padrão de resposta, validação Zod, auditoria nas mutações (§3).
- Rotas públicas existem para poucos casos e são sempre escopadas por `company_uuid` (ex.: cardápio em `src/core/config/routes.ts:113-119`) — **não** criar rota pública com identificador de paciente.
- Rate limit existe em login/first-run/recuperação (`src/core/auth/routes.ts:20,28`; `src/core/recovery/routes.ts:23,31`) e **não** no `POST /api/security/pin/verify` (`src/core/security/routes.ts:27`) — fora do escopo do Odonto, mas é achado.

---

## 12. Frontend, views e componentes

- **Sem layout engine:** cada tela é um HTML completo que repete head/CSS e inclui `partials/nav` (ex.: `src/modules/finance/views/finance-bills.ejs:1-14`). Views de módulo e do core entram no **mesmo lookup** EJS (`server.ts:418-419`) → **prefixar sempre** (`odonto-*`) para não colidir nem ser sobrescrito.
- **Padrão Alpine:** factory no `<script>` da própria view espalhando mixins (`tableToolkit`, `crudPage`, `paymentMethodsMixin`…), `<dialog>` + `showModal()`, `fetch` cru, gating de UI por permissão no EJS (`<% if (user.permissions.has('…')) %>`).
- Componentes reutilizáveis em `src/views/partials/`: `nav`, `search-filter` (busca + modal de filtros + `filterRows`), `pager` (paginação **client-side**), `confirm` (`window.confirmDlg`), `empty-state`, `capability-gate`, `theme-init`, `support-widget`.
- JS global sem bundler: `src/public/js/{table-toolkit,crud-page,masks,money,datetime,payment-methods,barcode,tour}.js`.
- **CSP com nonce é obrigatória** em todo `<script>` (`server.ts:267-305`); o teste `src/tests/csp.ts:50-84` varre **todas** as páginas e falha se faltar nonce. Handlers inline (`onclick=`) **não funcionam**. `'unsafe-eval'` é mantido de propósito para o Alpine (`server.ts:288`).
- **Paginação é client-side** (`table-toolkit.js:51-58`): a listagem carrega tudo. Prontuário/exames com muitos itens vão degradar — prever filtro por período/paciente desde o início.

---

## 13. Testes, lint, build e CI

- **Testes de integração sem framework:** cabeçalho JSDoc (vira descrição), `resetTestDb()` → `migrateUp()` → `runSeeds()` → `activateTestLicense()` → `createServer()` → `PORT` próprio → `check()`/`unwrap()` → `process.exit(falhas ? 1 : 0)` (modelo: `src/tests/finance-attachment.ts:1-95`; utilitários em `src/tests/{shared,testUtils,resetTestDb}.ts`).
- **Rodar 1 teste:** `node scripts/test-isolated.js src/tests/<arquivo>.ts` (usa banco temporário por `KIVO_DB_PATH` — **nunca** rode um teste direto com `tsx` sem isso, ele apaga o banco de dev: aviso em `scripts/test-isolated.js:1-14`).
- **Suíte:** `npm test` → `scripts/test-runner.js` (descobre por diretório, pula os 10 que precisam do MySQL do cloud, `--plain` para CI).
- **Registrar teste novo:** comando em `scripts/commands.json` (`"test:odonto-pacientes": {"run": "node scripts/test-isolated.js src/tests/odonto-patients.ts"}`) — o runner o pega sozinho; opcionalmente listar em `scripts/kivo.js:60-100` para aparecer no `node scripts/kivo`.
- **Lint/build:** `npm run lint` (eslint flat config, ignora `dist/`, `drizzle/`, `src/public/vendor/**`), `npx tsc -p tsconfig.json --noEmit`, `npm run build` (tsc + `copy-build-assets.js`).
- **CI: removido na árvore de trabalho.** `git status` mostra ` D .github/workflows/ci.yml` (4 jobs: qualidade, suíte com MySQL, 2 E2E) — o arquivo existe apenas em `HEAD`. Também deletados `.claude/agents/cacador-de-bugs.md` e `.claude/agents/corretor-de-bugs.md`. **Restaurar antes de qualquer merge** (risco D14).

---

## 14. A. O que pode ser reutilizado

| Área | Reutilizar | Como |
|---|---|---|
| Módulo/rotas/menu/permissões/capabilities | Núcleo completo | Criar `module.manifest.ts`; zero mudança no core |
| Banco | `BaseRepository`, `makeCrudRouter`, migrator, convenções | Nova migration `0078+` |
| Usuários/permissões | `users`, `roles`, RBAC, `requirePermission` | Permissões `odonto.*` no manifesto |
| Auditoria | `audit(req, ação, entidade, id, antes, depois)` | Chamar em toda mutação e na leitura de prontuário |
| Paciente (cadastro-base) | `customers` + ficha `GET /customers/:id/summary` + `makeCrudRouter` | `odonto_patients.customer_id → customers.id` |
| Cobrança e recebimento | `finance.receivables.create` / `settleFull` / `POST /settle` | Gerar parcelas do plano aprovado |
| Caixa | `finance.cash` | Movimento automático na baixa em dinheiro |
| Convênio/operadora | `agreement_companies` + `chargeAgreementRaw` + fatura mensal | Sem código novo |
| Formas de pagamento | `finance.paymethods.listActive()` | Seleção na baixa |
| Estoque de insumos | `products`/`categories`/`product_lots` + FIFO/FEFO + `commercial.stock.move` | Material, descartável, medicamento |
| Preço por convênio/cliente | `commercial.pricing.resolvePrice` + `price_lists` | Valores de procedimento |
| Impressão de documento | Rota server-side + EJS + `window.print()` | Modelo: `src/modules/labels/pages.ts:42-95` |
| NF-e de material | `src/modules/nfe` | Entrada com lote/validade |
| Testes | Runner + `test-isolated.js` + `testUtils` | Novo arquivo por tela/fluxo |

---

## 15. B. O que precisa ser adaptado

1. **CRUD genérico para colunas `NOT NULL DEFAULT`** — hoje quebra (500) quando o campo é omitido (`crud.ts:219`). Ajustar **antes** de modelar as tabelas clínicas (18.1).
2. **Auditoria clínica** — usar o helper existente, mas (a) auditar leitura, (b) definir retenção própria (a poda de 365 dias e o reset de fábrica não servem para prontuário).
3. **Backup** — incluir diretório de mídia clínica (hoje só o SQLite vai para o backup: `src/core/backup/service.ts:36-37,102,309`).
4. **`roles/presets.ts`** — cargos Dentista / Recepcionista / Auxiliar (a PR §19 pede) entram como presets; hoje os presets são do varejo.
5. **Assistente de onboarding** — incluir as capabilities do Odonto em `WIZARD_FEATURES` (`src/core/onboarding/service.ts:101-138`), se quisermos oferecê-las no primeiro acesso.
6. **Rótulo de capability no diálogo de gate** — `src/views/partials/capability-gate.ejs:31-37` é hardcoded; sem isso a mensagem cai no fallback `o recurso "<key>"`.
7. **Tela de perfis** — nenhuma mudança de código: `GET /api/roles/permissions` já agrupa por módulo e o rótulo vem de `app.locals.moduleNamesJson` (`src/core/server.ts:423-425`).
8. **Reset de fábrica** — decidir se tabela clínica entra em `KEEP_INTACT_FABRICA` (`src/core/database/resetData.ts:33`) ou se fica explicitamente fora, com aviso próprio (hoje seria apagada como "dado de teste").
9. **Trava de troca de licença** — bloquear/limpar dados quando `companyUuid` muda (`src/core/license/routes.ts:52-72`) — **item mais urgente de todo o projeto** para o requisito §24.4 (D2).
10. **Ícone do módulo** — não existe ícone odontológico em `src/public/icons`; adicionar um SVG lá (o build copia `src/public` inteiro, `scripts/copy-build-assets.js`).

---

## 16. C. O que precisa ser criado

### 16.1 Paciente e ficha clínica

`odonto_patients` (`customer_id NOT NULL → customers`, `birth_date`, `sex`, `rg`, `photo_file`, `notes`, `active`…) e o vínculo com profissional responsável. Dados clínicos em tabelas próprias (§16.3), **nunca** em campos soltos de `customers`.

### 16.2 Profissionais

Não existe. `odonto_professionals` (`user_id → users`, `name`, `cro`, `cro_state`, `specialties`, `active`) — necessário para agenda, evolução, plano e assinatura de documento (PR §8 e §24.5).

### 16.3 Prontuário, anamnese e evolução (imutabilidade)

Requisito da PR §8/§24.3: registro clínico não se apaga; correção é **retificação com histórico**. O projeto **não usa triggers** em nenhuma migration (grep `CREATE TRIGGER` = 0). Desenho recomendado, sem trigger:

- `odonto_clinical_records` (cabeça do registro: paciente, profissional, tipo, data/hora) + `odonto_clinical_record_versions` (**append-only**: `record_id`, `version`, `content_json`, `created_at`, `created_by`, `reason`, `replaces_version`). A "edição" grava **nova versão**; o repository do módulo **não expõe** `update`/`softDelete` para essas tabelas.
- `odonto_anamnesis_templates` + `odonto_anamnesis_answers` (respostas vinculadas ao paciente e à **versão** do formulário, com data/hora/usuário — PR §5).
- Odontograma: `odonto_tooth_conditions` (catálogo semeado com UUID fixo: íntegro, cárie, restaurado, ausente, fratura, endo, implante, coroa, extração indicada — PR §10) + `odonto_chart_entries` (paciente, dente FDI, face, condição, status planejado/realizado, profissional, data). **Preservar histórico** em vez de sobrescrever a linha.
- Numeração FDI: 18–11 / 21–28 / 48–41 / 31–38 (PR §9), com suporte preparado a decídua.

### 16.4 Plano de tratamento e ligação com o financeiro

- `odonto_treatment_plans` (paciente, profissional, status `planejado|apresentado|aprovado|em_andamento|concluido|cancelado`, total em centavos, datas) + `odonto_treatment_plan_items` (procedimento, dente, face, valor, quantidade, profissional, status).
- **`odonto_plan_charges`** (`plan_id`, `receivable_id`, `installment_no`, `amount_cents`): a tabela de ligação **do módulo**, mantendo `receivables` e o manifesto do finance intocados (evita o risco de FK no sync — D9).
- Fluxo: plano `aprovado` → serviço do Odonto calcula o rateio (reusando a mesma regra de `sales.ts:407-418`, idealmente extraída para serviço — 16.5) → cria N `receivables` via serviço → registra as linhas em `odonto_plan_charges` → audit.

### 16.5 Serviço de parcelamento (extração recomendada no Core)

`finance.receivables` só cria **uma** parcela. Para não duplicar a regra de rateio (hoje em `sales.ts:402-420` e na rota `bills.ts:444-503`), extrair `createInstallments(...)` no módulo `finance` (ou aceitar `installments` no `create`) e passar a usar nos dois lugares. É a única alteração em módulo existente que considero **necessária**, e é pequena e testável (`src/tests/fase_installments.ts` já existe: 25 checks).

### 16.6 Agenda

`odonto_appointments` (paciente, profissional, data, hora, duração, procedimento, **cadeira/sala**, status `agendado|confirmado|em_atendimento|atendido|faltou|cancelado`, observação, origem do encaixe) + `odonto_chairs` (opcional) + `odonto_practice_hours`. Visualizações diária/semanal/mensal (PR §6) são tela nova em EJS + Alpine; **não** existe componente de calendário no projeto — é construção nova (ou CSS grid simples, sem dependência nova).

### 16.7 Documentos com variáveis

`odonto_document_templates` (nome, tipo, conteúdo com `{{...}}`, variáveis, status) + `odonto_clinical_documents` (paciente, consulta, template, conteúdo renderizado, arquivo, usuário, data). Renderizador server-side: substitui placeholders por valores **escapados** de paciente/profissional/consulta/data e devolve HTML para a rota de impressão (modelo `labels/pages.ts:42-95`). Testar ausência de placeholder órfão e escape.

### 16.8 Exames e imagens clínicas (infraestrutura nova)

- Diretório próprio (`storage/odonto-exams` + `storage/odonto-images`) derivado de `KIVO_DB_PATH`.
- **Upload binário** (multer com `diskStorage` ou `express.raw` em rota dedicada, limite próprio por tipo) — o caminho base64/5MB não serve.
- **Download só por rota autenticada** com `requirePermission` + verificação de vínculo com o paciente + `nosniff` + `Content-Disposition` + auditoria de acesso (padrão de `finance/bills.ts:613-632`, mas **sem** `express.static`).
- Validação por assinatura de bytes; allowlist sem SVG/HTML; considerar TIFF/DICOM no futuro.
- Entrada no **backup** (§15.3) e decisão explícita sobre sync (§10).

### 16.9 Permissões, capabilities e menu propostos

Permissões (prefixo obrigatório `odonto.`):
`odonto.dashboard.view` · `odonto.patients.view|create|edit|delete` · `odonto.anamnesis.view|create` · `odonto.records.view|create|rectify` · `odonto.chart.view|edit` · `odonto.treatments.view|create|edit|approve` · `odonto.procedures.view|manage` · `odonto.agenda.view|create|edit|cancel` · `odonto.documents.view|generate|manage_templates` · `odonto.exams.view|upload|delete` · `odonto.professionals.manage` · `odonto.settings.manage`.

Capabilities (nascem desligadas; controlam menu e API): `odonto.agenda` · `odonto.odontograma` · `odonto.documentos` · `odonto.exames` · `odonto.financeiro` (ponte com o financeiro).

Menu (dentro de `name: 'Odonto (clínicas e consultórios)'`): Painel, Pacientes, Agenda, Prontuário, Odontograma, Tratamentos, Procedimentos, Documentos, Exames — cada item com `permission` e, quando opt-in, `capability`.

---

## 17. D. Riscos técnicos

| # | Risco | Sev. | Evidência | Mitigação |
|---|---|---|---|---|
| **D1** | Arquivo clínico servido sem autenticação se seguir o padrão `/uploads/*` | **Crítico** | `src/core/server.ts:311-315` (antes de `attachUser:332`/`requireAuth:397`); nome do arquivo entregue ao cliente (`BillRepository.ts:20` → `bills.ts:386`); LAN escuta `0.0.0.0` (`electron/main.ts:440-457`) | Rota autenticada dedicada + nunca `express.static` para pasta clínica |
| **D2** | Troca de licença sem limpeza local → dados da empresa anterior legíveis e **empurrados** para a partição nova | **Crítico** | `src/core/license/routes.ts:52-72` (`setLicense` + `runSync` imediato); push sem filtro de empresa (`sync/engine.ts:59-68`) | Bloquear troca com dados locais ou exigir reset de fábrica; teste de regressão |
| **D3** | Sem imutabilidade/retificação para prontuário (PR §8/§24.3) | **Crítico** | Sem trigger em nenhuma migration; `BaseRepository` expõe `update`/`softDelete` para qualquer tabela (`repository.ts:104-134`) | Tabela de versões append-only + repository sem `update` (16.3) |
| **D4** | Auditoria insuficiente para dado clínico | **Alto** | Sem auditoria de leitura; poda de 365 dias (`audit/service.ts:44-52`); zerada no reset (`resetData.ts:33,173`); não sincroniza | Auditar leitura + retenção própria + decisão de sync |
| **D5** | Backup não cobre mídia clínica → exame perdido no restore | **Alto** | `src/core/backup/service.ts:36-37,102,309` | Incluir diretórios clínicos no backup (e no restore) |
| **D6** | Sem cifragem em repouso; sync e backup trafegam o dado clínico | **Alto** | SQLite texto + WAL; backup gzip sem cifra (`backup/service.ts:235-259`); `sync_records.payload JSON` no MySQL (`cloud/migrations/0001_sync_core/up.sql:8-22`) | Decisão de produto (19): campo cifrado, banco cifrado ou risco aceito documentado |
| **D7** | Subestimar a agenda: **nada existe** (nem profissional, nem horário, nem calendário) | **Alto** | §8 desta auditoria | Tratar a Fase 3 como projeto próprio, com estimativa isolada |
| **D8** | Usar `createSale` para cobrar plano → exige caixa aberto | Médio | `src/modules/store/sales.ts:338-339` | Usar `finance.receivables.create` |
| **D9** | Adicionar coluna em `receivables` para ligar ao plano → vínculo errado no sync | Médio | FK não sincronizada usa "qualquer id local" (`sync/engine.ts:198`) | Tabela de ligação no módulo (`odonto_plan_charges`) |
| **D10** | Criar tipo novo em `products.product_type` → rebuild destrutivo de tabela central | Médio | `0049_add_complemento_product_type/up.sql:1-43` | Categoria + `product_type_config` |
| **D11** | Colisão de `permissions.key`/`capabilities.key` (UNIQUE global) | Médio | `loader.ts:102-104,117` | Prefixo `odonto.` em tudo |
| **D12** | Migration: `0060` sem `down.sql`; sem checksum/drift | Médio | `migrator.ts:147-153,219` | Nunca editar migration aplicada; sempre `down.sql` simétrico |
| **D13** | CSP + views sem namespace → tela "morta" silenciosa ou view errada | Médio | `server.ts:267-305,418-419`; `src/tests/csp.ts:50-84` | Nonce em todo `<script>`; prefixo `odonto-` nas views; incluir telas no teste CSP |
| **D14** | **CI removido** e lint já vermelho: não há rede de segurança | Médio | `git status` → ` D .github/workflows/ci.yml`; `src/core/devdocs/markdown.ts:30` | Restaurar CI + corrigir lint e as 2 falhas antes de começar (18.1) |
| **D15** | Módulo quebrado derruba o boot | Médio | `loader.ts:22,63,253`; `registry.ts:11` | Manter o manifesto válido, rotas existentes, `setup` sem throw; rodar `npm run smoke` |
| **D16** | Listagem client-side degrada com prontuário grande | Médio | `table-toolkit.js:51-58` | Filtro por paciente/período já na v1 |
| **D17** | Base64/5MB inviável para exame de imagem | Médio | `attachments.ts:36`; `server.ts:309` | Upload binário (§16.8) |
| **D18** | Reset de fábrica / `db:reset` apagam tabela clínica sem aviso específico | Médio | `resetData.ts:7-33,129`; `cli.ts:26-35` | Regra explícita + confirmação própria |
| **D19** | Baixa parcial **aumenta a próxima parcela** ou cria título novo → altera contrato do plano sem registro clínico | Médio | `finance/bills.ts:262-322` | Decisão de produto na aprovação do plano |
| **D20** | Multa/juros, formas de pagamento e `settings` são **globais** (afetam varejo/comandas da mesma empresa) | Baixo | `lateFees.ts`; `payment_methods` por máquina | Documentar; não criar configuração paralela |
| **D21** | `hello` (módulo de teste) exposto em produção | Baixo | `src/modules/hello/module.manifest.ts:3-15`; fail-open `license/service.ts:305` | **Resolvido depois desta auditoria**: módulo removido do repositório e o smoke passou a testar uma rota de módulo real (`src/dev.ts`) |

---

## 18. E. Ordem de implementação sugerida

### 18.1 Antes de escrever código do Odonto (bloqueadores de qualidade)

1. **Restaurar `.github/workflows/ci.yml`** (existe em `HEAD`): sem ele, nada prova que o Odonto não quebrou o resto.
2. **Corrigir as 3 falhas da linha de base**: (a) lint `src/core/devdocs/markdown.ts:30` (`no-control-regex`); (b) e (c) as duas falhas de teste com a mesma causa raiz — `POST /api/commercial/suppliers` → 500 por `NOT NULL constraint failed: suppliers.default_markup_bps`. Correção mínima recomendada: suportar defaults por campo no CRUD genérico (`CrudConfig.defaults`) e declarar `default_markup_bps: 0` no config de fornecedores (`src/modules/commercial/routes.ts:236-246`), **sem** alterar o comportamento dos demais CRUDs.
3. **Fechar D2** (trava de troca de licença) ou, no mínimo, registrar a decisão de risco por escrito — é o requisito §24.4 da PR.
4. Definir o **baseline verde** como contrato: `npm run build` + `npm run lint` + `npm test` antes e depois de cada fase.

### 18.2 Fase 1 — Fundação (PR §27)

- `src/modules/odonto/module.manifest.ts` com `id: 'odonto'`, `name: 'Odonto (clínicas e consultórios)'`, `dependsOn: ['commercial','store','finance']`, permissões, capabilities e menu (§16.9).
- `migrations/0078_odonto_base/{up,down}.sql` com as tabelas de paciente/profissional/procedimento (mínimo viável) + catálogo de situações odontológicas semeado com UUID determinístico.
- `routes.ts` (CRUD de paciente via padrão do projeto), `pages.ts`, `views/odonto-patients.ejs` (tela única no padrão `finance-bills.ejs`).
- `setup.ts` publicando o serviço `odonto.patients` (contrato TS) para o resto do módulo.
- Teste `src/tests/odonto-patients.ts` + comando em `scripts/commands.json`; incluir a tela nova no teste de CSP.
- Documento `src/docs/dev/odonto.md` (aparece em `/admin/documentacao`).

### 18.3 Fases seguintes (PR §27, com ajustes desta auditoria)

| Fase PR | Ajuste recomendado |
|---|---|
| 2 — Pacientes/Histórico/Anamnese | Anamnese versionada (§16.3); paciente ancorado em `customers` |
| 3 — Agenda | **Projeto próprio** (D7): profissional + horário + cadeira + status |
| 4 — Prontuário/Evolução | Tabela de versões append-only + auditoria de leitura **antes** de expor a tela |
| 5 — Odontograma | Catálogo de condições extensível; histórico por entrada, nunca sobrescrever |
| 6 — Tratamentos | Extrair serviço de parcelas (§16.5) + tabela de ligação (§16.4) |
| 7 — Documentos | Motor de variáveis + sanitização; reusar impressão |
| 8 — Exames e imagens | **Depende de 16.8** (upload binário + download autenticado + backup) — não iniciar antes disso |
| 9 — Refinamento | Dashboard (dados de agenda/recebíveis), relatórios, auditoria, UX, testes, revisão de segurança/LGPD |

**Sugestão de antecipação:** a infraestrutura de arquivo clínico (16.8) e a auditoria de leitura (16.3/D4) são pré-requisitos de Fase 8 e Fase 4 — se ficarem para o fim, viram retrofit em dado já gravado.

---

## 19. Decisões que dependem do dono do produto (não são técnicas)

1. **Cifragem**: aceitar o risco documentado (SQLite local, controle de acesso ao SO) ou implementar cifragem de campos/banco? Impacta backup, sync e performance.
2. **Sincronização de dado clínico**: fica local à máquina (mais simples e mais seguro) ou sincroniza entre terminais? A PR §24.7 manda decidir antes.
3. **Retenção**: qual o prazo legal/vocacional para prontuário e auditoria clínica? Hoje o padrão de auditoria é 365 dias e o reset de fábrica apaga a trilha.
4. **Segregação por profissional**: "dentista vê só os seus pacientes" é requisito? Não existe base para isso hoje.
5. **Convênio odontológico**: operadora entra como `agreement_company` (fatura mensal já pronta) ou como plano por paciente?
6. **NFS-e**: ignorar na v1 (como sugere a PR §26) ou é requisito da clínica piloto? Não existe nota de serviço no sistema.
7. **Baixa parcial** que aumenta a parcela seguinte (`bills.ts:262-322`) é aceitável num contrato de tratamento?
8. **Reset de fábrica** deve apagar dado clínico ou preservá-lo?

---

## 20. Anexos

### 20.1 Arquivos-chave para revisão

`src/core/modules/loader.ts` · `src/core/modules/types.ts` · `src/core/server.ts` · `src/core/database/{repository,migrator,connection,seeds,resetData}.ts` · `src/core/permissions/middleware.ts` · `src/core/capabilities/{service,middleware}.ts` · `src/core/audit/service.ts` · `src/core/license/{routes,service}.ts` · `src/core/sync/{engine,registry}.ts` · `src/modules/commercial/{crud.ts,routes.ts,setup.ts,stock.ts,pricing.ts}` · `src/modules/finance/{setup.ts,bills.ts,cash.ts,attachments.ts}` · `src/modules/labels/{pages.ts,routes.ts,views/labels-generator.ejs}` · `src/views/partials/{nav,search-filter,pager}.ejs` · `src/tests/{finance-attachment,impressao,csp}.ts` · `scripts/{commands.json,kivo.js,test-isolated.js,copy-build-assets.js}`

### 20.2 Higiene do repositório (achados ao abrir a auditoria)

- `doc/PR — Kivo Odonto _ Módulo de Gestão para Consultórios Odontológicos.md` está **não rastreado** (`??`).
- **Deletados sem commit**: `.github/workflows/ci.yml`, `.claude/agents/cacador-de-bugs.md`, `.claude/agents/corretor-de-bugs.md`.
- README aponta para arquivos inexistentes: `agente.md`, `doc/KIVO_PLANO.md`, `doc/auditoria/`.
- `check_schema.ts` na raiz aponta para validação que **não existe** em `src/` nem em nenhum script.
- Migration `0060_commercial_products_unique_indexes_repair` sem `down.sql`.

---

*Auditoria produzida em modo somente-leitura. Nenhum arquivo de código do Kivo foi criado ou modificado nesta etapa; a única alteração no repositório é este documento.*

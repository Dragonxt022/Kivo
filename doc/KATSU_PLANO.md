# Katsu — Plano de Desenvolvimento

> **Rascunho v0.1** — plataforma comercial modular desktop-first.
> Documento vivo. Serve de referência para desenvolvimento humano **e** para execução por agente.

---

## 1. Visão do produto

Katsu não é "um sistema para restaurantes". É uma **plataforma comercial modular**: um núcleo estável (Core) sobre o qual se instalam *Apps* de segmento (Restaurante, Mercado, Farmácia, Oficina, etc.), como aplicativos em um celular.

O sistema cresce conforme o cliente cresce. O cliente instala apenas o que usa.

**Princípios inegociáveis:**

1. **Core independente de segmento.** Nenhuma regra de negócio de segmento pode vazar para o Core.
2. **Offline-first.** Tudo funciona sem internet; a nuvem é sincronização e serviços, nunca dependência de operação.
3. **Segurança primeiro.** Autenticação, permissões e auditoria são a Fase 1, não um recurso posterior.
4. **IDs universais (UUID) para sincronização.** O ID interno do SQLite nunca cruza máquinas.
5. **Cada módulo atualiza sozinho.** Sem obrigar atualização do sistema inteiro.

---

## 2. Arquitetura em 4 camadas

```
Katsu
│
├── Core       → nunca muda; infraestrutura reutilizável
├── Shared     → funções puras reaproveitáveis (money, cpf, pdf, pix...)
├── Apps       → segmentos de negócio (restaurant, market, pharmacy...)
└── Plugins    → extensões de terceiros (futuro)
```

### Regra de dependência (crítica para o agente)

```
Plugins  →  Apps  →  Shared  →  Core
```

A seta indica "pode importar de". **Nunca o contrário.** Core não conhece Apps. Shared não conhece Apps. Um App não importa de outro App diretamente — comunicação entre Apps passa por eventos/serviços do Core.

---

## 3. Stack tecnológica

| Camada | Escolha | Observação |
|---|---|---|
| Runtime desktop | **Electron** | empacotamento e auto-update |
| Servidor local | **Express 5** | API local (localhost) dentro do Electron |
| Linguagem | **TypeScript** | padrão em todo o projeto |
| Banco local | **better-sqlite3** | síncrono, muito mais rápido que `sqlite3` |
| ORM / query builder | **Drizzle ORM** | migrations versionadas, tipagem forte |
| Padrão | **MVC + Services/Repositories** | camadas explícitas |
| Nuvem (VPS) | Node + Express + MySQL | painel admin, licenças, sync — código em `cloud/` |

---

## 4. Estrutura de pastas

```
katsu/
├── src/
│   ├── core/
│   │   ├── auth/            # login, sessão, hash, remember
│   │   ├── security/        # rate-limit, sanitização, headers
│   │   ├── users/           # CRUD usuários, cargos
│   │   ├── permissions/     # RBAC por módulo/ação
│   │   ├── audit/           # logs de auditoria
│   │   ├── database/        # conexão, migrations, seeds
│   │   ├── sync/            # motor de sincronização (UUID)
│   │   ├── cache/
│   │   ├── logs/
│   │   ├── backup/
│   │   ├── license/         # validação de licença/plano
│   │   ├── notifications/
│   │   ├── printing/        # impressão térmica/A4
│   │   ├── reports/         # engine de relatórios
│   │   ├── updater/         # auto-update app + módulos
│   │   └── config/
│   │
│   ├── shared/
│   │   ├── money/           ├── cpf/            ├── cnpj/
│   │   ├── cep/             ├── phone/          ├── dates/
│   │   ├── masks/           ├── validators/     ├── pdf/
│   │   ├── qrcode/          ├── barcode/        ├── pix/
│   │   ├── taxes/ (ncm/cfop)├── ibge/           └── xml-danfe/
│   │
│   ├── modules/            # os "Apps"
│   │   ├── restaurant/
│   │   ├── market/
│   │   ├── pharmacy/
│   │   ├── workshop/
│   │   ├── carwash/
│   │   └── electronics/
│   │     └── (cada módulo:) controllers/ models/ views/ routes/
│   │         services/ repositories/ permissions/ config/ migrations/
│   │
│   ├── routes/            # registro central de rotas
│   ├── public/            # assets estáticos
│   ├── electron/          # main process, preload, janelas
│   └── config/
│
├── storage/  temp/  uploads/  database/
├── drizzle/              # migrations geradas
├── cloud/                # servidor de nuvem (Fase 6a): Node + Express + MySQL,
│                          # deploy independente do Electron app (package.json próprio)
├── package.json
└── KATSU_PLANO.md
```

**Contrato de módulo.** Cada App expõe um `module.manifest.ts`:

```ts
export default {
  id: 'restaurant',
  name: 'Restaurante',
  version: '1.0.0',
  requiresCore: '>=1.0.0',
  permissions: ['restaurant.orders', 'restaurant.kitchen', ...],
  migrations: './migrations',
  routes: './routes',
  menu: [ /* itens de menu injetados na UI */ ],
}
```

O Core descobre, valida e carrega módulos a partir desse manifesto. Instalar/remover um App = registrar/desregistrar o manifesto + rodar/reverter migrations.

---

## 5. Roadmap por fases

Cada fase abaixo tem: **objetivo · entregáveis · definição de pronto (DoD)**. Um agente deve concluir a DoD de uma fase antes de abrir a próxima.

### Fase 0 — Arquitetura e fundação
**Objetivo:** esqueleto executável com sistema de módulos funcionando (mesmo vazio).
**Entregáveis:**
- Projeto Electron + Express 5 + TypeScript rodando.
- `better-sqlite3` + Drizzle configurados, primeira migration.
- Loader de módulos lendo `module.manifest.ts`.
- Auto-updater esqueleto (app e módulos separados).
- Padrões de código: ESLint, Prettier, estrutura de commits, scripts npm.
**DoD:** app abre, carrega um módulo "hello" fictício via manifesto, migration roda e reverte.

**Empacotamento (adicionado depois, pré-requisito para instalar em máquina de cliente):**
`npm run dist:win` gera um instalador NSIS (`dist-installer/Katsu Setup *.exe`) via
`electron-builder` (`asar: false` — evita complexidade de módulo nativo dentro de asar;
`better-sqlite3` é recompilado para o ABI do Electron automaticamente no build, ou via
`npm run rebuild:electron` para testar `electron .` localmente). Corrigido também um bug
real descoberto ao testar o build compilado pela primeira vez: `src/core/modules/loader.ts`
usava `import(pathToFileURL(p).href)` para carregar manifestos — o `tsc` (module:
commonjs) rebaixa isso para `require(url)`, que não aceita URL `file://` como
especificador; só quebrava rodando `node` puro sobre o build (nunca em dev via `tsx`).
Corrigido para `require(p)` direto. Os caminhos de `migrator.ts`/`loader.ts`/`server.ts`
que antes dependiam de `process.cwd() + 'src/...'` agora são relativos a `__dirname`
(funcionam tanto em dev quanto no app empacotado, cujo `dist/` espelha a estrutura de
`src/` via `scripts/copy-build-assets.js`). Banco de dados e backups locais vão para
`app.getPath('userData')` quando empacotado (`src/electron/bootstrap.ts`/`main.ts`), não
para a pasta de instalação. Ponto de configuração da URL de produção do `cloud/`:
`src/core/config/cloud.ts` (precisa ser preenchido antes de gerar o instalador para
clientes reais). Tela de licença (`/admin/configuracoes`) ganhou formulário editável de
`company_uuid`/`license_key` + botão "Sincronizar agora" — antes só existia a rota de
API, sem interface. Assinatura de código (code signing) do `.exe` fica pendente.

**Segundo bug real, achado só no teste em máquina de verdade** (o sandbox de
desenvolvimento não consegue abrir janela do Electron para testar isso): o app
instalava e o processo aparecia no Gerenciador de Tarefas, mas nenhuma janela abria.
Causa: `seedPackagedBackupDir()` (`src/electron/main.ts`) inseria na tabela `settings`
sem a coluna `uuid` (`NOT NULL UNIQUE`, sem default) — o `INSERT` lançava
`NOT NULL constraint failed: settings.uuid`, a promise de `boot()` rejeitava sem
nenhum `.catch()`, e a `BrowserWindow` nunca chegava a ser criada. Corrigido (gera
`uuid` como todo outro INSERT em `settings` já faz, ex.: `src/core/config/routes.ts`) e
**adicionado tratamento de erro fatal no boot**: qualquer falha agora grava
`boot-error.log` em `app.getPath('userData')` e mostra uma caixa de diálogo antes de
fechar — antes, uma falha assim ficava completamente muda (processo vivo, sem janela,
sem log nenhum).

**Nota operacional para quem for desenvolver depois de gerar um instalador:**
`npm run rebuild:electron` (e o próprio `electron-builder` durante `dist:win`)
recompilam `better-sqlite3` contra o ABI do Electron — isso pode deixar `npm run dev`/
`npm run test:faseN` (que usam o Node do sistema via `tsx`) quebrados com erro de
`NODE_MODULE_VERSION` até rodar `npm rebuild better-sqlite3` de volta.

**Auto-update de verdade (substituiu o esqueleto `src/core/updater/`):** usa
`electron-updater` + GitHub Releases (`build.publish` no `package.json`, provider
`github`, detectado do remote `Dragonxt022/katsu`). `npm run release:win` builda **e**
publica a Release (instalador + `latest.yml`) — precisa de `GH_TOKEN` (Personal Access
Token com escopo de `repo`/`public_repo`) na env no momento de rodar. Importante: dar
`git push` sozinho **não** libera nada para quem já tem o app instalado — só
`npm run release:win` publica uma Release de verdade, que é o que o
`autoUpdater.checkForUpdates()` (chamado no boot, só quando `app.isPackaged`) enxerga.
Update baixado dispara um diálogo perguntando se reinicia agora ou depois; eventos vão
para `update.log` em `app.getPath('userData')` (sem console num app empacotado).
Só cobre o **app inteiro** (módulos vão juntos, empacotados) — atualização
independente por módulo continua sem existir.

### Fase 1 — Core: segurança
**Objetivo:** ninguém entra sem autenticar; nada acontece sem permissão; tudo fica registrado.
**Entregáveis:**
- **Auth:** login, logout, hash de senha (argon2/bcrypt), sessão, "lembrar login".
- **Usuários e cargos:** Administrador, Gerente, Operador, Caixa, Entregador, Estoquista.
- **Permissões (RBAC) por módulo e ação:** visualizar, criar, editar, excluir, exportar, imprimir — e permissões finas (ex.: "alterar preço", "alterar estoque" separadas de "editar produto").
- **Auditoria:** todo evento gera log (usuário, ação, entidade, antes/depois, hora, IP, máquina).
- Configurações, backup local, licenciamento base.
**DoD:** usuário sem permissão de "excluir" não consegue excluir por nenhuma via (UI ou rota); toda ação sensível aparece no log de auditoria.

### Fase 2 — Shared (biblioteca compartilhada)
**Objetivo:** funções puras, testadas, reaproveitáveis por todos os Apps.
**Entregáveis:** money, datas, CPF/CNPJ, CEP, telefone, máscaras, validators, PDF, QR Code, código de barras, PIX, impressão, impostos (NCM/CFOP), IBGE.
**DoD:** cada utilitário com testes unitários; zero dependência de Core ou de Apps (funções puras).

### Fase 3 — Comercial (base transacional)
**Objetivo:** cadastros e estoque que sustentam qualquer segmento.
**Entregáveis:** clientes, fornecedores, produtos, categorias, estoque, compras.
**DoD:** CRUD completo com permissões e auditoria aplicadas; movimentação de estoque consistente.

### Fase 4 — Financeiro
**Objetivo:** dinheiro entra e sai de forma rastreável.
**Entregáveis:** caixa, contas a pagar, contas a receber, fluxo de caixa, relatórios financeiros.
**DoD:** abertura/fechamento de caixa confere; relatório de fluxo bate com lançamentos.

### Fase 5 — Apps (segmentos)
**Objetivo:** primeiro segmento comercializável ponta a ponta.
**Ordem sugerida:** ~~Restaurante primeiro~~ → **DECIDIDO (2026-07-06): Loja/varejo primeiro** (módulo `store`: PDV genérico para material de construção, mercado, roupas). Restaurante, Farmácia, Oficina, Lava Jato e Eletrônica vêm depois, reaproveitando commercial + finance + store.
**Entregáveis por App:** PDV, delivery, produção/cozinha, regras específicas do segmento.
**DoD:** um restaurante consegue operar um dia inteiro só com o Katsu (venda → produção → caixa → relatório).

### Fase 6 — Nuvem
**Objetivo:** multi-dispositivo e continuidade.
**Entregáveis:** motor de sincronização por UUID com resolução de conflitos, assinaturas, backup em nuvem, painel administrativo (VPS).
**DoD:** duas máquinas offline editam, reconectam e convergem sem perda nem duplicação.

Dividida em sub-fases sequenciais e testáveis (mesmo padrão da Fase 5):

- **6a — Motor de sincronização** ✅ implementado e testado (`npm run test:fase6a`).
  Servidor de nuvem em `cloud/` (Node + Express + **MySQL**, ver §11), rodando local via
  Docker para dev/teste. Ver §6 para o contrato e os desvios conscientes adotados.
- **6b — Licenciamento remoto + módulos habilitados por plano** ✅ implementado e
  testado (`npm run test:fase6b`). Ver §7 para o desenho.
- **6c — Backup em nuvem** ✅ implementado e testado (`npm run test:fase6c`). Ver §8.
- **6d — Painel administrativo (MVP)** ✅ implementado e testado (`npm run test:fase6d`).
  Ver §9. **Fase 6 completa.**

### Fase 7 — IA e ecossistema
**Objetivo:** plataforma aberta.
**Entregáveis:** assistente com IA, automações, API pública, marketplace de módulos, plugins de terceiros.
**DoD:** um plugin externo instala e funciona sem alterar o Core.

---

## 6. Sincronização (contrato)

- Toda entidade sincronizável tem `id` (SQLite, local) **e** `uuid` (universal).
- SQLite usa `id` internamente; a sincronização usa **somente `uuid`**.
- Campos de controle obrigatórios: `uuid`, `updated_at`, `deleted_at` (soft delete), `synced_at`, `origin_machine`.
- ~~Estratégia de conflito: last-write-wins por campo~~ → **DECIDIDO (2026-07-07, Fase 6a):
  last-write-wins por LINHA INTEIRA** (compara `updated_at` da linha, não campo a campo).
  Field-level LWW exigiria um log de mudanças por coluna instrumentado em todo ponto de
  escrita de todos os módulos — desproporcional ao risco real. Merge manual assistido para
  financeiro segue **fora de escopo** (não implementado).

```
Internet volta → enviar alterações → servidor → receber alterações
              → resolver conflitos (por UUID) → registrar → fim
```

### Fase 6a — o que foi implementado

- **Módulos declaram `syncTables` no manifesto** (`src/core/modules/types.ts`), agregado
  pelo loader (`src/core/sync/registry.ts`) — o Core nunca conhece tabelas de um App
  específico, mesmo padrão de `permissions`/`menu`.
- **Motor cliente** (`src/core/sync/{introspect,engine,client,routes}.ts`): introspecção
  genérica via `PRAGMA table_info`, tradução de FK id↔uuid, tabelas filhas (line items)
  embutidas no payload do agregado pai, ledgers append-only (`stock_movements`,
  `cash_movements`) com hook de recomputo local.
- **Achado crítico:** `stock_qty`/`balance_after` são derivados do ledger — nunca viajam
  na rede (`excludeColumns`). Cada máquina reconstrói o saldo a partir do ledger mesclado
  (`recomputeStockForProducts` em `src/modules/commercial/stock.ts`), evitando perda de
  baixas concorrentes por sobrescrita de linha inteira.
- **`payment_methods` não sincroniza** — é configuração por máquina/terminal (cada
  maquininha pode ter taxa própria), seedada independentemente em cada instalação;
  `sale_payments.payment_method_id` fica fora do payload (nome/tipo/taxa já são
  congelados na própria linha).
- **`users`/`roles`/`permissions`/`modules`/`settings` não sincronizam** nesta sub-fase
  (fora de escopo — levanta questões de segurança que se sobrepõem à 6b).
  Colunas que referenciam `users` (ex.: `user_id`, `opened_by`) ficam fora do payload.
- **`origin_machine` é gravado no momento da edição local**, não só durante o sync — hoje
  isso é feito no CRUD genérico (`src/modules/commercial/crud.ts`, usado por
  clientes/fornecedores). **Pendência conhecida:** os demais pontos de escrita
  (produtos, compras, caixa, vendas, orçamentos, contas) ainda não fazem esse stamp;
  funcionam corretamente para dados/estoque (LWW por linha + replay de ledger), mas o
  log de auditoria de conflito (`sync.conflict`) só é confiável hoje para
  clientes/fornecedores. Estender o mesmo stamp aos demais módulos antes de confiar no
  audit trail de conflito nessas entidades.
- **Servidor de nuvem** (`cloud/`, Node + Express + MySQL — ver §11): tabela genérica
  `sync_records` (não espelho 1:1) — um módulo novo só declara `syncTables`, o `cloud/`
  não precisa de migration nem deploy novo. Autenticação mínima por
  `company_uuid` + `license_key` (o mesmo já guardado em `license` — sessão/JWT de
  verdade fica para a 6b).
- **`machineId()` aceita override via `KATSU_MACHINE_ID`** (env var) — necessário para
  testar múltiplas "máquinas" na mesma máquina física de desenvolvimento; também útil
  para VMs clonadas de um template que precisem de identidade distinta.
- **Teste de ponta a ponta:** `src/tests/fase6a.ts` (`npm run test:fase6a`) sobe o
  `cloud/` + duas instâncias do Katsu como processos filhos (o Core mantém uma única
  conexão SQLite por processo — não dá para simular duas máquinas no mesmo processo),
  comunicando-se só por HTTP. Requer `docker compose -f cloud/docker-compose.yml up -d`
  e `npm run cloud:install && CLOUD_DB_PORT=3307 npm run cloud:migrate` antes.

---

## 7. Licenciamento

Cada instalação combina:

```
Machine ID  +  Empresa ID (UUID)  +  License Key
```

O servidor mantém, por empresa: licença → módulos habilitados → plano → validade → última sincronização. O Core valida a licença no boot (com tolerância offline configurável para não travar operação sem internet).

### Fase 6b — o que foi implementado

- **`cloud/` (`companies.plan`, `companies.modules` JSON, `companies.valid_until`)**:
  provisionamento continua manual/CLI (`cloud/src/provision-company.ts --plan <nome>
  --modules <a,b,c>`) — painel de verdade só na 6d. Nova rota
  `GET /api/license/validate` (mesma autenticação `X-Katsu-Company`/
  `X-Katsu-License-Key` do motor de sync).
- **`companies.modules = NULL`** (nunca configurado) é **fail-open** — trata como "sem
  restrição", igual ao cliente local antes da primeira validação remota. **Diferente**
  de `modules = []` (configurado explicitamente como "nenhum módulo"), que bloquearia
  tudo. Bug corrigido durante o desenvolvimento: o endpoint inicialmente devolvia `[]`
  para "nunca configurado" — todo módulo teria sumido no restart de qualquer empresa
  provisionada sem `--modules`. Coberto por teste de regressão em `fase6b.ts`.
- **Cliente** (`src/core/license/service.ts`): `getEntitledModules()`/
  `isModuleEntitled(moduleId)` leem o cache local (`license.modules_json`);
  `refreshLicenseFromCloud()` busca o estado remoto e atualiza esse cache — chamada no
  início de `runSync()` (`src/core/sync/engine.ts`), best-effort (falha de rede não
  interrompe o resto do sync).
- **`src/core/modules/loader.ts`** só monta rotas/páginas/menu/permissões/syncTables de
  um módulo se `isModuleEntitled(manifest.id)`; senão grava `modules.enabled = 0` (coluna
  que já existia desde a Fase 0 mas nunca tinha sido usada) e pula o módulo. Migrations
  de todo módulo em disco continuam rodando incondicionalmente — perder entitlement não
  apaga dado, só tira da UI/API até reabilitar.
- **Decisão confirmada com o usuário: entitlement só vale após reiniciar o Katsu** — o
  loader decide no boot a partir do cache local; não há desmontagem dinâmica de rotas
  Express em tempo real. Gating ao vivo (sem reiniciar) fica fora de escopo por ora.
- `GET /api/license` agora também devolve `modules` (lista atual ou `null`).

### Fase 6e — Planos comerciais (Trial/Prata/Ouro/Diamante)

Resolve o item em aberto da seção 12 ("modelo de precificação... híbrido"): quatro
planos fixos, cada um com um conjunto de capacidades **fixo no código**, não mais um
`companies.plan`/`modules` totalmente livre.

- **Trial** (15 dias) e **Prata**: sem atualização automática, sem salvamento em nuvem
  (sync push/pull e upload de backup). Trial existe só para o cliente provar o uso local
  antes de assinar; tecnicamente idêntico ao Prata em capacidades.
- **Ouro**: atualização automática + sincronização/backup em nuvem.
- **Diamante**: tudo do Ouro + capacidade reservada `app.online` (futura versão web —
  **não implementada**, só a flag existe para não quebrar o modelo depois).
- `src/core/license/plans.ts` (app local) e `cloud/src/plans.ts` (servidor) — regra
  **duplicada intencionalmente** entre os dois deployables (sem pacote compartilhado):
  `canAutoUpdate(plan)`/`canSaveToCloud(plan)` retornam `false` só para
  `plan IN ('trial', 'prata')` — **fail-open** para qualquer outro valor (`null`, texto
  livre legado), diferente de `isModuleEntitled` (que é fail-open só quando
  `modules_json` nunca foi configurado). Não reaproveita `modules_json`/`isModuleEntitled`
  de propósito: usar o mesmo mecanismo faria empresas sem `modules` configurado (comum
  antes desta fase) ganharem sync/update de graça por fail-open.
- Enforcement em duas camadas: local (`POST /api/sync/run`, upload de backup em
  `runBackup()`, `setupAutoUpdater()` no Electron) **e** no `cloud/`
  (`requireCloudSavePlan` em `auth.ts`, aplicado a `sync push/pull` e
  `backup upload` — não a `backup download/list`, que continua liberado para
  recuperação de dados já salvos antes de uma eventual troca de plano).
- Trial é provisionado manualmente pelo admin (painel `cloud/admin` ou
  `provision-company.ts --plan trial`); se a validade não for informada, vira
  automaticamente hoje + 15 dias (`trialValidUntil()`).
- **UI de aviso** (`src/views/partials/nav.ejs`, incluído em toda página logada):
  faixa fixa acima do menu quando `plan === 'trial'` mostrando dias restantes
  (`GET /api/license/status`, endpoint enxuto sem `requirePermission('license.view')`
  — qualquer usuário logado precisa dele, não só quem administra a licença); e um
  `<dialog>` não fechável quando `status === 'expirada'`, pedindo para acionar o
  suporte. **Esse bloqueio é só de UI** — não passou a rejeitar chamadas de API no
  backend local, mantém a política de nunca travar a operação no servidor.
- Contato de suporte (telefone/e-mail) é **global** (do fornecedor, não por empresa),
  configurado em `/admin/settings` no `cloud/` (tabela `app_settings`, chave/valor) e
  devolvido por `GET /api/license/validate` junto com `plan`/`modules`/`validUntil`.

---

## 8. Backup

- **Automático:** diário às 23:00 → compacta o SQLite → envia à nuvem (se houver assinatura).
- **Sem assinatura:** backup local direcionável (Documentos, pendrive, HD).
- Restauração validada por checksum.

### Fase 6c — o que foi implementado

- **Upload automático** (`src/core/backup/service.ts`, dentro de `runBackup()`): sempre
  que houver `company_uuid`/`license_key` configurados (`getLicenseCredentials()` — a
  leitura mais simples de "há assinatura" disponível hoje; plano pago vs. gratuito não
  existe ainda), o `.gz` recém-gerado sobe para o `cloud/` em best-effort — falha de
  rede não compromete o backup local, que já aconteceu primeiro. Sem licença configurada
  (modo dev), nada muda: comportamento idêntico ao da Fase 1.
- **`cloud/`**: nova tabela `cloud_backups` (metadados) + arquivo em disco local do
  próprio serviço (`cloud/storage/backups/<company_uuid>/<uuid>.gz`) — mesmo raciocínio
  "simples agora, trocável depois" da 6a (object storage de verdade fica para quando
  houver necessidade real de volume). Novo router `cloud/src/routes/backup.ts`:
  `POST /api/backup/upload` (corpo binário, `express.raw()` só nessa rota, confere sha256
  recebido contra o header antes de aceitar), `GET /api/backup` (lista), `GET /api/backup/:uuid/download`.
- **Recuperação de desastre** (a diferença real frente à Fase 6a): o motor de sync só
  replica tabelas de negócio; o backup é um dump binário completo do SQLite — inclui
  `users`, `roles`, `permissions`, `settings`, `audit_logs`. `downloadCloudBackup()`
  baixa e registra localmente (`trigger = 'nuvem'`); a restauração em si reaproveita
  `restoreBackup(id)`, que já existia — sem duplicar a lógica de checksum-e-sobrescrita.
  Uma instalação nova (nunca viu a empresa) consegue restaurar o estado inteiro de outra
  máquina, inclusive logar com o mesmo usuário/senha (testado em `fase6c.ts`).
- Novas rotas no Core: `GET /api/backup/cloud` e `POST /api/backup/cloud/:uuid/download`
  (mesmas permissões já existentes, `backup.view`/`backup.restore` — nenhuma nova).

---

## 9. Painel Administrativo (VPS) — praticamente outro sistema

Escopo: clientes, assinaturas, licenças, máquinas, sincronizações, financeiro (boletos/PIX), atualizações, módulos, logs, suporte, downloads.

### Fase 6d — o que foi implementado (MVP)

O escopo completo acima é grande demais para uma sub-fase — nada de billing/PIX/
boleto existia em nenhuma parte do projeto. **Recorte confirmado com o usuário:**
gestão de empresas (substitui a CLI `provision-company.ts`), visibilidade de
sincronizações/backups, e um controle **manual** de cobrança (sem gateway/PIX/boleto
de verdade — só registro e baixa manual). Emissão real de boleto/PIX, atualizações de
módulo, central de suporte e downloads ficam para uma etapa futura.

- **Segunda camada de autenticação**: o `cloud/` já autenticava *instalações*
  (`company_uuid` + `license_key`, Fase 6a). Esta sub-fase adiciona autenticação de
  **operador humano** do painel — tabela `admin_users` (bcrypt, provisionada via CLI
  `cloud/src/provision-admin.ts`, mesmo padrão de `provision-company.ts`) e sessão **em
  memória** (`cloud/src/adminAuth.ts`) — decisão de escopo: o painel reinicia raramente
  e perder sessões num restart é aceitável; evita mais uma tabela só para isso. Cookie
  lido via regex manual em `req.headers.cookie`, mesmo padrão de
  `src/core/auth/middleware.ts` no app principal.
- **Views EJS server-rendered**, sem framework de front — é um CRUD simples, forms HTML
  puros bastam (`cloud/src/views/*.ejs`): dashboard (empresas + sync + pendências),
  formulário de empresa, detalhe (edição + backups + cobranças).
- **`companies.modules`/`plan`/`valid_until` editáveis pelo painel** — mesma tabela e
  mesmo endpoint `GET /api/license/validate` que o motor de sync já consumia desde a
  6b; painel e API sempre leem/escrevem o mesmo dado, sem duplicar estado.
- **Cobrança manual** (`charges`, migration `0005_charges`): descrição, valor,
  vencimento, status (`pendente`/`paga`/`cancelada`), `paid_at`. Sem PIX/boleto/gateway
  — o admin registra e dá baixa na mão. Dashboard mostra total pendente por empresa.
- Chave de licença é gerada e mostrada em texto puro **uma única vez** (na criação da
  empresa ou ao girar a chave) — só o hash fica gravado, mesmo modelo de
  `license_key_hash` já usado desde a 6a.

**Fase 6 (Nuvem) está completa**: motor de sincronização (6a), licenciamento remoto e
módulos por plano (6b), backup em nuvem (6c) e painel administrativo MVP (6d) — todos
implementados e testados (`test:fase6a` a `test:fase6d`). Próximo item do roadmap:
Fase 7 (IA e ecossistema).

---

## 10. Ordem de ataque recomendada para o agente

1. Fase 0 completa e testada (fundação não se refatora depois).
2. Fase 1 **inteira** antes de qualquer tela de negócio — segurança não se "adiciona depois".
3. Fase 2 conforme demanda das fases seguintes (implemente o utilitário quando o primeiro consumidor aparecer, com teste).
4. Fases 3 → 4 → 5 em sequência, entregando **Restaurante** como primeiro App vendável.
5. Nuvem (Fase 6) só quando um App já roda 100% offline.
6. Ecossistema (Fase 7) por último.

**Regra de ouro para o agente:** ao começar qualquer tarefa, respeitar a regra de dependência da seção 2 e o contrato de módulo da seção 4. Se uma implementação exigir que o Core conheça um App, a arquitetura está sendo violada — parar e revisar.

---

## 11. Pontos em aberto (decidir antes de codar)

- Nome definitivo dos identificadores comerciais (Katsu Business? Katsu Platform?).
- ~~Banco da nuvem: Postgres (recomendado) vs. MySQL~~ → **DECIDIDO (2026-07-07): MySQL**
  (familiaridade do usuário). Servidor em `cloud/` na raiz do repo, deploy independente
  do Electron app; local via Docker (`cloud/docker-compose.yml`).
- ~~Biblioteca de hash~~ → **DECIDIDO (2026-07-05): bcrypt** (implementado via `bcryptjs`, API idêntica, sem dependência nativa — troca por `bcrypt` nativo é drop-in se necessário).
- ~~Estratégia de views~~ → **DECIDIDO (2026-07-05): EJS + Alpine.js** (server-rendered, sem build step, Alpine servido localmente para manter offline-first).
- Modelo de precificação por módulo (assinatura mensal, licença perpétua, híbrido).

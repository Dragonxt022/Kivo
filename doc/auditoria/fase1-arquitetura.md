# FASE 1 — Arquitetura

## Escopo

Análise da estrutura de pastas, separação de responsabilidades, acoplamento entre módulos,
inversão de dependência, reutilização de código, services, repositories, controllers, DTOs,
models, tipagem, eventos, middlewares, inicialização da aplicação, bootstrap e carregamento
de módulos.

---

## Checklist

- [x] Estrutura de pastas
- [x] Separação de responsabilidades
- [x] Acoplamento entre módulos
- [x] Inversão de dependência
- [x] Reutilização de código
- [x] Services
- [x] Repositories
- [x] Controllers
- [x] DTOs
- [x] Models
- [x] Tipagem
- [x] Eventos
- [x] Middlewares
- [x] Inicialização da aplicação
- [x] Bootstrap
- [x] Carregamento de módulos

---

## Resultados

| Item | Avaliação | Gravidade | Prioridade | Esforço |
|------|-----------|-----------|------------|---------|
| Estrutura de pastas | ✅ Excelente | — | — | — |
| Separação de responsabilidades | ✅ Excelente | — | — | — |
| Acoplamento entre módulos | ✅ Baixo (saudável) | — | — | — |
| Inversão de dependência | ⚠️ Quase perfeita | Média | Média | 1h |
| Reutilização de código | ⚠️ Parcial | Média | Média | 4h |
| Services | ⚠️ Inconsistente | Média | Alta | 8h |
| Repositories | ❌ Ausente | Alta | Alta | 12h |
| Controllers | ❌ Ausente | Média | Média | 6h |
| DTOs | ⚠️ Locais, sem padronização | Baixa | Baixa | 2h |
| Models | ⚠️ Drizzle subutilizado | Baixa | Baixa | 1h |
| Tipagem | ✅ Boa | — | — | — |
| Eventos | ❌ Ausente | Média | Média | 4h |
| Middlewares | ✅ Excelente | — | — | — |
| Inicialização | ✅ Excelente | — | — | — |
| Bootstrap | ✅ Elegante | — | — | — |
| Carregamento de módulos | ✅ Robusto | — | — | — |

---

## Problemas Encontrados

### 1. Business logic vaza para route handlers

**Local:** `src/modules/commercial/routes.ts`, `src/core/users/routes.ts`,
`src/modules/finance/routes.ts`, `src/modules/foodservice/routes.ts`

**Gravidade:** Média

**Impacto:** Manutenção difícil, testes mais complexos, lógica duplicada entre
rotas e services. Dificulta adicionar camadas como validação ou transformação
centralizada.

**Evidência:** Em `src/modules/commercial/routes.ts`, a maioria das operações CRUD
(categorias linhas 59-119, produtos linhas 185-530, complementos linhas 533-708,
kits linhas 711-788) tem SQL e validação diretamente nos handlers, enquanto operações
complexas como vendas (`store/sales.ts`) estão corretamente em services.

**Recomendação:** Mover toda lógica de negócio e acesso a dados para services.
Routes devem apenas extrair dados da request, delegar ao service, e responder.

**Esforço estimado:** 8h

---

### 2. Ausência de repository layer

**Local:** Todo o `src/` (em nenhum lugar existe `src/**/repositories/`)

**Gravidade:** Alta

**Impacto:** SQL raw espalhado por routes e services. Trocar de banco ou adicionar
cache exigiria mudanças em dezenas de arquivos. Drizzle ORM é importado mas nunca
usado para queries — apenas para schema e migrations.

**Evidência:** `getSqlite()` de `src/core/database/connection.ts:13` é chamado
diretamente com `db.prepare(sql).run()` em routes e services. Não há nenhuma
camada de abstração entre a lógica de negócio e o SQLite.

**Recomendação:** Introduzir repositories por domínio (ex: `ProductRepository`,
`UserRepository`) que encapsulem queries SQL. Futuramente permitiria migrar para
Drizzle queries ou adicionar cache sem afetar services.

**Esforço estimado:** 12h

---

### 3. Ausência de controller layer

**Local:** Nenhum arquivo em `src/` segue padrão controller

**Gravidade:** Média

**Impacto:** Routes acumulam responsabilidades de roteamento, validação,
transformação e resposta. Sem testes unitários para handlers HTTP.

**Evidência:** `src/core/users/routes.ts` tem create, update, delete, bulk-delete
tudo inline. O mesmo padrão se repete em `src/modules/finance/routes.ts`.

**Recomendação:** Extrair controllers com funções puras que recebem `(req, res)`,
delegam a services e retornam respostas padronizadas. Routes viram apenas
declarativas (`router.get('/users', listUsers)`).

**Esforço estimado:** 6h

---

### 4. Inversão de dependência violada — Core importa módulos

**Local:** `src/core/database/seedDemo.ts:4-6`

```typescript
import { createSale } from '../../modules/store/sales';
import { openRegister, closeRegister } from '../../modules/finance/cash';
import { moveStockRaw } from '../../modules/commercial/stock';
```

**Gravidade:** Média

**Impacto:** Viola o princípio de que Core não conhece módulos. Se a assinatura
dessas funções mudar, seedDemo.ts quebra. Impede que módulos sejam opcionais.

**Recomendação:** seedDemo.ts deveria usar `getService()` como todo o resto do
sistema. Alternativamente, criar um serviço `demo.seeder` registrado por cada
módulo que queira participar dos seeds.

**Esforço estimado:** 1h

---

### 5. Fragilidade na ordem de carregamento dos módulos

**Local:** `src/core/modules/loader.ts:169` — `fs.readdirSync(MODULES_DIR)`

**Gravidade:** Média

**Impacto:** `commercial` e `finance` precisam carregar ANTES de `store` porque
registram serviços que `store` consome no setup. A ordem atual funciona por acaso
(alfabética no Windows: `comandas` → `commercial` → `dre` → `finance` → ...).
`commercial` e `finance` vêm antes de `store` por coincidência alfabética, não
por contrato. Em sistemas de arquivos com ordenação diferente (Linux, macOS),
`store` poderia carregar antes e quebrar com `getService()` lançando erro.

**Evidência:** `src/modules/store/setup.ts:5-9` faz `getService('commercial.stock')`
e `getService('finance.cash')` no momento do setup (antes das rotas). Se o loader
não tiver carregado `commercial` e `finance` primeiro, o registry lança erro.

**Recomendação:** Adicionar campo `dependsOn?: string[]` no ModuleManifest.
O loader deve ordenar os módulos respeitando dependências antes de executar setup.

```typescript
// module.manifest.ts (store)
dependsOn: ['commercial', 'finance']
```

**Esforço estimado:** 2h

---

### 6. CRUD factory subutilizada

**Local:** `src/modules/commercial/crud.ts` vs `src/modules/commercial/routes.ts`

**Gravidade:** Baixa

**Impacto:** Existe uma factory `makeCrudRouter()` que gera rotas CRUD automaticamente
para uma tabela, mas é usada apenas para customers (linha 25-29). Categories,
complement groups, kit items, recipes, variants e attributes têm CRUD manual
repetitivo em routes.ts (~500 linhas).

**Evidência:** Compare `commercial/crud.ts:23-135` (~112 linhas de factory genérica)
com as ~500 linhas de CRUD manual em `commercial/routes.ts:59-880`. A factory
suporta customizações por `beforeCreate`/`afterCreate`, então poderia substituir
grande parte do código manual.

**Recomendação:** Refatorar CRUDs repetitivos para usar `makeCrudRouter()`,
reduzindo código duplicado e centralizando validações.

**Esforço estimado:** 4h

---

### 7. Ausência de sistema de eventos / pub-sub

**Local:** Em nenhum lugar do `src/`

**Gravidade:** Média

**Impacto:** Comunicação entre módulos é exclusivamente síncrona via service
registry (`getService()`). Não há forma de reagir a eventos como "venda criada"
ou "estoque alterado" sem acoplar diretamente. Exemplos de uso que seriam mais
elegantes com eventos:

- Quando uma venda é criada, notificar cozinha (foodservice) — hoje é chamada
  diretamente em `store/sales.ts:411-414`
- Quando um produto chega no estoque mínimo, disparar alerta
- Quando licença expira, notificar todos os módulos

**Evidência:** Busca por `EventEmitter`, `ipcMain`, `ipcRenderer`, `webContents.send`
não retorna resultados em `src/`. A comunicação cross-module usa exclusivamente
chamadas síncronas a `getService()`.

**Recomendação:** Implementar um EventBus simples no core, baseado em EventEmitter,
permitindo que módulos emitam e escutem eventos sem acoplamento direto:

```typescript
// core/services/eventBus.ts
export const eventBus = new EventEmitter();
```

Módulos podem então fazer:
```typescript
eventBus.on('sale:created', (sale) => { /* reagir */ });
```

Sem precisar importar o módulo `store` diretamente.

**Esforço estimado:** 4h

---

### 8. Tipos DTO duplicados entre módulos

**Local:** Interfaces de serviço definidas em `setup.ts` e redefinidas em consumidores

**Gravidade:** Baixa

**Impacto:** Quando um módulo define uma interface de serviço em `setup.ts` e outro
módulo a consome, o tipo é importado como `import type`. Mas DTOs de entrada/saída
(como `SaleInput`, `SaleItemInput`) são definidos localmente em cada arquivo e não
em um local compartilhado. Se a estrutura mudar, todos os consumidores precisam
atualizar manualmente.

**Recomendação:** Centralizar tipos compartilhados em `src/shared/types/` ou
exportar do próprio módulo em um arquivo `types.ts` padronizado.

**Esforço estimado:** 2h

---

## Pontos Positivos

- **Estrutura de pastas exemplar:** `core/` vs `modules/` vs `shared/` com
  responsabilidades muito claras e sem mistura
- **Module system é um destaque arquitetural:** Manifesto tipado, loader genérico,
  descoberta automática por convenção de diretório
- **Service Registry implementado corretamente:** `registerService`/`getService`
  evita imports diretos entre módulos na runtime
- **Inversão de dependência quase perfeita:** Core não conhece módulos (exceto
  seedDemo.ts), módulos conhecem Core
- **Middleware chain bem organizada:** Orhem clara e consistente em server.ts
- **Bootstrap elegante:** Dynamic import resolve problema de timing do KATSU_DB_PATH
- **Segurança do Electron:** `contextIsolation: true`, `nodeIntegration: false`
- **CRUD factory existe** e é bem projetada — só precisa ser mais usada
- **Ausência proposital de IPC:** Toda comunicação é HTTP local, simplificando
  a arquitetura e permitindo desenvolvimento sem Electron

---

## Nota da FASE 1: B

**Justificativa:** A arquitetura geral é sólida e bem pensada. O module system,
service registry e separação core/modules/shared são diferenciais positivos.
Os problemas principais são a ausência de repository/controller layers (que
não são críticos para uma v0.1.5), a violação pontual em seedDemo.ts, e a
fragilidade na ordem de carregamento. Nada aqui exige ação imediata, mas
os itens de prioridade alta (services + repositories) devem ser endereçados
antes de escalar o produto.

---

## Observações

Os problemas com maior custo-benefício para resolver agora são:

1. **#4 — seedDemo.ts:** 1h de esforço, elimina a única violação de DIP
2. **#5 — Ordem de módulos:** 2h de esforço, previne quebra silenciosa em outros SOs
3. **#6 — CRUD factory:** 4h de esforço, elimina ~500 linhas de código duplicado
4. **#7 — EventBus:** 4h de esforço, habilita arquitetura reativa futura

Os problemas estruturais maiores (#1 services, #2 repositories, #3 controllers)
são candidatos para um ciclo de refatoração dedicado após a auditoria completa.

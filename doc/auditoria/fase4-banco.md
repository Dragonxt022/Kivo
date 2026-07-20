# FASE 4 — Banco de Dados

## Escopo

Análise de modelagem, relacionamentos, índices, constraints, chaves,
integridade, transações, rollback e concorrência.

---

## Checklist

- [x] Modelagem
- [x] Relacionamentos
- [x] Índices
- [x] Constraints
- [x] Chaves
- [x] Integridade
- [x] Transações
- [x] Rollback
- [x] Concorrência

---

## Resultados

| Item | Avaliação | Gravidade | Prioridade | Esforço |
|------|-----------|-----------|------------|---------|
| Modelagem geral | ✅ Excelente | — | — | — |
| Relacionamentos (FKs) | ✅ Robusto (38 FKs) | — | — | — |
| Constraints (CHECK) | ✅ Excepcional (39 checks) | — | — | — |
| Chaves (PKs) | ✅ Padrão consistente | — | — | — |
| Integridade referencial | ✅ FKs ativados | — | — | — |
| Índices | ⚠️ 26 índices, 3 missing | Baixa | Baixa | 1h |
| Drizzle subutilizado | ⚠️ Só 2 de 53 tabelas | Baixa | Baixa | — |
| Sync engine N+1 queries | ❌ Crítico | Alta | Alta | 4h |
| PRAGMA introspect sem cache | ❌ Consultas repetitivas | Alta | Alta | 2h |
| Transações — comandas | ⚠️ openComanda sem tx | Média | Média | 1h |
| Transações — convertQuote | ⚠️ quote UPDATE fora | Média | Média | 0.5h |
| Transações — seedDemo | ⚠️ sem tx envolvente | Baixa | Baixa | 1h |
| Transações — applyIncomingBatch | ⚠️ sem tx por lote | Média | Média | 2h |
| Concorrência — sem lock | ⚠️ Risco documentado | Média | Média | 2h |
| SELECT * desnecessários | ⚠️ 16 ocorrências | Baixa | Baixa | 2h |
| Pricing resolveMany N queries | ⚠️ Loop individual | Baixa | Baixa | 1h |

---

## Problemas Encontrados

### 1. ALTA — Sync engine: N+1 queries massivo

**Local:** `src/core/sync/engine.ts:67-112` — `buildOutgoingPayload`,
`buildChildPayload`, `collectOutgoingBatch`

**Gravidade:** Alta

**Impacto:** Para exportar 100 registros sujos de uma tabela com 2 FKs e 1
tabela filha, o sync engine executa ~1.000 queries individuais. Cada uma paga
overhead de prepared statement + SQLite exec.

**Evidência:** O padrão para cada registro sujo executa:
1. `PRAGMA table_info` (cols da tabela pai)
2. N `SELECT uuid FROM target WHERE id = ?` (para cada FK)
3. 1 `SELECT * FROM child WHERE parent_id = ?`
4. Para cada child: `PRAGMA table_info` + SELECT uuid do FK

Sem cache de PRAGMA entre chamadas.

**Recomendação:**
1. **Cachear `tableColumns()` e `foreignKeyTargets()`** em um Map, pois o schema
   não muda em tempo de execução
2. **Batch de FK lookups**: `SELECT uuid, id FROM target WHERE id IN (?, ?, ...)`
   em vez de uma query por FK
3. **Cachear `tableColumns` para child tables** também
4. Idealmente, montar todo o payload com uma única query com JOINs

**Esforço estimado:** 4h

---

### 2. ALTA — PRAGMA introspection sem cache

**Local:** `src/core/sync/introspect.ts:26,72`
— `PRAGMA table_info(${table})` e `PRAGMA foreign_key_list(${table})`

**Gravidade:** Alta

**Impacto:** Essas queries retornam metadados do schema que são **imutáveis**
durante a vida da conexão, mas são chamadas centenas de vezes por ciclo de sync.

**Evidência:**
```typescript
// introspect.ts:26 — chamado para CADA tabela, CADA registro
export function tableColumns(table: string): ColumnInfo[] {
  return db().prepare(`PRAGMA table_info(${table})`).all() as ColumnInfo[];
}
```

**Recomendação:** Implementar cache lazy:

```typescript
const columnCache = new Map<string, ColumnInfo[]>();
export function tableColumns(table: string): ColumnInfo[] {
  if (!columnCache.has(table))
    columnCache.set(table, db().prepare(`PRAGMA table_info(${table})`).all() as ColumnInfo[]);
  return columnCache.get(table)!;
}
```

**Esforço estimado:** 2h

---

### 3. MÉDIA — openComanda sem transação

**Local:** `src/modules/comandas/comandas.ts:14-33` — `openComanda`

**Gravidade:** Média

**Impacto:** Insere comanda e atualiza status da mesa em queries separadas
sem atomicidade. Se a segunda falhar, fica uma comanda órfã.

**Evidência:**
```typescript
// Insert comanda (linha 17-19)
const info = db().prepare(`INSERT INTO comandas (...) VALUES (...)`).run(...);
// Update mesa (linha 23-24) — fora da mesma transação
db().prepare(`UPDATE store_tables SET status = 'ocupada' WHERE id = ?`).run(tableId);
```

**Recomendação:** Envolver ambas operações em `db.transaction()`.

**Esforço estimado:** 1h

---

### 4. MÉDIA — convertQuote não atomiza UPDATE do status

**Local:** `src/modules/store/quotes.ts:91-94`

**Gravidade:** Média

**Impacto:** `createSale` (com tx própria) pode suceder, mas o UPDATE do status
do orçamento para `'convertido'` pode falhar — deixando o orçamento como `'aberto'`
mesmo com venda criada.

**Evidência:**
```typescript
const saleId = await createSale(input);    // tx interna
db().prepare(`UPDATE quotes SET status = 'convertido' WHERE id = ?`).run(quoteId); // fora!
```

**Recomendação:** Envolver `createSale` + UPDATE do status em uma única
transação externa.

**Esforço estimado:** 0.5h

---

### 5. MÉDIA — applyIncomingBatch sem transação por lote

**Local:** `src/core/sync/engine.ts:270-298`

**Gravidade:** Média

**Impacto:** Registros recebidos do cloud são aplicados um por um, cada um
em sua própria transação implícita. Se o processo cair no meio do lote,
alguns registros são aplicados e outros não.

**Recomendação:** Envolver o processamento de cada lote (batch) em uma única
transação. Como o sync engine já tem lógica de idempotência, re-aplicar é
seguro, mas a atomicidade evita estados intermediários inconsistentes.

**Esforço estimado:** 2h

---

### 6. MÉDIA — Sem proteção contra múltiplos processos

**Local:** Documentado em `doc/plano.md:367`, sem proteção no código

**Gravidade:** Média

**Impacto:** Dois `npm run dev` contra o mesmo `kivo.db` já causaram
corrupção de dados (documentado). WAL mode permite leitura concorrente
mas não escrita simultânea por processos diferentes.

**Recomendação:** Implementar um file lock na abertura da conexão:

```typescript
// connection.ts
import { mkdirSync, writeFileSync, unlinkSync, existsSync } from 'fs';
const LOCK_FILE = path.join(path.dirname(DB_PATH), 'kivo.lock');
if (existsSync(LOCK_FILE)) {
  console.error('Outra instância já está usando este banco.');
  process.exit(1);
}
writeFileSync(LOCK_FILE, String(process.pid));
```

Ou usar o módulo `proper-lockfile` para locking mais robusto.

**Esforço estimado:** 2h

---

### 7. BAIXA — Índices faltantes em nomes

**Local:** Tabelas `products`, `customers`, `suppliers`

**Gravidade:** Baixa

**Impacto:** Buscas por nome de produto/cliente/fornecedor fazem full scan.
Em catálogos com 10k+ produtos, a busca pode ser lenta.

**Evidência:** Nenhum `CREATE INDEX` para `products(name)`,
`customers(name)`, `suppliers(name)` nas migrações.

**Recomendação:**
```sql
CREATE INDEX idx_products_name ON products(name);
CREATE INDEX idx_customers_name ON customers(name);
CREATE INDEX idx_suppliers_name ON suppliers(name);
```

**Esforço estimado:** 1h

---

### 8. BAIXA — SELECT * em 16 locais

**Local:** Sync engine (`engine.ts:57,63,88`), kitchen (`kitchen.ts:57,60,66`),
sales (`sales.ts:417`), quotes (`quotes.ts:69`), outros

**Gravidade:** Baixa

**Impacto:** Retorna colunas desnecessárias, aumentando tráfego de memória.
Mais crítico no sync engine onde tabelas podem ter muitas colunas.

**Recomendação:** Substituir `SELECT *` por lista explícita de colunas onde
apenas algumas são necessárias. Priorizar sync engine.

**Esforço estimado:** 2h

---

### 9. BAIXA — Pricing resolveMany N queries

**Local:** `src/modules/commercial/pricing.ts:51-52`

**Gravidade:** Baixa

**Impacto:** Para cada produto em uma venda, executa até 4 SELECTs individuais.
Em uma venda de 50 itens, são 200 queries.

**Recomendação:** Agrupar produtos em um único `SELECT ... WHERE id IN (...)`.

**Esforço estimado:** 1h

---

## Pontos Positivos

- **Modelagem exemplar**: 53 tabelas com relacionamentos claros e consistentes
- **39 CHECK constraints** no banco — regras de negócio na camada mais profunda
- **38 foreign keys** com integridade referencial ativa (`PRAGMA foreign_keys = ON`)
- **Padrão de chaves consistente**: `INTEGER PRIMARY KEY AUTOINCREMENT` + `uuid UNIQUE`
- **Append-only ledgers**: `stock_movements` e `cash_movements` sem `updated_at`/`deleted_at`
- **Partial unique indexes**: barcode/sku únicos apenas entre registros ativos
- **Migrações idempotentes**: `ON CONFLICT` em seeds, `_migrations` para tracking
- **FK desligadas durante migrações**: padrão correto para SQLite
- **WAL mode**: ativado para leitura concorrente
- **Cents-based money**: sem problemas de ponto flutuante
- **`comment` column** em toda tabela: documentação inline do schema

---

## Nota da FASE 4: B-

**Justificativa:** O schema é maduro e bem projetado — constraints, FKs,
índices, padronização de chaves e migrações são de alta qualidade. O principal
problema está na **camada de queries**: o sync engine tem um padrão N+1 sério
que pode degradar performance com o crescimento dos dados, e há pontos de
atomicidade perdidos (comandas, quotes, sync batches). Nada crítico para
v0.1.5, mas endereçar o sync engine evita dores de cabeça futuras.

---

## Resumo — Itens para plano de correção

| # | Item | Esforço | Quando |
|---|------|---------|--------|
| 1 | Cachear PRAGMA introspection | 2h | Antes de escalar |
| 2 | Batch FK lookups no sync | 4h | Antes de escalar |
| 3 | Transação em openComanda | 1h | Próximo ciclo |
| 4 | Transação em convertQuote | 0.5h | Próximo ciclo |
| 5 | Transação em applyIncomingBatch | 2h | Próximo ciclo |
| 6 | File lock anti-concorrência | 2h | Recomendado |
| 7 | Índices em nome (products, etc.) | 1h | Baixo esforço |
| 8 | SELECT * → colunas específicas | 2h | Boa prática |
| 9 | Batch pricing resolveMany | 1h | Boa prática |

# FASE 3 — Performance

## Escopo

Análise de consultas lentas, N+1 Queries, memória, cache, índices,
carregamentos desnecessários, uso de CPU, sincronizações e gargalos.

---

## Resultados

| Item | Avaliação | Gravidade | Prioridade | Esforço |
|------|-----------|-----------|------------|---------|
| Sync engine — dirty rows sem LIMIT | ❌ Pode causar OOM | Crítica | Alta | 2h |
| Sync engine — PRAGMA sem cache | ❌ N+1 em schema introspection | Alta | Alta | 2h |
| Sync engine — children N+1 | ❌ 1 query por child por row | Alta | Alta | 4h |
| Stock recompute pós-sync | ❌ Replay completo síncrono | Alta | Média | 3h |
| Pricing resolveMany N+1 | ⚠️ 1-3 SELECTs por item | Média | Média | 1h |
| SELECT * desnecessários | ⚠️ 16 ocorrências | Média | Média | 2h |
| Backup carrega DB inteiro em RAM | ⚠️ Pode causar OOM em DB grande | Média | Média | 3h |
| Índices faltantes (stock_movements, sales, etc.) | ⚠️ Vários sugeridos | Média | Média | 2h |
| Audit serializa objetos grandes | ⚠️ JSON.stringify em todo CRUD | Baixa | Baixa | 1h |
| WAL mode (sem synchronous=NORMAL) | ⚠️ FULL = mais lento | Baixa | Baixa | 0.5h |
| Kitchen tickets sem LIMIT | ⚠️ Full scan potencial | Baixa | Baixa | 0.5h |
| SELECT datetime('now') via SQL | ⚠️ Overhead desnecessário | Baixa | Baixa | 0.5h |
| DRE report sem índices compostos | ⚠️ Pode ficar lento | Baixa | Baixa | 1h |
| createSale — item loop N+1 | ⚠️ 4-5 queries por item | Média | Média | 2h |

---

## Problemas Encontrados

### 1. CRÍTICO — Sync: dirty rows sem LIMIT

**Local:** `src/core/sync/engine.ts:57,63`

**Impacto:** `collectDirtyRows()` retorna TODOS os registros sujos sem LIMIT.
Uma máquina offline por semanas pode ter milhões de dirty rows — tudo carregado
na memória de uma vez. Causa OOM.

**Recomendação:** Adicionar `LIMIT ? OFFSET ?` e paginar.

### 2. ALTA — Sync: PRAGMA table_info sem cache

**Local:** `src/core/sync/introspect.ts:26,72`

**Impacto:** Cada chamada a `tableColumns()` executa `PRAGMA table_info`.
Schema metadata é imutável — cachear em Map reduz ~1000 queries por sync.

### 3. ALTA — Sync: children N+1

**Local:** `src/core/sync/engine.ts:86-91`

**Impacto:** Para cada dirty row, uma query por child table. Com 500 rows
e 2 children = 1000 queries extras.

### 4. ALTA — Stock recompute pós-sync

**Local:** `src/modules/commercial/stock.ts:94-109`

**Impacto:** Após cada sync pull, `recomputeStockForProducts` replay TODOS
os movimentos de estoque para cada produto afetado. Síncrono, bloqueia event loop.

**Recomendação:** Processar em lote assíncrono com batch size.

### 5. MÉDIA — Backup carrega DB inteiro em RAM

**Local:** `src/core/backup/service.ts:69,138,217,266`

**Impacto:** `gzipSync(fs.readFileSync(tmpDb))` — DB inteiro em RAM.
Com DB de 500MB, são ~1GB de pico (original + comprimido).

**Recomendação:** Stream com `zlib.createGzip()` e `fs.createReadStream()`.

---

## Nota da FASE 3: C

**Justificativa:** Para um app desktop single-user, a performance é aceitável.
O sync engine é o maior gargalo futuro — sem paginação, sem cache de schema,
e com N+1 children. Os demais problemas são médios a baixos. Corrigir o
sync engine antes de escalar é a prioridade.

# FASE 8 — Código

## Escopo

Code Review completo: funções grandes, arquivos gigantes, código duplicado,
complexidade, nomes, comentários, responsabilidades misturadas.

---

## Checklist

- [x] Funções grandes
- [x] Arquivos gigantes
- [x] Código duplicado
- [x] Complexidade
- [x] Nomes
- [x] Comentários
- [x] Responsabilidades misturadas

---

## Resultados

| Item | Avaliação | Gravidade | Prioridade | Esforço |
|------|-----------|-----------|------------|---------|
| Test coverage | ✅ Boa (32 testes, critical paths cobertos) | — | — | — |
| Error handler centralizado | ❌ Ausente | Crítica | Alta | 2h |
| Unhandled rejections | ❌ Sem handlers globais | Crítica | Alta | 1h |
| Empty catch blocks | ❌ Kitchen notif silenciada | Alta | Média | 0.5h |
| Fire-and-forget sem log | ❌ 5 ocorrências | Alta | Média | 1h |
| Arquivos gigantes | ❌ commercial/routes.ts (1496 linhas) | Alta | Alta | 8h |
| Funções gigantes | ⚠️ createSale (322 linhas) | Alta | Média | 4h |
| CRUD boilerplate duplicado | ❌ ~41 handlers manuais | Alta | Alta | 6h |
| addDays() duplicado | ⚠️ 2 arquivos | Baixa | Baixa | 0.5h |
| Complexidade ciclomática | ⚠️ createSale tem 5-6 níveis | Média | Média | 3h |
| Nomes (vars de 1 letra) | ⚠️ b, q, r, m, p, d | Baixa | Baixa | 2h |
| Comentários | ✅ Excelentes no geral | — | — | — |
| console.log em produção | ⚠️ Backup, scheduler | Baixa | Baixa | 1h |
| No centralized logger | ⚠️ Usa console diretamente | Baixa | Baixa | 2h |
| as any em produção | ⚠️ 6 em comandas.ts | Média | Média | 1h |
| throw dentro de transaction | ⚠️ sales.ts (9x) | Baixa | Baixa | 1h |
| agreementScheduler fake Req | ⚠️ {} as Request | Média | Média | 0.5h |
| Organização dos módulos | ✅ Consistente no geral | — | — | — |
| Service Registry | ✅ Bem implementado | — | — | — |

---

## Problemas Encontrados

### 1. CRÍTICO — Sem central error handler no Express

**Local:** `src/core/server.ts` — nenhum middleware de erro registrado

**Gravidade:** Crítica

**Impacto:** Qualquer erro síncrono não capturado em route handlers derruba
o processo. Express 5 trata rejected promises apenas se o handler retornar
a promise, mas muitos handlers são síncronos.

**Evidência:** Nenhum `app.use((err, req, res, next) => {...})` no server.ts.

**Recomendação:** Adicionar error handler global ao final de `createServer()`:

```typescript
app.use((err: Error, _req: Request, res: Response, _next: NextFunction) => {
  console.error('[erro]', err);
  res.status(500).json({ error: 'Erro interno do servidor.' });
});
```

**Esforço estimado:** 2h

---

### 2. CRÍTICO — Sem handlers globais de exceção

**Local:** Nenhum lugar em `src/`

**Gravidade:** Crítica

**Impacto:** Promises rejeitadas não capturadas são silenciosamente engolidas
pelo Node (que só loga um warning mas não crasha). Erros inesperados podem
passar despercebidos.

**Evidência:** `grep` por `unhandledRejection`, `uncaughtException`, `process.on`
não retorna resultados em `src/`.

**Recomendação:** Adicionar em `dev.ts` e `electron/main.ts`:

```typescript
process.on('unhandledRejection', (reason) => {
  console.error('[unhandledRejection]', reason);
});
process.on('uncaughtException', (err) => {
  console.error('[uncaughtException]', err);
  app.quit(); // se for Electron
});
```

**Esforço estimado:** 1h

---

### 3. ALTA — commercial/routes.ts com 1496 linhas

**Local:** `src/modules/commercial/routes.ts`

**Gravidade:** Alta

**Impacto:** Um único arquivo monolítico contendo CRUD de ~15 entidades
diferentes. Dificulta navegação, manutenção, testes unitários e code review.

**Evidência:** O arquivo gerencia categorias, produtos, complementos, kits,
receitas, variantes, atributos, listas de preço, compras, estoque, e mais.

**Recomendação:** Dividir em arquivos separados por domínio:

```
routes/
  categories.ts
  products.ts
  variants.ts
  complements.ts
  kits.ts
  recipes.ts
  pricelists.ts
  purchases.ts
  stock.ts
```

**Esforço estimado:** 8h

---

### 4. ALTA — ~41 handlers CRUD manuais duplicados

**Local:** `src/modules/commercial/routes.ts` — entidades repetitivas

**Gravidade:** Alta

**Impacto:** O mesmo padrão de SELECT → valida → INSERT/UPDATE → audit é
repetido manualmente dezenas de vezes. O projeto já tem `makeCrudRouter()`
em `crud.ts` que poderia substituir a maior parte.

**Evidência:** Categories, complement groups, kit items, recipe items,
variants, attributes, price lists — todos com handlers manuais idênticos.
A factory `makeCrudRouter()` só é usada para customers/suppliers/agreements.

**Recomendação:** Refatorar entidades CRUD simples para usar `makeCrudRouter()`.
Manter manuais apenas operações com lógica de negócio significativa (compras,
produtos com imagem/variants).

**Esforço estimado:** 6h

---

### 5. ALTA — createSale com 322 linhas e 6+ responsabilidades

**Local:** `src/modules/store/sales.ts:85-407`

**Gravidade:** Alta

**Impacto:** Função monolítica que mistura: resolução de itens, expansão de
kits, consumo de receitas, pagamentos múltiplos, crédito, fidelidade,
convênios, notificação de cozinha. Difícil testar cada aspecto isoladamente.

**Evidência:** 5-6 níveis de aninhamento, `throw` dentro de transaction,
responsabilidades de domínio e infraestrutura misturadas.

**Recomendação:** Extrair responsabilidades em funções/módulos menores:

- `resolveKitItems(items)`
- `resolveRecipeConsumption(items)`
- `resolvePayments(input, totalCents)`
- `applyStoreCredit(customerId, amount)`
- `applyLoyalty(customerId, saleId, totalCents)`
- `createReceivables(saleId, payments, customerId)`
- `notifyKitchen(saleId, items)`

**Esforço estimado:** 4h

---

### 6. MÉDIA — Empty catch blocks (kitchen silent failure)

**Local:** `src/modules/store/sales.ts:405`, `src/modules/comandas/comandas.ts:65`

**Gravidade:** Média

**Impacto:** Falhas de notificação da cozinha são silenciosamente engolidas.
Nenhum log, nenhum alerta. Operadores não sabem que a cozinha não recebeu
o pedido.

**Evidência:**
```typescript
} catch { /* best-effort */ }
```

**Recomendação:** No mínimo logar o erro:

```typescript
} catch (e) {
  console.error('[kitchen] falha ao notificar:', e);
}
```

Idealmente, expor em uma fila de retentativas ou painel admin.

**Esforço estimado:** 0.5h

---

### 7. MÉDIA — 5 fire-and-forget `.catch(() => {})`

**Local:** `src/core/server.ts:28,141`, `src/modules/commercial/routes.ts:304,384`,
`src/core/sync/routes.ts:37`

**Gravidade:** Média

**Impacto:** Chamadas assíncronas que falham silenciosamente. `trySubmitPending`
pode falhar e ninguém fica sabendo.

**Recomendação:** Adicionar logging no `.catch()`:

```typescript
.catch((e) => console.error('[submit] erro:', e))
```

**Esforço estimado:** 1h

---

### 8. MÉDIA — agreementScheduler usa `{} as Request`

**Local:** `src/modules/finance/agreementScheduler.ts:5`

**Gravidade:** Média

**Impacto:** Objeto vazio tipado como `Request` passado para `audit()`.
Funciona porque `audit` trata `req.ip` e `req.user` como opcionais, mas
é frágil e anti-padrão.

**Recomendação:** Criar um sistema de "system request" ou auditoria sem
requerente:

```typescript
const systemReq = { ip: 'system', user: null } as unknown as Request;
```

Ou melhor, criar uma função `auditSystem(action, entity, entityId)` que
não precise de Request.

**Esforço estimado:** 0.5h

---

### 9. MÉDIA — `as any` em produção (6 ocorrências)

**Local:** `src/modules/comandas/comandas.ts:100,124,126,143,149,178`

**Gravidade:** Média

**Impacto:** Perde type safety em pontos críticos do módulo de comandas.

**Recomendação:** Substituir por tipos corretos ou casts seguros.

**Esforço estimado:** 1h

---

### 10. BAIXA — addDays() duplicado

**Local:** `src/modules/store/sales.ts:70-74` e `src/modules/finance/bills.ts:49-53`

**Gravidade:** Baixa

**Recomendação:** Mover para `src/shared/date/index.ts`.

**Esforço estimado:** 0.5h

---

### 11. BAIXA — Nomes de variável de 1 letra

**Local:** Uso de `b` (body), `q` (query), `r` (response), `m` (match), `p` (product),
`d` (date), `n` (count) espalhados pelo código

**Gravidade:** Baixa

**Impacto:** Reduz legibilidade, especialmente para novos contribuidores.

**Recomendação:** Renomear gradualmente ao refatorar arquivos.

**Esforço estimado:** 2h (distribuído)

---

## Pontos Positivos

- **32 testes de integração** cobrindo critical paths (vendas, estoque, pagamentos)
- **Comentários em português excelentes** — detalhados, atuais, explicam regras de negócio
- **Service Registry consistente** — comunicação cross-module sempre via `getService()`
- **Estrutura de módulos consistente** — todos seguem o padrão manifest + routes + pages
- **Sem commented-out code** — código limpo, sem lixo acumulado
- **Ledger pattern bem abstraído** — customerLedger.ts reutilizado por storeCredit + loyalty
- **CRUD factory existe** — `makeCrudRouter()` bem projetada, só precisa ser mais usada

---

## Nota da FASE 8: C+

**Justificativa:** O código é funcional e tem boa organização geral, mas sofre
de problemas clássicos de projeto em evolução rápida: arquivos que cresceram
demais, funções que acumularam responsabilidades, e boilerplate que nunca foi
refatorado. A ausência de error handler global e handlers de exceção é o ponto
mais crítico. Os testes existem e cobrem o essencial, mas são todos integração
(sem unit tests). O ponto forte é a consistência arquitetural e os comentários
de qualidade.

---

## Resumo — Prioridades de Correção

| # | Item | Esforço | Impacto |
|---|------|---------|---------|
| 1 | Error handler global Express | 2h | Crítico |
| 2 | Handlers unhandledRejection/uncaughtException | 1h | Crítico |
| 3 | Logging em empty catch blocks | 0.5h | Evita surpresas |
| 4 | Logging em fire-and-forget | 1h | Evita surpresas |
| 5 | Extrair createSale em funções menores | 4h | Manutenibilidade |
| 6 | Refatorar CRUDs para usar factory | 6h | Reduz ~1000 linhas |
| 7 | Dividir commercial/routes.ts | 8h | Organização |
| 8 | Substituir {} as Request | 0.5h | Robustez |
| 9 | Eliminar as any em produção | 1h | Type safety |

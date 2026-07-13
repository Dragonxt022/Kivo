# FASE 7 — TypeScript

## Escopo

Análise de `any` desnecessários, tipos duplicados, interfaces repetidas,
cast perigosos, inferências ruins, generics.

---

## Resultados

| Item | Avaliação | Gravidade | Prioridade | Esforço |
|------|-----------|-----------|------------|---------|
| `as any` em produção | ⚠️ 7 em comandas.ts, 1 em foodservice | Média | Média | 1h |
| `as Request` sem validação | ❌ {} as Request (agreementScheduler) | Alta | Alta | 0.5h |
| `as unknown as Request` (seedDemo) | ⚠️ Aceitável para seed | Baixa | Baixa | — |
| `req.user!` (34 ocorrências) | ⚠️ Non-null assertion repetitivo | Média | Média | 2h |
| `img.imageUrl!` | ⚠️ Non-null em optional property | Média | Baixa | 0.5h |
| Tipos duplicados | ✅ Nenhum idêntico | — | — | — |
| Interfaces repetidas | ✅ Nenhuma (cada uma em 1 lugar) | — | — | — |
| Generics | ⚠️ Subutilizados (só 4 definições próprias) | Baixa | Baixa | — |
| `satisfies` | ✅ 14 usos (moderno) | — | — | — |
| `strict: true` | ✅ Ativado | — | — | — |
| `@ts-ignore` / `@ts-nocheck` | ✅ Zero ocorrências | — | — | — |
| `import type` | ✅ 46 usos, consistente | — | — | — |
| `readonly` | ❌ Nunca usado | Baixa | Baixa | 1h |
| Barrel exports (index.ts) | ❌ Ausente | Baixa | Baixa | 2h |
| `as const` | ⚠️ Só 1 uso | Baixa | Baixa | — |
| `unknown` em catch | ⚠️ Inconsistente (e vs unknown) | Baixa | Baixa | 1h |

---

## Problemas Encontrados

### 1. ALTA — `{} as Request` no agreementScheduler

**Local:** `src/modules/finance/agreementScheduler.ts:5`

**Impacto:** Objeto vazio tipado como `Request`. Se `audit()` acessar
`req.ip` ou `req.user`, retorna undefined em vez de falhar. Esconderia
bugs.

**Recomendação:** Extrair `audit()` em versão que não precise de Request,
ou criar factory `makeSystemRequest()`.

### 2. MÉDIA — `as any` em comandas.ts (7 ocorrências)

**Local:** `src/modules/comandas/comandas.ts:100,124,126,143,149,152,178`

**Impacto:** Perda de type safety em queries DB críticas.

**Recomendação:** Tipar retornos de `db.prepare(...).get()` como já feito
nas linhas 37 e 82 do mesmo arquivo.

### 3. MÉDIA — `req.user!` em 34 locais

**Impacto:** Non-null assertion repetido. Se a cadeia de middleware mudar,
todos quebram silenciosamente.

**Recomendação:** Criar type guard:
```typescript
function assertAuth(req: Request): asserts req is Request & { user: AuthUser } {
  if (!req.user) throw new Error('Not authenticated');
}
```

---

## Nota da FASE 7: B-

**Justificativa:** TypeScript é bem usado no geral — strict mode ativado,
zero `@ts-ignore`, `satisfies` em 14 lugares, `import type` consistente.
Os problemas são pontuais: `as any` no módulo comandas, `as Request` fake,
e 34 `req.user!` que poderiam ser eliminados com um type guard.

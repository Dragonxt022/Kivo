# FASE 6 — API Express

## Escopo

Análise de controllers, services, validações, tratamento de erro,
padronização, códigos HTTP, logs, rate limiting e autenticação.

---

## Resultados

| Item | Avaliação | Gravidade | Prioridade | Esforço |
|------|-----------|-----------|------------|---------|
| Controllers | ❌ Inline nas routes | Média | Média | 6h |
| Services — store, auth, license | ✅ Bem separados | — | — | — |
| Services — users, roles, commercial | ❌ SQL direto nas routes | Média | Média | 8h |
| Validação | ❌ Ad-hoc, sem schema | Média | Média | 6h |
| Error handler global | ❌ Ausente | Crítica | Alta | 2h |
| Resposta padronizada | ❌ Sem envelope único | Média | Baixa | 3h |
| Códigos HTTP | ✅ Geralmente corretos | — | — | — |
| Logs de requisição | ❌ Nenhum (sem morgan) | Média | Baixa | 1h |
| Rate limiting | ❌ Ausente | Alta | Alta | 1h |
| Autenticação | ✅ Consistente (3 camadas) | — | — | — |
| RBAC | ✅ Completo | — | — | — |
| Service Registry | ✅ Bem implementado | — | — | — |
| Route factories (CRUD, bills) | ✅ Reutilizáveis | — | — | — |

---

## Problemas Encontrados

### 1. CRÍTICO — Sem error handler global no Express

**Local:** `src/core/server.ts`

Qualquer erro não capturado crasha o processo. Adicionar middleware de erro.

### 2. ALTA — Sem rate limiting

**Local:** Todas as rotas — nenhuma proteção contra brute force.

### 3. MÉDIA — Sem envelope de resposta padronizado

**Local:** Todas as rotas — inconsistência entre `res.json([...])`,
`res.json({ ok: true })`, `res.json({ id })`, `{ error }`.

**Recomendação:** Adotar envelope:
```typescript
{ success: true, data: ... }  // sucesso
{ success: false, error: '...', code?: '...' }  // erro
```

### 4. MÉDIA — Sem logging de requisições HTTP

**Local:** Nenhum middleware como `morgan`.

**Recomendação:** Adicionar `morgan('dev')` ou similar.

### 5. MÉDIA — SQL direto nas rotas (users, roles, commercial, finance)

**Local:** `src/core/users/routes.ts`, `src/core/roles/routes.ts`,
`src/modules/commercial/routes.ts`, `src/modules/finance/routes.ts`

**Recomendação:** Mover para services (já iniciado com store, auth, license).

---

## Nota da FASE 6: C

**Justificativa:** A API é funcional e tem pontos fortes (autenticação
consistente, RBAC completo, service registry, factories reutilizáveis),
mas carece de padronização, validação schema-driven, error handler global,
e rate limiting. A separação services/routes é inconsistente entre módulos.

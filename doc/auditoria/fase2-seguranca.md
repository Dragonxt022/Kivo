# FASE 2 — Segurança

## Escopo

Análise de SQL Injection, XSS, CSRF, validação insuficiente, autenticação,
autorização, permissões, armazenamento de senha, criptografia, JWT, Electron
exposto, IPC inseguro, preload inseguro, Node Integration, Context Isolation,
e acesso ao sistema operacional.

---

## Checklist

- [x] SQL Injection
- [x] XSS
- [x] CSRF
- [x] Validação insuficiente
- [x] Autenticação
- [x] Autorização
- [x] Permissões
- [x] Armazenamento de senha
- [x] Criptografia
- [x] JWT
- [x] Electron exposto
- [x] IPC inseguro
- [x] Preload inseguro
- [x] Node Integration
- [x] Context Isolation
- [x] Acesso ao sistema operacional

---

## Resultados

| Item | Avaliação | Gravidade | Prioridade | Esforço |
|------|-----------|-----------|------------|---------|
| SQL Injection | ✅ 0 vulnerabilidades exploráveis | — | — | — |
| XSS — EJS/Templates | ✅ Seguro (escaped output) | — | — | — |
| XSS — x-html no PDV | ⚠️ Potencial stored XSS | Baixa | Baixa | 1h |
| CSRF | ❌ Nenhuma proteção | Crítica | Alta | 4h |
| Security Headers | ❌ Nenhum (Helmet/CSP) | Crítica | Alta | 2h |
| Validação de entrada | ⚠️ Ad-hoc, sem biblioteca | Média | Média | 6h |
| Autenticação — geral | ⚠️ Boa base, gaps pontuais | Média | Média | — |
| Password strength | ❌ Fraca (só 6 chars mín) | Alta | Alta | 1h |
| Rate limiting (login) | ❌ Ausente | Alta | Alta | 1h |
| Username enumeration | ⚠️ Possível por timing | Média | Média | 1h |
| Sessões expiradas | ⚠️ Sem limpeza automática | Baixa | Baixa | 1h |
| Autorização/Permissões | ✅ Robusta e completa | — | — | — |
| Privilege escalation | ✅ Não encontrado | — | — | — |
| bcrypt rounds (10) | ⚠️ Aceitável, ideal 12+ | Baixa | Baixa | 0.5h |
| JWT | ✅ Não usado (opaque tokens) | — | — | — |
| Electron — contextIsolation | ✅ true | — | — | — |
| Electron — nodeIntegration | ✅ false | — | — | — |
| Preload | ✅ Mínimo (só version) | — | — | — |
| IPC | ✅ Não usado | — | — | — |
| shell.openExternal/dangerous | ✅ Não encontrado | — | — | — |
| child_process em produção | ✅ Não encontrado | — | — | — |
| Path traversal | ✅ Não encontrado | — | — | — |
| File upload | ✅ Seguro (magic bytes, UUID) | — | — | — |
| Chaves/segredos hardcoded | ✅ Nenhum encontrado | — | — | — |

---

## Problemas Encontrados

### 1. CRÍTICO — Nenhuma proteção CSRF

**Local:** Todos os endpoints que alteram estado (POST/PUT/DELETE) em
`src/core/auth/routes.ts`, `src/core/users/routes.ts`,
`src/modules/commercial/routes.ts`, etc.

**Gravidade:** Crítica

**Impacto:** Um site malicioso pode fazer requisições cross-origin para alterar
dados, criar usuários, excluir registros, etc., se a vítima estiver autenticada.
O cookie `sameSite: 'lax'` só protege requisições GET, não POST/PUT/DELETE.

**Evidência:** Nenhum middleware CSRF, nenhum token CSRF em formulários, nenhuma
validação de header `Origin`/`Referer`. `package.json` não contém pacotes como
`csurf` ou `csrf`.

**Recomendação:** Implementar proteção CSRF. Duas opções viáveis:

**Opção A (simples):** Mudar `sameSite` para `'strict'` no cookie de sessão
(`src/core/auth/routes.ts:23`). Isso bloqueia cookies em requisições
cross-site completamente. Compatível com Electron + HTTP local.

**Opção B (completa):** Adicionar middleware CSRF com token. O backend gera um
token, o frontend Alpine.js o inclui em headers customizados
(ex: `X-CSRF-Token`), e o middleware valida em toda mutação.

**Para um desktop app com acesso LAN:** Opção A + B é o ideal.

**Esforço estimado:** 2h (opção A) / 4h (opção B)

---

### 2. CRÍTICO — Nenhum security header (Helmet/CSP)

**Local:** `src/core/server.ts:78-81` — middleware stack

**Gravidade:** Crítica

**Impacto:** Sem `X-Frame-Options`, o app pode ser embedado em iframes
(clickjacking). Sem `X-Content-Type-Options`, navegadores podem fazer MIME
sniffing. Sem CSP, não há defesa em profundidade contra XSS. O header
`X-Powered-By: Express` vaza informação do stack.

**Evidência:** Nenhum middleware de segurança na stack do Express. Apenas
`express.json`, `express.urlencoded`, `express.static`.

```typescript
// src/core/server.ts:78-81
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true }));
app.use(express.static(public));
app.use('/uploads/products', express.static(...));
```

**Recomendação:** Instalar `helmet` e configurar:

```typescript
import helmet from 'helmet';
app.use(helmet({
  contentSecurityPolicy: false, // desligar se conflitar com Alpine.js/CDN
  crossOriginEmbedderPolicy: false, // desligar para compatibilidade EJS
}));
```

Para CSP, configurar gradualmente em modo report-only primeiro.

**Esforço estimado:** 2h

---

### 3. ALTA — Password strength insuficiente

**Local:**
- `src/core/auth/routes.ts:59` — só checa `length < 6`
- `src/core/users/routes.ts:38` — NENHUMA validação de senha no cadastro

**Gravidade:** Alta

**Impacto:** Usuários podem criar senhas de 1 caractere. O seed padrão é
`admin / admin`. Sem política de complexidade, o sistema fica vulnerável a
ataques de força bruta em contas de usuário.

**Evidência:**
```typescript
// auth/routes.ts:59 — única validação existente
if (String(newPassword).length < 6) {
  return res.status(400).json({ error: 'A senha deve ter no mínimo 6 caracteres.' });
}

// users/routes.ts:38 — sem validação de senha
const { username, name, password, roleSlug } = req.body ?? {};
if (!username || !name || !password || !roleSlug) {
```

**Recomendação:** Criar uma função `validatePasswordStrength(password)` em
`src/shared/` que exija:
- Mínimo 8 caracteres
- Pelo menos 1 letra maiúscula
- Pelo menos 1 letra minúscula
- Pelo menos 1 dígito
- Opcional: 1 caractere especial

Aplicar em: criação de usuário (`users/routes.ts`), alteração de senha
(`auth/routes.ts`), e configuração de PIN (`security/routes.ts`).

**Esforço estimado:** 1h

---

### 4. ALTA — Rate limiting ausente no login

**Local:** `src/core/auth/routes.ts:9-37` — `POST /api/auth/login`

**Gravidade:** Alta

**Impacto:** Um atacante pode fazer tentativas ilimitadas de login, permitindo
força bruta de senhas e enumeração de usuários. O único registro é passivo
(audit log).

**Evidência:** Nenhum middleware de rate limit (`express-rate-limit` ou similar)
no `package.json`. A rota de login não tem nenhuma lógica de limitação.

**Recomendação:** Instalar `express-rate-limit` e aplicar:

```typescript
import rateLimit from 'express-rate-limit';

const loginLimiter = rateLimit({
  windowMs: 60 * 1000, // 1 minuto
  max: 5,              // 5 tentativas por minuto
  message: { error: 'Muitas tentativas. Aguarde 1 minuto.' },
});

authRoutes.post('/login', loginLimiter, async (req, res) => { ... });
```

**Esforço estimado:** 1h

---

### 5. MÉDIA — Username enumeration por timing

**Local:** `src/core/auth/service.ts:49`

**Gravidade:** Média

**Impacto:** Um atacante pode descobrir quais usernames existem medindo o tempo
de resposta. Se o usuário não existe, a resposta é imediata (short-circuit).
Se existe, o bcrypt roda (~200-300ms).

**Evidência:**
```typescript
// auth/service.ts:47-49
if (!row || !verifyPassword(password, row.password_hash)) {
  return null;
}
```

**Recomendação:** Sempre rodar `verifyPassword` mesmo quando o usuário não
existe, usando um hash dummy:

```typescript
const dummyHash = bcrypt.hashSync('dummy', 10);
const match = row ? verifyPassword(password, row.password_hash) : verifyPassword(password, dummyHash);
if (!row || !match) return null;
```

**Esforço estimado:** 1h

---

### 6. MÉDIA — Validação de entrada ad-hoc, sem schema

**Local:** Todo o codebase — nenhuma biblioteca de validação

**Gravidade:** Média

**Impacto:** Cada endpoint faz validação manual diferente. Não há schema
centralizado, contract testing, ou mensagens de erro padronizadas. Erros de
validação podem vazar detalhes de implementação.

**Evidência:** Nenhum `zod`, `joi`, `express-validator`, `yup` no projeto.
Validações são `if (!body.field)` ou `String(body.field).trim()` espalhados.

**Recomendação:** Adotar `zod` para schemas de validação. Benefícios:
- Tipos inferidos automaticamente (elimina interfaces manuais)
- Mensagens de erro padronizadas em português
- Validação de tipos, formatos, ranges
- Schemas reutilizáveis entre criação e atualização

Exemplo:
```typescript
import { z } from 'zod';

const createUserSchema = z.object({
  username: z.string().min(3).max(50),
  name: z.string().min(1).max(200),
  password: z.string().min(8),
  roleSlug: z.string(),
});
```

**Esforço estimado:** 6h (pode ser feito incrementalmente)

---

### 7. MÉDIA — bcrypt rounds fixados em 10 (abaixo do ideal)

**Local:** `src/core/auth/service.ts:19` — `bcrypt.hashSync(plain, 10)`

**Gravidade:** Baixa

**Impacto:** 10 rounds é o mínimo aceitável. OWASP 2026 recomenda 12+ rounds
para bcrypt (ou Argon2id). Em hardware moderno, 12 rounds ainda é rápido o
suficiente (~500ms) para login.

**Recomendação:** Mudar para 12 rounds. Armazenar o número de rounds no hash
(o bcrypt já inclui o custo no prefixo `$2a$10$...`), então hashes existentes
continuam funcionando. Hashes novos usarão 12 rounds.

```typescript
const SALT_ROUNDS = 12;
```

**Esforço estimado:** 0.5h

---

### 8. MÉDIA — x-html no PDV (stored XSS potencial)

**Local:** `src/modules/store/views/store-pdv.ejs:359,398`

**Gravidade:** Baixa

**Impacto:** Se um administrador cadastrar um nome de método de pagamento
contendo HTML/script malicioso, ele será renderizado como HTML puro no PDV
para todos os usuários.

**Evidência:** O template usa `x-html` com concatenação de strings:
```ejs
<button ... x-html="methodIcon(m.type) + '<span>' + m.name + '</span>' + ...">
```

**Recomendação:** Substituir `x-html` por `x-text` combinado com elementos
separados, ou sanitizar o HTML antes de renderizar. Melhor: usar `x-text`
para o nome e deixar o ícone em elemento separado.

**Esforço estimado:** 1h

---

### 9. BAIXA — Sem limpeza de sessões expiradas

**Local:** `src/core/auth/service.ts` — sessões são inseridas mas nunca limpas

**Gravidade:** Baixa

**Impacto:** As linhas da tabela `sessions` com `expires_at` no passado nunca
são removidas. Com uso prolongado, a tabela cresce indefinidamente.

**Recomendação:** Adicionar cleanup periódico (ex: no bootstrap do servidor
ou scheduler diário):

```typescript
db.prepare(`DELETE FROM sessions WHERE expires_at < datetime('now')`).run();
```

**Esforço estimado:** 1h

---

## Pontos Positivos

- **SQL Injection: ZERO vulnerabilidades** — todas as queries usam parâmetros `?`
- **RBAC exemplar** — toda rota protegida, admin role protegido, negações auditadas
- **Electron seguro** — `contextIsolation: true`, `nodeIntegration: false`
- **Preload minimalista** — só expõe versão, sem IPC bridges perigosos
- **Nenhum segredo hardcoded** — zero credenciais ou chaves no código fonte
- **File upload seguro** — validação por magic bytes, UUID nos nomes, sem path traversal
- **Audit trail completo** — todas as ações sensíveis são logadas
- **License integrity** — HMAC-SHA256, clock watermark, machine binding
- **Cookies httpOnly + sameSite** — proteção básica contra XSS e CSRF parcial

---

## Nota da FASE 2: C

**Justificativa:** A aplicação tem fundamentos sólidos (parameterized queries,
RBAC completo, Electron seguro), mas faltam proteções essenciais: **CSRF e
security headers são críticas ausentes**. Autenticação tem gaps de rate limiting
e password strength que precisam ser endereçados antes de expor o sistema a
clientes reais.

---

## Resumo Executivo — Itens para ação imediata

| # | Item | Esforço | Impacto |
|---|------|---------|---------|
| 1 | ✅ Mudar `sameSite` para `'strict'` | 5min | Bloqueia CSRF imediatamente |
| 2 | ✅ Instalar `helmet` + configurar | 2h | Security headers básicos |
| 3 | ✅ Adicionar `express-rate-limit` no login | 1h | Previne força bruta |
| 4 | ✅ Reforçar política de senha (8+ chars) | 1h | Protege contas de usuário |
| 5 | 🔄 Corrigir username enumeration | 1h | Elimina vazamento de informação |
| 6 | 🔄 Aumentar bcrypt para 12 rounds | 0.5h | Melhor prática |
| 7 | 🔄 Sanitizar x-html no PDV | 1h | Elimina stored XSS |

Os itens 1-4 são os de maior custo-benefício e podem ser feitos em meio período.
